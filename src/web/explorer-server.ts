import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { Store } from '../db/store';
import { ensureDir, writeFileAtomic } from '../io/fs-utils';
import { ahoyPaths, explorerExportFilename, snapshotFilename, toAhoyFiles, toExplorerCsv } from '../io/explorer-export';
import type { ExportPreset } from '../io/export';
import { slugify } from '../io/output';
import { createCostTracker } from '../llm/costs';
import { errorCost } from '../llm/claude';
import { buildDossier, DOSSIER_ESTIMATES } from '../llm/dossier';
import { LENS_RERANK_USD_PER_100, LENS_USD_PER_1000, scoreLens } from '../llm/lens';
import { AHOY_CHECK_USD_PER_PERSON, AHOY_SEND_USD_PER_PROPOSAL, checkAhoy, planAhoySend, sendAhoyProposal } from '../llm/ahoy';
import { withLedger } from '../db/store';
import type {
  CostTracker,
  CrmMatch,
  DossierDepth,
  DossierRecord,
  ExplorerCosts,
  ExplorerEvent,
  ExplorerPerson,
  ExplorerState,
  JobQueueState,
  Lens,
  LensScore,
  SavedList,
} from '../types';
import {
  HTML_HEADERS,
  HttpError,
  checkHostAndOrigin,
  isAbortError,
  listenLocal,
  parseIds,
  readJsonBody,
  safeEqual,
  sendJson,
} from './http-common';
import { renderExplorerHtml } from './template';

export type DossierFn = typeof buildDossier;
export type ScoreFn = typeof scoreLens;
export type AhoyCheckFn = typeof checkAhoy;
export type AhoyProposalFn = typeof sendAhoyProposal;

export interface ExplorerServerOptions {
  store: Store;
  dbPath: string;
  outDir: string;
  /** dossier prompt template (contents of dossier.md) */
  template: string;
  /** model for deep dossiers and lens reranking */
  researchModel: string;
  /** exact port (fails if busy) */
  port?: number;
  /** tried when `port` is unset; falls back to a random free port if busy */
  preferredPort?: number;
  concurrency?: { light: number; deep: number };
  dossierFn?: DossierFn;
  scoreFn?: ScoreFn;
  /** Ahoy hooks (tests) */
  ahoyCheckFn?: AhoyCheckFn;
  ahoyProposalFn?: AhoyProposalFn;
  /** model for light dossiers (default haiku) */
  lightModel?: string;
  /** first-pass lens model (default haiku) */
  lensModel?: string;
  /** default rerank band for new lenses */
  rerankTop?: number;
  /** rate-limit backoff schedule (ms); default 1m, 2m, 5m, 10m. After the last step the queue waits for a manual Resume. */
  backoffMs?: number[];
  /** rate-limited attempts per person before it is recorded as an error (default 3) */
  maxRateLimitedAttempts?: number;
  /** heartbeat interval (ms) for SSE pings + checking for other processes' DB changes (default 15s) */
  heartbeatMs?: number;
  /** shared cost tracker (seed + ledger); default: a fresh tracker that writes to the store's ledger */
  costs?: CostTracker;
  /** terminal logging hook */
  onEvent?: (e: ExplorerEvent) => void;
  /** HTML template override (tests); default loads explorer.html */
  htmlTemplate?: string;
}

export interface ExplorerServer {
  url: string;
  port: number;
  token: string;
  state(): ExplorerState;
  /** write the read-only snapshot (api:null) to outputs/<date>_network-explorer.html; '' if the template is missing */
  snapshot(): Promise<string>;
  /** cancel queued work, abort running jobs, write a final snapshot, close sockets */
  close(): Promise<{ snapshot: string }>;
}

const DEPTH_RANK: Record<DossierDepth, number> = { light: 1, deep: 2 };
const LIST_ID = /^[a-z0-9-]{1,64}$/;
const LENS_ID = /^[a-z0-9-]{1,80}$/;

const stripPrompt = ({ prompt: _p, ...l }: SavedList & { prompt?: string | null }): SavedList => l;

export async function startExplorerServer(opts: ExplorerServerOptions): Promise<ExplorerServer> {
  const { store } = opts;
  const token = randomBytes(24).toString('base64url');
  const controller = new AbortController();
  const costs = opts.costs ?? withLedger(createCostTracker(), store);
  const dossierFn = opts.dossierFn ?? buildDossier;
  const scoreFn = opts.scoreFn ?? scoreLens;
  const conc = { light: Math.max(1, opts.concurrency?.light ?? 1), deep: Math.max(1, opts.concurrency?.deep ?? 2) };
  const backoff = opts.backoffMs ?? [60_000, 120_000, 300_000, 600_000];
  const lightModel = opts.lightModel ?? 'haiku';
  const lensModel = opts.lensModel ?? 'haiku';
  const maxRlAttempts = Math.max(1, opts.maxRateLimitedAttempts ?? 3);

  // ---- people (in memory; refreshed per person / after lens jobs) ----
  const people = new Map<string, ExplorerPerson>();
  const reloadPeople = () => {
    people.clear();
    for (const p of store.listExplorerPeople()) people.set(p.id, p);
  };
  // PRAGMA data_version changes only when ANOTHER connection commits (e.g. `network-builder -p …` or an import
  // while the explorer is open), so this reloads exactly when someone else changed the database.
  const dataVersion = (): number => {
    try {
      return Number((store.db.prepare('PRAGMA data_version').get() as { data_version?: number } | undefined)?.data_version ?? 0);
    } catch {
      return 0;
    }
  };
  let seenVersion = dataVersion();
  /** reload when another process committed to the DB; returns true if it did (callers notify clients) */
  const syncFromOthers = (): boolean => {
    const v = dataVersion();
    if (v === seenVersion) return false;
    seenVersion = v;
    reloadPeople();
    return true;
  };
  reloadPeople();
  const refreshPerson = (id: string) => {
    const p = store.getExplorerPerson(id);
    if (p) people.set(id, p);
    return p;
  };

  const clients = new Set<ServerResponse>();
  let closing = false;
  let seq = 0;

  // ---- dossier queue ----
  type Job = { id: string; depth: DossierDepth; force: boolean; rlAttempts: number };
  const queued: Job[] = [];
  const running = new Map<string, Job>();
  const inflight = new Set<Promise<void>>();
  let pausedUntil: number | null = null;
  /** set after the backoff schedule is exhausted: only POST /api/dossiers/resume clears it */
  let pausedManual = false;
  let backoffLevel = 0;
  let pauseTimer: NodeJS.Timeout | undefined;

  // ---- lens job (one at a time) ----
  let lensJob: JobQueueState['lensJob'] = null;
  let ahoyJob: JobQueueState['ahoyJob'] = null;
  let ahoyPromise: Promise<void> | null = null;
  let lensPromise: Promise<void> | null = null;

  const queueState = (): JobQueueState => ({
    queued: queued.map(({ id, depth }) => ({ id, depth })),
    running: [...running.values()].map(({ id, depth }) => ({ id, depth })),
    pausedUntil: pausedUntil && pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
    pausedManual,
    lensJob: lensJob ? { ...lensJob } : null,
    ahoyJob: ahoyJob ? { ...ahoyJob } : null,
    seq,
  });
  const bump = () => {
    seq++;
  };
  const costSnapshot = (): ExplorerCosts => {
    let c: ExplorerCosts;
    try {
      c = store.explorerCosts();
    } catch {
      const by = costs.byStage();
      c = { enrich: by.enrich, dossier: by.dossier, lens: by.lens + by.rank, research: by.research, total: 0, incomplete: false };
      c.total = c.enrich + c.dossier + c.lens + c.research;
    }
    return { ...c, incomplete: c.incomplete || costs.isIncomplete() };
  };
  const lists = (): SavedList[] => store.listLists().map(stripPrompt);

  const state = (api: boolean): ExplorerState => {
    syncFromOthers();
    return stateNow(api);
  };
  const stateNow = (api: boolean): ExplorerState => ({
    version: 6,
    generatedAt: new Date().toISOString(),
    people: [...people.values()],
    lenses: store.listLenses(),
    lists: lists(),
    api: api ? { token } : null,
    queue: queueState(),
    costs: costSnapshot(),
    estimates: {
      lightUsd: DOSSIER_ESTIMATES.lightUsd,
      deepUsd: DOSSIER_ESTIMATES.deepUsd,
      lensUsdPer1000: LENS_USD_PER_1000,
      lensRerankUsdPer100: LENS_RERANK_USD_PER_100,
      ahoyCheckUsdPerPerson: AHOY_CHECK_USD_PER_PERSON,
      ahoySendUsdPerProposal: AHOY_SEND_USD_PER_PROPOSAL,
    },
    dbPath: opts.dbPath,
  });

  const emit = (e: ExplorerEvent) => {
    const msg = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) res.write(msg);
    try {
      opts.onEvent?.(e);
    } catch {
      /* a logging hook must never break the server */
    }
  };
  /** reload + tell clients when another process changed the DB (cheap PRAGMA check) */
  const notifyIfChanged = () => {
    try {
      if (!syncFromOthers()) return;
    } catch {
      return;
    }
    emit({ type: 'lenses', lenses: store.listLenses() });
    emit({ type: 'reload', reason: 'the database was changed by another network-builder process' });
  };
  const emitQueue = () => {
    bump();
    emit({ type: 'queue', queue: queueState() });
  };

  const bestDepth = (id: string): number => {
    const d = people.get(id)?.dossier;
    return d && d.status === 'ok' ? DEPTH_RANK[d.depth] : 0;
  };

  const schedulePauseEnd = () => {
    if (pauseTimer) clearTimeout(pauseTimer);
    if (!pausedUntil) return;
    pauseTimer = setTimeout(() => {
      pauseTimer = undefined;
      pausedUntil = null;
      emitQueue();
      pump();
    }, Math.max(0, pausedUntil - Date.now()));
    pauseTimer.unref?.();
  };

  const runDossier = async (job: Job) => {
    const person = people.get(job.id);
    let rec: DossierRecord | undefined;
    if (person) {
      const started = Date.now();
      try {
        rec = await dossierFn(person, {
          depth: job.depth,
          model: job.depth === 'light' ? lightModel : opts.researchModel,
          template: opts.template,
          signal: controller.signal,
        });
      } catch (e) {
        if (isAbortError(e) || controller.signal.aborted) {
          // shutting down: leave the person as-is, but record what the interrupted call already cost
          const ec = errorCost(e);
          if (ec.usd > 0) costs.add('dossier', ec.usd);
          if (ec.incomplete || ec.usd === 0) costs.markIncomplete();
          rec = undefined;
        } else
          rec = {
            personId: job.id,
            depth: job.depth,
            status: 'error',
            error: (e as Error)?.message ?? String(e),
            model: job.depth === 'light' ? lightModel : opts.researchModel,
            costUsd: 0,
            durationMs: Date.now() - started,
            createdAt: new Date().toISOString(),
          };
      }
    }
    running.delete(job.id);
    if (!rec || controller.signal.aborted) {
      bump();
      return;
    }
    if (rec.costUsd > 0) costs.add('dossier', rec.costUsd);

    if (rec.status === 'rate_limited') {
      job.rlAttempts++;
      const alreadyPaused = pausedManual || (pausedUntil !== null && pausedUntil > Date.now());
      if (!alreadyPaused) {
        // escalate once per pause (concurrent jobs hitting the same limit don't each bump the level)
        if (backoffLevel >= backoff.length) {
          pausedManual = true;
          pausedUntil = null;
          if (pauseTimer) clearTimeout(pauseTimer);
          emit({
            type: 'notice',
            level: 'warn',
            message: 'Web search keeps hitting the rate limit — profiles are paused. Click Resume when you want to try again.',
          });
        } else {
          const delay = backoff[backoffLevel] ?? 60_000;
          backoffLevel++;
          pausedUntil = Date.now() + delay;
          schedulePauseEnd();
          emit({
            type: 'notice',
            level: 'warn',
            message: `Web search is rate-limited — pausing profiles for ${Math.max(1, Math.round(delay / 60_000))} min.`,
          });
        }
      }
      if (job.rlAttempts < maxRlAttempts) {
        // not done: back to the front of the queue
        queued.unshift(job);
        emitQueue();
        return;
      }
      // gave up on this person for now: record an error (not ok) so it can be re-queued manually later
      rec = { ...rec, status: 'error', error: `rate-limited ${job.rlAttempts}× — retry later` };
    }

    if (rec.status === 'ok') backoffLevel = 0;
    try {
      store.addDossier(rec);
    } catch (e) {
      emit({ type: 'notice', level: 'error', message: `Could not save dossier: ${(e as Error).message}` });
    }
    const updated = refreshPerson(job.id) ?? person!;
    bump();
    emit({
      type: 'person',
      person: updated,
      costs: costSnapshot(),
      ...(rec.status === 'error' ? { error: rec.error ?? 'unknown error' } : {}),
    });
    emit({ type: 'queue', queue: queueState() });
  };

  const capacity = (depth: DossierDepth) => [...running.values()].filter((j) => j.depth === depth).length < conc[depth];

  const pump = () => {
    if (closing || pausedManual) return;
    if (pausedUntil && pausedUntil > Date.now()) return;
    let started = false;
    for (let i = 0; i < queued.length; ) {
      const job = queued[i]!;
      if (!capacity(job.depth)) {
        i++;
        continue;
      }
      queued.splice(i, 1);
      running.set(job.id, job);
      started = true;
      const p = runDossier(job).finally(() => {
        inflight.delete(p);
        pump();
      });
      inflight.add(p);
    }
    if (started) emitQueue();
  };

  const enqueueDossiers = (ids: string[], depth: DossierDepth, force: boolean) => {
    const accepted: string[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const known = people.has(id);
      const busy = running.has(id) || queued.some((j) => j.id === id);
      const hasEnough = bestDepth(id) >= DEPTH_RANK[depth];
      if (!known || busy || (!force && hasEnough)) {
        skipped.push(id);
        continue;
      }
      queued.push({ id, depth, force, rlAttempts: 0 });
      accepted.push(id);
    }
    if (accepted.length) {
      emitQueue();
      pump();
    }
    return { queued: accepted, skipped, queue: queueState() };
  };

  const cancelDossiers = (ids?: string[]) => {
    const target = ids ? new Set(ids) : undefined;
    const cancelled: string[] = [];
    for (let i = queued.length - 1; i >= 0; i--) {
      if (!target || target.has(queued[i]!.id)) cancelled.unshift(queued.splice(i, 1)[0]!.id);
    }
    if (cancelled.length) emitQueue();
    return { cancelled, queue: queueState() };
  };

  const resumeDossiers = () => {
    const was = pausedManual || (pausedUntil !== null && pausedUntil > Date.now());
    pausedManual = false;
    pausedUntil = null;
    backoffLevel = 0;
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = undefined;
    emitQueue();
    pump();
    return { resumed: was, queue: queueState() };
  };

  // ---- lenses ----
  const findLensByGoal = (goal: string) => {
    const g = goal.trim().toLowerCase();
    return store.listLenses().find((l) => l.goal.trim().toLowerCase() === g);
  };

  const startLensJob = (lens: Lens, targetIds: string[]) => {
    if (lensPromise) throw new HttpError(409, 'a lens is already being scored — wait for it to finish');
    if (!store.acquireLensLock(lens.id)) {
      throw new HttpError(409, `“${lens.goal}” is being scored by another network-builder process — try again when it finishes`);
    }
    const targets = targetIds.map((id) => people.get(id)).filter((p): p is ExplorerPerson => Boolean(p));
    lensJob = { lensId: lens.id, phase: 'score', done: 0, total: targets.length };
    emitQueue();
    const lockBeat = setInterval(() => store.touchLensLock(lens.id), 30_000);
    lockBeat.unref?.();
    lensPromise = (async () => {
      let scores: LensScore[] = [];
      try {
        scores = await scoreFn({
          lens,
          people: targets,
          allPeople: [...people.values()],
          store,
          costs,
          signal: controller.signal,
          onProgress: (p) => {
            lensJob = { lensId: lens.id, phase: p.phase, done: p.done, total: p.total };
            emitQueue();
          },
          // stream each batch to the UI as it lands
          onScores: (batch) => {
            emit({
              type: 'lens',
              lens: store.getLens(lens.id) ?? lens,
              scores: batch.map((x) => ({ personId: x.personId, score: x.score, reason: x.reason, basis: x.basis })),
              costs: costSnapshot(),
            });
          },
        });
      } catch (e) {
        if (!(isAbortError(e) || controller.signal.aborted)) {
          emit({ type: 'notice', level: 'error', message: `Scoring “${lens.goal}” failed: ${(e as Error)?.message ?? e}` });
        }
      } finally {
        clearInterval(lockBeat);
        store.releaseLensLock(lens.id);
        lensJob = null;
        lensPromise = null;
      }
      if (controller.signal.aborted) return;
      reloadPeople();
      const fresh = store.getLens(lens.id) ?? lens;
      emit({
        type: 'lens',
        lens: fresh,
        scores: scores.map((s) => ({ personId: s.personId, score: s.score, reason: s.reason, basis: s.basis })),
        costs: costSnapshot(),
      });
      emit({ type: 'lenses', lenses: store.listLenses() });
      emitQueue();
    })();
    return lensJob;
  };

  const createLens = (body: Record<string, unknown>) => {
    const goal = typeof body.goal === 'string' ? body.goal.replace(/\s+/g, ' ').trim() : '';
    if (!goal) throw new HttpError(400, '`goal` is required');
    if (goal.length > 300) throw new HttpError(400, '`goal` is too long (max 300 chars)');
    const rerankTop =
      body.rerankTop === undefined
        ? opts.rerankTop ?? 150
        : Number.isInteger(body.rerankTop) && (body.rerankTop as number) >= 0 && (body.rerankTop as number) <= 1000
          ? (body.rerankTop as number)
          : (() => {
              throw new HttpError(400, '`rerankTop` must be an integer 0–1000');
            })();
    if (lensPromise) throw new HttpError(409, 'a lens is already being scored — wait for it to finish');
    const existing = findLensByGoal(goal);
    const lens = existing ?? store.createLens({ goal, rankModel: lensModel, rerankModel: rerankTop > 0 ? opts.researchModel : '', rerankTop });
    const ids = existing ? store.staleOrUnscored(lens.id) : [...people.keys()];
    if (ids.length) startLensJob(lens, ids);
    if (!existing) emit({ type: 'lenses', lenses: store.listLenses() });
    return { lens: store.getLens(lens.id) ?? lens, existing: Boolean(existing), scoring: ids.length };
  };

  /** Re-score stale/unscored people, or everyone with `all` (e.g. after the scoring rules improved). */
  const refreshLens = (id: string, all = false) => {
    const lens = store.getLens(id);
    if (!lens) throw new HttpError(404, 'no such lens');
    const ids = all ? [...people.keys()] : store.staleOrUnscored(id);
    if (ids.length) startLensJob(lens, ids);
    return { lens, scoring: ids.length };
  };

  const deleteLens = (id: string) => {
    if (lensJob?.lensId === id) throw new HttpError(409, 'that lens is being scored right now');
    if (!store.deleteLens(id)) throw new HttpError(404, 'no such lens');
    for (const p of people.values()) delete p.scores[id];
    const lenses = store.listLenses();
    emit({ type: 'lenses', lenses });
    return { lenses };
  };

  /** membership edits: pin people in/out by hand, clear pins, or change the score threshold */
  const updateLens = (id: string, body: Record<string, unknown>) => {
    if (!store.getLens(id)) throw new HttpError(404, 'no such lens');
    let scoring = 0;
    if (body.goal !== undefined) {
      const goal = typeof body.goal === 'string' ? body.goal.replace(/\s+/g, ' ').trim() : '';
      if (!goal) throw new HttpError(400, '`goal` must be a non-empty string');
      if (goal.length > 300) throw new HttpError(400, '`goal` is too long (max 300 chars)');
      if (lensJob?.lensId === id) throw new HttpError(409, 'that lens is being scored right now');
      const clash = findLensByGoal(goal);
      if (clash && clash.id !== id) throw new HttpError(409, `another lens already has that goal (“${clash.goal}”)`);
      if (body.rescore === true && lensPromise) throw new HttpError(409, 'a lens is already being scored — wait for it to finish');
      store.setLensGoal(id, goal);
      for (const p of people.values()) {
        const sc = p.scores[id];
        if (sc) sc.stale = true;
      }
      if (body.rescore === true) {
        scoring = people.size;
        startLensJob(store.getLens(id)!, [...people.keys()]);
      }
    } else if (body.rescore !== undefined) throw new HttpError(400, '`rescore` needs `goal`');
    const pin = body.pin;
    if (pin !== undefined && pin !== 'in' && pin !== 'out' && pin !== null) throw new HttpError(400, '`pin` must be "in", "out" or null');
    if (body.threshold !== undefined) {
      const t = body.threshold;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 100) throw new HttpError(400, '`threshold` must be a number 0-100');
      store.setLensThreshold(id, t);
    }
    if (pin !== undefined) {
      const ids = parseIds(body.ids, true)!.filter((x) => people.has(x));
      store.setLensPins(id, ids, pin as 'in' | 'out' | null);
    } else if (body.ids !== undefined) throw new HttpError(400, '`ids` needs `pin`');
    const lenses = store.listLenses();
    emit({ type: 'lenses', lenses });
    return { lens: lenses.find((l) => l.id === id), lenses, scoring };
  };

  // ---- Ahoy CRM (v7): read-only check, manual resolve, send as proposals ----
  const ahoyCheckFn = opts.ahoyCheckFn ?? checkAhoy;
  const ahoyProposalFn = opts.ahoyProposalFn ?? sendAhoyProposal;
  const applyCrm = (updates: { id: string; crm: CrmMatch | null }[]) => {
    const known = updates.filter((u) => people.has(u.id));
    if (!known.length) return;
    store.setCrmMatches(known);
    for (const u of known) {
      const p = people.get(u.id)!;
      if (u.crm) p.crm = u.crm;
      else delete p.crm;
    }
    emit({ type: 'crm', updates: known, costs: costSnapshot() });
  };
  const ahoyBusy = () => {
    if (ahoyPromise) throw new HttpError(409, 'an Ahoy check or send is already running — wait for it to finish');
  };
  const runAhoyJob = (kind: 'check' | 'send', total: number, work: () => Promise<void>) => {
    ahoyJob = { kind, done: 0, total };
    emitQueue();
    ahoyPromise = (async () => {
      try {
        await work();
      } catch (e) {
        if (!(isAbortError(e) || controller.signal.aborted)) {
          emit({ type: 'notice', level: 'error', message: `Ahoy ${kind} failed: ${(e as Error)?.message ?? e}` });
        }
      } finally {
        ahoyJob = null;
        ahoyPromise = null;
        if (!controller.signal.aborted) emitQueue();
      }
    })();
  };
  const ahoyCheck = (body: Record<string, unknown>) => {
    ahoyBusy();
    const targets = parseIds(body.ids, true)!.map((id) => people.get(id)).filter((p): p is ExplorerPerson => Boolean(p));
    if (!targets.length) throw new HttpError(400, 'no known people in `ids`');
    runAhoyJob('check', targets.length, async () => {
      await ahoyCheckFn({
        people: targets,
        costs,
        signal: controller.signal,
        onResults: (u) => applyCrm(u),
        onProgress: (done, total) => {
          ahoyJob = { kind: 'check', done, total };
          emitQueue();
        },
      });
      const r = targets.map((p) => people.get(p.id)?.crm?.status);
      const n = (s: string) => r.filter((x) => x === s).length;
      emit({ type: 'notice', level: n('error') ? 'warn' : 'info', message:
        `Ahoy check done: ${n('in_crm')} already in Ahoy, ${n('new')} new, ${n('ambiguous')} to pick${n('error') ? `, ${n('error')} failed` : ''}.` });
    });
    return { checking: targets.length, queue: queueState() };
  };
  const ahoyResolve = (body: Record<string, unknown>) => {
    const id = typeof body.id === 'string' ? body.id : '';
    const p = people.get(id);
    if (!p) throw new HttpError(404, 'no such person');
    if (!p.crm) throw new HttpError(400, 'check this person against Ahoy first');
    const choice = body.contactId;
    const base = { ...p.crm, resolvedByHand: true, checkedAt: new Date().toISOString() };
    let next: CrmMatch;
    if (choice === null || choice === 'new') {
      next = { ...base, status: 'new', reason: 'You marked this person as not in Ahoy.' };
      delete next.contactId; delete next.contactName; delete next.contactEmail; delete next.linkedToCompany;
    } else if (typeof choice === 'string') {
      const cand = (p.crm.candidates ?? []).find((c) => c.id === choice);
      if (!cand) throw new HttpError(400, '`contactId` must be one of the candidates (or "new")');
      next = { ...base, status: 'in_crm', contactId: cand.id, contactName: cand.name, linkedToCompany: 'unknown', reason: `You picked ${cand.name} (${cand.detail}).` };
    } else throw new HttpError(400, '`contactId` must be a candidate id or "new"');
    delete next.candidates;
    applyCrm([{ id, crm: next }]);
    return { crm: next };
  };
  const ahoyPlan = (body: Record<string, unknown>) => {
    const targets = parseIds(body.ids, true)!.map((id) => people.get(id)).filter((p): p is ExplorerPerson => Boolean(p));
    const lensId = parseLensId(body.lensId);
    const lens = lensId ? store.getLens(lensId) : undefined;
    return { plan: planAhoySend(targets, lens), lens: lens ? { id: lens.id, goal: lens.goal } : null };
  };
  const ahoySend = (body: Record<string, unknown>) => {
    ahoyBusy();
    const { plan, lens } = ahoyPlan(body);
    if (!plan.proposals.length) throw new HttpError(400, 'nothing to send — check these people against Ahoy first');
    runAhoyJob('send', plan.proposals.length, async () => {
      let done = 0;
      const urls: string[] = [];
      for (const pr of plan.proposals) {
        if (controller.signal.aborted) return;
        const res = await ahoyProposalFn(pr, { costs, signal: controller.signal });
        const at = new Date().toISOString();
        applyCrm(pr.personIds.filter((id) => people.get(id)?.crm).map((id) => ({
          id,
          crm: { ...people.get(id)!.crm!, sent: { at, proposalId: res.proposalId, url: res.url, title: pr.title } },
        })));
        if (res.url) urls.push(res.url);
        ahoyJob = { kind: 'send', done: ++done, total: plan.proposals.length };
        emitQueue();
      }
      emit({ type: 'notice', level: 'info', message:
        `Sent ${plan.proposals.length} proposal${plan.proposals.length > 1 ? 's' : ''} to Ahoy${lens ? ` for “${lens.goal}”` : ''} — approve ${plan.proposals.length > 1 ? 'them' : 'it'} in Ahoy: ${urls.join(' ')}` });
    });
    return { proposals: plan.proposals.length, summary: plan.summary, skipped: plan.skipped.length, queue: queueState() };
  };

  // ---- lists (global, in the store) ----
  const parseName = (v: unknown): string => {
    const name = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (!name) throw new HttpError(400, '`name` is required');
    if (name.length > 100) throw new HttpError(400, '`name` is too long (max 100 chars)');
    return name;
  };
  const uniqueListId = (base: string) => {
    let id = base.slice(0, 60) || 'list';
    for (let n = 2; store.hasList(id); n++) id = `${base.slice(0, 56)}-${n}`;
    return id;
  };
  const parseLensId = (v: unknown): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || !LENS_ID.test(v)) throw new HttpError(400, 'invalid `lensId`');
    if (!store.getLens(v)) throw new HttpError(400, 'unknown `lensId`');
    return v;
  };
  const listsChanged = () => {
    const all = lists();
    emit({ type: 'lists', lists: all });
    return all;
  };
  const upsertList = (urlId: string, body: Record<string, unknown>) => {
    if (!LIST_ID.test(urlId)) throw new HttpError(400, 'invalid list id');
    const name = parseName(body.name);
    const ids = parseIds(body.ids, true)!;
    const lensId = parseLensId(body.lensId);
    const now = new Date().toISOString();
    const current = lists();
    // `create: true` always makes a new list with a server-assigned id (a stale client can't clobber a list).
    let list = body.create === true ? undefined : current.find((l) => l.id === urlId);
    if (list) {
      // ids the DB doesn't know (e.g. removed people) are kept at the end rather than silently dropped
      const foreign = list.ids.filter((id) => !people.has(id) && !ids.includes(id));
      list = { ...list, name, ids: [...ids, ...foreign], updatedAt: now };
    } else {
      list = { id: uniqueListId(slugify(name, 60, 'list')), name, ids, createdAt: now, updatedAt: now };
    }
    const lens = lensId ? store.getLens(lensId) : undefined;
    store.upsertList(list, lens?.goal ?? null);
    if (lensId) store.setMeta(`list_lens:${list.id}`, lensId);
    const all = listsChanged();
    return { list: all.find((l) => l.id === list!.id) ?? list, lists: all };
  };
  const deleteList = (id: string) => {
    if (!store.deleteList(id)) throw new HttpError(404, 'no such list');
    return { lists: listsChanged() };
  };

  const exportCsv = async (body: Record<string, unknown>) => {
    const name = parseName(body.name);
    let preset: ExportPreset;
    if (body.preset === undefined || body.preset === 'crm') preset = 'crm';
    else if (body.preset === 'full') preset = 'full';
    else if (body.preset === 'ahoy') preset = 'ahoy';
    else throw new HttpError(400, '`preset` must be "crm", "full" or "ahoy"');
    const lensId = parseLensId(body.lensId);
    const rows = parseIds(body.ids, true)!
      .map((id) => people.get(id))
      .filter((p): p is ExplorerPerson => Boolean(p));
    if (!rows.length) throw new HttpError(400, 'no known people in `ids`');
    const lens = lensId ? store.getLens(lensId) : undefined;
    await ensureDir(opts.outDir);
    const out = path.join(opts.outDir, explorerExportFilename(name, rows.length));
    let paths: string[] = [out];
    if (preset === 'ahoy') {
      const files = toAhoyFiles(rows, lens);
      const ap = ahoyPaths(out);
      await writeFileAtomic(ap.companies, files.companies);
      await writeFileAtomic(ap.contacts, files.contacts);
      paths = [ap.companies, ap.contacts];
      if (files.counts.notes) {
        await writeFileAtomic(ap.notes, files.notes);
        paths.push(ap.notes);
      }
    } else await writeFileAtomic(out, toExplorerCsv(rows, preset, lens, store.listLenses()));
    try {
      const listId = typeof body.listId === 'string' && store.hasList(body.listId) ? body.listId : lists().find((l) => l.name === name)?.id ?? null;
      store.recordExport({ listId, name, preset, path: paths[0]!, count: rows.length });
    } catch {
      /* bookkeeping only */
    }
    return { path: paths[0], paths, count: rows.length };
  };

  // ---- snapshot ----
  let snapshotChain: Promise<unknown> = Promise.resolve();
  const snapshot = (): Promise<string> => {
    const next = snapshotChain.then(async () => {
      let html: string;
      try {
        html = opts.htmlTemplate !== undefined ? renderExplorerHtml(state(false), opts.htmlTemplate) : renderExplorerHtml(state(false));
      } catch {
        return ''; // template missing — the live server still works via the API
      }
      await ensureDir(opts.outDir);
      const out = path.join(opts.outDir, snapshotFilename());
      await writeFileAtomic(out, html);
      return out;
    });
    snapshotChain = next.catch(() => {});
    return next;
  };

  // ---- HTTP ----
  let port = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    checkHostAndOrigin(req, port);

    let param = '';
    let routePath = url.pathname;
    const m = /^\/api\/(lists|lenses)\/([^/]+)(\/refresh)?$/.exec(url.pathname);
    if (m) {
      try {
        param = decodeURIComponent(m[2]!);
      } catch {
        throw new HttpError(400, 'invalid id');
      }
      routePath = `/api/${m[1]}/:id${m[3] ?? ''}`;
    }
    const route = `${method} ${routePath}`;
    const known = [
      'GET /', 'GET /api/state', 'GET /api/events',
      'POST /api/dossiers', 'POST /api/dossiers/cancel', 'POST /api/dossiers/resume',
      'POST /api/lenses', 'POST /api/lenses/:id/refresh', 'PUT /api/lenses/:id', 'DELETE /api/lenses/:id',
      'GET /api/lists', 'PUT /api/lists/:id', 'DELETE /api/lists/:id',
      'POST /api/export', 'POST /api/snapshot',
      'POST /api/ahoy/check', 'POST /api/ahoy/resolve', 'POST /api/ahoy/plan', 'POST /api/ahoy/send',
    ];
    if (!known.includes(route)) {
      if (known.some((k) => k.endsWith(` ${routePath}`))) throw new HttpError(405, 'method not allowed');
      throw new HttpError(404, 'not found');
    }

    const presented =
      route === 'GET /' || route === 'GET /api/events' ? url.searchParams.get('t') ?? '' : String(req.headers['x-nb-token'] ?? '');
    if (!safeEqual(presented, token)) throw new HttpError(401, 'missing or invalid token — open the URL printed in the terminal');

    // another process (CLI `lens rescore`, `-p`, an import) may have changed the DB: reload before answering
    if (route !== 'GET /api/events') notifyIfChanged();

    switch (route) {
      case 'GET /': {
        const html = opts.htmlTemplate !== undefined ? renderExplorerHtml(state(true), opts.htmlTemplate) : renderExplorerHtml(state(true));
        res.writeHead(200, HTML_HEADERS);
        res.end(html);
        return;
      }
      case 'GET /api/state':
        return sendJson(res, 200, state(true));
      case 'POST /api/dossiers': {
        const body = await readJsonBody(req);
        if (closing) throw new HttpError(503, 'server is shutting down');
        const depth = body.depth === undefined || body.depth === 'light' ? 'light' : body.depth === 'deep' ? 'deep' : null;
        if (!depth) throw new HttpError(400, '`depth` must be "light" or "deep"');
        return sendJson(res, 200, enqueueDossiers(parseIds(body.ids, true)!, depth, body.force === true));
      }
      case 'POST /api/dossiers/cancel': {
        const body = await readJsonBody(req);
        return sendJson(res, 200, cancelDossiers(parseIds(body.ids, false)));
      }
      case 'POST /api/dossiers/resume': {
        await readJsonBody(req);
        if (closing) throw new HttpError(503, 'server is shutting down');
        return sendJson(res, 200, resumeDossiers());
      }
      case 'POST /api/lenses': {
        const body = await readJsonBody(req);
        if (closing) throw new HttpError(503, 'server is shutting down');
        return sendJson(res, 200, createLens(body));
      }
      case 'POST /api/lenses/:id/refresh': {
        const body = await readJsonBody(req);
        if (closing) throw new HttpError(503, 'server is shutting down');
        if (body.all !== undefined && typeof body.all !== 'boolean') throw new HttpError(400, '`all` must be a boolean');
        return sendJson(res, 200, refreshLens(param, body.all === true));
      }
      case 'PUT /api/lenses/:id': {
        const body = await readJsonBody(req);
        return sendJson(res, 200, updateLens(param, body));
      }
      case 'DELETE /api/lenses/:id':
        await readJsonBody(req);
        return sendJson(res, 200, deleteLens(param));
      case 'GET /api/lists':
        return sendJson(res, 200, { lists: lists() });
      case 'PUT /api/lists/:id': {
        const body = await readJsonBody(req);
        return sendJson(res, 200, upsertList(param, body));
      }
      case 'DELETE /api/lists/:id':
        await readJsonBody(req);
        return sendJson(res, 200, deleteList(param));
      case 'POST /api/export': {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await exportCsv(body));
      }
      case 'POST /api/ahoy/check': {
        const body = await readJsonBody(req);
        if (closing) throw new HttpError(503, 'server is shutting down');
        return sendJson(res, 200, ahoyCheck(body));
      }
      case 'POST /api/ahoy/resolve':
        return sendJson(res, 200, ahoyResolve(await readJsonBody(req)));
      case 'POST /api/ahoy/plan':
        return sendJson(res, 200, ahoyPlan(await readJsonBody(req)));
      case 'POST /api/ahoy/send': {
        const body = await readJsonBody(req);
        if (closing) throw new HttpError(503, 'server is shutting down');
        return sendJson(res, 200, ahoySend(body));
      }
      case 'POST /api/snapshot':
        await readJsonBody(req);
        return sendJson(res, 200, { path: await snapshot() });
      case 'GET /api/events': {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        clients.add(res);
        const hello: ExplorerEvent = { type: 'hello', queue: queueState(), costs: costSnapshot() };
        res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
        req.on('close', () => clients.delete(res));
        return;
      }
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: (e as Error)?.message ?? 'error' });
      else res.end();
    });
  });
  server.headersTimeout = 30_000;

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
    notifyIfChanged();
  }, opts.heartbeatMs ?? 15_000);
  heartbeat.unref();

  port = await listenLocal(server, { port: opts.port, preferredPort: opts.preferredPort });

  let closed: Promise<{ snapshot: string }> | undefined;
  const close = () =>
    (closed ??= (async () => {
      closing = true;
      cancelDossiers();
      if (pauseTimer) clearTimeout(pauseTimer);
      controller.abort();
      await Promise.allSettled([...inflight, ...(lensPromise ? [lensPromise] : []), ...(ahoyPromise ? [ahoyPromise] : [])]);
      let snap = '';
      try {
        snap = await snapshot();
      } catch {
        /* best effort */
      }
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return { snapshot: snap };
    })());

  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    port,
    token,
    state: () => state(true),
    snapshot,
    close,
  };
}
