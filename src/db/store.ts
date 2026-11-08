import { mkdirSync } from 'node:fs';
import { AccountsRepo } from './accounts';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { slugify } from '../io/output';
import type {
  CostStage,
  CostTracker,
  CrmMatch,
  DossierRecord,
  EvidenceBasis,
  ExplorerCosts,
  ExplorerPerson,
  Lens,
  LensScore,
  Person,
  PriorResearch,
  Profile,
  ProfileCache,
  RankResult,
  ResearchRecord,
  RunCache,
  RunMeta,
  SavedList,
} from '../types';
import { inputHash } from './hash';
import { migrate } from './schema';

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function parseJson<T>(v: unknown): T | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    return JSON.parse(v) as T;
  } catch {
    return undefined;
  }
}

export interface ListRecord extends SavedList {
  /** goal of the report the list was built in (for picking fit score/research on export); null if unknown */
  prompt: string | null;
}

export interface ExportRecord {
  listId: string | null;
  name: string;
  preset: string;
  path: string;
  count: number;
}

export interface DbStats {
  path: string;
  people: number;
  profiledPeople: number;
  profiles: number;
  runs: { runKey: string; prompt: string; people: number; ranked: number; updatedAt: string }[];
  rankings: number;
  researchedPeople: number;
  researchRows: number;
  lists: number;
  exports: number;
  /** v6 */
  dossiers: { people: number; light: number; deep: number; legacy: number };
  lenses: { id: string; goal: string; scored: number; stale: number }[];
  spend: Record<CostStage, number> & { total: number };
}

/**
 * The single persistent store (node:sqlite, synchronous). One instance per process; all writes are
 * short statements so WAL + busy_timeout lets a CLI run and a `serve` session share the file.
 */
export class Store {
  readonly db: DatabaseSync;
  /** accounts (ABX), captured LinkedIn contacts and account membership */
  readonly accounts: AccountsRepo;

  private constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(pathDir(path), { recursive: true });
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
    if (path !== ':memory:') {
      // Switching a brand-new file to WAL can report SQLITE_BUSY without consulting busy_timeout when several
      // processes create the database at once; retry briefly.
      for (let attempt = 0; ; attempt++) {
        try {
          this.db.exec('PRAGMA journal_mode = WAL');
          break;
        } catch (e) {
          if (attempt >= 50 || !/locked|busy/i.test((e as Error).message)) throw e;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.random() * 30);
        }
      }
    }
    this.db.exec('PRAGMA synchronous = NORMAL');
    migrate(this.db);
    this.accounts = new AccountsRepo(this.db);
  }

  static open(dbPath: string): Store {
    return new Store(dbPath);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /** run fn in a transaction (synchronous) */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- meta ----------
  getMeta(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return r ? str(r.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------- people ----------
  /**
   * Insert new people; refresh existing ones only from observations at least as new as the stored one
   * (`at` = when the data was observed, e.g. a report's createdAt), and never overwrite a value with a blank.
   * Blank stored values are always filled. first_seen/last_seen widen.
   */
  upsertPeople(people: Person[], source: string, at = now()): void {
    const stmt = this.db.prepare(`
      INSERT INTO people (id, full_name, first_name, last_name, title, company, url, email, connected_on, extra_json, first_seen, last_seen, last_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        full_name = CASE WHEN excluded.full_name = '' THEN people.full_name WHEN people.full_name = '' OR excluded.last_seen >= people.last_seen THEN excluded.full_name ELSE people.full_name END,
        first_name = CASE WHEN excluded.first_name = '' THEN people.first_name WHEN people.first_name = '' OR excluded.last_seen >= people.last_seen THEN excluded.first_name ELSE people.first_name END,
        last_name = CASE WHEN excluded.last_name = '' THEN people.last_name WHEN people.last_name = '' OR excluded.last_seen >= people.last_seen THEN excluded.last_name ELSE people.last_name END,
        title = CASE WHEN excluded.title = '' THEN people.title WHEN people.title = '' OR excluded.last_seen >= people.last_seen THEN excluded.title ELSE people.title END,
        company = CASE WHEN excluded.company = '' THEN people.company WHEN people.company = '' OR excluded.last_seen >= people.last_seen THEN excluded.company ELSE people.company END,
        url = CASE WHEN excluded.url = '' THEN people.url WHEN people.url = '' OR excluded.last_seen >= people.last_seen THEN excluded.url ELSE people.url END,
        email = CASE WHEN excluded.email = '' THEN people.email WHEN people.email = '' OR excluded.last_seen >= people.last_seen THEN excluded.email ELSE people.email END,
        connected_on = CASE WHEN excluded.connected_on = '' THEN people.connected_on WHEN people.connected_on = '' OR excluded.last_seen >= people.last_seen THEN excluded.connected_on ELSE people.connected_on END,
        extra_json = CASE WHEN excluded.extra_json IN ('', '{}') THEN people.extra_json
          WHEN people.extra_json IN ('', '{}') OR excluded.last_seen >= people.last_seen THEN excluded.extra_json ELSE people.extra_json END,
        last_source = CASE WHEN excluded.last_seen >= people.last_seen THEN excluded.last_source ELSE people.last_source END,
        last_seen = MAX(people.last_seen, excluded.last_seen),
        first_seen = MIN(people.first_seen, excluded.first_seen)`);
    this.tx(() => {
      for (const p of people) {
        stmt.run(
          p.id, p.fullName ?? '', p.firstName ?? '', p.lastName ?? '', p.title ?? '', p.company ?? '', p.url ?? '',
          p.email ?? '', p.connectedOn ?? '', JSON.stringify(p.extra ?? {}), at, at, source,
        );
      }
    });
  }

  getPeople(ids: string[]): Map<string, Person> {
    const out = new Map<string, Person>();
    const stmt = this.db.prepare('SELECT * FROM people WHERE id = ?');
    ids.forEach((id) => {
      const r = stmt.get(id) as Row | undefined;
      if (!r) return;
      out.set(id, {
        id,
        rowIndex: 0,
        fullName: str(r.full_name),
        firstName: str(r.first_name),
        lastName: str(r.last_name),
        title: str(r.title),
        company: str(r.company),
        url: str(r.url),
        email: str(r.email),
        connectedOn: str(r.connected_on),
        extra: parseJson<Record<string, string>>(r.extra_json) ?? {},
      });
    });
    return out;
  }

  // ---------- profiles ----------
  getProfile(key: string): Profile | undefined {
    const r = this.db.prepare('SELECT profile_json FROM profiles WHERE key = ?').get(key) as Row | undefined;
    return r ? parseJson<Profile>(r.profile_json) : undefined;
  }

  setProfile(key: string, profile: Profile, personId?: string, model = ''): void {
    this.db
      .prepare(`INSERT INTO profiles (key, person_id, model, profile_json, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET profile_json = excluded.profile_json,
          person_id = COALESCE(excluded.person_id, profiles.person_id), model = excluded.model`)
      .run(key, personId ?? null, model, JSON.stringify(profile), now());
  }

  /** most recent profile for a person (any title/model) */
  latestProfileFor(personId: string): Profile | undefined {
    const r = this.db
      .prepare('SELECT profile_json FROM profiles WHERE person_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(personId) as Row | undefined;
    return r ? parseJson<Profile>(r.profile_json) : undefined;
  }

  linkProfile(key: string, personId: string): void {
    this.db.prepare('UPDATE profiles SET person_id = ? WHERE key = ? AND person_id IS NULL').run(personId, key);
  }

  // ---------- runs + rankings ----------
  upsertRun(meta: RunMeta): void {
    this.db
      .prepare(`INSERT INTO runs (run_key, prompt, input_path, rank_model, research_model, total_people, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_key) DO UPDATE SET prompt = excluded.prompt, input_path = excluded.input_path,
          rank_model = excluded.rank_model, research_model = excluded.research_model,
          total_people = excluded.total_people, updated_at = excluded.updated_at`)
      .run(meta.runKey, meta.prompt, meta.inputPath, meta.rankModel, meta.researchModel, meta.totalPeople, meta.createdAt, meta.updatedAt);
  }

  getRun(runKey: string): RunMeta | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE run_key = ?').get(runKey) as Row | undefined;
    if (!r) return undefined;
    return {
      runKey,
      prompt: str(r.prompt),
      inputPath: str(r.input_path),
      rankModel: str(r.rank_model),
      researchModel: str(r.research_model),
      totalPeople: Number(r.total_people ?? 0),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    };
  }

  getRankings(runKey: string): Map<string, RankResult> {
    const out = new Map<string, RankResult>();
    const rows = this.db.prepare('SELECT person_id, score, reason FROM rankings WHERE run_key = ? AND ranked = 1').all(runKey) as Row[];
    for (const r of rows) out.set(str(r.person_id), { id: str(r.person_id), score: Number(r.score), reason: str(r.reason) });
    return out;
  }

  setRankings(runKey: string, results: RankResult[]): void {
    if (!this.getRun(runKey)) {
      const t = now();
      this.upsertRun({ runKey, prompt: '', inputPath: '', rankModel: '', researchModel: '', totalPeople: 0, createdAt: t, updatedAt: t });
    }
    const stmt = this.db.prepare(`INSERT INTO rankings (run_key, person_id, score, reason, ranked) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(run_key, person_id) DO UPDATE SET score = excluded.score, reason = excluded.reason, ranked = 1`);
    this.tx(() => {
      for (const r of results) stmt.run(runKey, r.id, r.score, r.reason);
    });
  }

  clearRankings(runKey: string): void {
    this.db.prepare('DELETE FROM rankings WHERE run_key = ?').run(runKey);
  }

  /**
   * Best ranking for a person to show on an export: the most recent run with `prompt` if given,
   * else the most recently updated run that ranked them.
   */
  rankingFor(personId: string, prompt?: string | null): (RankResult & { prompt: string; rank: number }) | undefined {
    const sql = `SELECT r.person_id, r.run_key, r.score, r.reason, runs.prompt FROM rankings r JOIN runs ON runs.run_key = r.run_key
      WHERE r.person_id = ? AND r.ranked = 1 ${prompt ? 'AND runs.prompt = ?' : ''} ORDER BY runs.updated_at DESC LIMIT 1`;
    const args: string[] = prompt ? [personId, prompt] : [personId];
    const r = this.db.prepare(sql).get(...args) as Row | undefined;
    if (!r && prompt) return this.rankingFor(personId);
    if (!r) return undefined;
    // position within that run by score (1 = best); ties share the better position
    const higher = this.db
      .prepare('SELECT COUNT(*) AS n FROM rankings WHERE run_key = ? AND ranked = 1 AND score > ?')
      .get(str(r.run_key), Number(r.score)) as Row | undefined;
    return { id: personId, score: Number(r.score), reason: str(r.reason), prompt: str(r.prompt), rank: Number(higher?.n ?? 0) + 1 };
  }

  // ---------- research ----------
  /** latest ok record stored under this exact key */
  getResearchByKey(key: string): ResearchRecord | undefined {
    const r = this.db
      .prepare("SELECT record_json FROM research WHERE key = ? AND status = 'ok' ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(key) as Row | undefined;
    return r ? parseJson<ResearchRecord>(r.record_json) : undefined;
  }

  /** store a research record (ok results only are ever looked up). Idempotent per (key, finishedAt); true if new. */
  insertResearch(key: string, rec: ResearchRecord, prompt: string): boolean {
    // never keep a cache-hit marker in the stored record
    const { fromCache: _drop, ...clean } = rec as ResearchRecord & { fromCache?: boolean };
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO research (person_id, key, prompt, signals_hash, model, status, record_json, error, cost_usd, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        rec.id, key, prompt, rec.signalsHash ?? '', rec.model ?? '', rec.status, JSON.stringify(clean),
        rec.error ?? null, Number(rec.costUsd) || 0, Math.round(Number(rec.durationMs) || 0), rec.finishedAt || now(),
      );
    return Number(r.changes) > 0;
  }

  hasResearchKey(key: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM research WHERE key = ? LIMIT 1').get(key));
  }

  /** latest ok research for a person from any goal/signals/model (optionally excluding one key) */
  getPriorResearch(personId: string, excludeKey?: string): PriorResearch | undefined {
    const r = this.db
      .prepare(`SELECT prompt, model, record_json, created_at FROM research
        WHERE person_id = ? AND status = 'ok' AND key <> ? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(personId, excludeKey ?? '') as Row | undefined;
    if (!r) return undefined;
    const rec = parseJson<ResearchRecord>(r.record_json);
    if (!rec?.report) return undefined;
    return { prompt: str(r.prompt), model: str(r.model), finishedAt: rec.finishedAt || str(r.created_at), report: rec.report };
  }

  /** latest ok research for a person, preferring `prompt` (used by exports) */
  latestResearchFor(personId: string, prompt?: string | null): ResearchRecord | undefined {
    if (prompt) {
      const r = this.db
        .prepare("SELECT record_json FROM research WHERE person_id = ? AND status = 'ok' AND prompt = ? ORDER BY created_at DESC, id DESC LIMIT 1")
        .get(personId, prompt) as Row | undefined;
      const rec = r ? parseJson<ResearchRecord>(r.record_json) : undefined;
      if (rec) return rec;
    }
    const r = this.db
      .prepare("SELECT record_json FROM research WHERE person_id = ? AND status = 'ok' ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(personId) as Row | undefined;
    return r ? parseJson<ResearchRecord>(r.record_json) : undefined;
  }

  // ---------- lists ----------
  listLists(): ListRecord[] {
    const lists = this.db.prepare('SELECT * FROM lists ORDER BY updated_at DESC').all() as Row[];
    const members = this.db.prepare('SELECT person_id FROM list_members WHERE list_id = ? ORDER BY position');
    return lists.map((l) => ({
      id: str(l.id),
      name: str(l.name),
      prompt: l.prompt === null || l.prompt === undefined ? null : str(l.prompt),
      createdAt: str(l.created_at),
      updatedAt: str(l.updated_at),
      ids: (members.all(str(l.id)) as Row[]).map((m) => str(m.person_id)),
    }));
  }

  /** by exact id, then case-insensitive name */
  findList(idOrName: string): ListRecord | undefined {
    const all = this.listLists();
    const q = idOrName.trim().toLowerCase();
    return all.find((l) => l.id === idOrName) ?? all.find((l) => l.name.toLowerCase() === q);
  }

  /** insert or replace a list (id is the primary key); members replaced in the given order */
  upsertList(list: SavedList, prompt?: string | null): void {
    this.tx(() => {
      this.db
        .prepare(`INSERT INTO lists (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at,
            prompt = COALESCE(excluded.prompt, lists.prompt)`)
        .run(list.id, list.name, prompt ?? null, list.createdAt, list.updatedAt);
      this.db.prepare('DELETE FROM list_members WHERE list_id = ?').run(list.id);
      const ins = this.db.prepare('INSERT OR IGNORE INTO list_members (list_id, person_id, position) VALUES (?, ?, ?)');
      list.ids.forEach((pid, i) => ins.run(list.id, pid, i));
    });
  }

  hasList(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM lists WHERE id = ?').get(id));
  }

  deleteList(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM lists WHERE id = ?').run(id).changes) > 0;
  }

  // ---------- exports ----------
  recordExport(e: ExportRecord): void {
    this.db
      .prepare('INSERT INTO exports (list_id, name, preset, path, count, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.listId, e.name, e.preset, e.path, e.count, now());
  }

  // ---------- spend ----------
  addCost(stage: CostStage, usd: number, runKey?: string | null, note?: string): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.db
      .prepare('INSERT INTO cost_ledger (stage, usd, run_key, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(stage, usd, runKey ?? null, note ?? null, now());
  }

  // ---------- stats ----------
  stats(): DbStats {
    const n = (sql: string): number => Number((this.db.prepare(sql).get() as Row | undefined)?.n ?? 0);
    const runs = (this.db
      .prepare(`SELECT runs.run_key, runs.prompt, runs.total_people, runs.updated_at,
          (SELECT COUNT(*) FROM rankings r WHERE r.run_key = runs.run_key AND r.ranked = 1) AS ranked
        FROM runs ORDER BY runs.updated_at DESC`)
      .all() as Row[]).map((r) => ({
      runKey: str(r.run_key),
      prompt: str(r.prompt),
      people: Number(r.total_people ?? 0),
      ranked: Number(r.ranked ?? 0),
      updatedAt: str(r.updated_at),
    }));
    const spendRows = this.db.prepare('SELECT stage, SUM(usd) AS usd FROM cost_ledger GROUP BY stage').all() as Row[];
    const spend = { enrich: 0, rank: 0, research: 0, dossier: 0, lens: 0, ahoy: 0, total: 0 };
    for (const r of spendRows) {
      const stage = str(r.stage) as CostStage;
      if (stage in spend) spend[stage] = Number(r.usd ?? 0);
    }
    spend.total = spend.enrich + spend.rank + spend.research + spend.dossier + spend.lens + spend.ahoy;
    return {
      path: this.path,
      people: n('SELECT COUNT(*) AS n FROM people'),
      profiledPeople: n('SELECT COUNT(DISTINCT person_id) AS n FROM profiles WHERE person_id IS NOT NULL'),
      profiles: n('SELECT COUNT(*) AS n FROM profiles'),
      runs,
      rankings: n('SELECT COUNT(*) AS n FROM rankings'),
      researchedPeople: n("SELECT COUNT(DISTINCT person_id) AS n FROM research WHERE status = 'ok'"),
      researchRows: n('SELECT COUNT(*) AS n FROM research'),
      lists: n('SELECT COUNT(*) AS n FROM lists'),
      exports: n('SELECT COUNT(*) AS n FROM exports'),
      dossiers: {
        people: n("SELECT COUNT(DISTINCT person_id) AS n FROM dossiers WHERE status = 'ok'"),
        light: n("SELECT COUNT(*) AS n FROM dossiers WHERE status = 'ok' AND depth = 'light'"),
        deep: n("SELECT COUNT(*) AS n FROM dossiers WHERE status = 'ok' AND depth = 'deep'"),
        legacy: n("SELECT COUNT(*) AS n FROM dossiers WHERE legacy = 1"),
      },
      lenses: this.listLenses().map((l) => ({ id: l.id, goal: l.goal, scored: l.scored, stale: l.stale })),
      spend,
    };
  }
  // ---------- v6: dossiers ----------
  /** store a dossier version; returns its row id. Converted rows pass a sourceKey so conversion is idempotent. */
  addDossier(rec: DossierRecord, sourceKey?: string): number {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO dossiers (person_id, depth, status, model, record_json, error, cost_usd, duration_ms, created_at, legacy, source_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        rec.personId, rec.depth, rec.status, rec.model ?? '', JSON.stringify(rec), rec.error ?? null,
        Number(rec.costUsd) || 0, Math.round(Number(rec.durationMs) || 0), rec.createdAt || now(), rec.legacy ? 1 : 0,
        sourceKey ?? null,
      );
    return Number(r.lastInsertRowid ?? 0);
  }

  /** best ok dossier: deep beats light, then newest */
  bestDossier(personId: string): DossierRecord | undefined {
    const r = this.db
      .prepare(`SELECT record_json FROM dossiers WHERE person_id = ? AND status = 'ok'
        ORDER BY CASE depth WHEN 'deep' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1`)
      .get(personId) as Row | undefined;
    return r ? withDossierDefaults(parseJson<DossierRecord>(r.record_json)) : undefined;
  }

  /** best ok dossier for every person (one query) */
  private bestDossiers(): Map<string, DossierRecord> {
    const out = new Map<string, DossierRecord>();
    const rows = this.db
      .prepare(`SELECT person_id, record_json FROM dossiers WHERE status = 'ok'
        ORDER BY person_id, CASE depth WHEN 'deep' THEN 0 ELSE 1 END, created_at DESC, id DESC`)
      .all() as Row[];
    for (const r of rows) {
      const id = str(r.person_id);
      if (out.has(id)) continue;
      const rec = withDossierDefaults(parseJson<DossierRecord>(r.record_json));
      if (rec) out.set(id, rec);
    }
    return out;
  }

  /** latest profile per person (one query) */
  private latestProfiles(): Map<string, Profile> {
    const out = new Map<string, Profile>();
    const rows = this.db
      .prepare('SELECT person_id, profile_json FROM profiles WHERE person_id IS NOT NULL ORDER BY person_id, created_at DESC')
      .all() as Row[];
    for (const r of rows) {
      const id = str(r.person_id);
      if (out.has(id)) continue;
      const p = parseJson<Profile>(r.profile_json);
      if (p) out.set(id, p);
    }
    return out;
  }

  private rowToPerson(r: Row, index: number): Person {
    return {
      id: str(r.id),
      rowIndex: index + 1,
      fullName: str(r.full_name),
      firstName: str(r.first_name),
      lastName: str(r.last_name),
      title: str(r.title),
      company: str(r.company),
      url: str(r.url),
      email: str(r.email),
      connectedOn: str(r.connected_on),
      extra: parseJson<Record<string, string>>(r.extra_json) ?? {},
    };
  }

  /** current input hash per person (title + company + profile + best dossier) */
  currentInputHashes(): Map<string, string> {
    const profiles = this.latestProfiles();
    const dossiers = this.bestDossiers();
    const out = new Map<string, string>();
    for (const r of this.db.prepare('SELECT id, title, company FROM people').all() as Row[]) {
      const id = str(r.id);
      out.set(id, inputHash({ title: str(r.title), company: str(r.company), profile: profiles.get(id), dossier: dossiers.get(id) }));
    }
    return out;
  }

  private buildExplorerPeople(where = '', args: string[] = []): ExplorerPerson[] {
    const profiles = this.latestProfiles();
    const dossiers = this.bestDossiers();
    const crm = this.crmMatches();
    const rows = this.db.prepare(`SELECT * FROM people ${where} ORDER BY full_name COLLATE NOCASE, id`).all(...args) as Row[];
    const scoreRows = this.db
      .prepare(`SELECT lens_id, person_id, score, reason, basis, input_hash FROM lens_scores ${where ? 'WHERE person_id = ?' : ''}`)
      .all(...args) as Row[];
    const scores = new Map<string, Row[]>();
    for (const sr of scoreRows) {
      const pid = str(sr.person_id);
      (scores.get(pid) ?? scores.set(pid, []).get(pid)!).push(sr);
    }
    return rows.map((r, i) => {
      const person = this.rowToPerson(r, i);
      const profile = profiles.get(person.id);
      const dossier = dossiers.get(person.id);
      const hash = inputHash({ title: person.title, company: person.company, profile, dossier });
      const out: ExplorerPerson = { ...person, scores: {} };
      if (profile) out.profile = profile;
      if (dossier) out.dossier = dossier;
      const cm = crm.get(person.id);
      if (cm) out.crm = cm;
      for (const sr of scores.get(person.id) ?? []) {
        out.scores[str(sr.lens_id)] = {
          score: Number(sr.score),
          reason: str(sr.reason),
          basis: (str(sr.basis) || 'headline') as EvidenceBasis,
          stale: str(sr.input_hash) !== hash,
        };
      }
      return out;
    });
  }

  // ---------- v7: Ahoy CRM reconciliation ----------
  crmMatches(): Map<string, CrmMatch> {
    const out = new Map<string, CrmMatch>();
    for (const r of this.db.prepare('SELECT person_id, record_json FROM crm_matches').all() as Row[]) {
      try {
        out.set(str(r.person_id), JSON.parse(str(r.record_json)) as CrmMatch);
      } catch {
        /* corrupt row: treat as unchecked */
      }
    }
    return out;
  }

  /** upsert (match) or clear (null) reconciliation results, one transaction */
  setCrmMatches(updates: { id: string; crm: CrmMatch | null }[]): void {
    if (!updates.length) return;
    const put = this.db.prepare(`INSERT INTO crm_matches (person_id, record_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(person_id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at`);
    const del = this.db.prepare('DELETE FROM crm_matches WHERE person_id = ?');
    this.tx(() => {
      for (const u of updates) {
        if (u.crm) put.run(u.id, JSON.stringify(u.crm), now());
        else del.run(u.id);
      }
    });
  }

  /** every person with profile, best dossier and their score in every lens (stale computed from input hashes) */
  listExplorerPeople(): ExplorerPerson[] {
    return this.buildExplorerPeople();
  }

  getExplorerPerson(id: string): ExplorerPerson | undefined {
    return this.buildExplorerPeople('WHERE id = ?', [id])[0];
  }

  // ---------- v6: lenses ----------
  private rowToLens(r: Row, hashes: Map<string, string>): Lens {
    const id = str(r.id);
    let scored = 0;
    let stale = 0;
    for (const s of this.db.prepare('SELECT person_id, input_hash FROM lens_scores WHERE lens_id = ?').all(id) as Row[]) {
      const cur = hashes.get(str(s.person_id));
      if (cur === undefined) continue; // person no longer exists
      if (cur === str(s.input_hash)) scored++;
      else stale++;
    }
    const pins = (this.db.prepare('SELECT person_id, state FROM lens_pins WHERE lens_id = ? ORDER BY pinned_at, person_id').all(id) as Row[])
      .filter((x) => hashes.has(str(x.person_id)))
      .map((x) => ({ id: str(x.person_id), state: str(x.state) }));
    return {
      id,
      goal: str(r.goal),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      rankModel: str(r.rank_model),
      rerankModel: str(r.rerank_model),
      rerankTop: Number(r.rerank_top ?? 0),
      scored,
      stale,
      threshold: Number(r.threshold ?? 70),
      pinnedIn: pins.filter((x) => x.state === 'in').map((x) => x.id),
      pinnedOut: pins.filter((x) => x.state === 'out').map((x) => x.id),
    };
  }

  /** all lenses, most recently updated first, with scored/stale counts */
  listLenses(): Lens[] {
    const hashes = this.currentInputHashes();
    return (this.db.prepare('SELECT * FROM lenses ORDER BY updated_at DESC, id').all() as Row[]).map((r) => this.rowToLens(r, hashes));
  }

  getLens(id: string): Lens | undefined {
    const r = this.db.prepare('SELECT * FROM lenses WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToLens(r, this.currentInputHashes()) : undefined;
  }

  /** a lens with exactly this goal (case/space-insensitive), newest first */
  findLensByGoal(goal: string): Lens | undefined {
    const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    const want = norm(goal);
    const r = (this.db.prepare('SELECT * FROM lenses ORDER BY updated_at DESC').all() as Row[]).find((x) => norm(str(x.goal)) === want);
    return r ? this.rowToLens(r, this.currentInputHashes()) : undefined;
  }

  /** create a lens; id = slug(goal), suffixed -2, -3… when taken */
  /** change how many top people the rerank model re-checks on future scoring runs */
  setLensRerankTop(lensId: string, rerankTop: number): void {
    this.db.prepare('UPDATE lenses SET rerank_top = ?, updated_at = ? WHERE id = ?').run(Math.max(0, Math.floor(rerankTop) || 0), now(), lensId);
  }

  /** reword a lens: same id, scores and pins kept but every score marked stale (it was scored for the old goal) */
  setLensGoal(lensId: string, goal: string): void {
    this.tx(() => {
      this.db.prepare('UPDATE lenses SET goal = ?, updated_at = ? WHERE id = ?').run(goal.trim(), now(), lensId);
      this.db.prepare("UPDATE lens_scores SET input_hash = '' WHERE lens_id = ?").run(lensId);
    });
  }

  /** score at/above which people are in the lens (0-100) */
  setLensThreshold(lensId: string, threshold: number): void {
    this.db.prepare('UPDATE lenses SET threshold = ? WHERE id = ?').run(Math.max(0, Math.min(100, Math.round(threshold))), lensId);
  }

  /** pin people in or out of a lens by hand, or clear their pin (null) so the score decides again */
  setLensPins(lensId: string, personIds: string[], state: 'in' | 'out' | null, at = now()): void {
    if (!personIds.length) return;
    const del = this.db.prepare('DELETE FROM lens_pins WHERE lens_id = ? AND person_id = ?');
    const put = this.db.prepare(`INSERT INTO lens_pins (lens_id, person_id, state, pinned_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(lens_id, person_id) DO UPDATE SET state = excluded.state, pinned_at = excluded.pinned_at`);
    this.tx(() => {
      for (const id of personIds) {
        if (state) put.run(lensId, id, state, at);
        else del.run(lensId, id);
      }
    });
  }

  createLens(i: { goal: string; rankModel: string; rerankModel: string; rerankTop: number }, at = now()): Lens {
    const base = slugify(i.goal, 60, 'lens');
    let id = base;
    for (let n = 2; this.db.prepare('SELECT 1 FROM lenses WHERE id = ?').get(id); n++) id = `${base}-${n}`;
    this.db
      .prepare('INSERT INTO lenses (id, goal, rank_model, rerank_model, rerank_top, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, i.goal.trim(), i.rankModel, i.rerankModel, Math.max(0, Math.floor(i.rerankTop) || 0), at, at);
    return this.getLens(id)!;
  }

  deleteLens(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM lenses WHERE id = ?').run(id).changes) > 0;
  }

  /** upsert scores (one transaction) and bump each touched lens's updated_at */
  setLensScores(scores: LensScore[]): void {
    if (!scores.length) return;
    const stmt = this.db.prepare(`INSERT INTO lens_scores (lens_id, person_id, score, reason, basis, model, input_hash, scored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lens_id, person_id) DO UPDATE SET score = excluded.score, reason = excluded.reason, basis = excluded.basis,
        model = excluded.model, input_hash = excluded.input_hash, scored_at = excluded.scored_at`);
    const touched = new Set<string>();
    this.tx(() => {
      for (const s of scores) {
        stmt.run(s.lensId, s.personId, Math.max(0, Math.min(100, Math.round(s.score))), s.reason, s.basis, s.model, s.inputHash, s.scoredAt || now());
        touched.add(s.lensId);
      }
      const bump = this.db.prepare('UPDATE lenses SET updated_at = ? WHERE id = ?');
      for (const id of touched) bump.run(now(), id);
    });
  }

  /** mark scores stale (clear their input hash) so "Update stale" re-scores them — e.g. after a failed/aborted rerank */
  markLensScoresStale(lensId: string, personIds: string[]): void {
    if (!personIds.length) return;
    const stmt = this.db.prepare("UPDATE lens_scores SET input_hash = '' WHERE lens_id = ? AND person_id = ?");
    this.tx(() => {
      for (const id of personIds) stmt.run(lensId, id);
    });
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  /**
   * Cross-process lock for scoring one lens (meta row `lens_job:<id>` = {pid, at}). A lock is stale when its pid is
   * dead or its heartbeat is older than `staleMs`. Returns false when another live process holds it.
   */
  acquireLensLock(lensId: string, staleMs = 120_000): boolean {
    const key = `lens_job:${lensId}`;
    let ok = false;
    this.tx(() => {
      const cur = this.getMeta(key);
      if (cur) {
        try {
          const { pid, at } = JSON.parse(cur) as { pid: number; at: string };
          const fresh = Date.now() - Date.parse(at) < staleMs;
          if (pid !== process.pid && fresh && pidAlive(pid)) return;
        } catch {
          /* corrupt lock → replace */
        }
      }
      this.setMeta(key, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      ok = true;
    });
    return ok;
  }

  /** refresh the heartbeat of a lock this process holds */
  touchLensLock(lensId: string): void {
    const key = `lens_job:${lensId}`;
    try {
      const cur = this.getMeta(key);
      if (cur && (JSON.parse(cur) as { pid: number }).pid === process.pid) {
        this.setMeta(key, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      }
    } catch {
      /* best effort */
    }
  }

  releaseLensLock(lensId: string): void {
    const key = `lens_job:${lensId}`;
    try {
      const cur = this.getMeta(key);
      if (cur && (JSON.parse(cur) as { pid: number }).pid === process.pid) this.deleteMeta(key);
    } catch {
      /* best effort */
    }
  }

  /** person ids with no score in this lens, or whose inputs changed since they were scored */
  staleOrUnscored(lensId: string): string[] {
    const hashes = this.currentInputHashes();
    const scored = new Map<string, string>();
    for (const r of this.db.prepare('SELECT person_id, input_hash FROM lens_scores WHERE lens_id = ?').all(lensId) as Row[]) {
      scored.set(str(r.person_id), str(r.input_hash));
    }
    const out: string[] = [];
    for (const [id, h] of hashes) if (scored.get(id) !== h) out.push(id);
    return out;
  }

  /** cumulative spend from the ledger, grouped for the explorer ('rank' is legacy lens scoring) */
  explorerCosts(): ExplorerCosts {
    const spend = { enrich: 0, dossier: 0, lens: 0, research: 0, ahoy: 0 };
    for (const r of this.db.prepare('SELECT stage, SUM(usd) AS usd FROM cost_ledger GROUP BY stage').all() as Row[]) {
      const usd = Number(r.usd ?? 0);
      const stage = str(r.stage);
      if (stage === 'enrich') spend.enrich += usd;
      else if (stage === 'dossier') spend.dossier += usd;
      else if (stage === 'lens' || stage === 'rank') spend.lens += usd;
      else if (stage === 'research') spend.research += usd;
      else if (stage === 'ahoy') spend.ahoy += usd;
    }
    return { ...spend, total: spend.enrich + spend.dossier + spend.lens + spend.research + spend.ahoy, incomplete: false };
  }
}

function pathDir(p: string): string {
  return path.dirname(path.resolve(p));
}

// ---------- cache adapters (same interfaces the LLM stages already use) ----------

/**
 * RunCache backed by the store: rankings per run key; research shared across runs (exact key) plus
 * "prior research" lookups across goals. `fresh` wipes this run's rankings and ignores exact research hits.
 */
export function dbRunCache(store: Store, runKey: string, opts: { prompt: string; fresh?: boolean }): RunCache {
  const fresh = Boolean(opts.fresh);
  if (fresh) store.clearRankings(runKey);
  const ranks = store.getRankings(runKey);
  return {
    dir: store.path,
    runKey,
    getRank: (id) => ranks.get(id),
    async setRanks(results) {
      for (const r of results) ranks.set(r.id, r);
      store.setRankings(runKey, results);
    },
    async getResearch(key) {
      if (fresh) return undefined;
      return store.getResearchByKey(key);
    },
    async setResearch(key, rec) {
      store.insertResearch(key, rec, opts.prompt);
    },
    async getPriorResearch(personId, excludeKey) {
      return store.getPriorResearch(personId, excludeKey);
    },
    async writeMeta(meta) {
      const prev = store.getRun(meta.runKey);
      store.upsertRun({ ...meta, createdAt: prev?.createdAt || meta.createdAt });
    },
  };
}

export function dbProfileCache(store: Store, model = ''): ProfileCache {
  return {
    dir: store.path,
    async get(key) {
      return store.getProfile(key);
    },
    async set(key, profile, personId) {
      store.setProfile(key, profile, personId, model);
    },
  };
}

/** Wrap a cost tracker so every new spend is also appended to the ledger (seed the tracker BEFORE wrapping). */
export function withLedger(costs: CostTracker, store: Store, runKey?: string | null): CostTracker {
  return {
    ...costs,
    add(stage, usd) {
      costs.add(stage, usd);
      try {
        store.addCost(stage, usd, runKey);
      } catch {
        /* the ledger is bookkeeping; never fail a paid call over it */
      }
    },
    total: () => costs.total(),
    byStage: () => costs.byStage(),
    markIncomplete: () => costs.markIncomplete(),
    isIncomplete: () => costs.isIncomplete(),
  };
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Older dossiers (before recent activity existed) lack recentActivity/recentThemes: read them as []. */
export function withDossierDefaults(rec: DossierRecord | undefined): DossierRecord | undefined {
  const d = rec?.dossier;
  if (!rec || !d) return rec;
  if (Array.isArray(d.recentActivity) && Array.isArray(d.recentThemes)) return rec;
  return {
    ...rec,
    dossier: {
      ...d,
      recentActivity: Array.isArray(d.recentActivity) ? d.recentActivity : [],
      recentThemes: Array.isArray(d.recentThemes) ? d.recentThemes : [],
    },
  };
}
