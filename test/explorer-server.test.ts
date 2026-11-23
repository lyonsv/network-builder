import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/store';
import { inputHash } from '../src/db/hash';
import { stablePortFor } from '../src/web/http-common';
import { startExplorerServer, type AhoyCheckFn, type AhoyProposalFn, type DossierFn, type ExplorerServer, type OrgInferFn, type OrgResearchFn, type ScoreFn } from '../src/web/explorer-server';
import { normalizeOrgResearch } from '../src/llm/org-research';
import type { DossierRecord, ExplorerEvent, LensScore, Person } from '../src/types';

const TEMPLATE = '<!doctype html><title>__NB_TITLE__</title><script id="nb-data" type="application/json">__NB_DATA__</script>';

const mkPerson = (id: string, name: string, title: string): Person => ({
  id,
  rowIndex: 0,
  fullName: name,
  firstName: name.split(' ')[0]!,
  lastName: name.split(' ').slice(1).join(' '),
  title,
  company: '',
  url: `https://www.linkedin.com/in/${id}/`,
  email: '',
  connectedOn: '2020-01-01',
  extra: {},
});

const okDossier = (personId: string, depth: 'light' | 'deep', oneLiner = 'Someone'): DossierRecord => ({
  personId,
  depth,
  status: 'ok',
  model: depth === 'light' ? 'haiku' : 'sonnet',
  costUsd: 0.01,
  durationMs: 5,
  createdAt: new Date().toISOString(),
  dossier: {
    identityConfirmed: true,
    confidence: 'high',
    oneLiner,
    currentRole: 'Partner',
    currentCompany: 'Fund',
    location: 'Dublin',
    career: [{ role: 'Partner', company: 'Fund', period: '2019–present', current: true }],
    education: [],
    investingSummary: 'Invests',
    investments: ['Acme'],
    boards: [],
    expertise: [],
    notable: [],
    publicPresence: [],
    recentActivity: [],
    recentThemes: [],
    sources: [{ title: 'x', url: 'https://example.com' }],
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await sleep(10);
  }
}

let dir = '';
let store: Store | undefined;
let server: ExplorerServer | undefined;

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  store?.close();
  store = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

async function setup(o: { dossierFn?: DossierFn; scoreFn?: ScoreFn; ahoyCheckFn?: AhoyCheckFn; ahoyProposalFn?: AhoyProposalFn; orgInferFn?: OrgInferFn; orgResearchFn?: OrgResearchFn; backoffMs?: number[]; concurrency?: { light: number; deep: number }; heartbeatMs?: number } = {}) {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nb-explorer-'));
  store = Store.open(path.join(dir, 'network.db'));
  store.upsertPeople(
    [mkPerson('aaa', 'Ann Angel', 'Angel Investor'), mkPerson('bbb', 'Bob Builder', 'Recruiter | Angel Investor'), mkPerson('ccc', 'Cat Chair', 'Board Chair')],
    'test.csv',
  );
  const events: ExplorerEvent[] = [];
  server = await startExplorerServer({
    store,
    dbPath: path.join(dir, 'network.db'),
    outDir: path.join(dir, 'outputs'),
    template: '# dossier',
    researchModel: 'sonnet',
    htmlTemplate: TEMPLATE,
    dossierFn: o.dossierFn ?? (async (p, { depth }) => okDossier(p.id, depth)),
    scoreFn: o.scoreFn,
    ahoyCheckFn: o.ahoyCheckFn,
    ahoyProposalFn: o.ahoyProposalFn,
    orgInferFn: o.orgInferFn,
    orgResearchFn: o.orgResearchFn,
    backoffMs: o.backoffMs,
    concurrency: o.concurrency,
    heartbeatMs: o.heartbeatMs,
    onEvent: (e) => events.push(e),
  });
  return { events, base: `http://127.0.0.1:${server.port}`, token: server.token };
}

async function req(
  method: string,
  url: string,
  o: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, {
    method,
    headers: { ...(o.token ? { 'X-NB-Token': o.token } : {}), ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...o.headers },
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

/** raw http request so we can send a forged Host header (fetch forbids it) */
function rawGet(port: number, p: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on('error', reject);
    r.end();
  });
}

describe('explorer server security', () => {
  it('requires the token, our Host and our Origin; limits bodies; unknown routes', async () => {
    const { base, token } = await setup();
    expect((await req('GET', `${base}/api/state`)).status).toBe(401);
    expect((await req('GET', `${base}/`)).status).toBe(401);
    expect((await req('GET', `${base}/?t=${token}`)).status).toBe(200);
    expect((await req('GET', `${base}/api/events`)).status).toBe(401);
    expect((await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa'] }, headers: { Origin: 'http://evil.com' } })).status).toBe(403);
    expect(await rawGet(server!.port, '/api/state', { Host: 'evil.com', 'X-NB-Token': token })).toBe(403);
    expect((await req('POST', `${base}/api/dossiers`, { token, raw: JSON.stringify({ ids: ['x'.repeat(1_100_000)] }), headers: { 'Content-Type': 'application/json' } })).status).toBe(413);
    expect((await req('GET', `${base}/api/nope`, { token })).status).toBe(404);
    expect((await req('GET', `${base}/api/dossiers`, { token })).status).toBe(405);
  });

  it('serves the explorer HTML with state embedded (escaped) and a CSP', async () => {
    const { base, token } = await setup();
    store!.upsertPeople([mkPerson('ddd', '</script><img onerror=x>', 'x')], 'evil.csv');
    const res = await fetch(`${base}/?t=${token}`);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).not.toContain('__NB_DATA__');
    expect(html.match(/<\/script>/g)?.length).toBe(1);
  });

  it('stable port per key', () => {
    expect(stablePortFor('/a/network.db')).toBe(stablePortFor('/a/network.db'));
    expect(stablePortFor('/a/network.db')).toBeGreaterThanOrEqual(47000);
    expect(stablePortFor('/a/network.db')).toBeLessThan(48000);
  });
});

describe('dossier queue', () => {
  it('queues, dedupes, skips unknown + already-profiled, respects light concurrency 1', async () => {
    let active = 0;
    let maxActive = 0;
    const { base, token, events } = await setup({
      dossierFn: async (p, { depth }) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active--;
        return okDossier(p.id, depth);
      },
    });
    const r = await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa', 'bbb', 'aaa', 'zzz'], depth: 'light' } });
    expect(r.json.queued).toEqual(['aaa', 'bbb']);
    expect(r.json.skipped).toEqual(['zzz']);
    await until(() => events.filter((e) => e.type === 'person').length === 2);
    expect(maxActive).toBe(1);
    const st = (await req('GET', `${base}/api/state`, { token })).json;
    expect(st.version).toBe(6);
    expect(st.people.find((x: any) => x.id === 'aaa').dossier.depth).toBe('light');
    // light again → skipped; deep → accepted; light with force → accepted
    expect((await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa'], depth: 'light' } })).json.skipped).toEqual(['aaa']);
    expect((await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa'], depth: 'deep' } })).json.queued).toEqual(['aaa']);
    await until(() => events.filter((e) => e.type === 'person').length === 3);
    expect((await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa'], depth: 'light' } })).json.skipped).toEqual(['aaa']);
    expect((await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['bbb'], depth: 'light', force: true } })).json.queued).toEqual(['bbb']);
    expect((await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa'], depth: 'huge' } })).status).toBe(400);
    // dossier cost went to the ledger
    await until(() => events.filter((e) => e.type === 'person').length === 4);
    expect(store!.explorerCosts().dossier).toBeGreaterThan(0);
  });

  it('pauses on rate limit, requeues at the front, resumes after backoff', async () => {
    let calls = 0;
    const order: string[] = [];
    const { base, token, events } = await setup({
      backoffMs: [80, 160],
      dossierFn: async (p, { depth }) => {
        calls++;
        order.push(p.id);
        if (calls === 1) return { ...okDossier(p.id, depth), status: 'rate_limited', dossier: undefined, costUsd: 0.002 };
        return okDossier(p.id, depth);
      },
    });
    await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa', 'bbb'], depth: 'light' } });
    await until(() => events.some((e) => e.type === 'notice' && e.level === 'warn'));
    const paused = (await req('GET', `${base}/api/state`, { token })).json.queue;
    expect(paused.pausedUntil).not.toBeNull();
    expect(paused.queued[0].id).toBe('aaa');
    await until(() => events.filter((e) => e.type === 'person').length === 2, 3000);
    expect(order).toEqual(['aaa', 'aaa', 'bbb']);
    expect((await req('GET', `${base}/api/state`, { token })).json.queue.pausedUntil).toBeNull();
  });

  it('gives up on a person after 3 rate-limited attempts and then waits for a manual Resume (no endless paid retries)', async () => {
    let calls = 0;
    let limited = true;
    const { base, token, events } = await setup({
      backoffMs: [20, 40],
      dossierFn: async (p, { depth }) => {
        calls++;
        if (limited) return { ...okDossier(p.id, depth), status: 'rate_limited', dossier: undefined, costUsd: 0.002 };
        return okDossier(p.id, depth);
      },
    });
    await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa', 'bbb'], depth: 'light' } });
    await until(() => events.some((e) => e.type === 'person' && e.person.id === 'aaa'));
    const errEv = events.find((e) => e.type === 'person' && e.person.id === 'aaa') as Extract<ExplorerEvent, { type: 'person' }>;
    expect(errEv.error).toMatch(/rate-limited 3× — retry later/);
    expect(calls).toBe(3);
    const st = (await req('GET', `${base}/api/state`, { token })).json;
    expect(st.queue.pausedManual).toBe(true);
    expect(st.queue.queued.map((j: any) => j.id)).toEqual(['bbb']);
    await sleep(150); // no auto-resume
    expect(calls).toBe(3);
    // the error is stored (not ok), so the person can be re-queued later
    expect(st.people.find((x: any) => x.id === 'aaa').dossier).toBeUndefined();
    limited = false;
    const r = await req('POST', `${base}/api/dossiers/resume`, { token, body: {} });
    expect(r.json.resumed).toBe(true);
    expect(r.json.queue.pausedManual).toBe(false);
    await until(() => events.some((e) => e.type === 'person' && e.person.id === 'bbb'));
    expect(calls).toBe(4);
    // and aaa can be re-queued manually
    expect((await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa'], depth: 'light' } })).json.queued).toEqual(['aaa']);
  });

  it('concurrent rate limits escalate the backoff once per pause, not once per job', async () => {
    const { base, token } = await setup({
      backoffMs: [5_000, 60_000],
      concurrency: { light: 1, deep: 2 },
      dossierFn: async (p, { depth }) => {
        await sleep(20);
        return { ...okDossier(p.id, depth), status: 'rate_limited', dossier: undefined, costUsd: 0.01 };
      },
    });
    await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa', 'bbb'], depth: 'deep' } });
    await sleep(120);
    const q = (await req('GET', `${base}/api/state`, { token })).json.queue;
    expect(q.pausedUntil).not.toBeNull();
    const ms = Date.parse(q.pausedUntil) - Date.now();
    expect(ms).toBeLessThan(6_000); // first step (5s), not the second (60s)
    expect(q.queued.map((j: any) => j.id).sort()).toEqual(['aaa', 'bbb']);
  });

  it('cancels queued (not running) work; errors are reported, not retried', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { base, token, events } = await setup({
      dossierFn: async (p, { depth }) => {
        if (p.id === 'aaa') await gate;
        if (p.id === 'ccc') throw new Error('boom');
        return okDossier(p.id, depth);
      },
    });
    await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa', 'bbb', 'ccc'] } });
    const c = await req('POST', `${base}/api/dossiers/cancel`, { token, body: { ids: ['bbb'] } });
    expect(c.json.cancelled).toEqual(['bbb']);
    release();
    await until(() => events.filter((e) => e.type === 'person').length === 2);
    const err = events.find((e) => e.type === 'person' && e.person.id === 'ccc');
    expect(err && err.type === 'person' && err.error).toBe('boom');
    expect(store!.bestDossier('ccc')).toBeUndefined();
  });
});

describe('lenses', () => {
  const stubScore: ScoreFn = async ({ lens, people, store: st, onProgress }) => {
    await sleep(30);
    onProgress?.({ phase: 'score', done: people.length, total: people.length });
    const scores: LensScore[] = people.map((p, i) => ({
      lensId: lens.id,
      personId: p.id,
      score: 90 - i * 10,
      reason: `reason ${p.id}`,
      basis: p.dossier ? 'dossier-light' : 'headline',
      model: 'haiku',
      inputHash: inputHash(p),
      scoredAt: new Date().toISOString(),
    }));
    st.setLensScores(scores);
    return scores;
  };

  it('creates, scores in the background, 409s while busy, refreshes only stale, deletes', async () => {
    const { base, token, events } = await setup({ scoreFn: stubScore });
    const r = await req('POST', `${base}/api/lenses`, { token, body: { goal: 'potential angel investors' } });
    expect(r.status).toBe(200);
    expect(r.json.scoring).toBe(3);
    const lensId = r.json.lens.id as string;
    expect((await req('POST', `${base}/api/lenses`, { token, body: { goal: 'heads of marketing' } })).status).toBe(409);
    await until(() => events.some((e) => e.type === 'lens'));
    const st = (await req('GET', `${base}/api/state`, { token })).json;
    expect(st.people.find((x: any) => x.id === 'aaa').scores[lensId].score).toBe(90);
    expect(st.queue.lensJob).toBeNull();
    // nothing stale → no job
    expect((await req('POST', `${base}/api/lenses/${lensId}/refresh`, { token })).json.scoring).toBe(0);
    // same goal again (case-insensitive) → existing lens, nothing to score
    const again = await req('POST', `${base}/api/lenses`, { token, body: { goal: 'Potential Angel Investors ' } });
    expect(again.json.existing).toBe(true);
    expect(again.json.scoring).toBe(0);
    // a new dossier makes that person stale → refresh scores just them
    await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['ccc'] } });
    await until(() => events.some((e) => e.type === 'person'));
    const ref = await req('POST', `${base}/api/lenses/${lensId}/refresh`, { token });
    expect(ref.json.scoring).toBe(1);
    await until(() => events.filter((e) => e.type === 'lens').length === 2);
    // re-score all (e.g. after the scoring rules improved) → everyone, not just stale
    const all = await req('POST', `${base}/api/lenses/${lensId}/refresh`, { token, body: { all: true } });
    expect(all.json.scoring).toBe(3);
    await until(() => events.filter((e) => e.type === 'lens').length === 3);
    expect((await req('POST', `${base}/api/lenses/${lensId}/refresh`, { token, body: { all: 'yes' } })).status).toBe(400);
    expect((await req('POST', `${base}/api/lenses`, { token, body: { goal: '' } })).status).toBe(400);
    expect((await req('DELETE', `${base}/api/lenses/${lensId}`, { token })).json.lenses).toEqual([]);
    expect((await req('DELETE', `${base}/api/lenses/${lensId}`, { token })).status).toBe(404);
  });

  it('saves membership: threshold + manual pins in/out, cleared pins, validation, cascade on delete', async () => {
    const { base, token, events } = await setup({ scoreFn: stubScore });
    const lensId = (await req('POST', `${base}/api/lenses`, { token, body: { goal: 'potential angel investors' } })).json.lens.id as string;
    await until(() => events.some((e) => e.type === 'lens'));
    const url = `${base}/api/lenses/${lensId}`;
    let r = await req('PUT', url, { token, body: { threshold: 75 } });
    expect(r.status).toBe(200);
    expect(r.json.lens).toMatchObject({ threshold: 75, pinnedIn: [], pinnedOut: [] });
    r = await req('PUT', url, { token, body: { ids: ['ccc', 'nope'], pin: 'in' } });
    expect(r.json.lens.pinnedIn).toEqual(['ccc']);
    r = await req('PUT', url, { token, body: { ids: ['aaa'], pin: 'out' } });
    expect(r.json.lens.pinnedOut).toEqual(['aaa']);
    expect(events.some((e) => e.type === 'lenses')).toBe(true);
    r = await req('PUT', url, { token, body: { ids: ['ccc'], pin: null } });
    expect(r.json.lens.pinnedIn).toEqual([]);
    // persisted in the store (survives restarts)
    expect(store!.getLens(lensId)).toMatchObject({ threshold: 75, pinnedIn: [], pinnedOut: ['aaa'] });
    expect((await req('PUT', url, { token, body: { threshold: 101 } })).status).toBe(400);
    expect((await req('PUT', url, { token, body: { ids: ['aaa'], pin: 'maybe' } })).status).toBe(400);
    expect((await req('PUT', url, { token, body: { ids: ['aaa'] } })).status).toBe(400);
    expect((await req('PUT', `${base}/api/lenses/missing`, { token, body: { threshold: 50 } })).status).toBe(404);
    // reword: same id, pins + threshold kept, scores stale, optional re-score of everyone
    r = await req('PUT', url, { token, body: { goal: '  people who write angel cheques ' } });
    expect(r.json.lens).toMatchObject({ id: lensId, goal: 'people who write angel cheques', threshold: 75, pinnedOut: ['aaa'], stale: 3 });
    expect((await req('PUT', url, { token, body: { goal: '' } })).status).toBe(400);
    expect((await req('PUT', url, { token, body: { rescore: true } })).status).toBe(400);
    const n = events.filter((e) => e.type === 'lens').length;
    r = await req('PUT', url, { token, body: { goal: 'people who write big angel cheques', rescore: true } });
    expect(r.json.scoring).toBe(3);
    await until(() => events.filter((e) => e.type === 'lens').length > n);
    expect(store!.getLens(lensId)).toMatchObject({ stale: 0, scored: 3, pinnedOut: ['aaa'] });
    await req('DELETE', url, { token });
    expect(store!.db.prepare('SELECT COUNT(*) AS n FROM lens_pins').get()).toEqual({ n: 0 });
  });

  it('lists + CSV export with lens columns (BOM, server-assigned ids)', async () => {
    const { base, token, events } = await setup({ scoreFn: stubScore });
    const lensId = (await req('POST', `${base}/api/lenses`, { token, body: { goal: 'angels' } })).json.lens.id;
    await until(() => events.some((e) => e.type === 'lens'));
    const a = await req('PUT', `${base}/api/lists/new`, { token, body: { name: 'Angels', ids: ['bbb', 'aaa'], create: true, lensId } });
    expect(a.json.list.id).toBe('angels');
    const b = await req('PUT', `${base}/api/lists/new`, { token, body: { name: 'Angels', ids: ['ccc'], create: true } });
    expect(b.json.list.id).toBe('angels-2');
    expect((await req('GET', `${base}/api/lists`, { token })).json.lists).toHaveLength(2);
    const ex = await req('POST', `${base}/api/export`, { token, body: { name: 'Angels', ids: ['bbb', 'aaa', 'zzz'], preset: 'crm', listId: 'angels', lensId } });
    expect(ex.json.count).toBe(2);
    const csv = readFileSync(ex.json.path, 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\n');
    expect(lines[0]).toContain('"Fit Score"');
    expect(lines[1]).toContain('"Bob"');
    expect(lines[1]).toContain('80');
    expect((await req('POST', `${base}/api/export`, { token, body: { name: 'x', ids: ['aaa'], lensId: 'nope' } })).status).toBe(400);
    expect((await req('DELETE', `${base}/api/lists/angels-2`, { token })).json.lists).toHaveLength(1);
  });
});

describe('shutdown', () => {
  it('aborts running work, writes a snapshot (api:null), closes quickly', async () => {
    const { base, token } = await setup({
      dossierFn: (_p, { signal }) =>
        new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    });
    await req('POST', `${base}/api/dossiers`, { token, body: { ids: ['aaa', 'bbb'] } });
    const t = Date.now();
    const { snapshot } = await server!.close();
    expect(Date.now() - t).toBeLessThan(2000);
    expect(snapshot).toMatch(/_network-explorer\.html$/);
    const html = readFileSync(snapshot, 'utf8');
    expect(html).toContain('"api":null');
    expect(readdirSync(path.join(dir, 'outputs'))).toHaveLength(1);
    expect(store!.bestDossier('aaa')).toBeUndefined();
    server = undefined;
  });
});

describe('external writes', () => {
  it('pushes a reload hint (and lenses) when another process changes the DB, without a page refresh', async () => {
    const { events } = await setup({ heartbeatMs: 40 });
    const other = Store.open(path.join(dir, 'network.db'));
    other.createLens({ goal: 'from the cli', rankModel: 'haiku', rerankModel: '', rerankTop: 0 });
    other.close();
    await until(() => events.some((e) => e.type === 'reload'));
    const lensesEv = events.filter((e) => e.type === 'lenses').pop() as Extract<ExplorerEvent, { type: 'lenses' }>;
    expect(lensesEv.lenses.map((l) => l.goal)).toContain('from the cli');
  });

  it('refuses to score a lens another process is scoring (lens lock)', async () => {
    const { base, token } = await setup({ scoreFn: async () => [] });
    const lens = store!.createLens({ goal: 'locked goal', rankModel: 'haiku', rerankModel: '', rerankTop: 0 });
    store!.setMeta(`lens_job:${lens.id}`, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
    const r = await req('POST', `${base}/api/lenses/${lens.id}/refresh`, { token, body: { all: true } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/another network-builder process/);
    store!.setMeta(`lens_job:${lens.id}`, JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
    expect((await req('POST', `${base}/api/lenses/${lens.id}/refresh`, { token, body: { all: true } })).status).toBe(200);
  });

  it('reloads people when another connection changes the database', async () => {
    const { base, token } = await setup();
    const other = Store.open(path.join(dir, 'network.db'));
    other.upsertPeople([mkPerson('eee', 'Eve External', 'CMO')], 'other.csv');
    other.close();
    const st = (await req('GET', `${base}/api/state`, { token })).json;
    expect(st.people.some((x: any) => x.id === 'eee')).toBe(true);
  });
});

describe('Ahoy CRM endpoints', () => {
  const at = new Date().toISOString();
  const checkStub: AhoyCheckFn = async ({ people, onResults, onProgress }) => {
    const out = people.map((p) => ({
      id: p.id,
      crm:
        p.id === 'aaa'
          ? { status: 'in_crm' as const, contactId: 'c-aaa', contactName: p.fullName, companyId: 'co-1', companyName: 'Fund', companyStatus: 'no_domain' as const, linkedToCompany: 'yes' as const, reason: 'linkedin match', checkedAt: at }
          : p.id === 'bbb'
            ? { status: 'ambiguous' as const, companyStatus: 'new' as const, companyName: 'Recruit Co', candidates: [{ id: 'k1', name: 'Bob Builder', detail: 'Recruiter' }, { id: 'k2', name: 'Bob Builder', detail: 'Plumber' }], reason: 'two Bobs', checkedAt: at }
            : { status: 'new' as const, companyStatus: 'new' as const, companyName: 'Board Co', reason: 'no match', checkedAt: at },
    }));
    onResults?.(out);
    onProgress?.(people.length, people.length);
    return out;
  };
  const sent: unknown[] = [];
  const proposalStub: AhoyProposalFn = async (plan) => {
    sent.push(plan);
    return { proposalId: String(sent.length), url: `https://app.ahoy.ai/proposals/${sent.length}` };
  };

  it('checks (read-only), persists, lets you resolve ambiguity, plans and sends proposals, and marks people sent', async () => {
    const { base, token, events } = await setup({ ahoyCheckFn: checkStub, ahoyProposalFn: proposalStub });
    const ids = ['aaa', 'bbb', 'ccc'];
    const r = await req('POST', `${base}/api/ahoy/check`, { token, body: { ids } });
    expect(r.status).toBe(200);
    await until(() => events.some((e) => e.type === 'crm'));
    await until(() => !store!.listExplorerPeople().every((p) => !p.crm) && events.some((e) => e.type === 'notice'));
    const crm = store!.crmMatches();
    expect(crm.get('aaa')).toMatchObject({ status: 'in_crm', companyStatus: 'no_domain' });
    expect(crm.get('bbb')?.status).toBe('ambiguous');

    // ambiguous people are skipped until resolved
    let plan = (await req('POST', `${base}/api/ahoy/plan`, { token, body: { ids } })).json.plan;
    expect(plan.skipped.map((s: { id: string }) => s.id)).toEqual(['bbb']);
    expect((await req('POST', `${base}/api/ahoy/resolve`, { token, body: { id: 'bbb', contactId: 'nope' } })).status).toBe(400);
    const res = await req('POST', `${base}/api/ahoy/resolve`, { token, body: { id: 'bbb', contactId: 'k1' } });
    expect(res.json.crm).toMatchObject({ status: 'in_crm', contactId: 'k1', resolvedByHand: true });
    plan = (await req('POST', `${base}/api/ahoy/plan`, { token, body: { ids } })).json.plan;
    expect(plan.skipped).toEqual([]);
    expect(plan.summary).toMatchObject({ newContacts: 1, existingContacts: 2 });

    const send = await req('POST', `${base}/api/ahoy/send`, { token, body: { ids } });
    expect(send.json.proposals).toBe(1);
    await until(() => [...store!.crmMatches().values()].every((m) => m.sent));
    expect(store!.crmMatches().get('ccc')?.sent).toMatchObject({ proposalId: '1', url: 'https://app.ahoy.ai/proposals/1' });
    // already-sent people are not sent twice
    await until(() => !store!.listExplorerPeople().some(() => false));
    const again = await req('POST', `${base}/api/ahoy/send`, { token, body: { ids } });
    expect(again.status).toBe(400);
    expect(sent).toHaveLength(1);
    // state carries crm for the UI
    const st = (await req('GET', `${base}/api/state`, { token })).json;
    expect(st.people.find((p: { id: string }) => p.id === 'aaa').crm.status).toBe('in_crm');
    expect(st.estimates.ahoyCheckUsdPerPerson).toBeGreaterThan(0);
  });

  it('one Ahoy job at a time; bad input is rejected', async () => {
    let release!: () => void;
    const slow: AhoyCheckFn = (o) => new Promise((r) => { release = () => r(checkStub(o)); });
    const { base, token } = await setup({ ahoyCheckFn: slow, ahoyProposalFn: proposalStub });
    expect((await req('POST', `${base}/api/ahoy/check`, { token, body: { ids: ['aaa'] } })).status).toBe(200);
    expect((await req('POST', `${base}/api/ahoy/check`, { token, body: { ids: ['bbb'] } })).status).toBe(409);
    release();
    expect((await req('POST', `${base}/api/ahoy/check`, { token, body: { ids: ['zzz'] } })).status).toBe(400);
    expect((await req('POST', `${base}/api/ahoy/resolve`, { token, body: { id: 'ccc', contactId: 'new' } })).status).toBe(400);
  });
});

describe('accounts + Chrome extension API', () => {
  const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const profile = {
    url: 'https://www.linkedin.com/in/riley-moss-example/',
    fullName: 'Riley Moss',
    headline: 'CFO at Ledgerly',
    currentCompany: 'Ledgerly',
    sections: { experience: { items: [{ lines: ['Chief Financial Officer', 'Ledgerly', 'Mar 2022 - Present'], companyUrl: 'https://www.linkedin.com/company/ledgerly/' }] } },
  };

  it('pairs, then captures into a new account with a live event; network people are untouched', async () => {
    const { base, token, events } = await setup();
    const ext = (method: string, p: string, o: { body?: unknown; capture?: string; origin?: string } = {}) =>
      req(method, base + p, { body: o.body, headers: { ...(o.capture !== undefined ? { 'X-NB-Capture': o.capture } : {}), Origin: o.origin ?? EXT_ORIGIN } });

    // not paired yet → 401 with a message that says how to pair
    expect((await ext('GET', '/ext/ping', { capture: 'nope' })).json.error).toMatch(/pair/);
    // the page token is not accepted on /ext, and the pairing endpoint needs the page token
    expect((await ext('GET', '/ext/ping', { capture: token })).status).toBe(401);
    expect((await req('POST', `${base}/api/ext/pair`, { body: {} })).status).toBe(401);

    const pair = await req('POST', `${base}/api/ext/pair`, { token, body: {} });
    expect(pair.json.code).toMatch(/^nb1\./);
    const decoded = JSON.parse(Buffer.from(pair.json.code.slice(4), 'base64url').toString());
    expect(decoded.u).toBe(base);
    const cap = decoded.t as string;
    expect(pair.json.extension).toEqual({ paired: true, seenAt: null });

    expect((await ext('GET', '/ext/ping', { capture: cap })).json.ok).toBe(true);
    // the page learns the extension connected (header button turns green)
    const st = await req('GET', `${base}/api/state`, { token });
    expect(st.json.extension.paired).toBe(true);
    expect(typeof st.json.extension.seenAt).toBe('string');
    // a web page can't use the capture token
    expect((await ext('GET', '/ext/ping', { capture: cap, origin: 'https://www.linkedin.com' })).status).toBe(403);

    const look = await ext('GET', `/ext/lookup?url=${encodeURIComponent(profile.url)}&company=Ledgerly`, { capture: cap });
    expect(look.json).toMatchObject({ isConnection: false, capturedAt: null, accounts: [], suggested: null });

    const r = await ext('POST', '/ext/capture', { capture: cap, body: { profile, role: 'decision-maker' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ account: { name: 'Ledgerly' }, createdAccount: true, addedToAccount: true, isConnection: false });
    const ev = events.find((e) => e.type === 'accounts' && e.notice) as any;
    expect(ev.notice).toMatch(/Added Riley Moss to Ledgerly/);
    expect(ev.accounts[0]).toMatchObject({ name: 'Ledgerly', memberCount: 1, roles: { 'decision-maker': 1 } });

    // a bad capture is a 400 with a readable reason
    const bad = await ext('POST', '/ext/capture', { capture: cap, body: { profile: { ...profile, url: 'https://www.linkedin.com/feed/' } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/profile URL/);

    const state = await req('GET', `${base}/api/state`, { token });
    expect(state.json.people).toHaveLength(3);
    expect(state.json.accounts[0].name).toBe('Ledgerly');

    // rotating the pairing invalidates the old code
    await req('POST', `${base}/api/ext/pair`, { token, body: { rotate: true } });
    expect((await ext('GET', '/ext/ping', { capture: cap })).status).toBe(401);
  });

  it('list walk: POST /ext/capture-list → light contacts, anonymous rows, headcounts; idempotent, capped, never in the network', async () => {
    const { base, token, events } = await setup();
    const ext = (body: unknown, o: { capture?: string; origin?: string } = {}) =>
      req('POST', `${base}/ext/capture-list`, { body, headers: { ...(o.capture !== undefined ? { 'X-NB-Capture': o.capture } : {}), Origin: o.origin ?? EXT_ORIGIN } });
    const pair = await req('POST', `${base}/api/ext/pair`, { token, body: {} });
    const cap = JSON.parse(Buffer.from(pair.json.code.slice(4), 'base64url').toString()).t as string;

    const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const page = { kind: 'people-tab', url: 'https://www.linkedin.com/company/ledgerly/people/?keywords=marketing', keywords: 'marketing', companyUrl: 'https://www.linkedin.com/company/ledgerly' };
    const rows = [
      { idx: 0, lines: ['Riley Moss', '· 2nd', 'Head of Brand at Ledgerly'], href: 'https://www.linkedin.com/in/riley-moss-example' },
      { idx: 1, lines: ['Sam Okafor', 'Content Lead'], href: 'https://www.linkedin.com/in/ACoAABcdEfGh1234567' },
      { idx: 2, lines: ['LinkedIn Member', 'Senior Marketing Manager at Ledgerly', 'Hamburg, Germany'], href: '' },
    ];
    const facets = 'What they do\n412 Marketing\n1,023 Sales';
    const body = { runId, accountName: 'Ledgerly', page, rows, header: '1,234 associated members', facets };

    // auth model unchanged: capture token + extension origin only
    expect((await ext(body)).status).toBe(401);
    expect((await ext(body, { capture: token })).status).toBe(401);
    expect((await ext(body, { capture: cap, origin: 'https://www.linkedin.com' })).status).toBe(403);
    expect((await req('GET', `${base}/ext/capture-list`, { headers: { 'X-NB-Capture': cap, Origin: EXT_ORIGIN } })).status).toBe(405);
    // input limits
    const many = Array.from({ length: 101 }, (_, i) => ({ idx: i, lines: ['LinkedIn Member'] }));
    expect((await ext({ ...body, rows: many }, { capture: cap })).status).toBe(400);
    expect((await ext({ ...body, runId: 'not-a-uuid' }, { capture: cap })).status).toBe(400);
    expect((await ext({ ...body, page: { ...page, kind: 'feed' } }, { capture: cap })).status).toBe(400);
    expect((await ext({ ...body, page: { ...page, url: 'https://evil.example/company/x/people/' } }, { capture: cap })).status).toBe(400);
    expect((await ext({ ...body, rows: [{ idx: -1, lines: [] }] }, { capture: cap })).status).toBe(400);
    expect((await ext({ ...body, stopReason: 'bored', final: true }, { capture: cap })).status).toBe(400);
    expect((await ext({ ...body, accountName: undefined, page: { ...page, companyUrl: undefined } }, { capture: cap })).status).toBe(400);

    const r1 = await ext(body, { capture: cap });
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ account: { name: 'Ledgerly' }, createdAccount: true, added: 2, anonymous: 1, totalRows: 3, run: { id: runId, named: 2, anonymous: 1, rowsSeen: 3, pageKind: 'people-tab', keywords: 'marketing' } });
    const accountId = r1.json.account.id as string;
    expect(store!.accounts.get(accountId)!.linkedinUrl).toBe('https://www.linkedin.com/company/ledgerly');

    // the same batch again: nothing new
    const r2 = await ext(body, { capture: cap });
    expect(r2.json).toMatchObject({ createdAccount: false, added: 0, anonymous: 0, run: { named: 2, anonymous: 1, rowsSeen: 3 } });
    const view = (await req('GET', `${base}/api/accounts/${accountId}`, { token })).json;
    expect(view.members.map((m: any) => [m.fullName, m.kind, m.sources[0].kind, m.sources[0].runId])).toEqual(
      expect.arrayContaining([['Riley Moss', 'light', 'extension-list', runId], ['Sam Okafor', 'light', 'extension-list', runId]]),
    );
    expect(view.members).toHaveLength(2); // the anonymous row is a count, never a member
    expect(store!.accounts.anonRows(runId)).toEqual([{ runId, idx: 2, headline: 'Senior Marketing Manager at Ledgerly', location: 'Hamburg, Germany' }]);

    // header → query-scoped headcount, replaced (not added) when the run posts it again; "What they do" on this
    // keyword-filtered tab counts the result set, so it is never stored
    const hc = () => store!.accounts.headcounts(accountId).map((h) => [h.scope, h.label, h.count, h.source, h.runId]);
    expect(hc()).toEqual([['query', 'marketing', 1234, 'linkedin-people', runId]]);
    await ext({ ...body, rows: [], facets: 'What they do\n420 Marketing', header: '1,240 associated members' }, { capture: cap });
    expect(hc()).toEqual([['query', 'marketing', 1240, 'linkedin-people', runId]]);

    // an empty / unreadable header (e.g. on a final post) keeps the run's snapshot
    await ext({ ...body, rows: [], facets: 'What they do', header: '' }, { capture: cap });
    expect(hc()).toHaveLength(1);

    // finishing: stop reason stored, notice sent, later posts to the run refused
    const fin = await ext({ runId, accountId, page, rows: [], final: true, stopReason: 'checkpoint' }, { capture: cap });
    expect(fin.json.run).toMatchObject({ stopReason: 'checkpoint', named: 2, anonymous: 1 });
    expect(fin.json.run.finishedAt).not.toBe('');
    expect((events.filter((e) => e.type === 'accounts' && (e as any).notice).pop() as any).notice).toMatch(/Mapped 2 people \+ 1 anonymous .*Ledgerly.*checkpoint/);
    expect((await ext(body, { capture: cap })).status).toBe(409);
    expect(store!.accounts.listRuns(accountId)[0]).toMatchObject({ id: runId, stopReason: 'checkpoint' });

    // a run never holds more than 1,000 rows
    const run2 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
    for (let b = 0; b < 10; b++) {
      const batch = Array.from({ length: 100 }, (_, i) => ({ idx: b * 100 + i, lines: ['LinkedIn Member', `Role ${b * 100 + i}`] }));
      expect((await ext({ runId: run2, accountId, page, rows: batch }, { capture: cap })).status).toBe(200);
    }
    expect(store!.accounts.getListRun(run2)).toMatchObject({ rowsSeen: 1000, anonymous: 1000 });
    expect((await ext({ runId: run2, accountId, page, rows: [{ idx: 1000, lines: ['LinkedIn Member'] }] }, { capture: cap })).status).toBe(409);
    // a run stays on its account
    const other = (await req('POST', `${base}/api/accounts`, { token, body: { name: 'Globex' } })).json.account.id;
    expect((await ext({ runId, accountId: other, page, rows: [] }, { capture: cap })).status).toBe(409);

    // headcount scope: company only for an unfiltered People tab; a keyword-less search or a filtered tab is a query
    const scopeRun = async (rid: string, pg: Record<string, unknown>) => {
      expect((await ext({ runId: rid, accountId, page: pg, rows: [], header: '900 results' }, { capture: cap })).status).toBe(200);
      return store!.accounts.headcounts(accountId).filter((h) => h.runId === rid).map((h) => [h.scope, h.label, h.source]);
    };
    expect(await scopeRun('2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', { kind: 'people-tab', url: 'https://www.linkedin.com/company/ledgerly/people/' }))
      .toEqual([['company', '', 'linkedin-people']]);
    expect(await scopeRun('3d9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', { kind: 'search', url: 'https://www.linkedin.com/search/results/people/?keywords=marketing&origin=X&page=2&spellCorrectionEnabled=true' }))
      .toEqual([['query', 'marketing', 'linkedin-search']]); // only result-set filters label it (no page / origin / UI flags)
    expect(await scopeRun('4e9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', { kind: 'people-tab', url: 'https://www.linkedin.com/company/ledgerly/people/?facetGeoRegion=101' }))
      .toEqual([['query', 'facetGeoRegion: 101', 'linkedin-people']]);
    expect(await scopeRun('5f9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', { kind: 'search', url: 'https://www.linkedin.com/search/results/people/' }))
      .toEqual([['query', '', 'linkedin-search']]);

    // list people never enter the network
    expect((await req('GET', `${base}/api/state`, { token })).json.people.map((p: any) => p.id).sort()).toEqual(['aaa', 'bbb', 'ccc']);
    // the accounts list now tells the extension each account's LinkedIn page (to preselect it)
    const accs = (await req('GET', `${base}/ext/accounts`, { headers: { 'X-NB-Capture': cap, Origin: EXT_ORIGIN } })).json.accounts;
    expect(accs.find((a: any) => a.id === accountId).linkedinUrl).toBe('https://www.linkedin.com/company/ledgerly');
  });

  it('"Capture headcount only": a final post with zero rows stores the counts as snapshots and says so', async () => {
    const { base, token, events } = await setup();
    const pair = await req('POST', `${base}/api/ext/pair`, { token, body: {} });
    const cap = JSON.parse(Buffer.from(pair.json.code.slice(4), 'base64url').toString()).t as string;
    const id = (await req('POST', `${base}/api/accounts`, { token, body: { name: 'Ledgerly' } })).json.account.id;
    const r = await req('POST', `${base}/ext/capture-list`, {
      headers: { 'X-NB-Capture': cap, Origin: EXT_ORIGIN },
      body: {
        runId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', accountId: id, rows: [], final: true, stopReason: 'end',
        page: { kind: 'people-tab', url: 'https://www.linkedin.com/company/ledgerly/people/', keywords: '' },
        header: '1,250 associated members', facets: 'What they do\n90 Sales\n44 Marketing',
      },
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ added: 0, totalRows: 0, headcount: { members: 1250, functions: 2 } });
    await until(() => events.some((e) => e.type === 'accounts' && /Saved LinkedIn headcount for Ledgerly: 1,250 members, 2 “What they do” counts/.test(e.notice ?? '')));
    const org = (await req('GET', `${base}/api/accounts/${id}`, { token })).json.org;
    expect(org.headcount.linkedin.company.count).toBe(1250);
    expect(org.headcount.linkedin.marketing.count).toBe(44);
    expect(org.members).toEqual([]);
    expect(org.runs).toEqual([]); // a counts-only capture is not a walk
    expect((await req('GET', `${base}/api/accounts/${id}`, { token })).status).toBe(200);
    // on a FILTERED People tab, "What they do" counts the result set: not stored (the header is a query count)
    const f = await req('POST', `${base}/ext/capture-list`, {
      headers: { 'X-NB-Capture': cap, Origin: EXT_ORIGIN },
      body: {
        runId: '9b2d1c3e-5f60-4a7b-8c9d-0e1f2a3b4c5d', accountId: id, rows: [], final: true,
        page: { kind: 'people-tab', url: 'https://www.linkedin.com/company/ledgerly/people/?keywords=marketing', keywords: 'marketing' },
        header: '300 associated members', facets: 'What they do\n9 Sales\n200 Marketing',
      },
    });
    expect(f.json.headcount).toEqual({ members: 300, functions: 0 });
    const org2 = (await req('GET', `${base}/api/accounts/${id}`, { token })).json.org;
    expect(org2.headcount.linkedin.marketing.count).toBe(44);
    expect(org2.headcount.linkedin.company.count).toBe(1250);
    expect(org2.headcount.linkedin.queries.map((q: any) => [q.label, q.count])).toEqual([['marketing', 300]]);
  });

  it('manages accounts and members from the page', async () => {
    const { base, token } = await setup();
    const created = await req('POST', `${base}/api/accounts`, { token, body: { name: 'Initech', domain: 'initech.example' } });
    const id = created.json.account.id;
    expect((await req('POST', `${base}/api/accounts`, { token, body: { name: 'initech' } })).status).toBe(400);
    const add = await req('POST', `${base}/api/accounts/${id}/members`, { token, body: { ids: ['aaa', 'bbb', 'zzz'] } });
    expect(add.json.added).toEqual(['aaa', 'bbb']);
    expect(add.json.unknown).toEqual(['zzz']);
    const up = await req('PUT', `${base}/api/accounts/${id}/members/bbb`, { token, body: { role: 'champion', reportsTo: 'aaa', department: 'sales' } });
    expect(up.json.view.members.find((m: any) => m.id === 'bbb')).toMatchObject({ role: 'champion', reportsTo: 'aaa', department: 'sales', isConnection: true });
    expect((await req('PUT', `${base}/api/accounts/${id}/members/bbb`, { token, body: { role: 'boss' } })).status).toBe(400);
    await req('PUT', `${base}/api/accounts/${id}`, { token, body: { brief: '## Why now\nNew CFO.' } });
    const brief = await req('GET', `${base}/api/accounts/${id}/brief`, { token });
    expect(brief.json.markdown).toContain('New CFO.');
    expect(brief.json.markdown).toContain('**Champion:** Bob Builder');
    expect((await req('DELETE', `${base}/api/accounts/${id}/members/aaa`, { token })).json.view.members).toHaveLength(1);
    expect((await req('DELETE', `${base}/api/accounts/${id}`, { token })).json.accounts).toEqual([]);
    expect((await req('GET', `${base}/api/accounts/${id}`, { token })).status).toBe(404);
  });

  it('adds light contacts by hand and edits org fields with provenance', async () => {
    const { base, token } = await setup();
    const id = (await req('POST', `${base}/api/accounts`, { token, body: { name: 'Ledgerly' } })).json.account.id;
    const url = `${base}/api/accounts/${id}/contacts`;
    const contacts = [
      { fullName: 'Jonas Müller-Brandt', url: 'https://www.linkedin.com/in/ACoAABjonas1234567', title: 'Head of Brand' },
      { fullName: 'Sam Okafor', headline: 'Content Lead at Ledgerly', location: 'Munich' },
    ];
    expect((await req('POST', url, { body: { contacts } })).status).toBe(401);
    expect((await req('POST', url, { token, body: { contacts: Array.from({ length: 501 }, (_, i) => ({ fullName: `P ${i}` })) } })).status).toBe(400);
    expect((await req('POST', url, { token, body: { contacts: [{ fullName: 'X', url: 42 }] } })).status).toBe(400);
    expect((await req('POST', url, { token, body: { contacts: [{ title: 'No name' }] } })).status).toBe(400);
    expect((await req('POST', url, { token, body: { contacts: 'nope' } })).status).toBe(400);
    expect((await req('POST', url, { token, body: { contacts, role: 'boss' } })).status).toBe(400);
    expect((await req('POST', `${base}/api/accounts/nope/contacts`, { token, body: { contacts } })).status).toBe(404);

    const r = await req('POST', url, { token, body: { contacts, role: 'influencer' } });
    expect(r.status).toBe(200);
    expect(r.json.added).toHaveLength(2);
    expect(r.json.view.members.map((m: any) => [m.fullName, m.kind, m.role, m.sources[0].kind])).toEqual(
      expect.arrayContaining([['Jonas Müller-Brandt', 'light', 'influencer', 'manual'], ['Sam Okafor', 'light', 'influencer', 'manual']]),
    );
    const again = await req('POST', url, { token, body: { contacts } });
    expect(again.json.added).toEqual([]);
    // light contacts never enter the network
    expect((await req('GET', `${base}/api/state`, { token })).json.people.map((p: any) => p.id).sort()).toEqual(['aaa', 'bbb', 'ccc']);

    const [jonas, sam] = r.json.added as string[];
    const put = (pid: string, body: unknown) => req('PUT', `${base}/api/accounts/${id}/members/${pid}`, { token, body });
    const up = await put(sam!, { reportsTo: jonas, subfunction: 'content', team: 'Editorial', entity: 'Ledgerly GmbH', country: 'DE', responsibilities: 'Blog and newsletter', noise: 'none' });
    expect(up.status).toBe(200);
    expect(up.json.view.members.find((m: any) => m.id === sam)).toMatchObject({
      reportsTo: jonas, reportsToSource: 'user', subfunction: 'content', autoSubfunction: false, team: 'Editorial', entity: 'Ledgerly GmbH',
      country: 'DE', responsibilities: 'Blog and newsletter', noise: '',
    });
    // every account view carries the org map (Phase 5): the page renders the tree from it, never rebuilds it
    const org = up.json.view.org;
    expect(org).toMatchObject({ scope: 'marketing', flagged: [], unplaced: [] });
    expect(org.roots).toEqual([{ id: jonas, children: [{ id: sam, children: [], edge: { source: 'user', confidence: 1, reason: '' } }] }]);
    expect(org.headcount.captured).toMatchObject({ total: 2, light: 2 });
    expect((await req('GET', `${base}/api/accounts/${id}`, { token })).json.org.members.sort()).toEqual([jonas, sam].sort());
    expect((await put(sam!, { subfunction: 'sales' })).status).toBe(400);
    expect((await put(sam!, { country: 'Germany' })).status).toBe(400);
    expect((await put(sam!, { confirmReportsTo: 'yes' })).status).toBe(400);
    expect((await put(jonas!, { confirmReportsTo: true })).status).toBe(400); // no line to confirm
    expect((await put(sam!, { confirmReportsTo: true })).status).toBe(200);
    expect((await put(sam!, { reportsToSource: 'bogus' })).status).toBe(400);
    const reset = await put(sam!, { reportsToSource: 'auto' });
    expect(reset.json.view.members.find((m: any) => m.id === sam)).toMatchObject({ reportsTo: '', reportsToSource: '' });
    expect(reset.json.accounts[0]).toMatchObject({ captured: 0, light: 2 });
  });

  it('org inference: started only by a token POST, one job at a time, never overrides the user, costs on the ledger, cancellable', async () => {
    const calls: Parameters<OrgInferFn>[0][] = [];
    let release!: () => void;
    let mode: 'ok' | 'wait-abort' = 'ok';
    const orgInferFn: OrgInferFn = async (o) => {
      calls.push(o);
      if (mode === 'wait-abort') {
        await new Promise<void>((resolve) => o.signal!.addEventListener('abort', () => resolve(), { once: true }));
        const e = Object.assign(new Error('Aborted'), { name: 'AbortError' });
        throw e;
      }
      await new Promise<void>((r) => { release = r; });
      o.onProgress?.({ phase: 'classify', done: 3, total: 3 });
      o.onProgress?.({ phase: 'reporting', done: 3, total: 3 });
      const [cmo, brand, ic] = o.members.map((m) => m.id);
      return {
        classified: new Map(o.ids!.map((id) => [id, { subfunction: 'brand' as const, seniority: 'ic' as const, noise: '' as const, confidence: 0.6, reason: 'stub', model: 'haiku', at: 'now' }])),
        edges: [
          { id: brand!, managerId: ic!, confidence: 0.6, reason: 'should be ignored (user line)', source: 'llm' as const },
          { id: ic!, managerId: brand!, confidence: 0.6, reason: 'same team', source: 'llm' as const },
          { id: cmo!, managerId: null, confidence: 0.3, reason: '', source: 'llm' as const },
        ],
        costUsd: 0.012, costIncomplete: false, failedBatches: 0, reportingFallback: false,
      };
    };
    const { base, token, events } = await setup({ orgInferFn });
    const id = (await req('POST', `${base}/api/accounts`, { token, body: { name: 'Ledgerly' } })).json.account.id;
    const added = (await req('POST', `${base}/api/accounts/${id}/contacts`, { token, body: { contacts: [
      { fullName: 'Ava Lindqvist', title: 'CMO' }, { fullName: 'Ben Ortiz', title: 'Director Brand' }, { fullName: 'Dev Rao', title: 'Brand Specialist' },
    ] } })).json.added as string[];
    const [cmo, brand, ic] = added;
    await req('PUT', `${base}/api/accounts/${id}/members/${brand}`, { token, body: { reportsTo: cmo, subfunction: 'leadership' } });

    const url = `${base}/api/accounts/${id}/org/infer`;
    expect((await req('POST', url, { body: {} })).status).toBe(401);
    expect((await req('GET', url, { token })).status).toBe(405);
    expect((await req('POST', `${base}/api/accounts/nope/org/infer`, { token, body: {} })).status).toBe(404);
    expect((await req('POST', url, { token, body: { ids: ['not-on-account'] } })).status).toBe(400);
    expect((await req('POST', url, { token, body: { ids: 'x' } })).status).toBe(400);
    expect(calls).toHaveLength(0);

    const r = await req('POST', url, { token, body: {} });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ started: 3, queue: { orgJob: { accountId: id, kind: 'infer' } } });
    expect(r.json.estimateUsd).toBeGreaterThan(0);
    expect((await req('POST', url, { token, body: {} })).status).toBe(409);
    expect((await req('GET', `${base}/api/state`, { token })).json.estimates.orgInferUsdPer100).toBeGreaterThan(0);
    await until(() => Boolean(release));
    release();
    await until(() => events.some((e) => e.type === 'accounts' && /Classified 3 people; 1 reporting line suggested/.test(e.notice ?? '')));
    await until(() => (events.filter((e) => e.type === 'queue').at(-1) as any)?.queue.orgJob === null);
    expect(calls[0]).toMatchObject({ model: 'haiku', ids: added });
    // the job's total is people from start to finish
    const totals = events.flatMap((e) => (e.type === 'queue' && e.queue.orgJob ? [e.queue.orgJob.total] : []));
    expect(totals.length).toBeGreaterThan(2);
    expect(new Set(totals)).toEqual(new Set([3]));
    expect(r.json.estimateUsd).toBeCloseTo(0.005); // per-run floor

    const view = (await req('GET', `${base}/api/accounts/${id}`, { token })).json;
    const m = new Map(view.members.map((x: any) => [x.id, x]));
    expect(m.get(brand)).toMatchObject({ reportsTo: cmo, reportsToSource: 'user', subfunction: 'leadership', autoSubfunction: false, inference: { subfunction: 'brand' } });
    expect(m.get(ic)).toMatchObject({ reportsTo: brand, reportsToSource: 'inferred', reportsToConfidence: 0.6, subfunction: 'brand' });
    expect(store!.explorerCosts().org).toBeCloseTo(0.012);
    expect((await req('GET', `${base}/api/state`, { token })).json.costs.org).toBeCloseTo(0.012);

    // cancel: nothing changes; cancel on an idle account is a no-op
    mode = 'wait-abort';
    expect((await req('POST', `${base}/api/accounts/${id}/org/cancel`, { token, body: {} })).json.cancelled).toBe(false);
    expect((await req('POST', url, { token, body: { ids: [ic] } })).status).toBe(200);
    expect((await req('POST', `${base}/api/accounts/${id}/org/cancel`, { token, body: {} })).json.cancelled).toBe(true);
    await until(() => events.some((e) => e.type === 'notice' && /cancelled/.test(e.message)));
    expect((await req('GET', `${base}/api/state`, { token })).json.queue.orgJob).toBeNull();
    expect((await req('GET', `${base}/api/accounts/${id}`, { token })).json.members.find((x: any) => x.id === ic)).toMatchObject({ reportsTo: brand, reportsToSource: 'inferred' });
  });

  // ---- web org research (Phase 4); the pass runner is stubbed, all people fictional ----
  const passOk = (pass: any, raw: unknown, costUsd = 0.1) => ({ pass, status: 'ok' as const, data: normalizeOrgResearch(raw as any), model: 'stub', costUsd, durationMs: 1 });
  const passRl = (pass: any, costUsd = 0.01) => ({ pass, status: 'rate_limited' as const, error: 'web search was rate-limited', model: 'stub', costUsd, durationMs: 1 });
  const ev = (path: string) => `https://www.ledgerly.example${path}`;
  const seedRaw = {
    people: [
      { name: 'Ava Lindqvist', title: 'Chief Marketing Officer', entity: '', country: '', subfunction: 'leadership', evidenceUrl: ev('/leadership'), quote: 'Ava Lindqvist, CMO', date: '' },
      { name: 'Riley Moss', title: 'Head of Communications', entity: 'Ledgerly Services GmbH', country: 'DE', subfunction: 'comms-pr', evidenceUrl: ev('/leadership'), quote: 'Riley Moss leads communications', date: '' },
      { name: 'Dev Rao', title: 'Brand Lead', entity: '', country: '', subfunction: 'brand', evidenceUrl: 'https://www.linkedin.com/in/devrao', quote: 'Brand Lead', date: '' },
      { name: 'Noor Haddad', title: 'Content Lead', entity: '', country: '', subfunction: 'content', evidenceUrl: '', quote: 'x', date: '' },
    ],
    facts: [
      { kind: 'reporting', text: 'Riley Moss reports to the CMO.', entity: '', country: '', subject: 'Riley Moss', manager: 'Ava Lindqvist', evidenceUrl: ev('/press/riley'), quote: 'Riley Moss, who reports to CMO Ava Lindqvist', confidence: 0.9 },
      { kind: 'reporting', text: 'Ben Ortiz reports to Riley Moss.', entity: '', country: '', subject: 'Ben Ortiz', manager: 'Riley Moss', evidenceUrl: ev('/press/ben'), quote: 'Ben Ortiz reports to Riley Moss', confidence: 0.9 },
      { kind: 'entity', text: 'Group marketing sits in the services entity.', entity: 'Ledgerly Services GmbH', country: 'DE', subject: '', manager: '', evidenceUrl: ev('/imprint'), quote: 'Ledgerly Services GmbH', confidence: 0.6 },
    ],
    headcounts: [{ label: 'employees', scope: 'company', count: 1200, evidenceUrl: ev('/about'), quote: 'over 1,200 employees' }],
    searchesRun: 5,
    rateLimited: false,
  };
  const empty = { people: [], facts: [], headcounts: [], searchesRun: 2, rateLimited: false };

  it('web org research: token POST only, sequential passes, backoff on rate limits, evidence kept, never over a user line, idempotent', async () => {
    const calls: Parameters<OrgResearchFn>[0][] = [];
    let seedLimited = 1;
    const orgResearchFn: OrgResearchFn = async (o) => {
      calls.push(o);
      if (o.pass === 'seed' && seedLimited-- > 0) return passRl('seed');
      return o.pass === 'seed' ? passOk('seed', seedRaw, 0.4) : passOk(o.pass, empty, 0.05);
    };
    const { base, token, events } = await setup({ orgResearchFn, backoffMs: [5] });
    const id = (await req('POST', `${base}/api/accounts`, { token, body: { name: 'Ledgerly', domain: 'ledgerly.example' } })).json.account.id;
    const [ava, ben] = (await req('POST', `${base}/api/accounts/${id}/contacts`, { token, body: { contacts: [
      { fullName: 'Ava Lindqvist', title: 'CMO' }, { fullName: 'Ben Ortiz', title: 'Director Brand' },
    ] } })).json.added as string[];
    await req('PUT', `${base}/api/accounts/${id}/members/${ben}`, { token, body: { reportsTo: ava } }); // the user's line

    const url = `${base}/api/accounts/${id}/org/research`;
    expect((await req('POST', url, { body: {} })).status).toBe(401);
    expect((await req('GET', url, { token })).status).toBe(405);
    expect((await req('POST', `${base}/api/accounts/nope/org/research`, { token, body: {} })).status).toBe(404);
    expect((await req('POST', url, { token, body: { passes: ['seed', 'linkedin'] } })).status).toBe(400);
    expect((await req('POST', url, { token, body: { passes: [] } })).status).toBe(400);
    expect((await req('POST', url, { token, body: { passes: 'seed' } })).status).toBe(400);
    expect(calls).toHaveLength(0);
    const st = (await req('GET', `${base}/api/state`, { token })).json;
    expect(st.estimates.orgResearchUsd).toEqual({ min: 0.3, max: 1.4 });
    expect(st.estimates.orgResearchPassUsd.seed.max).toBeGreaterThan(st.estimates.orgResearchPassUsd.press.max);

    const r = await req('POST', url, { token, body: { passes: ['press', 'seed'] } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ started: 2, passes: ['seed', 'press'], queue: { orgJob: { accountId: id, kind: 'research', phase: 'seed', done: 0, total: 2 } } });
    expect(r.json.estimate.min).toBeGreaterThan(0);
    expect((await req('POST', `${base}/api/accounts/${id}/org/infer`, { token, body: {} })).status).toBe(409); // one org job at a time
    await until(() => events.some((e) => e.type === 'accounts' && /Web research done/.test(e.notice ?? '')));
    await until(() => (events.filter((e) => e.type === 'queue').at(-1) as any)?.queue.orgJob === null);

    expect(calls.map((c) => c.pass)).toEqual(['seed', 'seed', 'press']); // rate-limited seed retried after the backoff
    expect(calls.map((c) => c.model)).toEqual(['sonnet', 'sonnet', 'haiku']);
    expect(calls[0]!.known.people.map((p) => p.name)).toEqual(expect.arrayContaining(['Ava Lindqvist', 'Ben Ortiz']));
    expect(calls[2]!.known.people.map((p) => p.name)).toContain('Riley Moss'); // later passes see earlier findings
    expect(events.some((e) => e.type === 'notice' && /rate-limited — pausing/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === 'queue' && e.queue.orgJob?.pausedUntil)).toBe(true);
    expect(store!.explorerCosts().org).toBeCloseTo(0.01 + 0.4 + 0.05);

    const view = (await req('GET', `${base}/api/accounts/${id}`, { token })).json;
    const byName = new Map(view.members.map((m: any) => [m.fullName, m]));
    expect(view.members).toHaveLength(3); // Ava confirmed (not duplicated), Riley added, LinkedIn-only / evidence-less people dropped
    const riley = byName.get('Riley Moss') as any;
    expect(riley).toMatchObject({ kind: 'light', title: 'Head of Communications', entity: 'Ledgerly Services GmbH', country: 'DE', subfunction: 'comms-pr', confidence: 0.9 });
    expect(riley.reportsTo).toBe(ava);
    expect(riley).toMatchObject({ reportsToSource: 'web', reportsToConfidence: 0.9 });
    expect(riley.reportsToReason).toContain(ev('/press/riley'));
    expect(riley.sources).toEqual([expect.objectContaining({ kind: 'web', evidenceUrl: ev('/leadership'), quote: 'Riley Moss leads communications' })]);
    expect((byName.get('Ava Lindqvist') as any).sources.some((s: any) => s.kind === 'web' && s.evidenceUrl === ev('/leadership'))).toBe(true);
    expect(byName.get('Ben Ortiz')).toMatchObject({ reportsTo: ava, reportsToSource: 'user' }); // web never overrides the user
    for (const m of view.members) for (const s of m.sources.filter((x: any) => x.kind === 'web')) expect(s.evidenceUrl).toMatch(/^https:\/\/www\.ledgerly\.example\//);
    const facts = store!.accounts.orgFacts(id);
    expect(facts).toHaveLength(3);
    expect(facts.find((f) => f.kind === 'entity')!.text).toContain('(Ledgerly Services GmbH, DE)');
    expect(facts.every((f) => /^https:\/\//.test(f.evidenceUrl) && f.quote)).toBe(true);
    expect(store!.accounts.headcounts(id)).toEqual([expect.objectContaining({ source: 'web', scope: 'company', count: 1200, evidenceUrl: ev('/about'), confidence: 0.9 })]);
    // people never enter the network
    expect(store!.listExplorerPeople().some((p) => p.fullName === 'Riley Moss')).toBe(false);

    // the same research again: nothing duplicated
    const nContacts = store!.accounts.allContacts().length;
    expect((await req('POST', url, { token, body: { passes: ['seed'] } })).status).toBe(200);
    await until(() => events.filter((e) => e.type === 'accounts' && /Web research done/.test(e.notice ?? '')).length === 2);
    expect(store!.accounts.allContacts().length).toBe(nContacts);
    expect(store!.accounts.members(id)).toHaveLength(3);
    expect(store!.accounts.orgFacts(id)).toHaveLength(3);
    expect(store!.accounts.headcounts(id)).toHaveLength(1);
    const riley2 = store!.accounts.members(id).find((m) => m.personId === riley.id)!;
    expect(riley2.sources.filter((s) => s.kind === 'web')).toHaveLength(1);
  });

  it('web org research: name-only match for web people, edge confidence from the fact, duplicates reported', async () => {
    const raw = {
      ...empty,
      people: [
        { name: 'Ava Lindqvist', title: 'Chief Marketing Officer', entity: '', country: '', subfunction: 'leadership', evidenceUrl: 'https://news.example/ava', quote: 'CMO Ava Lindqvist', date: '' },
        { name: 'Sam Okafor', title: 'Head of Brand', entity: '', country: '', subfunction: 'brand', evidenceUrl: ev('/team'), quote: 'Sam Okafor, Head of Brand', date: '' },
        { name: 'Dev Rao', title: 'Digital Lead', entity: '', country: '', subfunction: 'digital-social', evidenceUrl: ev('/team'), quote: 'Dev Rao, Digital', date: '' },
      ],
      facts: [
        { kind: 'reporting', text: 'Sam reports to the CMO.', entity: '', country: '', subject: 'Sam Okafor', manager: 'Ava Lindqvist', evidenceUrl: ev('/team'), quote: 'Sam Okafor works with CMO Ava Lindqvist', confidence: 0.7 },
        { kind: 'reporting', text: 'Dev maybe reports to Sam.', entity: '', country: '', subject: 'Dev Rao', manager: 'Sam Okafor', evidenceUrl: ev('/team'), quote: 'Dev Rao and Sam Okafor', confidence: 0.4 },
        { kind: 'reporting', text: 'Kai reports to Ava.', entity: '', country: '', subject: 'Kai Brandt', manager: 'Ava Lindqvist', evidenceUrl: ev('/team'), quote: 'Kai Brandt reports to Ava Lindqvist', confidence: 0.9 },
      ],
    };
    const orgResearchFn: OrgResearchFn = async (o) => passOk(o.pass, raw, 0.1);
    const { base, token, events } = await setup({ orgResearchFn });
    const id = (await req('POST', `${base}/api/accounts`, { token, body: { name: 'Ledgerly', domain: 'ledgerly.example' } })).json.account.id;
    const [ava] = (await req('POST', `${base}/api/accounts/${id}/contacts`, { token, body: { contacts: [
      { fullName: 'Ava Lindqvist', title: 'CMO' }, // "CMO" vs "Chief Marketing Officer"
      { fullName: 'Dev Rao', url: 'https://www.linkedin.com/in/dev-rao-1', title: 'Werkstudent Vertrieb' }, { fullName: 'Dev Rao', url: 'https://www.linkedin.com/in/dev-rao-2', title: 'Sales Intern' },
    ] } })).json.added as string[];
    expect(store!.accounts.members(id)).toHaveLength(3);
    expect((await req('POST', `${base}/api/accounts/${id}/org/research`, { token, body: { passes: ['seed'] } })).status).toBe(200);
    const done = () => events.find((e) => e.type === 'accounts' && /Web research done/.test(e.notice ?? '')) as any;
    await until(() => Boolean(done()));
    const ms = store!.accounts.members(id);
    expect(ms.filter((m) => m.personId === ava)).toHaveLength(1);
    expect(ms).toHaveLength(5); // Ava matched by name alone; Sam new; Dev ambiguous (two Devs) → new + warning
    const view = (await req('GET', `${base}/api/accounts/${id}`, { token })).json;
    const sam = view.members.find((m: any) => m.fullName === 'Sam Okafor');
    expect(sam).toMatchObject({ reportsTo: ava, reportsToSource: 'web', reportsToConfidence: 0.7 });
    expect(view.members.filter((m: any) => m.reportsToSource === 'web')).toHaveLength(1); // 0.4 edge and unknown Kai skipped
    expect(view.members.find((m: any) => m.id === ava).sources.some((s: any) => s.kind === 'web')).toBe(true);
    expect(done().notice).toMatch(/possible duplicate to check: Dev Rao/);
  });

  it('web org research: exhausted backoff waits for Resume; cancel keeps finished passes', async () => {
    const calls: string[] = [];
    let pressLimited = 2;
    const orgResearchFn: OrgResearchFn = async (o) => {
      calls.push(o.pass);
      if (o.pass === 'seed') return passOk('seed', { ...empty, people: [seedRaw.people[1]] }, 0.3);
      if (o.pass === 'press' && pressLimited-- > 0) return passRl('press');
      if (o.pass === 'press') return passOk('press', empty, 0.05);
      // jobs: hangs until cancelled; an aborted call carries its spend
      await new Promise<void>((resolve) => o.signal!.addEventListener('abort', () => resolve(), { once: true }));
      throw Object.assign(new Error('Aborted'), { name: 'AbortError', details: {} });
    };
    const { base, token, events } = await setup({ orgResearchFn, backoffMs: [5] });
    const id = (await req('POST', `${base}/api/accounts`, { token, body: { name: 'Ledgerly', domain: 'ledgerly.example' } })).json.account.id;
    const other = (await req('POST', `${base}/api/accounts`, { token, body: { name: 'Globex' } })).json.account.id;
    const r = await req('POST', `${base}/api/accounts/${id}/org/research`, { token, body: { passes: ['seed', 'press', 'jobs'] } });
    expect(r.status).toBe(200);
    const lastQueue = () => (events.filter((e) => e.type === 'queue').at(-1) as any)?.queue;
    await until(() => lastQueue()?.orgJob?.pausedManual === true);
    expect(lastQueue().orgJob).toMatchObject({ kind: 'research', phase: 'press', done: 1, total: 3 });
    expect(calls).toEqual(['seed', 'press', 'press']); // one timed backoff, then a manual pause — no tight loop
    await sleep(30);
    expect(calls).toHaveLength(3);
    expect(events.some((e) => e.type === 'notice' && /Click Resume/.test(e.message))).toBe(true);
    // the seed pass is already saved
    expect(store!.accounts.members(id)).toHaveLength(1);
    expect((await req('POST', `${base}/api/accounts/${id}/org/research`, { token, body: {} })).status).toBe(409);
    expect((await req('POST', `${base}/api/accounts/${other}/org/resume`, { token, body: {} })).json.resumed).toBe(false);
    expect((await req('POST', `${base}/api/accounts/${id}/org/resume`, { body: {} })).status).toBe(401);

    expect((await req('POST', `${base}/api/accounts/${id}/org/resume`, { token, body: {} })).json.resumed).toBe(true);
    await until(() => calls.includes('jobs'));
    expect(calls).toEqual(['seed', 'press', 'press', 'press', 'jobs']);
    expect((await req('POST', `${base}/api/accounts/${id}/org/resume`, { token, body: {} })).json.resumed).toBe(false); // not paused
    expect((await req('POST', `${base}/api/accounts/${id}/org/cancel`, { token, body: {} })).json.cancelled).toBe(true);
    await until(() => events.some((e) => e.type === 'notice' && /Web research cancelled — findings from finished passes are kept/.test(e.message)));
    await until(() => lastQueue()?.orgJob === null);
    expect(store!.accounts.members(id)).toHaveLength(1);
    expect(store!.explorerCosts().org).toBeCloseTo(0.3 + 0.01 + 0.01 + 0.05);
    // the job is free again
    expect((await req('POST', `${base}/api/accounts/${id}/org/research`, { token, body: { passes: ['seed'] } })).status).toBe(200);
  });

  it('web org research: Resume during a timed pause retries now and resets the backoff', async () => {
    const calls: string[] = [];
    let limited = 2;
    const orgResearchFn: OrgResearchFn = async (o) => {
      calls.push(o.pass);
      return limited-- > 0 ? passRl(o.pass) : passOk(o.pass, empty, 0.05);
    };
    // first pause is long: only Resume ends it; with a reset backoff the second rate limit waits the long step again
    const { base, token, events } = await setup({ orgResearchFn, backoffMs: [60_000, 5] });
    const id = (await req('POST', `${base}/api/accounts`, { token, body: { name: 'Ledgerly' } })).json.account.id;
    expect((await req('POST', `${base}/api/accounts/${id}/org/research`, { token, body: { passes: ['press'] } })).status).toBe(200);
    const lastQueue = () => (events.filter((e) => e.type === 'queue').at(-1) as any)?.queue;
    await until(() => Boolean(lastQueue()?.orgJob?.pausedUntil));
    expect((await req('POST', `${base}/api/accounts/${id}/org/resume`, { token, body: {} })).json.resumed).toBe(true);
    await until(() => calls.length === 2);
    await until(() => Boolean(lastQueue()?.orgJob?.pausedUntil));
    const until1 = Date.parse(lastQueue().orgJob.pausedUntil) - Date.now();
    expect(until1).toBeGreaterThan(30_000); // back at the first (long) step, not the 5 ms one
    await sleep(30);
    expect(calls).toHaveLength(2);
    expect((await req('POST', `${base}/api/accounts/${id}/org/resume`, { token, body: {} })).json.resumed).toBe(true);
    await until(() => lastQueue()?.orgJob === null);
    expect(calls).toEqual(['press', 'press', 'press']);
  });
});
