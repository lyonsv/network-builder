import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DossierRecord, ExplorerPerson, Person, Profile, ResearchRecord, ResearchReport } from '../src/types';

// runClaude is mocked: these tests never call the real Claude Code CLI.
const runClaude = vi.fn();
vi.mock('../src/llm/claude', async (orig) => ({
  ...(await orig<typeof import('../src/llm/claude')>()),
  runClaude: (...a: unknown[]) => runClaude(...a),
}));

const { Store, migrateV6, openStore, inputHash } = await import('../src/db');
const { SCHEMA_VERSION } = await import('../src/db/schema');
const {
  buildDossier, buildDossierPrompt, classifyRateLimited, normalizeDossier, normalizeRecent, linkedinSlug, ensureDossierTemplate,
  DEFAULT_DOSSIER_MD, PREVIOUS_DEFAULT_DOSSIER_MD, DOSSIER_ESTIMATES,
} = await import('../src/llm/dossier');
const { DOSSIER_SCHEMA } = await import('../src/llm/schemas');
const { withDossierDefaults } = await import('../src/db/store');
const { buildLensPrompt, scoreLens, LENS_RUBRIC, dossierDigest } = await import('../src/llm/lens');
const { createCostTracker } = await import('../src/llm/costs');
const { ClaudeError } = await import('../src/llm/claude');

let dir: string;
let store: import('../src/db/store').Store;

beforeEach(async () => {
  runClaude.mockReset();
  dir = await mkdtemp(path.join(os.tmpdir(), 'nb-v6-'));
  store = Store.open(path.join(dir, 'network.db'));
});
afterEach(() => store.close());

const person = (id: string, title: string, over: Partial<Person> = {}): Person => ({
  id, rowIndex: 1, fullName: `Person ${id}`, firstName: 'Person', lastName: id, title, company: '',
  url: `https://www.linkedin.com/in/${id}/`, email: '', connectedOn: '2024-01-02', extra: {}, ...over,
});

const profile = (over: Partial<Profile> = {}): Profile => ({
  company: 'Fund', role: 'Partner', seniority: 'partner', function: 'investing', industry: 'venture capital',
  tags: ['vc', 'investor'], region: '', ...over,
});

const dossier = (personId: string, depth: 'light' | 'deep', createdAt: string, over: Partial<DossierRecord> = {}): DossierRecord => ({
  personId, depth, status: 'ok', model: depth === 'light' ? 'haiku' : 'sonnet', costUsd: 0.01, durationMs: 10, createdAt,
  dossier: normalizeDossier({
    identityConfirmed: true, confidence: 'high', oneLiner: `${depth} one-liner`, currentRole: 'Chair',
    career: [{ role: 'VP EMEA', company: 'Globex', period: '2010–2016', current: false }],
    investingSummary: 'Angel investor in Ledgerly', investments: ['Ledgerly'], boards: ['Harbor Group (Chair)'],
    sources: [{ title: 'x', url: 'https://example.com' }],
  }),
  ...over,
});

const report = (over: Partial<ResearchReport> = {}): ResearchReport => ({
  identityConfirmed: true, summary: 'Jane is a London VC. She chairs a founders network.', currentRole: 'Venture Partner at Bluefield Capital',
  location: 'London', signals: [{ signal: '2. Direct relevance', finding: 'Active angel investor in 30 startups', strength: 'strong' }],
  fitAssessment: 'Great fit', recommendedApproach: 'Email', talkingPoints: ['a'], redFlags: [], sources: [{ title: 's', url: 'https://s.example' }],
  confidence: 'high', researchScore: 90, ...over,
});

describe('schema v2', () => {
  it('migrates to the latest version with v6 tables', () => {
    const v = (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(v).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    for (const t of ['dossiers', 'lenses', 'lens_scores']) {
      expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy();
    }
  });
});

describe('inputHash', () => {
  it('is stable and independent of profile key/tag order', () => {
    const a = inputHash({ title: 'Partner at X', company: '', profile: profile({ tags: ['vc', 'investor'] }) });
    const b = inputHash({ title: 'Partner at X ', company: '', profile: { ...profile(), tags: ['investor', 'vc'] } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
  it('changes with title, profile or a new dossier', () => {
    const base = inputHash({ title: 'T', company: '' });
    expect(inputHash({ title: 'T2', company: '' })).not.toBe(base);
    expect(inputHash({ title: 'T', company: '', profile: profile() })).not.toBe(base);
    expect(inputHash({ title: 'T', company: '', dossier: dossier('a', 'light', '2026-01-01T00:00:00Z') })).not.toBe(base);
  });
});

describe('dossiers + explorer people', () => {
  it('bestDossier prefers deep over newer light; ignores errors', () => {
    store.upsertPeople([person('a', 'Board Chair')], 'test');
    store.addDossier(dossier('a', 'deep', '2026-01-01T00:00:00Z'));
    store.addDossier(dossier('a', 'light', '2026-02-01T00:00:00Z'));
    store.addDossier({ ...dossier('a', 'deep', '2026-03-01T00:00:00Z'), status: 'error', dossier: undefined, error: 'x' });
    expect(store.bestDossier('a')?.depth).toBe('deep');
    expect(store.bestDossier('a')?.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(store.getExplorerPerson('a')?.dossier?.depth).toBe('deep');
  });

  it('lens scores go stale when a new dossier arrives', () => {
    store.upsertPeople([person('a', 'Board Chair'), person('b', 'Partner at Fund')], 'test');
    const lens = store.createLens({ goal: 'angels', rankModel: 'haiku', rerankModel: 'sonnet', rerankTop: 150 });
    const people = store.listExplorerPeople();
    store.setLensScores(people.map((p: ExplorerPerson) => ({
      lensId: lens.id, personId: p.id, score: 50, reason: 'r', basis: 'headline', model: 'haiku',
      inputHash: inputHash({ title: p.title, company: p.company }), scoredAt: '2026-01-01T00:00:00Z',
    })));
    expect(store.staleOrUnscored(lens.id)).toEqual([]);
    expect(store.getLens(lens.id)).toMatchObject({ scored: 2, stale: 0 });
    store.addDossier(dossier('a', 'light', '2026-02-01T00:00:00Z'));
    expect(store.staleOrUnscored(lens.id)).toEqual(['a']);
    expect(store.getLens(lens.id)).toMatchObject({ scored: 1, stale: 1 });
    expect(store.getExplorerPerson('a')?.scores[lens.id]?.stale).toBe(true);
    expect(store.getExplorerPerson('b')?.scores[lens.id]?.stale).toBe(false);
  });

  it('createLens makes unique slugs; findLensByGoal; deleteLens cascades scores', () => {
    store.upsertPeople([person('a', 'x')], 'test');
    const l1 = store.createLens({ goal: 'Angel investors', rankModel: 'haiku', rerankModel: '', rerankTop: 0 });
    const l2 = store.createLens({ goal: 'Angel investors', rankModel: 'haiku', rerankModel: '', rerankTop: 0 });
    expect(l1.id).toBe('angel-investors');
    expect(l2.id).toBe('angel-investors-2');
    expect(store.findLensByGoal('  angel   INVESTORS ')?.id).toBeDefined();
    store.setLensScores([{ lensId: l1.id, personId: 'a', score: 1, reason: '', basis: 'headline', model: 'h', inputHash: 'x', scoredAt: '' }]);
    expect(store.deleteLens(l1.id)).toBe(true);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM lens_scores WHERE lens_id = ?').get(l1.id)).toEqual({ n: 0 });
  });

  it('explorerCosts groups ledger stages', () => {
    store.addCost('enrich', 0.3);
    store.addCost('dossier', 0.1);
    store.addCost('lens', 0.05);
    store.addCost('rank', 0.12);
    store.addCost('research', 0.48);
    const c = store.explorerCosts();
    expect(c.lens).toBeCloseTo(0.17);
    expect(c.total).toBeCloseTo(1.05);
  });
});

describe('migrateV6', () => {
  function seedLegacy() {
    store.upsertPeople([person('a', 'VC and angel investor'), person('b', 'Board Chair'), person('c', 'Recruiter')], 'csv');
    store.setProfile('k-a', profile(), 'a', 'haiku');
    const t = '2026-11-04T10:00:00.000Z';
    store.upsertRun({ runKey: 'run1', prompt: 'make a list of potential angel investors', inputPath: 'x.csv', rankModel: 'haiku', researchModel: 'sonnet', totalPeople: 3, createdAt: t, updatedAt: t });
    store.setRankings('run1', [{ id: 'a', score: 98, reason: 'VC' }, { id: 'b', score: 75, reason: 'chair' }, { id: 'c', score: 4, reason: 'no' }]);
    const rec: ResearchRecord = { id: 'a', status: 'ok', report: report(), costUsd: 0.12, durationMs: 1, model: 'sonnet', signalsHash: 'h', finishedAt: '2026-11-04T11:00:00.000Z' };
    store.insertResearch('key-a', rec, 'make a list of potential angel investors');
  }

  it('converts runs to a lens and research to a legacy deep dossier, idempotently', () => {
    seedLegacy();
    const r1 = migrateV6(store);
    expect(r1).toEqual({ lensesCreated: 1, scoresMigrated: 3, dossiersConverted: 1 });
    const r2 = migrateV6(store);
    expect(r2).toEqual({ lensesCreated: 0, scoresMigrated: 0, dossiersConverted: 0 });

    const lenses = store.listLenses();
    expect(lenses).toHaveLength(1);
    expect(lenses[0]).toMatchObject({ id: 'make-a-list-of-potential-angel-investors', rankModel: 'haiku', rerankModel: 'sonnet', rerankTop: 150 });
    // a's score predates its (legacy) dossier → stale; b, c not stale
    expect(lenses[0]).toMatchObject({ scored: 2, stale: 1 });
    const a = store.getExplorerPerson('a')!;
    expect(a.scores[lenses[0]!.id]).toMatchObject({ score: 98, basis: 'headline', stale: true });
    expect(a.dossier).toMatchObject({ depth: 'deep', legacy: true, status: 'ok' });
    expect(a.dossier?.dossier?.oneLiner).toBe('Jane is a London VC.');
    expect(a.dossier?.dossier?.currentCompany).toBe('Bluefield Capital');
    expect(a.dossier?.dossier?.investingSummary).toContain('angel investor');
    expect(a.dossier?.legacyNotes).toMatchObject({ goal: 'make a list of potential angel investors', fitAssessment: 'Great fit', researchScore: 90 });
    expect(store.getExplorerPerson('c')?.scores[lenses[0]!.id]?.stale).toBe(false);
  });

  it('does not resurrect a deleted lens; openStore runs it', async () => {
    seedLegacy();
    migrateV6(store);
    const id = store.listLenses()[0]!.id;
    store.deleteLens(id);
    migrateV6(store);
    expect(store.listLenses()).toHaveLength(0);
    store.close();
    const { store: s2 } = await openStore(path.join(dir, 'network.db'));
    expect(s2.listLenses()).toHaveLength(0);
    s2.close();
    store = Store.open(path.join(dir, 'network.db'));
  });
});

const ep = (id: string, title: string, over: Partial<ExplorerPerson> = {}): ExplorerPerson => ({ ...person(id, title), scores: {}, ...over });

describe('lens prompt', () => {
  it('contains the credibility rubric, calibration and evidence fields', () => {
    const p = buildLensPrompt('potential angel investors', [
      ep('a', 'Founder at Search Technology | Talent | Angel Investor', { profile: profile({ seniority: 'founder/owner', tags: ['founder', 'angel'] }) }),
      ep('b', 'Board Chair | INED | Adviser', { dossier: dossier('b', 'light', '2026-01-01T00:00:00Z') }),
    ], 'score');
    expect(p).toContain(LENS_RUBRIC);
    expect(p).toMatch(/PRIMARY OCCUPATION FIRST/);
    expect(p).toMatch(/EVIDENCE LADDER/);
    expect(p).toMatch(/self-descriptions/);
    expect(p).toMatch(/Partner at Northwind Ventures" → 88-95/);
    expect(p).toContain('GOAL: potential angel investors');
    expect(p).toContain('"id":"p0"');
    expect(p).toContain('"headline":"Board Chair | INED | Adviser"');
    expect(p).toMatch(/"dossier":"light web profile, confidence high.*career: VP EMEA @ Globex \(2010–2016\).*investments: Ledgerly/);
    expect(p).toMatch(/\[headline\] or \[dossier\]/);
  });

  it('digest is longer in rerank mode and flags unconfirmed identity', () => {
    const d = dossier('b', 'deep', '2026-01-01T00:00:00Z');
    d.dossier!.identityConfirmed = false;
    const p = ep('b', 'x', { dossier: d });
    expect(dossierDigest(p, 600)).toContain('identity UNCONFIRMED');
    expect(buildLensPrompt('g', [p], 'rerank')).toMatch(/re-checking the strongest candidates/);
  });
});

describe('scoreLens', () => {
  it('scores everyone, reranks the top band with the rerank model, persists and records cost', async () => {
    store.upsertPeople([person('a', 'Partner at Fund'), person('b', 'Angel'), person('c', 'Recruiter')], 'csv');
    const lens = store.createLens({ goal: 'angels', rankModel: 'haiku', rerankModel: 'sonnet', rerankTop: 2 });
    runClaude.mockImplementation(async (o: { model: string; prompt: string }) => {
      const ids = [...o.prompt.matchAll(/"id":"(p\d+)"/g)].map((m) => m[1]!);
      const base: Record<string, number> = { 'Person a': 90, 'Person b': 70, 'Person c': 5 };
      const names = [...o.prompt.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]!);
      return {
        data: { results: ids.map((id, i) => ({ id, score: o.model === 'sonnet' ? base[names[i]!]! - 10 : base[names[i]!]!, reason: `[headline] ${o.model}` })) },
        costUsd: o.model === 'sonnet' ? 0.05 : 0.01, durationMs: 1, rawResult: '',
      };
    });
    const costs = createCostTracker();
    const progress: string[] = [];
    const people = store.listExplorerPeople();
    const out = await scoreLens({ lens, people, allPeople: people, store, costs, onProgress: (p) => progress.push(`${p.phase}:${p.done}/${p.total}`) });
    expect(out).toHaveLength(3);
    const byId = Object.fromEntries(out.map((s) => [s.personId, s]));
    expect(byId.a).toMatchObject({ score: 80, model: 'sonnet' });
    expect(byId.b).toMatchObject({ score: 60, model: 'sonnet' });
    expect(byId.c).toMatchObject({ score: 5, model: 'haiku', basis: 'headline' });
    expect(costs.byStage().lens).toBeCloseTo(0.06);
    expect(progress).toContain('score:3/3');
    expect(progress).toContain('rerank:2/2');
    expect(store.staleOrUnscored(lens.id)).toEqual([]);
    expect(store.getExplorerPerson('a')?.scores[lens.id]).toMatchObject({ score: 80, stale: false });
  });

  it('a failed rerank leaves the band stale (not silently final) and streams batches via onScores', async () => {
    store.upsertPeople([person('a', 'Partner at Fund'), person('b', 'Angel'), person('c', 'Recruiter')], 'csv');
    const lens = store.createLens({ goal: 'angels', rankModel: 'haiku', rerankModel: 'sonnet', rerankTop: 2 });
    runClaude.mockImplementation(async (o: { model: string; prompt: string }) => {
      if (o.model === 'sonnet') throw new ClaudeError('rerank boom', { costUsd: 0.03, retryable: false });
      const ids = [...o.prompt.matchAll(/"id":"(p\d+)"/g)].map((m) => m[1]!);
      return { data: { results: ids.map((id, i) => ({ id, score: 90 - i * 30, reason: 'r' })) }, costUsd: 0.01, durationMs: 1, rawResult: '' };
    });
    const streamed: number[] = [];
    const people = store.listExplorerPeople();
    await scoreLens({ lens, people, allPeople: people, store, costs: createCostTracker(), onScores: (b) => streamed.push(b.length) });
    expect(streamed).toEqual([3]); // pass-1 batch streamed; the failed rerank streamed nothing
    // the top-2 band only has first-pass scores → stale so "Update" re-checks them; c (outside the band) stays fresh
    expect(store.staleOrUnscored(lens.id).sort()).toEqual(['a', 'b']);
  });

  it('estimateLensUsd includes the rerank band', async () => {
    const { estimateLensUsd, LENS_USD_PER_1000, LENS_RERANK_USD_PER_100 } = await import('../src/llm/lens');
    expect(estimateLensUsd(2075, 150)).toBeCloseTo((2075 / 1000) * LENS_USD_PER_1000 + 1.5 * LENS_RERANK_USD_PER_100);
    expect(estimateLensUsd(10, 150)).toBeCloseTo(0.01 * LENS_USD_PER_1000 + 0.1 * LENS_RERANK_USD_PER_100);
    expect(estimateLensUsd(100, 0)).toBeCloseTo(0.1 * LENS_USD_PER_1000);
  });

  it('lens lock: held by another live pid → refused; dead pid or stale heartbeat → taken over', () => {
    const lens = store.createLens({ goal: 'g', rankModel: 'haiku', rerankModel: '', rerankTop: 0 });
    store.setMeta(`lens_job:${lens.id}`, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
    expect(store.acquireLensLock(lens.id)).toBe(false);
    store.setMeta(`lens_job:${lens.id}`, JSON.stringify({ pid: process.ppid, at: new Date(Date.now() - 10 * 60_000).toISOString() }));
    expect(store.acquireLensLock(lens.id)).toBe(true); // stale heartbeat
    store.releaseLensLock(lens.id);
    expect(store.getMeta(`lens_job:${lens.id}`)).toBeUndefined();
    store.setMeta(`lens_job:${lens.id}`, JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
    expect(store.acquireLensLock(lens.id)).toBe(true); // dead pid
  });

  it('a failed batch leaves people unscored; abort propagates', async () => {
    store.upsertPeople([person('a', 'x')], 'csv');
    const lens = store.createLens({ goal: 'g', rankModel: 'haiku', rerankModel: '', rerankTop: 0 });
    runClaude.mockRejectedValue(new ClaudeError('boom', { costUsd: 0.02, retryable: false }));
    const costs = createCostTracker();
    const out = await scoreLens({ lens, people: store.listExplorerPeople(), store, costs });
    expect(out).toEqual([]);
    expect(store.staleOrUnscored(lens.id)).toEqual(['a']);
    expect(costs.byStage().lens).toBeCloseTo(0.02); // the failed call's spend is still recorded
  });
});

describe('dossier', () => {
  const jane = ep('h', 'Board Chair | INED | Adviser', { fullName: 'Jane Example', url: 'https://www.linkedin.com/in/janetexample/' });

  it('prompt is goal-free, budgeted by depth, and uses the LinkedIn slug', () => {
    const light = buildDossierPrompt(jane, 'light', DEFAULT_DOSSIER_MD);
    expect(linkedinSlug(jane.url)).toBe('janetexample');
    expect(light).toContain('(slug: janetexample)');
    expect(light).toMatch(/GOAL-FREE/);
    expect(light).toMatch(/at most 2 WebSearch calls/);
    expect(light).toMatch(/do NOT fetch/);
    expect(light).toMatch(/rateLimited: set true/);
    expect(light).not.toMatch(/^GOAL:/m);
    const deep = buildDossierPrompt({ ...jane, dossier: dossier('h', 'light', '2026-01-01T00:00:00Z') }, 'deep', DEFAULT_DOSSIER_MD);
    expect(deep).toMatch(/at most 8 WebSearch calls/);
    expect(deep).toMatch(/Never fetch linkedin\.com/);
    expect(deep).toMatch(/earlier light profile/);
  });

  it('classifies rate limiting from the flag or text, but keeps partial results', () => {
    const empty = normalizeDossier({});
    expect(classifyRateLimited({ rateLimited: true }, empty)).toBe(true);
    expect(classifyRateLimited({}, normalizeDossier({ oneLiner: 'Not profiled: web search was rate-limited before any lookup.' }))).toBe(true);
    expect(classifyRateLimited({ rateLimited: true, searchesRun: 1 }, normalizeDossier({ currentRole: 'MD', sources: [{ title: 't', url: 'https://x.y' }] }))).toBe(false);
    expect(classifyRateLimited({ searchesRun: 2 }, empty)).toBe(false); // found nothing ≠ rate limited
  });

  it('does not mistake ordinary "nothing found" answers for rate limiting', () => {
    const texts = [
      'Searches failed to find any matching public profile for this person.',
      'Web searches are blocked by common-name ambiguity; could not identify the individual.',
      'Could not perform a search that distinguished this person from others with the same name.',
    ];
    for (const t of texts) {
      const d = normalizeDossier({ oneLiner: t });
      // explicit flag false → never rate limited, whatever the text says
      expect(classifyRateLimited({ rateLimited: false, searchesRun: 2 }, d)).toBe(false);
      // flag missing but searches ran → not rate limited
      expect(classifyRateLimited({ searchesRun: 2 }, d)).toBe(false);
      // flag and count missing → the narrow text heuristic must not match these phrasings
      expect(classifyRateLimited({}, d)).toBe(false);
    }
    // explicit false wins even with rate-limit wording
    expect(classifyRateLimited({ rateLimited: false }, normalizeDossier({ oneLiner: 'web search was rate-limited' }))).toBe(false);
  });

  it('buildDossier: ok, rate_limited (model + CLI), error, abort', async () => {
    runClaude.mockResolvedValueOnce({ data: { rateLimited: false, searchesRun: 2, oneLiner: 'Chair', confidence: 'medium', identityConfirmed: true, sources: [{ title: 'a', url: 'https://a.b' }, { title: 'bad', url: 'javascript:x' }] }, costUsd: 0.012, durationMs: 5, rawResult: '' });
    const ok = await buildDossier(jane, { depth: 'light', model: 'haiku', template: DEFAULT_DOSSIER_MD });
    expect(ok).toMatchObject({ status: 'ok', depth: 'light', model: 'haiku', costUsd: 0.012 });
    expect(ok.dossier?.sources).toEqual([{ title: 'a', url: 'https://a.b' }]);
    const call = runClaude.mock.calls[0]![0] as { tools: string[] };
    expect(call.tools).toEqual(['WebSearch']);

    runClaude.mockResolvedValueOnce({ data: { rateLimited: true, searchesRun: 0 }, costUsd: 0.003, durationMs: 5, rawResult: '' });
    expect(await buildDossier(jane, { depth: 'light', model: 'haiku', template: '' })).toMatchObject({ status: 'rate_limited', costUsd: 0.003 });

    runClaude.mockRejectedValueOnce(new ClaudeError('claude error: API Error: 429 rate_limit_error', { costUsd: 0, retryable: true }));
    expect(await buildDossier(jane, { depth: 'deep', model: 'sonnet', template: '' })).toMatchObject({ status: 'rate_limited' });

    runClaude.mockRejectedValueOnce(new ClaudeError('claude returned no structured output', { costUsd: 0.02 }));
    expect(await buildDossier(jane, { depth: 'deep', model: 'sonnet', template: '' })).toMatchObject({ status: 'error', costUsd: 0.02 });

    const abort = new ClaudeError('Aborted', { costUsd: 0 });
    abort.name = 'AbortError';
    runClaude.mockRejectedValueOnce(abort);
    await expect(buildDossier(jane, { depth: 'light', model: 'haiku', template: '' })).rejects.toThrow('Aborted');
  });

  it('ensureDossierTemplate creates once and never overwrites', async () => {
    const f = path.join(dir, 'sub', 'dossier.md');
    expect((await ensureDossierTemplate(f)).created).toBe(true);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(f, 'mine');
    const r = await ensureDossierTemplate(f);
    expect(r.created).toBe(false);
    // user text is kept verbatim; only the recent-activity section is appended (once)
    expect(r.content.startsWith('mine\n\n## Recent activity')).toBe(true);
  });
});

describe('recent activity (deep dossiers)', () => {
  const sam = ep('s', 'Founder & CEO @ Ledgerline | Ex-Payments EU CIO', { fullName: 'Sam Sample', url: 'https://www.linkedin.com/in/samsample/' });

  it('schema requires recentActivity + recentThemes with valid kinds', () => {
    const req = DOSSIER_SCHEMA.required as string[];
    expect(req).toContain('recentActivity');
    expect(req).toContain('recentThemes');
    const props = DOSSIER_SCHEMA.properties as Record<string, any>;
    expect(props.recentActivity.items.properties.kind.enum).toEqual(['post', 'article', 'podcast', 'talk', 'interview', 'news', 'announcement', 'other']);
    expect(props.recentActivity.items.required).toEqual(['date', 'kind', 'title', 'summary', 'url']);
  });

  it('deep prompt has the 8-search budget, reserves searches for recent activity, injects today, and bans linkedin fetches', () => {
    const deep = buildDossierPrompt(sam, 'deep', DEFAULT_DOSSIER_MD, '2026-11-04');
    expect(deep).toMatch(/at most 8 WebSearch calls/);
    expect(deep).toMatch(/reserve 2–3 for\nRECENT ACTIVITY/);
    expect(deep).toContain('today is 2026-11-04');
    expect(deep).toContain('since 2025-11');
    expect(deep).toMatch(/Never fetch linkedin\.com/);
    expect(deep).toMatch(/only if a search snippet shows its/);
    expect(deep).toMatch(/WHAT they said/);
    expect(deep).toMatch(/## Recent activity \(last 12 months\)/);
    const light = buildDossierPrompt(sam, 'light', DEFAULT_DOSSIER_MD, '2026-11-04');
    expect(light).not.toContain('today is 2026-11-04');
    expect(light).toMatch(/do NOT spend searches on them/);
    expect(DOSSIER_ESTIMATES.deepUsd).toBe(0.17);
  });

  it('normalizes: missing → [], bad kinds/dates/urls coerced, newest first, max 8', () => {
    const d = normalizeDossier({});
    expect(d.recentActivity).toEqual([]);
    expect(d.recentThemes).toEqual([]);
    const items = normalizeRecent([
      { date: '2026-03', kind: 'post', title: 'Older', summary: 's', url: 'https://a.b/1' },
      { date: 'last week', kind: 'tweet', title: 'Undated', summary: 's', url: 'javascript:alert(1)' },
      { date: '2026-10-02', kind: 'podcast', title: 'Newest', summary: 'says X', url: 'https://a.b/2' },
      { title: '', summary: '' },
      ...Array.from({ length: 10 }, (_, i) => ({ date: '2025-12', kind: 'news', title: `n${i}`, summary: '', url: '' })),
    ]);
    expect(items[0]).toMatchObject({ title: 'Newest', kind: 'podcast', date: '2026-10-02' });
    expect(items[1]).toMatchObject({ title: 'Older' });
    expect(items).toHaveLength(8);
    expect(items.find((i) => i.title === 'Undated')).toBeUndefined(); // pushed past the cap (undated sort last)
    const one = normalizeRecent([{ date: 'x', kind: 'tweet', title: 'U', summary: '', url: 'javascript:1' }]);
    expect(one[0]).toEqual({ date: '', kind: 'other', title: 'U', summary: '', url: '' });
    expect(normalizeDossier({ recentThemes: ['a', '', 'b', 'c', 'd', 'e', 'f', 'g'] }).recentThemes).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('older stored dossiers read back with [] for the new fields', () => {
    const rec = dossier('x', 'light', '2026-01-01T00:00:00Z');
    const old = JSON.parse(JSON.stringify(rec));
    delete old.dossier.recentActivity;
    delete old.dossier.recentThemes;
    const fixed = withDossierDefaults(old)!;
    expect(fixed.dossier!.recentActivity).toEqual([]);
    expect(fixed.dossier!.recentThemes).toEqual([]);
    store.addDossier(old);
    expect(store.bestDossier('x')!.dossier!.recentThemes).toEqual([]);
  });

  it('lens digest includes recent themes and up to 3 recent titles', () => {
    const rec = dossier('s', 'deep', '2026-11-01T00:00:00Z');
    rec.dossier!.recentThemes = ['AI banking', 'startup finance'];
    rec.dossier!.recentActivity = [
      { date: '2026-10', kind: 'podcast', title: 'T1', summary: '', url: '' },
      { date: '2026-09', kind: 'post', title: 'T2', summary: '', url: '' },
      { date: '2026-08', kind: 'talk', title: 'T3', summary: '', url: '' },
      { date: '2026-07', kind: 'news', title: 'T4', summary: '', url: '' },
    ];
    const dg = dossierDigest({ ...sam, dossier: rec }, 1500);
    expect(dg).toContain('recently talking about: AI banking; startup finance');
    expect(dg).toContain('recent: 2026-10 T1; 2026-09 T2; 2026-08 T3');
    expect(dg).not.toContain('T4');
  });

  it('template upgrade: untouched old default → new default; edited → section appended; backup written', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const a = path.join(dir, 'a.md');
    await writeFile(a, PREVIOUS_DEFAULT_DOSSIER_MD);
    const ra = await ensureDossierTemplate(a);
    expect(ra.content).toBe(DEFAULT_DOSSIER_MD);
    expect(await readFile(`${a}.bak`, 'utf8')).toBe(PREVIOUS_DEFAULT_DOSSIER_MD);
    const b = path.join(dir, 'b.md');
    await writeFile(b, '# Mine\n\n## Career\n- only career please\n');
    const rb = await ensureDossierTemplate(b);
    expect(rb.content.startsWith('# Mine\n\n## Career\n- only career please')).toBe(true);
    expect(rb.content).toMatch(/## Recent activity \(last 12 months\)/);
    expect(await readFile(`${b}.bak`, 'utf8')).toBe('# Mine\n\n## Career\n- only career please\n');
    // idempotent: second call doesn't append again
    const rb2 = await ensureDossierTemplate(b);
    expect(rb2.content.match(/## Recent activity/g)).toHaveLength(1);
  });
});
