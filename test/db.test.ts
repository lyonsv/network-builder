import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbProfileCache, dbRunCache, importLegacy, LEGACY_IMPORT_FLAG, openStore, Store, withLedger } from '../src/db';
import { SCHEMA_VERSION } from '../src/db/schema';
import { computeProfileKey, computeResearchKey } from '../src/io/cache';
import { createCostTracker } from '../src/llm/costs';
import { buildRankPrompt } from '../src/llm/rank';
import { buildResearchPrompt } from '../src/llm/research';
import type { Person, Profile, RankedPerson, ReportFile, ResearchRecord, ResearchReport } from '../src/types';

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'nb-db-'));
  store = Store.open(path.join(dir, 'network.db'));
});
afterEach(() => store.close());

const person = (id: string, over: Partial<Person> = {}): Person => ({
  id,
  rowIndex: 1,
  fullName: `Person ${id}`,
  firstName: 'Person',
  lastName: id,
  title: 'Partner at Fund',
  company: '',
  url: `https://www.linkedin.com/in/${id}`,
  email: '',
  connectedOn: '2024-01-02',
  extra: {},
  ...over,
});

const report = (over: Partial<ResearchReport> = {}): ResearchReport => ({
  identityConfirmed: true,
  summary: 'Invests in seed-stage SaaS across Ireland.',
  currentRole: 'Partner, Fund',
  location: 'Dublin, Ireland',
  signals: [{ signal: 'Who is this person?', finding: 'Partner at Fund', strength: 'strong' }],
  fitAssessment: 'Strong.',
  recommendedApproach: 'Warm intro.',
  talkingPoints: ['Recent fund'],
  redFlags: [],
  sources: [{ title: 'Fund team', url: 'https://fund.example/team' }],
  confidence: 'high',
  researchScore: 88,
  ...over,
});

const rec = (id: string, finishedAt: string, over: Partial<ResearchRecord> = {}): ResearchRecord => ({
  id,
  status: 'ok',
  report: report(),
  costUsd: 0.12,
  durationMs: 1000,
  model: 'sonnet',
  signalsHash: 'sig1',
  finishedAt,
  ...over,
});

const profile: Profile = {
  company: 'Fund',
  role: 'Partner',
  seniority: 'partner',
  function: 'investing',
  industry: 'venture capital',
  tags: ['investor', 'vc'],
  region: '',
};

describe('schema', () => {
  it('migrate() is safe to run again inside an already-migrated database', async () => {
    const { migrate } = await import('../src/db/schema');
    migrate(store.db);
    migrate(store.db);
    expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  });

  it('migrates to the latest user_version and is idempotent on reopen', () => {
    const v = store.db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(v.user_version).toBe(SCHEMA_VERSION);
    store.close();
    store = Store.open(path.join(dir, 'network.db'));
    expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  });

  it('uses WAL and foreign keys', () => {
    expect((store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((store.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });
});

describe('people', () => {
  it('upserts: keeps first_seen, refreshes title, keeps email when the new export lacks it', () => {
    store.upsertPeople([person('a', { email: 'a@x.com' })], 'one.csv', '2024-01-01T00:00:00.000Z');
    store.upsertPeople([person('a', { title: 'GP at New Fund', email: '' }), person('b')], 'two.csv', '2025-01-01T00:00:00.000Z');
    const rows = store.db.prepare('SELECT * FROM people ORDER BY id').all() as Record<string, string>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'a', title: 'GP at New Fund', email: 'a@x.com', last_source: 'two.csv' });
    expect(rows[0]!.first_seen).toBe('2024-01-01T00:00:00.000Z');
    expect(rows[0]!.last_seen).toBe('2025-01-01T00:00:00.000Z');
  });

  it('an older observation never overwrites newer data, and blanks never overwrite values', () => {
    store.upsertPeople([person('a', { title: 'CEO at NewCo', url: 'https://l.in/a' })], 'new.csv', '2026-11-01T00:00:00.000Z');
    // serving an older report: older createdAt, stale title, blank url
    store.upsertPeople([person('a', { title: 'Engineer at OldCo', url: '' })], 'old.json', '2026-01-01T00:00:00.000Z');
    let row = store.db.prepare("SELECT * FROM people WHERE id = 'a'").get() as Record<string, string>;
    expect(row).toMatchObject({ title: 'CEO at NewCo', url: 'https://l.in/a', last_source: 'new.csv', last_seen: '2026-11-01T00:00:00.000Z' });
    expect(row.first_seen).toBe('2026-01-01T00:00:00.000Z');
    // a newer observation with a blank url updates the title but keeps the url
    store.upsertPeople([person('a', { title: 'Chair at NewCo', url: '' })], 'newer.csv', '2026-12-01T00:00:00.000Z');
    row = store.db.prepare("SELECT * FROM people WHERE id = 'a'").get() as Record<string, string>;
    expect(row).toMatchObject({ title: 'Chair at NewCo', url: 'https://l.in/a', last_source: 'newer.csv' });
  });
});

describe('legacy import of reports written after the store existed', () => {
  it('does not re-adopt their lists or re-count their spend', async () => {
    const out = path.join(dir, 'out-post');
    await mkdir(out, { recursive: true });
    const rep: ReportFile = {
      meta: {
        version: 1, prompt: 'angels', inputPath: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '', totalPeople: 1,
        rankModel: 'haiku', researchModel: 'sonnet', signalsPath: '', cacheDir: '', outDir: out, stem: 'post', estUsdPerResearch: 0.1,
        costs: { rank: 0.5, research: 0, enrich: 0.3 }, dbPath: '/some/network.db', runKey: 'rk',
      },
      people: [{ ...person('a'), score: 1, fitReason: '', rank: 1, ranked: true }],
      lists: [{ id: 'deleted-list', name: 'Deleted', ids: ['a'], createdAt: '', updatedAt: '' }],
    };
    await writeFile(path.join(out, 'post.json'), JSON.stringify(rep));
    const before = store.stats().spend.total;
    await importLegacy(store, { cacheDir: path.join(dir, 'nocache'), outDir: out });
    await importLegacy(store, { cacheDir: path.join(dir, 'nocache'), outDir: out });
    expect(store.hasList('deleted-list')).toBe(false);
    expect(store.stats().spend.total).toBe(before);
  });
});

describe('research: exact vs prior', () => {
  it('exact key returns the latest ok record; prior returns the latest ok from another key', async () => {
    const cache = dbRunCache(store, 'run1', { prompt: 'angel investors' });
    const kAngel = computeResearchKey('a', 'angel investors', 'sig1', 'sonnet');
    await cache.setResearch(kAngel, rec('a', '2025-01-01T00:00:00.000Z'));
    await cache.setResearch(kAngel, rec('a', '2025-01-02T00:00:00.000Z', { report: report({ researchScore: 91 }) }));
    expect((await cache.getResearch(kAngel))?.report?.researchScore).toBe(91);

    // a different goal has no exact hit, but gets the angel research as prior
    const kHire = computeResearchKey('a', 'senior engineers to hire', 'sig1', 'sonnet');
    expect(await cache.getResearch(kHire)).toBeUndefined();
    const prior = await cache.getPriorResearch!('a', kHire);
    expect(prior).toMatchObject({ prompt: 'angel investors', model: 'sonnet' });
    expect(prior?.report.researchScore).toBe(91);
    // excluding the only key → nothing
    expect(store.getPriorResearch('a', kAngel)).toBeUndefined();
  });

  it('error records are never returned as hits or priors', async () => {
    const cache = dbRunCache(store, 'run1', { prompt: 'g' });
    const k = computeResearchKey('a', 'g', 's', 'sonnet');
    await cache.setResearch(k, rec('a', '2025-01-01T00:00:00.000Z', { status: 'error', report: undefined, error: 'boom' }));
    expect(await cache.getResearch(k)).toBeUndefined();
    expect(store.getPriorResearch('a')).toBeUndefined();
  });

  it('fresh ignores exact research and wipes only this run’s rankings', async () => {
    const c1 = dbRunCache(store, 'run1', { prompt: 'g' });
    await c1.setRanks([{ id: 'a', score: 80, reason: 'r' }]);
    const k = computeResearchKey('a', 'g', 's', 'sonnet');
    await c1.setResearch(k, rec('a', '2025-01-01T00:00:00.000Z'));
    const c2 = dbRunCache(store, 'run1', { prompt: 'g', fresh: true });
    expect(c2.getRank('a')).toBeUndefined();
    expect(await c2.getResearch(k)).toBeUndefined();
    expect(store.getResearchByKey(k)).toBeDefined(); // shared research kept
  });
});

describe('rankings + profiles + ledger', () => {
  it('persists rankings per run and reloads them', async () => {
    const c = dbRunCache(store, 'run1', { prompt: 'g' });
    await c.writeMeta({ runKey: 'run1', inputPath: 'x.csv', prompt: 'g', rankModel: 'haiku', researchModel: 'sonnet', createdAt: '2025-01-01', updatedAt: '2025-01-01', totalPeople: 2 });
    await c.setRanks([{ id: 'a', score: 80, reason: 'r1' }, { id: 'b', score: 10, reason: 'r2' }]);
    const again = dbRunCache(store, 'run1', { prompt: 'g' });
    expect(again.getRank('a')).toEqual({ id: 'a', score: 80, reason: 'r1' });
    expect(store.stats().runs[0]).toMatchObject({ runKey: 'run1', prompt: 'g', ranked: 2 });
  });

  it('stores profiles linked to people', async () => {
    const pc = dbProfileCache(store, 'haiku');
    await pc.set('k1', profile, 'a');
    expect(await pc.get('k1')).toEqual(profile);
    expect(store.latestProfileFor('a')).toEqual(profile);
    expect(store.stats().profiledPeople).toBe(1);
  });

  it('withLedger appends only new spend (not the seed)', () => {
    const base = createCostTracker();
    base.add('rank', 1.5); // seeded before wrapping
    const costs = withLedger(base, store, 'run1');
    costs.add('research', 0.12);
    costs.add('enrich', 0);
    expect(costs.total()).toBeCloseTo(1.62);
    expect(store.stats().spend).toMatchObject({ research: 0.12, rank: 0, enrich: 0 });
  });
});

describe('lists + export', () => {
  it('CRUD keeps member order and finds by id or name', () => {
    const t = '2025-01-01T00:00:00.000Z';
    store.upsertList({ id: 'angels', name: 'Angels Ireland', ids: ['b', 'a', 'b'], createdAt: t, updatedAt: t }, 'angel investors');
    expect(store.findList('angels')?.ids).toEqual(['b', 'a']);
    expect(store.findList('angels ireland')?.prompt).toBe('angel investors');
    store.upsertList({ id: 'angels', name: 'Angels IE', ids: ['a'], createdAt: t, updatedAt: '2025-02-01T00:00:00.000Z' });
    expect(store.findList('angels')).toMatchObject({ name: 'Angels IE', ids: ['a'], prompt: 'angel investors' });
    expect(store.deleteList('angels')).toBe(true);
    expect(store.listLists()).toEqual([]);
  });
});

describe('prompts use prior research', () => {
  const prior = { prompt: 'angel investors', model: 'sonnet', finishedAt: '2025-01-03T00:00:00.000Z', report: report() };

  it('rank prompt includes a digest column only when someone has prior research', () => {
    const plain = buildRankPrompt('hire engineers', [person('a')]);
    expect(plain).not.toContain('earlier web research');
    const withPrior = buildRankPrompt('hire engineers', [{ ...person('a'), priorResearch: prior }, person('b')]);
    expect(withPrior).toContain('earlier web research');
    expect(withPrior).toContain('role: Partner, Fund');
    expect(withPrior).toContain('location: Dublin, Ireland');
    expect(withPrior).toMatch(/p1 \| Person b .* \| -$/m);
  });

  it('research prompt includes prior findings, sources and a lower search budget', () => {
    const p: RankedPerson = { ...person('a'), score: 70, fitReason: 'r', rank: 1, ranked: true };
    const base = buildResearchPrompt('hire engineers', '## Who\nsearch', p);
    expect(base).not.toContain('Earlier research on this person');
    expect(base).toContain('about 8 searches');
    const out = buildResearchPrompt('hire engineers', '## Who\nsearch', { ...p, priorResearch: prior });
    expect(out).toContain('Earlier research on this person');
    expect(out).toContain('for a DIFFERENT goal: "angel investors"');
    expect(out).toContain('https://fund.example/team');
    expect(out).toContain('about 4 searches');
  });
});

describe('legacy import', () => {
  it('imports reports, run caches, research and profiles once, without overwriting', async () => {
    const cacheDir = path.join(dir, '.cache');
    const outDir = path.join(dir, 'outputs');
    await mkdir(path.join(cacheDir, 'run1'), { recursive: true });
    await mkdir(path.join(cacheDir, 'research'), { recursive: true });
    await mkdir(path.join(cacheDir, 'profiles'), { recursive: true });
    await mkdir(outDir, { recursive: true });

    const prompt = 'angel investors';
    await writeFile(path.join(cacheDir, 'run1', 'meta.json'), JSON.stringify({ runKey: 'run1', inputPath: 'x.csv', prompt, rankModel: 'haiku', researchModel: 'sonnet', createdAt: '2025-01-01', updatedAt: '2025-01-01', totalPeople: 2 }));
    await writeFile(path.join(cacheDir, 'run1', 'ranks.json'), JSON.stringify({ a: { id: 'a', score: 90, reason: 'r' }, b: { id: 'b', score: 5, reason: 'r' } }));
    // research file for b: goal recovered by matching the key against known prompts
    const kb = computeResearchKey('b', prompt, 'sig1', 'sonnet');
    await writeFile(path.join(cacheDir, 'research', `${kb}.json`), JSON.stringify(rec('b', '2025-01-05T00:00:00.000Z')));
    await writeFile(path.join(cacheDir, 'research', 'garbage.json'), '{nope');
    const kp = computeProfileKey('b', 'Partner at Fund', '', 'haiku');
    await writeFile(path.join(cacheDir, 'profiles', `${kp}.json`), JSON.stringify(profile));

    const t = '2025-01-01T00:00:00.000Z';
    const rep: ReportFile = {
      meta: { version: 1, prompt, inputPath: 'x.csv', createdAt: t, updatedAt: t, totalPeople: 2, rankModel: 'haiku', researchModel: 'sonnet', signalsPath: 's.md', cacheDir, outDir, stem: 'r', estUsdPerResearch: 0.15, costs: { rank: 0.12, research: 0.24 } },
      people: [
        { ...person('a'), score: 90, fitReason: 'r', rank: 1, ranked: true, research: rec('a', '2025-01-04T00:00:00.000Z') },
        { ...person('b'), score: 5, fitReason: 'r', rank: 2, ranked: true },
      ],
      lists: [{ id: 'mine', name: 'Mine', ids: ['a'], createdAt: t, updatedAt: t }],
    };
    await writeFile(path.join(outDir, 'r.json'), JSON.stringify(rep));
    await writeFile(path.join(outDir, 'old.json'), JSON.stringify([person('c')])); // pre-meta bare array
    await writeFile(path.join(outDir, 'notes.json'), JSON.stringify({ hello: 1 }));

    const { store: s2, imported } = await openStore(path.join(dir, 'imported.db'), { cacheDir, outDir });
    try {
      expect(imported).toMatchObject({ reports: 2, people: 3, runs: 1, rankings: 2, research: 2, profiles: 1, lists: 1 });
      expect(s2.getMeta(LEGACY_IMPORT_FLAG)).toBeTruthy();
      expect(s2.getRankings('run1').get('a')?.score).toBe(90);
      expect(s2.getResearchByKey(kb)).toBeDefined();
      const rows = s2.db.prepare('SELECT person_id, prompt FROM research ORDER BY person_id').all() as { person_id: string; prompt: string }[];
      expect(rows).toEqual([{ person_id: 'a', prompt }, { person_id: 'b', prompt }]);
      expect(s2.latestProfileFor('b')).toEqual(profile);
      expect(s2.findList('mine')?.prompt).toBe(prompt);
      expect(s2.stats().spend).toMatchObject({ rank: 0.12, research: 0.24 });

      // second run: nothing new, nothing duplicated
      const again = await importLegacy(s2, { cacheDir, outDir });
      expect(again).toMatchObject({ people: 0, rankings: 0, research: 0, profiles: 0, lists: 0 });
      expect(s2.stats().spend.total).toBeCloseTo(0.36);
    } finally {
      s2.close();
    }
    // the flag means a reopen doesn't import again
    const reopened = await openStore(path.join(dir, 'imported.db'), { cacheDir, outDir });
    expect(reopened.imported).toBeUndefined();
    reopened.store.close();
  });
});
