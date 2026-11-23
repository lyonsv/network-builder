import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalCompanyUrl, canonicalProfileUrl, normalizeCompany, splitHeadline } from '../accounts/capture';
import { profileRef, profileUrlsConflict, sameName, titlesCompatible } from '../accounts/identity';
import {
  ACCOUNT_STATUSES,
  COMMITTEE_ROLES,
  DEPARTMENTS,
  HEADCOUNT_SCOPES,
  HEADCOUNT_SOURCES,
  LIST_PAGE_KINDS,
  LIST_STOP_REASONS,
  NOISE_FLAGS,
  ORG_FACT_KINDS,
  SOURCE_KINDS,
  SUBFUNCTIONS,
  TIERS,
  type Account,
  type AccountMemberRow,
  type AccountStatus,
  type AnonRow,
  type CapturedProfile,
  type CommitteeRole,
  type Contact,
  type Department,
  type HeadcountScope,
  type HeadcountSnapshot,
  type HeadcountSource,
  type LightContactInput,
  type ListPageKind,
  type ListRun,
  type ListStopReason,
  type MemberInference,
  type NoiseFlag,
  type OrgFact,
  type OrgFactKind,
  type ReportsToSource,
  type SourceRef,
  type Subfunction,
  type Tier,
} from '../accounts/types';
import { personId } from '../io/csv';
import { slugify } from '../io/output';

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const json = <T>(v: unknown, d: T): T => {
  try {
    return JSON.parse(str(v)) as T;
  } catch {
    return d;
  }
};

export class AccountError extends Error {}

export interface AccountPatch {
  name?: string;
  domain?: string;
  linkedinUrl?: string;
  aliases?: string[];
  status?: AccountStatus;
  brief?: string;
}

export interface MemberPatch {
  department?: Department | '';
  tier?: Tier | '';
  role?: CommitteeRole | '';
  reportsTo?: string;
  notes?: string;
  subfunction?: Subfunction | '';
  team?: string;
  entity?: string;
  /** ISO-3166 alpha-2 or '' */
  country?: string;
  responsibilities?: string;
  noise?: NoiseFlag | 'none' | '';
  /** 'auto' hands the reporting line back to automatic: clears it and its user ownership (can't combine with reportsTo) */
  reportsToSource?: 'auto';
}

export interface LightUpsertResult {
  /** new on this account */
  added: string[];
  /** already on this account, matched by profile URL (or the same name-only row) */
  updated: string[];
  /** already on this account, matched by name + compatible title (the URL, if any, was added as an alias) */
  merged: string[];
  skipped: { input: LightContactInput; reason: string }[];
  /** created although the name matched more than one existing member */
  warnings: { id: string; reason: string }[];
}

const LIMITS = {
  name: 120, domain: 200, alias: 120, aliases: 20, brief: 100_000, notes: 10_000, team: 120, entity: 200, responsibilities: 1000,
  personName: 200, title: 300, headline: 500, company: 200, location: 200, quote: 1000, factText: 2000, url: 2000,
};
const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num01 = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const sourceKey = (s: SourceRef) => `${s.kind}|${s.url ?? ''}|${s.runId ?? ''}`;
/** union of SourceRefs, deduped by kind + url + runId (first one kept) */
export function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const s of [...a, ...b]) {
    if (!s || typeof s !== 'object' || !SOURCE_KINDS.includes(s.kind)) continue;
    const k = sourceKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export const cleanDomain = (d: string): string =>
  (d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').slice(0, LIMITS.domain);

/** Accounts, captured contacts and membership. All SQL for the ABX feature lives here. */
export class AccountsRepo {
  constructor(private readonly db: DatabaseSync) {}

  private tx<T>(fn: () => T): T {
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

  // ---------- accounts ----------
  private toAccount(r: Row): Account {
    const status = str(r.status) as AccountStatus;
    return {
      id: str(r.id),
      name: str(r.name),
      domain: str(r.domain),
      linkedinUrl: str(r.linkedin_url),
      aliases: json<string[]>(r.aliases_json, []).filter((a) => typeof a === 'string'),
      status: ACCOUNT_STATUSES.includes(status) ? status : 'target',
      brief: str(r.brief),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    };
  }

  list(): Account[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY updated_at DESC, name COLLATE NOCASE').all() as Row[]).map((r) => this.toAccount(r));
  }

  get(id: string): Account | undefined {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toAccount(r) : undefined;
  }

  /** by id, exact LinkedIn company URL, or (normalised) name / alias */
  find(ref: string): Account | undefined {
    const q = (ref || '').trim();
    if (!q) return undefined;
    const byId = this.get(q);
    if (byId) return byId;
    const all = this.list();
    const cu = canonicalCompanyUrl(q);
    if (cu) return all.find((a) => a.linkedinUrl === cu);
    const n = normalizeCompany(q);
    if (!n) return undefined;
    return all.find((a) => normalizeCompany(a.name) === n || a.aliases.some((x) => normalizeCompany(x) === n));
  }

  /** match a capture to an account: LinkedIn company URL first, then name/alias */
  match(companyName: string, companyUrl: string): Account | undefined {
    const cu = canonicalCompanyUrl(companyUrl);
    const all = this.list();
    if (cu) {
      const hit = all.find((a) => a.linkedinUrl === cu);
      if (hit) return hit;
    }
    const n = normalizeCompany(companyName);
    return n ? all.find((a) => normalizeCompany(a.name) === n || a.aliases.some((x) => normalizeCompany(x) === n)) : undefined;
  }

  private validate(p: AccountPatch): AccountPatch {
    const out: AccountPatch = {};
    if (p.name !== undefined) {
      const name = String(p.name).replace(/\s+/g, ' ').trim();
      if (!name) throw new AccountError('account name is required');
      if (name.length > LIMITS.name) throw new AccountError(`account name is too long (max ${LIMITS.name} chars)`);
      out.name = name;
    }
    if (p.domain !== undefined) out.domain = cleanDomain(String(p.domain));
    if (p.linkedinUrl !== undefined) {
      const u = String(p.linkedinUrl).trim();
      const cu = canonicalCompanyUrl(u);
      if (u && !cu) throw new AccountError('LinkedIn URL must be a linkedin.com/company/… page');
      out.linkedinUrl = cu;
    }
    if (p.aliases !== undefined) {
      if (!Array.isArray(p.aliases)) throw new AccountError('aliases must be a list of names');
      const seen = new Set<string>();
      out.aliases = p.aliases
        .map((a) => String(a).replace(/\s+/g, ' ').trim().slice(0, LIMITS.alias))
        .filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))
        .slice(0, LIMITS.aliases);
    }
    if (p.status !== undefined) {
      if (!ACCOUNT_STATUSES.includes(p.status)) throw new AccountError(`status must be one of: ${ACCOUNT_STATUSES.join(', ')}`);
      out.status = p.status;
    }
    if (p.brief !== undefined) {
      const b = String(p.brief);
      if (b.length > LIMITS.brief) throw new AccountError(`brief is too long (max ${LIMITS.brief.toLocaleString()} chars)`);
      out.brief = b;
    }
    return out;
  }

  private uniqueId(name: string): string {
    const base = slugify(name, 60, 'account');
    let id = base;
    for (let n = 2; this.get(id); n++) id = `${base.slice(0, 56)}-${n}`;
    return id;
  }

  create(p: AccountPatch & { name: string }): Account {
    const v = this.validate(p);
    const clash = this.find(v.name!);
    if (clash) throw new AccountError(`an account called “${clash.name}” already exists`);
    if (v.linkedinUrl) {
      const byUrl = this.list().find((a) => a.linkedinUrl === v.linkedinUrl);
      if (byUrl) throw new AccountError(`“${byUrl.name}” already uses that LinkedIn page`);
    }
    const id = this.uniqueId(v.name!);
    const t = now();
    this.db
      .prepare(`INSERT INTO accounts (id, name, domain, linkedin_url, aliases_json, status, brief, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, v.name!, v.domain ?? '', v.linkedinUrl ?? '', JSON.stringify(v.aliases ?? []), v.status ?? 'target', v.brief ?? '', t, t);
    return this.get(id)!;
  }

  update(id: string, p: AccountPatch): Account {
    const cur = this.get(id);
    if (!cur) throw new AccountError('no such account');
    const v = this.validate(p);
    if (v.name && normalizeCompany(v.name) !== normalizeCompany(cur.name)) {
      const clash = this.find(v.name);
      if (clash && clash.id !== id) throw new AccountError(`an account called “${clash.name}” already exists`);
    }
    const next = { ...cur, ...v };
    this.db
      .prepare('UPDATE accounts SET name = ?, domain = ?, linkedin_url = ?, aliases_json = ?, status = ?, brief = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.domain, next.linkedinUrl, JSON.stringify(next.aliases), next.status, next.brief, now(), id);
    return this.get(id)!;
  }

  /** fill blanks only (used when a capture tells us the company's LinkedIn URL) */
  fillBlanks(id: string, p: { linkedinUrl?: string }): void {
    const cu = canonicalCompanyUrl(p.linkedinUrl ?? '');
    if (!cu) return;
    if (this.list().some((a) => a.linkedinUrl === cu)) return;
    this.db.prepare("UPDATE accounts SET linkedin_url = ? WHERE id = ? AND linkedin_url = ''").run(cu, id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
  }

  touch(id: string): void {
    this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(now(), id);
  }

  // ---------- contacts (captured LinkedIn profiles) ----------
  private toContact(r: Row): Contact {
    return {
      id: str(r.id),
      url: str(r.url),
      fullName: str(r.full_name),
      headline: str(r.headline),
      title: str(r.title),
      company: str(r.company),
      location: str(r.location),
      profile: json<CapturedProfile>(r.profile_json, {} as CapturedProfile),
      capturedAt: str(r.captured_at),
      captureCount: r.capture_count === null || r.capture_count === undefined ? 1 : Number(r.capture_count),
      kind: str(r.kind) === 'light' ? 'light' : 'full',
      sources: json<SourceRef[]>(r.sources_json, []),
    };
  }

  /** follow contact_aliases (a member URN merged into a vanity-URL contact, …) to the id the person lives under */
  resolveId(id: string): string {
    let cur = id;
    const st = this.db.prepare('SELECT contact_id FROM contact_aliases WHERE alias_id = ?');
    for (let i = 0; i < 10; i++) {
      const r = st.get(cur) as Row | undefined;
      if (!r || str(r.contact_id) === cur) break;
      cur = str(r.contact_id);
    }
    return cur;
  }

  aliasesOf(contactId: string): { aliasId: string; url: string; addedAt: string }[] {
    return (this.db.prepare('SELECT * FROM contact_aliases WHERE contact_id = ? ORDER BY added_at').all(contactId) as Row[]).map((r) => ({
      aliasId: str(r.alias_id),
      url: str(r.url),
      addedAt: str(r.added_at),
    }));
  }

  private addAlias(aliasId: string, contactId: string, url: string): void {
    if (!aliasId || aliasId === contactId) return;
    this.db
      .prepare('INSERT INTO contact_aliases (alias_id, contact_id, url, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias_id) DO UPDATE SET contact_id = excluded.contact_id')
      .run(aliasId, contactId, url, now());
  }

  getContact(id: string): Contact | undefined {
    const r = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(this.resolveId(id)) as Row | undefined;
    return r ? this.toContact(r) : undefined;
  }

  /** keyed by the ids asked for (aliases resolved) */
  contacts(ids: string[]): Map<string, Contact> {
    const out = new Map<string, Contact>();
    const st = this.db.prepare('SELECT * FROM contacts WHERE id = ?');
    for (const id of ids) {
      const r = st.get(this.resolveId(id)) as Row | undefined;
      if (r) out.set(id, this.toContact(r));
    }
    return out;
  }

  allContacts(): Contact[] {
    return (this.db.prepare('SELECT * FROM contacts ORDER BY full_name COLLATE NOCASE').all() as Row[]).map((r) => this.toContact(r));
  }

  /**
   * The id to file a profile URL under: the connection's id when this person is in your network (matched by URL,
   * tolerant of http/www/trailing-slash/encoding differences), else personId(canonical URL).
   */
  idForProfileUrl(url: string): { id: string; isConnection: boolean } {
    const canon = canonicalProfileUrl(url);
    if (!canon) throw new AccountError('not a LinkedIn profile URL');
    const id = personId(canon, '', '');
    if (this.db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) return { id, isConnection: true };
    const slug = canon.slice(canon.lastIndexOf('/') + 1);
    const variants = new Set([slug, encodeURIComponent(slug).toLowerCase()]);
    for (const s of variants) {
      const hit = this.db
        .prepare("SELECT id FROM people WHERE lower(rtrim(url, '/')) LIKE ? OR lower(rtrim(url, '/')) LIKE ? LIMIT 1")
        .get(`%linkedin.com/in/${s}`, `%linkedin.com/in/${s}?%`) as Row | undefined;
      if (hit) return { id: str(hit.id), isConnection: true };
    }
    // a URL merged into another contact (e.g. a member URN seen in a list, later captured under the vanity URL)
    const resolved = this.resolveId(id);
    if (resolved !== id) return { id: resolved, isConnection: Boolean(this.db.prepare('SELECT 1 FROM people WHERE id = ?').get(resolved)) };
    return { id, isConnection: false };
  }

  /** save a full profile capture (a light contact under the same id becomes `full`) */
  saveContact(profile: CapturedProfile, source?: SourceRef): { contact: Contact; isConnection: boolean; created: boolean } {
    const { id, isConnection } = this.idForProfileUrl(profile.url);
    const t = now();
    const blob = JSON.stringify(profile);
    let created = false;
    this.tx(() => {
      const prev = this.db.prepare('SELECT sources_json FROM contacts WHERE id = ?').get(id) as Row | undefined;
      created = !prev;
      const sources = mergeSources(json<SourceRef[]>(prev?.sources_json, []), source ? [source] : []);
      this.db
        .prepare(`INSERT INTO contacts (id, url, full_name, headline, title, company, location, profile_json, captured_at, capture_count, kind, sources_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'full', ?)
          ON CONFLICT(id) DO UPDATE SET url = excluded.url, full_name = excluded.full_name, headline = excluded.headline,
            title = excluded.title, company = excluded.company, location = excluded.location, profile_json = excluded.profile_json,
            captured_at = excluded.captured_at, capture_count = contacts.capture_count + 1, kind = 'full',
            sources_json = excluded.sources_json`)
        .run(id, profile.url, profile.fullName, profile.headline, profile.title, profile.company, profile.location, blob, t, JSON.stringify(sources));
      this.db.prepare('INSERT INTO contact_captures (contact_id, profile_json, captured_at) VALUES (?, ?, ?)').run(id, blob, t);
    });
    return { contact: this.getContact(id)!, isConnection, created };
  }

  // ---------- membership ----------
  private toMember(r: Row): AccountMemberRow {
    const d = str(r.department) as Department;
    const t = str(r.tier) as Tier;
    const role = str(r.role) as CommitteeRole;
    const sf = str(r.subfunction) as Subfunction;
    const noise = str(r.noise) as NoiseFlag | 'none';
    const rts = str(r.reports_to_source) as ReportsToSource;
    const inference = str(r.inference_json) ? json<MemberInference | null>(r.inference_json, null) : null;
    return {
      accountId: str(r.account_id),
      personId: str(r.person_id),
      department: DEPARTMENTS.includes(d) ? d : '',
      tier: TIERS.includes(t) ? t : '',
      role: COMMITTEE_ROLES.includes(role) ? role : '',
      reportsTo: str(r.reports_to),
      notes: str(r.notes),
      addedAt: str(r.added_at),
      updatedAt: str(r.updated_at),
      subfunction: SUBFUNCTIONS.includes(sf) ? sf : '',
      team: str(r.team),
      entity: str(r.entity),
      country: str(r.country),
      responsibilities: str(r.responsibilities),
      noise: noise === 'none' || NOISE_FLAGS.includes(noise as NoiseFlag) ? noise : '',
      sources: json<SourceRef[]>(r.sources_json, []),
      confidence: num01(r.confidence),
      reportsToSource: (['user', 'inferred', 'web'] as const).includes(rts as 'user') ? rts : '',
      reportsToConfidence: num01(r.reports_to_confidence),
      reportsToReason: str(r.reports_to_reason),
      ...(inference && typeof inference === 'object' ? { inference } : {}),
    };
  }

  members(accountId: string): AccountMemberRow[] {
    return (this.db.prepare('SELECT * FROM account_members WHERE account_id = ? ORDER BY added_at, person_id').all(accountId) as Row[]).map((r) =>
      this.toMember(r),
    );
  }

  allMembers(): AccountMemberRow[] {
    return (this.db.prepare('SELECT * FROM account_members ORDER BY added_at').all() as Row[]).map((r) => this.toMember(r));
  }

  membershipsOf(personId: string): AccountMemberRow[] {
    return (this.db.prepare('SELECT * FROM account_members WHERE person_id = ?').all(personId) as Row[]).map((r) => this.toMember(r));
  }

  /** is this id a known person (a connection or a captured contact)? */
  knownPerson(id: string): boolean {
    const r = this.resolveId(id);
    return Boolean(this.db.prepare('SELECT 1 FROM people WHERE id = ? UNION ALL SELECT 1 FROM contacts WHERE id = ? LIMIT 1').get(r, r));
  }

  /** add people (new ones only; existing members keep their settings unless `patch` is given) → ids actually added */
  addMembers(accountId: string, ids: string[], patch: MemberPatch = {}): { added: string[]; already: string[]; unknown: string[] } {
    if (!this.get(accountId)) throw new AccountError('no such account');
    const v = this.validateMember(accountId, patch);
    const added: string[] = [];
    const already: string[] = [];
    const unknown: string[] = [];
    this.tx(() => {
      const t = now();
      for (const raw of ids) {
        const id = this.resolveId(raw);
        if (!this.knownPerson(id)) {
          unknown.push(id);
          continue;
        }
        const exists = this.db.prepare('SELECT 1 FROM account_members WHERE account_id = ? AND person_id = ?').get(accountId, id);
        if (exists) {
          already.push(id);
          if (Object.keys(v).length) this.patchMemberRaw(accountId, id, v, t);
          continue;
        }
        this.db
          .prepare(`INSERT INTO account_members (account_id, person_id, department, tier, role, reports_to, notes, added_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(accountId, id, v.department ?? '', v.tier ?? '', v.role ?? '', v.reportsTo ?? '', v.notes ?? '', t, t);
        if (Object.keys(v).length) this.patchMemberRaw(accountId, id, v, t);
        added.push(id);
      }
      if (added.length || already.length) this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(t, accountId);
    });
    return { added, already, unknown };
  }

  private validateMember(accountId: string, p: MemberPatch, selfId?: string): MemberPatch {
    const out: MemberPatch = {};
    if (p.department !== undefined) {
      if (p.department !== '' && !DEPARTMENTS.includes(p.department)) throw new AccountError(`department must be one of: ${DEPARTMENTS.join(', ')} (or "" for automatic)`);
      out.department = p.department;
    }
    if (p.tier !== undefined) {
      if (p.tier !== '' && !TIERS.includes(p.tier)) throw new AccountError(`tier must be one of: ${TIERS.join(', ')} (or "" for automatic)`);
      out.tier = p.tier;
    }
    if (p.role !== undefined) {
      if (p.role !== '' && !COMMITTEE_ROLES.includes(p.role)) throw new AccountError(`role must be one of: ${COMMITTEE_ROLES.join(', ')} (or "" for none)`);
      out.role = p.role;
    }
    if (p.reportsTo !== undefined) {
      const r = p.reportsTo ? this.resolveId(String(p.reportsTo)) : '';
      if (r) {
        if (r === selfId) throw new AccountError('someone can’t report to themselves');
        if (!this.db.prepare('SELECT 1 FROM account_members WHERE account_id = ? AND person_id = ?').get(accountId, r)) {
          throw new AccountError('reportsTo must be another person on this account');
        }
        // no cycles: walk up from the proposed manager
        let cur = r;
        for (let i = 0; i < 100 && cur; i++) {
          if (cur === selfId) throw new AccountError('that would make a reporting loop');
          cur = str((this.db.prepare('SELECT reports_to FROM account_members WHERE account_id = ? AND person_id = ?').get(accountId, cur) as Row | undefined)?.reports_to);
        }
      }
      out.reportsTo = r;
    }
    if (p.notes !== undefined) {
      const n = String(p.notes);
      if (n.length > LIMITS.notes) throw new AccountError(`notes are too long (max ${LIMITS.notes.toLocaleString()} chars)`);
      out.notes = n;
    }
    if (p.subfunction !== undefined) {
      if (p.subfunction !== '' && !SUBFUNCTIONS.includes(p.subfunction)) throw new AccountError(`subfunction must be one of: ${SUBFUNCTIONS.join(', ')} (or "" for automatic)`);
      out.subfunction = p.subfunction;
    }
    for (const k of ['team', 'entity', 'responsibilities'] as const) {
      if (p[k] === undefined) continue;
      const v = String(p[k]).trim();
      if (v.length > LIMITS[k]) throw new AccountError(`${k} is too long (max ${LIMITS[k].toLocaleString()} chars)`);
      out[k] = v;
    }
    if (p.country !== undefined) {
      const c = String(p.country).trim().toUpperCase();
      if (c && !/^[A-Z]{2}$/.test(c)) throw new AccountError('country must be a two-letter ISO code (e.g. DE) or ""');
      out.country = c;
    }
    if (p.reportsToSource !== undefined) {
      if (p.reportsToSource !== 'auto') throw new AccountError('reportsToSource can only be "auto" (hand the reporting line back to automatic)');
      if (p.reportsTo !== undefined) throw new AccountError('send either reportsTo or reportsToSource: "auto", not both');
      out.reportsToSource = 'auto';
    }
    if (p.noise !== undefined) {
      if (p.noise !== '' && p.noise !== 'none' && !NOISE_FLAGS.includes(p.noise)) {
        throw new AccountError(`noise must be one of: ${NOISE_FLAGS.join(', ')}, "none" (not noise) or "" for automatic`);
      }
      out.noise = p.noise;
    }
    return out;
  }

  private patchMemberRaw(accountId: string, id: string, v: MemberPatch, t: string): void {
    const sets: string[] = [];
    const args: string[] = [];
    const col = {
      department: 'department', tier: 'tier', role: 'role', reportsTo: 'reports_to', notes: 'notes', subfunction: 'subfunction',
      team: 'team', entity: 'entity', country: 'country', responsibilities: 'responsibilities', noise: 'noise',
    } as const;
    for (const [k, c] of Object.entries(col) as [keyof MemberPatch, string][]) {
      if (v[k] !== undefined) {
        sets.push(`${c} = ?`);
        args.push(String(v[k]));
      }
    }
    // a reporting line set (or cleared) here is the user's decision: AI/web suggestions never override it
    if (v.reportsTo !== undefined) sets.push("reports_to_source = 'user'", 'reports_to_confidence = 1', "reports_to_reason = ''");
    if (v.reportsToSource === 'auto') sets.push("reports_to = ''", "reports_to_source = ''", 'reports_to_confidence = NULL', "reports_to_reason = ''");
    if (!sets.length) return;
    this.db.prepare(`UPDATE account_members SET ${sets.join(', ')}, updated_at = ? WHERE account_id = ? AND person_id = ?`).run(...args, t, accountId, id);
  }

  updateMember(accountId: string, rawId: string, p: MemberPatch): AccountMemberRow {
    const id = this.resolveId(rawId);
    if (!this.db.prepare('SELECT 1 FROM account_members WHERE account_id = ? AND person_id = ?').get(accountId, id)) {
      throw new AccountError('that person isn’t on this account');
    }
    const v = this.validateMember(accountId, p, id);
    const t = now();
    this.tx(() => {
      this.patchMemberRaw(accountId, id, v, t);
      this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(t, accountId);
    });
    return this.members(accountId).find((m) => m.personId === id)!;
  }

  removeMember(accountId: string, id: string): boolean {
    return this.tx(() => {
      const n = this.db.prepare('DELETE FROM account_members WHERE account_id = ? AND person_id = ?').run(accountId, id).changes;
      if (n) {
        // anyone who reported to them now has no known manager
        this.db
          .prepare(`UPDATE account_members SET reports_to = '', reports_to_source = '', reports_to_confidence = NULL, reports_to_reason = ''
            WHERE account_id = ? AND reports_to = ?`)
          .run(accountId, id);
        this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(now(), accountId);
      }
      return n > 0;
    });
  }

  // ---------- v9: reporting-line provenance ----------
  private memberRow(accountId: string, id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM account_members WHERE account_id = ? AND person_id = ?').get(accountId, id) as Row | undefined;
  }

  /** the user accepts a suggested (inferred / web) reporting line → it becomes theirs */
  confirmReportsTo(accountId: string, id: string): AccountMemberRow {
    const r = this.memberRow(accountId, id);
    if (!r) throw new AccountError('that person isn’t on this account');
    if (!str(r.reports_to)) throw new AccountError('there is no reporting line to confirm');
    if (str(r.reports_to_source) !== 'user') {
      const t = now();
      this.tx(() => {
        this.db
          .prepare("UPDATE account_members SET reports_to_source = 'user', reports_to_confidence = 1, updated_at = ? WHERE account_id = ? AND person_id = ?")
          .run(t, accountId, id);
        this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(t, accountId);
      });
    }
    return this.toMember(this.memberRow(accountId, id)!);
  }

  /**
   * Store a suggested manager ('' clears a suggestion). No-op (false) when the user set this person's reporting line;
   * same validation as a manual edit (same account, no self, no cycles).
   */
  applyInferredReportsTo(accountId: string, id: string, managerId: string, conf: number | null, reason: string, source: 'inferred' | 'web'): boolean {
    const r = this.memberRow(accountId, id);
    if (!r) throw new AccountError('that person isn’t on this account');
    if (str(r.reports_to_source) === 'user') return false;
    if (source !== 'inferred' && source !== 'web') throw new AccountError('source must be inferred or web');
    const v = this.validateMember(accountId, { reportsTo: managerId }, id);
    const c = num01(conf);
    if (c !== null && (c < 0 || c > 1)) throw new AccountError('confidence must be between 0 and 1');
    this.db
      .prepare(`UPDATE account_members SET reports_to = ?, reports_to_source = ?, reports_to_confidence = ?, reports_to_reason = ?, updated_at = ?
        WHERE account_id = ? AND person_id = ?`)
      .run(v.reportsTo ?? '', v.reportsTo ? source : '', v.reportsTo ? c : null, v.reportsTo ? clip(reason, 500) : '', now(), accountId, id);
    return true;
  }

  /**
   * Store the last AI classification per member (`inference_json` only — the user's own columns are never touched and
   * win at view time). Unknown ids are skipped. Returns how many members were updated.
   */
  applyInference(accountId: string, results: Iterable<[string, MemberInference]>): number {
    if (!this.get(accountId)) throw new AccountError('no such account');
    const t = now();
    return this.tx(() => {
      let n = 0;
      const upd = this.db.prepare('UPDATE account_members SET inference_json = ?, updated_at = ? WHERE account_id = ? AND person_id = ?');
      for (const [id, inf] of results) n += Number(upd.run(JSON.stringify(inf), t, accountId, this.resolveId(id)).changes);
      if (n) this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(t, accountId);
      return n;
    });
  }

  /**
   * Record what web research found about a member without touching anything the user set: entity / country /
   * sub-function fill only BLANK fields of the stored inference (user columns win at view time anyway), and the
   * member's `confidence` (in this org / role now) only ever goes up. Returns false when the person isn't a member.
   */
  applyWebFindings(
    accountId: string,
    rawId: string,
    f: { entity?: string; country?: string; subfunction?: Subfunction | ''; confidence?: number | null; at?: string },
  ): boolean {
    const id = this.resolveId(rawId);
    const r = this.memberRow(accountId, id);
    if (!r) return false;
    const inf = json<MemberInference>(r.inference_json, {} as MemberInference) ?? ({} as MemberInference);
    const next: MemberInference = { ...inf };
    const entity = clip(f.entity, LIMITS.entity);
    const country = /^[A-Z]{2}$/.test(f.country ?? '') ? f.country! : '';
    if (entity && !next.entity) next.entity = entity;
    if (country && !next.country) next.country = country;
    if (f.subfunction && SUBFUNCTIONS.includes(f.subfunction) && !next.subfunction) next.subfunction = f.subfunction;
    const changedInf = JSON.stringify(next) !== JSON.stringify(inf);
    if (changedInf && !next.at) next.at = f.at || now();
    if (changedInf && !next.model) next.model = 'web';
    const c = num01(f.confidence);
    const cur = num01(r.confidence);
    const conf = c !== null && c >= 0 && c <= 1 && (cur === null || c > cur) ? c : cur;
    if (!changedInf && conf === cur) return true;
    this.db
      .prepare('UPDATE account_members SET inference_json = ?, confidence = ?, updated_at = ? WHERE account_id = ? AND person_id = ?')
      .run(changedInf ? JSON.stringify(next) : str(r.inference_json), conf, now(), accountId, id);
    return true;
  }

  /**
   * Replace AI-suggested reporting lines for `ids` in one transaction: their earlier `inferred` lines are cleared, then
   * `edges` applied (managerId null = no suggestion). Lines set by the user — or found on the web — are never touched;
   * an edge that fails validation (other account, loop) is skipped. → {applied, skipped}
   */
  replaceInferredReportsTo(
    accountId: string,
    ids: string[],
    edges: { id: string; managerId: string | null; confidence: number; reason: string }[],
  ): { applied: number; skipped: string[] } {
    if (!this.get(accountId)) throw new AccountError('no such account');
    const skipped: string[] = [];
    let applied = 0;
    this.tx(() => {
      const protectedLine = (id: string) => ['user', 'web'].includes(str(this.memberRow(accountId, id)?.reports_to_source));
      for (const id of ids) {
        const r = this.memberRow(accountId, id);
        if (r && str(r.reports_to_source) === 'inferred') this.applyInferredReportsTo(accountId, id, '', null, '', 'inferred');
      }
      for (const e of edges) {
        if (!e.managerId || !this.memberRow(accountId, e.id) || protectedLine(e.id)) continue;
        try {
          if (this.applyInferredReportsTo(accountId, e.id, e.managerId, e.confidence, e.reason, 'inferred')) applied++;
        } catch (err) {
          if (!(err instanceof AccountError)) throw err;
          skipped.push(e.id);
        }
      }
      if (applied || ids.length) this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(now(), accountId);
    });
    return { applied, skipped };
  }

  // ---------- v9: light contacts + identity ----------
  /** members of an account with the name / title / URL / kind to match new rows against */
  private memberIdentities(accountId: string): { id: string; name: string; title: string; url: string; kind: string }[] {
    return (
      this.db
        .prepare(`SELECT m.person_id AS id, c.full_name AS cn, c.title AS ct, c.headline AS ch, c.url AS cu, c.kind AS ck,
            p.full_name AS pn, p.title AS pt, p.url AS pu
          FROM account_members m LEFT JOIN contacts c ON c.id = m.person_id LEFT JOIN people p ON p.id = m.person_id
          WHERE m.account_id = ?`)
        .all(accountId) as Row[]
    ).map((r) => ({
      id: str(r.id),
      name: str(r.cn) || str(r.pn),
      title: str(r.ct) || str(r.ch) || str(r.pt),
      url: str(r.cu) || str(r.pu),
      kind: r.ck === null || r.ck === undefined ? 'connection' : str(r.ck),
    }));
  }

  /** record where we saw this member (deduped by kind + url + runId) */
  addMemberSources(accountId: string, id: string, add: SourceRef[]): void {
    this.appendMemberSources(accountId, this.resolveId(id), add, now());
  }

  private appendMemberSources(accountId: string, id: string, add: SourceRef[], t: string): void {
    const r = this.memberRow(accountId, id);
    if (!r) return;
    const cur = json<SourceRef[]>(r.sources_json, []);
    const next = mergeSources(cur, add);
    if (next.length === cur.length) return;
    this.db.prepare('UPDATE account_members SET sources_json = ?, updated_at = ? WHERE account_id = ? AND person_id = ?').run(JSON.stringify(next), t, accountId, id);
  }

  private appendContactSources(id: string, add: SourceRef[]): void {
    const r = this.db.prepare('SELECT sources_json FROM contacts WHERE id = ?').get(id) as Row | undefined;
    if (!r) return;
    const cur = json<SourceRef[]>(r.sources_json, []);
    const next = mergeSources(cur, add);
    if (next.length !== cur.length) this.db.prepare('UPDATE contacts SET sources_json = ? WHERE id = ?').run(JSON.stringify(next), id);
  }

  /** fill blank title / headline / location (never overwrites anything, so a full capture is never downgraded) */
  private fillContactBlanks(id: string, f: { title: string; headline: string; location: string; url?: string }): void {
    const r = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Row | undefined;
    if (!r) return;
    const next = {
      title: str(r.title) || f.title,
      headline: str(r.headline) || f.headline,
      location: str(r.location) || f.location,
      url: str(r.url) || f.url || '',
    };
    if (next.title === str(r.title) && next.headline === str(r.headline) && next.location === str(r.location) && next.url === str(r.url)) return;
    let profile = str(r.profile_json);
    if (str(r.kind) === 'light') {
      const p = json<CapturedProfile>(profile, {} as CapturedProfile);
      profile = JSON.stringify({ ...p, url: p.url || next.url, title: p.title || next.title, headline: p.headline || next.headline, location: p.location || next.location });
    }
    this.db
      .prepare('UPDATE contacts SET title = ?, headline = ?, location = ?, url = ?, profile_json = ? WHERE id = ?')
      .run(next.title, next.headline, next.location, next.url, profile, id);
  }

  /**
   * kind='light' only: overwrite name / title / headline / company / location with the non-empty values of a newer
   * list sighting. Skipped for anyone added by hand (a `manual` source: the user typed those values) and when this
   * run started before the run of the contact's newest list sighting (a late Retry of an old run never wins).
   */
  private refreshLightContact(id: string, f: { fullName: string; title: string; headline: string; company: string; location: string }, runId?: string): void {
    const r = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Row | undefined;
    if (!r || str(r.kind) !== 'light') return;
    const srcs = json<SourceRef[]>(r.sources_json, []);
    if (srcs.some((s) => s.kind === 'manual')) return;
    const started = (rid?: string) => (rid ? this.getListRun(rid)?.startedAt ?? '' : '');
    const mine = started(runId);
    const newest = srcs.filter((s) => s.kind === 'extension-list' && s.runId && s.runId !== runId).map((s) => started(s.runId)).sort().pop() ?? '';
    if (mine && newest && mine < newest) return;
    const next = {
      full_name: f.fullName || str(r.full_name),
      title: f.title || str(r.title),
      headline: f.headline || str(r.headline),
      company: f.company || str(r.company),
      location: f.location || str(r.location),
    };
    if ((Object.keys(next) as (keyof typeof next)[]).every((k) => next[k] === str(r[k]))) return;
    const p = json<CapturedProfile>(str(r.profile_json), {} as CapturedProfile);
    const profile = { ...p, fullName: next.full_name, title: next.title, headline: next.headline, company: next.company, location: next.location };
    this.db
      .prepare('UPDATE contacts SET full_name = ?, title = ?, headline = ?, company = ?, location = ?, profile_json = ? WHERE id = ?')
      .run(next.full_name, next.title, next.headline, next.company, next.location, JSON.stringify(profile), id);
  }

  /**
   * File people seen in a list (or typed in by hand) under an account without a full profile. Idempotent: the same
   * rows again add nothing. Per row: (1) a known profile URL (aliases followed; connections matched) → that person;
   * (2) else exactly one member of this account with the same name and a compatible title → that member (a new URL
   * becomes an alias); (3) else a new `light` contact. Existing contacts only get blanks filled — except a `light` contact seen again in a
   * LinkedIn list (`extension-list`), whose name / title / headline / company / location take the newest values.
   * `matchNameOnly` (web research): in step 2 a single same-name member matches whatever its title.
   */
  upsertLightContacts(accountId: string, inputs: LightContactInput[], opts: { matchNameOnly?: boolean } = {}): LightUpsertResult {
    if (!this.get(accountId)) throw new AccountError('no such account');
    const out: LightUpsertResult = { added: [], updated: [], merged: [], skipped: [], warnings: [] };
    this.tx(() => {
      const t = now();
      const done = new Set<string>();
      for (const input of inputs) {
        const name = clip(input?.fullName, LIMITS.personName);
        if (!name) {
          out.skipped.push({ input, reason: 'missing name' });
          continue;
        }
        if (!input.source || !SOURCE_KINDS.includes(input.source.kind)) {
          out.skipped.push({ input, reason: 'missing or unknown source' });
          continue;
        }
        const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
        const ref = rawUrl ? profileRef(rawUrl) : null;
        if (rawUrl && !ref) {
          out.skipped.push({ input, reason: 'not a LinkedIn profile URL' });
          continue;
        }
        const headline = clip(input.headline, LIMITS.headline);
        const sp = splitHeadline(headline);
        const title = clip(input.title, LIMITS.title) || sp.title.slice(0, LIMITS.title);
        const company = clip(input.company, LIMITS.company) || sp.company.slice(0, LIMITS.company);
        const location = clip(input.location, LIMITS.location);
        const source: SourceRef = { ...input.source, at: input.source.at || t };

        let id = '';
        let byName = false;
        let dupOf: string[] = [];
        if (ref) {
          const hit = this.idForProfileUrl(ref.url).id;
          if (this.knownPerson(hit)) id = hit;
        } else {
          const nid = this.resolveId(personId('', name, accountId));
          if (this.knownPerson(nid)) id = nid;
        }
        if (!id) {
          const named = this.memberIdentities(accountId).filter((m) => sameName(m.name, name) && !profileUrlsConflict(m.url, ref?.url ?? ''));
          // web research: titles are worded differently from LinkedIn ("CMO" vs "Chief Marketing Officer"), so the one
          // member with that name is the person; otherwise titles must be compatible
          const cands =
            opts.matchNameOnly && named.length === 1 ? named : named.filter((m) => titlesCompatible(m.title, title || headline));
          if (cands.length === 1) {
            id = cands[0]!.id;
            byName = true;
            if (ref && ref.id !== id) this.addAlias(ref.id, id, ref.url);
          } else if (cands.length > 1) {
            dupOf = cands.map((c) => c.id);
          } else if (opts.matchNameOnly && named.length > 1) {
            dupOf = named.map((c) => c.id); // several members share the name: can't tell which one the web means
          }
        }
        const wasMember = Boolean(id && this.memberRow(accountId, id));
        if (!id) {
          id = ref ? ref.id : personId('', name, accountId);
          const profile: CapturedProfile = {
            url: ref?.url ?? '', fullName: name, headline, location, title, company, companyUrl: '', about: '', experience: [],
            education: [], other: {}, rawText: '',
          };
          this.db
            .prepare(`INSERT INTO contacts (id, url, full_name, headline, title, company, location, profile_json, captured_at, capture_count, kind, sources_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'light', ?)`)
            .run(id, ref?.url ?? '', name, headline, title, company, location, JSON.stringify(profile), t, JSON.stringify([source]));
          if (dupOf.length) out.warnings.push({ id, reason: `possible duplicate of ${dupOf.join(', ')}` });
        } else {
          // a light contact seen again in a LinkedIn list: the newest sighting wins (fixes fields from older, messier
          // parses); full captures, connections and web / manual rows only get blanks filled
          if (source.kind === 'extension-list') this.refreshLightContact(id, { fullName: name, title, headline, company, location }, source.runId);
          this.fillContactBlanks(id, { title, headline, location, url: ref?.url });
          this.appendContactSources(id, [source]);
        }
        if (!wasMember) {
          this.db
            .prepare(`INSERT INTO account_members (account_id, person_id, added_at, updated_at, sources_json) VALUES (?, ?, ?, ?, ?)`)
            .run(accountId, id, t, t, JSON.stringify([source]));
        } else {
          this.appendMemberSources(accountId, id, [source], t);
        }
        if (done.has(id)) continue; // the same person twice in one batch: report once
        done.add(id);
        (wasMember ? (byName ? out.merged : out.updated) : out.added).push(id);
      }
      if (out.added.length || out.updated.length || out.merged.length) this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(t, accountId);
    });
    return out;
  }

  /**
   * Fold a light contact into another person (a full capture or a connection): memberships move (where both are on an
   * account, values set on `into` win, then non-empty ones from `from`; sources are unioned), reporting lines that
   * pointed at `from` point at `into`, and `from`'s id/URL become aliases. Never merges two full contacts.
   */
  mergeContacts(fromId: string, intoId: string): { warnings: string[] } {
    const from = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(fromId) as Row | undefined;
    if (!from) throw new AccountError('no such contact to merge');
    if (str(from.kind) !== 'light') throw new AccountError('only a light contact can be merged into another person');
    if (fromId === intoId) return { warnings: [] };
    if (!this.knownPerson(intoId)) throw new AccountError('no such person to merge into');
    const into = this.resolveId(intoId);
    const warnings: string[] = [];
    this.tx(() => {
      const t = now();
      const fields = ['department', 'tier', 'role', 'notes', 'subfunction', 'team', 'entity', 'country', 'responsibilities', 'noise', 'inference_json'] as const;
      const touched = new Set<string>();
      for (const fm of this.db.prepare('SELECT * FROM account_members WHERE person_id = ?').all(fromId) as Row[]) {
        const acc = str(fm.account_id);
        touched.add(acc);
        const im = this.memberRow(acc, into);
        if (!im) {
          this.db.prepare('UPDATE account_members SET person_id = ?, updated_at = ? WHERE account_id = ? AND person_id = ?').run(into, t, acc, fromId);
          continue;
        }
        const merged: Record<string, unknown> = {};
        for (const f of fields) merged[f] = str(im[f]) || str(fm[f]);
        // the full member's line wins when the user set (or deliberately cleared) it; else a user line on the light row,
        // else whichever row has a line
        const fmUsable = Boolean(str(fm.reports_to)) && str(fm.reports_to) !== into;
        const rt =
          str(im.reports_to_source) === 'user'
            ? im
            : fmUsable && (str(fm.reports_to_source) === 'user' || !str(im.reports_to))
              ? fm
              : im;
        this.db
          .prepare(`UPDATE account_members SET ${fields.map((f) => `${f} = ?`).join(', ')}, reports_to = ?, reports_to_source = ?,
              reports_to_confidence = ?, reports_to_reason = ?, sources_json = ?, confidence = ?, added_at = ?, updated_at = ?
            WHERE account_id = ? AND person_id = ?`)
          .run(
            ...fields.map((f) => merged[f] as string),
            str(rt.reports_to), str(rt.reports_to_source), num01(rt.reports_to_confidence), str(rt.reports_to_reason),
            JSON.stringify(mergeSources(json<SourceRef[]>(im.sources_json, []), json<SourceRef[]>(fm.sources_json, []))),
            num01(im.confidence) ?? num01(fm.confidence),
            str(im.added_at) < str(fm.added_at) ? str(im.added_at) : str(fm.added_at), t, acc, into,
          );
        this.db.prepare('DELETE FROM account_members WHERE account_id = ? AND person_id = ?').run(acc, fromId);
      }
      // reporting lines that pointed at the light contact now point at the person
      for (const r of this.db.prepare('SELECT account_id FROM account_members WHERE reports_to = ?').all(fromId) as Row[]) touched.add(str(r.account_id));
      this.db.prepare('UPDATE account_members SET reports_to = ? WHERE reports_to = ?').run(into, fromId);
      this.db
        .prepare(`UPDATE account_members SET reports_to = '', reports_to_source = '', reports_to_confidence = NULL, reports_to_reason = ''
          WHERE person_id = reports_to`)
        .run();
      for (const acc of touched) warnings.push(...this.breakCycles(acc));
      // aliases: the light id (and its URL's id) now resolve to `into`
      this.db.prepare('UPDATE contact_aliases SET contact_id = ? WHERE contact_id = ?').run(into, fromId);
      this.addAlias(fromId, into, str(from.url));
      const ref = str(from.url) ? profileRef(str(from.url)) : null;
      if (ref) this.addAlias(ref.id, into, ref.url);
      this.appendContactSources(into, json<SourceRef[]>(from.sources_json, []));
      this.db.prepare('UPDATE contact_captures SET contact_id = ? WHERE contact_id = ?').run(into, fromId);
      this.db.prepare('DELETE FROM contacts WHERE id = ?').run(fromId);
    });
    return { warnings };
  }

  /** clear (non-user first) reporting lines that close a loop — only possible after a merge */
  private breakCycles(accountId: string): string[] {
    const warnings: string[] = [];
    const rows = this.db.prepare('SELECT person_id, reports_to, reports_to_source FROM account_members WHERE account_id = ?').all(accountId) as Row[];
    const up = new Map(rows.map((r) => [str(r.person_id), str(r.reports_to)]));
    const src = new Map(rows.map((r) => [str(r.person_id), str(r.reports_to_source)]));
    for (const start of up.keys()) {
      const path: string[] = [];
      let cur = start;
      while (cur && !path.includes(cur) && path.length < 500) {
        path.push(cur);
        cur = up.get(cur) ?? '';
      }
      if (!cur || !path.includes(cur)) continue;
      const loop = path.slice(path.indexOf(cur));
      const nonUser = loop.find((p) => src.get(p) !== 'user');
      const victim = nonUser ?? loop[0]!;
      if (!nonUser) warnings.push(`merging made a reporting loop from your own lines (${loop.join(' → ')}); cleared ${victim}’s manager`);
      this.db
        .prepare(`UPDATE account_members SET reports_to = '', reports_to_source = '', reports_to_confidence = NULL, reports_to_reason = ''
          WHERE account_id = ? AND person_id = ?`)
        .run(accountId, victim);
      up.set(victim, '');
    }
    return warnings;
  }

  // ---------- v9: headcounts, list runs, anonymous rows, org facts ----------
  private toHeadcount(r: Row): HeadcountSnapshot {
    return {
      id: Number(r.id), accountId: str(r.account_id), takenAt: str(r.taken_at), source: str(r.source) as HeadcountSource,
      scope: str(r.scope) as HeadcountScope, label: str(r.label), count: Number(r.count), url: str(r.url),
      evidenceUrl: str(r.evidence_url), quote: str(r.quote), confidence: num01(r.confidence), runId: str(r.run_id),
    };
  }

  addHeadcount(
    accountId: string,
    h: { source: HeadcountSource; scope: HeadcountScope; count: number; label?: string; url?: string; evidenceUrl?: string; quote?: string; confidence?: number | null; runId?: string; takenAt?: string },
  ): HeadcountSnapshot {
    if (!this.get(accountId)) throw new AccountError('no such account');
    if (!HEADCOUNT_SOURCES.includes(h.source)) throw new AccountError(`source must be one of: ${HEADCOUNT_SOURCES.join(', ')}`);
    if (!HEADCOUNT_SCOPES.includes(h.scope)) throw new AccountError(`scope must be one of: ${HEADCOUNT_SCOPES.join(', ')}`);
    if (!Number.isInteger(h.count) || h.count < 0) throw new AccountError('count must be a whole number ≥ 0');
    const c = num01(h.confidence);
    if (c !== null && (c < 0 || c > 1)) throw new AccountError('confidence must be between 0 and 1');
    const r = this.db
      .prepare(`INSERT INTO account_headcounts (account_id, taken_at, source, scope, label, count, url, evidence_url, quote, confidence, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(accountId, h.takenAt || now(), h.source, h.scope, clip(h.label, 200), h.count, clip(h.url, LIMITS.url), clip(h.evidenceUrl, LIMITS.url),
        clip(h.quote, LIMITS.quote), c, clip(h.runId, 100));
    return this.toHeadcount(this.db.prepare('SELECT * FROM account_headcounts WHERE id = ?').get(Number(r.lastInsertRowid)) as Row);
  }

  /** oldest first */
  headcounts(accountId: string): HeadcountSnapshot[] {
    return (this.db.prepare('SELECT * FROM account_headcounts WHERE account_id = ? ORDER BY taken_at, id').all(accountId) as Row[]).map((r) => this.toHeadcount(r));
  }

  private toListRun(r: Row): ListRun {
    return {
      id: str(r.id), accountId: str(r.account_id), pageKind: str(r.page_kind) as ListPageKind, url: str(r.url), keywords: str(r.keywords),
      startedAt: str(r.started_at), finishedAt: str(r.finished_at), rowsSeen: Number(r.rows_seen) || 0, named: Number(r.named) || 0,
      anonymous: Number(r.anonymous) || 0, stopReason: str(r.stop_reason) as ListStopReason | '',
    };
  }

  getListRun(runId: string): ListRun | undefined {
    const r = this.db.prepare('SELECT * FROM account_list_runs WHERE id = ?').get(runId) as Row | undefined;
    return r ? this.toListRun(r) : undefined;
  }

  /** `id`: the run id chosen by the extension (a UUID), else a new one */
  startListRun(accountId: string, p: { pageKind: ListPageKind; url: string; keywords?: string; id?: string }): ListRun {
    if (!this.get(accountId)) throw new AccountError('no such account');
    if (!LIST_PAGE_KINDS.includes(p.pageKind)) throw new AccountError(`pageKind must be one of: ${LIST_PAGE_KINDS.join(', ')}`);
    if (p.id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id)) throw new AccountError('run id must be a UUID');
    if (p.id && this.getListRun(p.id)) throw new AccountError('that list run already exists');
    const id = p.id ? p.id.toLowerCase() : randomUUID();
    this.db
      .prepare('INSERT INTO account_list_runs (id, account_id, page_kind, url, keywords, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, accountId, p.pageKind, clip(p.url, LIMITS.url), clip(p.keywords, 200), now());
    return this.getListRun(id)!;
  }

  updateListRun(runId: string, p: { rowsSeen?: number; named?: number; anonymous?: number; finishedAt?: string; stopReason?: ListStopReason | '' }): ListRun {
    if (!this.getListRun(runId)) throw new AccountError('no such list run');
    const sets: string[] = [];
    const args: (string | number)[] = [];
    for (const [k, c] of [['rowsSeen', 'rows_seen'], ['named', 'named'], ['anonymous', 'anonymous']] as const) {
      if (p[k] === undefined) continue;
      if (!Number.isInteger(p[k]) || p[k]! < 0) throw new AccountError(`${k} must be a whole number ≥ 0`);
      sets.push(`${c} = ?`);
      args.push(p[k]!);
    }
    if (p.stopReason !== undefined) {
      if (p.stopReason !== '' && !LIST_STOP_REASONS.includes(p.stopReason)) throw new AccountError(`stopReason must be one of: ${LIST_STOP_REASONS.join(', ')}`);
      sets.push('stop_reason = ?');
      args.push(p.stopReason);
    }
    if (p.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      args.push(String(p.finishedAt));
    }
    if (sets.length) this.db.prepare(`UPDATE account_list_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args, runId);
    return this.getListRun(runId)!;
  }

  /** newest first */
  listRuns(accountId: string): ListRun[] {
    return (this.db.prepare('SELECT * FROM account_list_runs WHERE account_id = ? ORDER BY started_at DESC, id').all(accountId) as Row[]).map((r) => this.toListRun(r));
  }

  /** distinct members of the account that a list run saw (their member sources carry the run id) */
  runMemberCount(accountId: string, runId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM account_members WHERE account_id = ? AND instr(sources_json, ?) > 0`)
      .get(accountId, `"runId":${JSON.stringify(runId)}`) as Row;
    return Number(r.n) || 0;
  }

  anonCount(runId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM account_anon_rows WHERE run_id = ?').get(runId) as Row).n) || 0;
  }

  /** replace one run's headcount rows of the given scopes (a re-post of the same run's header / facets) — one tx */
  replaceRunHeadcounts(
    accountId: string,
    runId: string,
    scopes: HeadcountScope[],
    rows: Parameters<AccountsRepo['addHeadcount']>[1][],
  ): HeadcountSnapshot[] {
    if (!runId) throw new AccountError('run id is required');
    const out: HeadcountSnapshot[] = [];
    this.tx(() => {
      for (const sc of scopes) this.db.prepare('DELETE FROM account_headcounts WHERE account_id = ? AND run_id = ? AND scope = ?').run(accountId, runId, sc);
      for (const r of rows) out.push(this.addHeadcount(accountId, { ...r, runId }));
    });
    return out;
  }

  /** idempotent by (run, idx) → how many were new */
  addAnonRows(runId: string, rows: { idx: number; headline?: string; location?: string }[]): number {
    if (!this.getListRun(runId)) throw new AccountError('no such list run');
    let n = 0;
    this.tx(() => {
      const st = this.db.prepare('INSERT OR IGNORE INTO account_anon_rows (run_id, idx, headline, location) VALUES (?, ?, ?, ?)');
      for (const r of rows) {
        if (!Number.isInteger(r.idx) || r.idx < 0) throw new AccountError('idx must be a whole number ≥ 0');
        n += Number(st.run(runId, r.idx, clip(r.headline, LIMITS.headline), clip(r.location, LIMITS.location)).changes);
      }
    });
    return n;
  }

  anonRows(runId: string): AnonRow[] {
    return (this.db.prepare('SELECT * FROM account_anon_rows WHERE run_id = ? ORDER BY idx').all(runId) as Row[]).map((r) => ({
      runId: str(r.run_id), idx: Number(r.idx), headline: str(r.headline), location: str(r.location),
    }));
  }

  /** web/user org facts; each needs an http(s) evidence URL; exact duplicates (kind + text + evidence URL) are skipped */
  addOrgFacts(
    accountId: string,
    facts: { kind: OrgFactKind; text: string; evidenceUrl: string; quote?: string; confidence?: number | null; runId?: string; foundAt?: string }[],
  ): { added: number; duplicates: number } {
    if (!this.get(accountId)) throw new AccountError('no such account');
    let added = 0;
    let duplicates = 0;
    this.tx(() => {
      for (const f of facts) {
        if (!ORG_FACT_KINDS.includes(f.kind)) throw new AccountError(`kind must be one of: ${ORG_FACT_KINDS.join(', ')}`);
        const text = clip(f.text, LIMITS.factText);
        if (!text) throw new AccountError('fact text is required');
        const ev = clip(f.evidenceUrl, LIMITS.url);
        if (!/^https?:\/\/\S+$/i.test(ev)) throw new AccountError('evidenceUrl must be an http(s) URL');
        const c = num01(f.confidence);
        if (c !== null && (c < 0 || c > 1)) throw new AccountError('confidence must be between 0 and 1');
        if (this.db.prepare('SELECT 1 FROM account_org_facts WHERE account_id = ? AND kind = ? AND text = ? AND evidence_url = ?').get(accountId, f.kind, text, ev)) {
          duplicates++;
          continue;
        }
        this.db
          .prepare('INSERT INTO account_org_facts (account_id, kind, text, evidence_url, quote, confidence, found_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(accountId, f.kind, text, ev, clip(f.quote, LIMITS.quote), c, f.foundAt || now(), clip(f.runId, 100));
        added++;
      }
    });
    return { added, duplicates };
  }

  orgFacts(accountId: string): OrgFact[] {
    return (this.db.prepare('SELECT * FROM account_org_facts WHERE account_id = ? ORDER BY found_at, id').all(accountId) as Row[]).map((r) => ({
      id: Number(r.id), accountId: str(r.account_id), kind: str(r.kind) as OrgFactKind, text: str(r.text), evidenceUrl: str(r.evidence_url),
      quote: str(r.quote), confidence: num01(r.confidence), foundAt: str(r.found_at), runId: str(r.run_id),
    }));
  }
}
