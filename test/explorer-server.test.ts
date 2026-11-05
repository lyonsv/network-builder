import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/store';
import { inputHash } from '../src/db/hash';
import { stablePortFor } from '../src/web/http-common';
import { startExplorerServer, type AhoyCheckFn, type AhoyProposalFn, type DossierFn, type ExplorerServer, type ScoreFn } from '../src/web/explorer-server';
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

async function setup(o: { dossierFn?: DossierFn; scoreFn?: ScoreFn; ahoyCheckFn?: AhoyCheckFn; ahoyProposalFn?: AhoyProposalFn; backoffMs?: number[]; concurrency?: { light: number; deep: number }; heartbeatMs?: number } = {}) {
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
