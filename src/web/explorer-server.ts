import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { ORG_INFER_USD_PER_100, ORG_MIN_EDGE_CONFIDENCE, estimateOrgInferUsd, runOrgInference } from '../llm/org-infer';
import {
  ORG_RESEARCH_MIN_EDGE_CONFIDENCE, ORG_RESEARCH_PASSES, ORG_RESEARCH_PASS_IDS, ORG_RESEARCH_USD_ESTIMATE, estimateOrgResearchUsd, isOwnDomain, runOrgResearchPass, webPersonConfidence,
  type OrgResearchData, type OrgResearchKnown, type OrgResearchPassId,
} from '../llm/org-research';
import { sameName } from '../accounts/identity';
import { withLedger } from '../db/store';
import type {
  CostTracker,
  CrmMatch,
  DossierDepth,
  DossierRecord,
  ExplorerCosts,
  ExplorerEvent,
  ExtensionStatus,
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
  checkExtensionRequest,
  checkHostAndOrigin,
  isAbortError,
  listenLocal,
  parseIds,
  readJsonBody,
  safeEqual,
  sendJson,
} from './http-common';
import { renderExplorerHtml } from './template';
import { AccountError, type AccountPatch, type MemberPatch } from '../db/accounts';
import { CaptureError, canonicalCompanyUrl } from '../accounts/capture';
import { accountMarkdown } from '../accounts/brief';
import { ingestCapture } from '../accounts/ingest';
import { buildOrgMap, orgMapSources } from '../accounts/org';
import { accountCompanyPages, accountSummaries, buildAccountView } from '../accounts/view';
import {
  COMMITTEE_ROLES, LIST_PAGE_KINDS, LIST_STOP_REASONS, SENIORITIES, type Account, type AccountSummary, type CapturePayload, type CommitteeRole, type LightContactInput,
  type ListPageKind, type ListStopReason, type SourceRef,
} from '../accounts/types';
import { listFilters, parseFunctionFacets, parseListCard, parsePeopleHeader, type ListCardPayload } from '../accounts/list-capture';

export type DossierFn = typeof buildDossier;
export type ScoreFn = typeof scoreLens;
export type AhoyCheckFn = typeof checkAhoy;
export type AhoyProposalFn = typeof sendAhoyProposal;
export type OrgInferFn = typeof runOrgInference;
export type OrgResearchFn = typeof runOrgResearchPass;

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
  /** org inference hook (tests); default runOrgInference (Haiku) */
  orgInferFn?: OrgInferFn;
  /** model for org inference and the Haiku web-research passes (default haiku) */
  orgModel?: string;
  /** web org-research pass hook (tests); default runOrgResearchPass (seed pass on `researchModel`, the rest on `orgModel`) */
  orgResearchFn?: OrgResearchFn;
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
/** list walks from the extension: rows per POST /ext/capture-list, rows per run (the extension caps runs at 500) */
export const LIST_ROWS_PER_REQUEST = 100;
export const LIST_ROWS_PER_RUN = 1000;

const stripPrompt = ({ prompt: _p, ...l }: SavedList & { prompt?: string | null }): SavedList => l;

/** the unpacked Chrome extension shipped with network-builder ('' if this install doesn't include it) */
export function extensionDir(): string {
  let here = '';
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return '';
  }
  for (const rel of ['../extension', '../../extension', '../../../extension']) {
    const d = path.resolve(here, rel);
    if (existsSync(path.join(d, 'manifest.json'))) return d;
  }
  return '';
}

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
  // ---- account org-map job (one at a time) ----
  let orgJob: JobQueueState['orgJob'] = null;
  let orgPromise: Promise<void> | null = null;
  let orgController: AbortController | null = null;

  const queueState = (): JobQueueState => ({
    queued: queued.map(({ id, depth }) => ({ id, depth })),
    running: [...running.values()].map(({ id, depth }) => ({ id, depth })),
    pausedUntil: pausedUntil && pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
    pausedManual,
    lensJob: lensJob ? { ...lensJob } : null,
    ahoyJob: ahoyJob ? { ...ahoyJob } : null,
    orgJob: orgJob ? { ...orgJob } : null,
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
      orgInferUsdPer100: ORG_INFER_USD_PER_100,
      orgResearchUsd: ORG_RESEARCH_USD_ESTIMATE,
      orgResearchPassUsd: Object.fromEntries(ORG_RESEARCH_PASS_IDS.map((p) => [p, ORG_RESEARCH_PASSES[p].usd])),
    },
    dbPath: opts.dbPath,
    accounts: accountList(),
    extension: extensionStatus(),
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
    emit({ type: 'accounts', accounts: accountList() });
    emit({ type: 'reload', reason: 'the database was changed by another network-builder process' });
  };
  /** `withCosts`: also send the spend (when an org job ends, so the page's spend chip catches failed / cancelled runs) */
  const emitQueue = (withCosts = false) => {
    bump();
    emit({ type: 'queue', queue: queueState(), ...(withCosts ? { costs: costSnapshot() } : {}) });
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

  // ---- accounts (ABX) ----
  const accountList = (): AccountSummary[] => accountSummaries(store.accounts, new Set(people.keys()));
  /** run an accounts operation, mapping validation errors to 400 / 404 */
  const acct = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof CaptureError) throw new HttpError(400, e.message);
      if (e instanceof AccountError) throw new HttpError(/no such account|no longer exists/.test(e.message) ? 404 : 400, e.message);
      throw e;
    }
  };
  const accountOr404 = (id: string) => {
    const a = store.accounts.get(id);
    if (!a) throw new HttpError(404, 'no such account');
    return a;
  };
  /** the account view the page gets: + the marketing org map (`buildOrgMap`, pure; MCP reuses it) */
  const accountView = (id: string) => {
    const v = buildAccountView(store.accounts, accountOr404(id), people);
    return { ...v, org: buildOrgMap(v, orgMapSources(store.accounts, id)) };
  };
  const accountsChanged = (changed?: string, notice?: string) => {
    const all = accountList();
    // costs ride along so the page's spend chip follows org jobs (stage `org`)
    emit({ type: 'accounts', accounts: all, ...(changed ? { changed } : {}), ...(notice ? { notice } : {}), costs: costSnapshot() });
    return all;
  };
  const strOpt = (v: unknown, field: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string') throw new HttpError(400, `\`${field}\` must be a string`);
    return v;
  };
  const accountPatch = (b: Record<string, unknown>): AccountPatch => {
    const p: AccountPatch = {};
    const name = strOpt(b.name, 'name');
    if (name !== undefined) p.name = name;
    const domain = strOpt(b.domain, 'domain');
    if (domain !== undefined) p.domain = domain;
    const li = strOpt(b.linkedinUrl, 'linkedinUrl');
    if (li !== undefined) p.linkedinUrl = li;
    if (b.aliases !== undefined) {
      if (!Array.isArray(b.aliases) || !b.aliases.every((x) => typeof x === 'string')) throw new HttpError(400, '`aliases` must be an array of strings');
      p.aliases = b.aliases as string[];
    }
    const status = strOpt(b.status, 'status');
    if (status !== undefined) p.status = status as AccountPatch['status'];
    const brief = strOpt(b.brief, 'brief');
    if (brief !== undefined) p.brief = brief;
    return p;
  };
  const memberPatch = (b: Record<string, unknown>): MemberPatch => {
    const p: MemberPatch = {};
    for (const k of ['department', 'tier', 'role', 'reportsTo', 'notes', 'subfunction', 'team', 'entity', 'country', 'responsibilities', 'noise', 'reportsToSource'] as const) {
      const v = strOpt(b[k], k);
      if (v !== undefined) (p as Record<string, string>)[k] = v;
    }
    return p;
  };
  const createAccount = (b: Record<string, unknown>) => {
    const patch = accountPatch(b);
    if (!patch.name) throw new HttpError(400, '`name` is required');
    const account = acct(() => store.accounts.create({ ...patch, name: patch.name! }));
    return { account, accounts: accountsChanged(account.id) };
  };
  const updateAccount = (id: string, b: Record<string, unknown>) => {
    accountOr404(id);
    acct(() => store.accounts.update(id, accountPatch(b)));
    return { view: accountView(id), accounts: accountsChanged(id) };
  };
  const deleteAccount = (id: string) => {
    if (!store.accounts.delete(id)) throw new HttpError(404, 'no such account');
    return { accounts: accountsChanged(id) };
  };
  const addMembers = (id: string, b: Record<string, unknown>) => {
    accountOr404(id);
    const ids = parseIds(b.ids, true)!;
    if (!ids.length) throw new HttpError(400, 'no people to add');
    const role = strOpt(b.role, 'role') as CommitteeRole | '' | undefined;
    const r = acct(() => store.accounts.addMembers(id, ids, role ? { role } : {}));
    return { ...r, view: accountView(id), accounts: accountsChanged(id) };
  };
  const updateMember = (id: string, pid: string, b: Record<string, unknown>) => {
    accountOr404(id);
    if (b.confirmReportsTo !== undefined && typeof b.confirmReportsTo !== 'boolean') throw new HttpError(400, '`confirmReportsTo` must be a boolean');
    const patch = memberPatch(b);
    acct(() => {
      store.accounts.updateMember(id, pid, patch);
      if (b.confirmReportsTo === true && patch.reportsTo === undefined) store.accounts.confirmReportsTo(id, pid);
    });
    return { view: accountView(id), accounts: accountsChanged(id) };
  };
  /** people typed in / pasted by hand without a capture → light contacts (source `manual`) */
  const addLightContacts = (id: string, b: Record<string, unknown>) => {
    accountOr404(id);
    if (!Array.isArray(b.contacts)) throw new HttpError(400, '`contacts` must be an array');
    if (!b.contacts.length) throw new HttpError(400, 'no contacts to add');
    if (b.contacts.length > 500) throw new HttpError(400, 'too many contacts (max 500 per request)');
    const role = strOpt(b.role, 'role') as CommitteeRole | '' | undefined;
    if (role && !COMMITTEE_ROLES.includes(role)) throw new HttpError(400, `role must be one of: ${COMMITTEE_ROLES.join(', ')}`);
    const at = new Date().toISOString();
    const caps = { fullName: 200, url: 2000, title: 300, headline: 500, company: 200, location: 200 } as const;
    const inputs: LightContactInput[] = b.contacts.map((c, i) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, `contacts[${i}] must be an object`);
      const o = c as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, max] of Object.entries(caps)) {
        const v = o[k];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string') throw new HttpError(400, `contacts[${i}].${k} must be a string`);
        if (v.length > max) throw new HttpError(400, `contacts[${i}].${k} is too long (max ${max} chars)`);
        out[k] = v;
      }
      if (!out.fullName?.trim()) throw new HttpError(400, `contacts[${i}].fullName is required`);
      return { ...out, fullName: out.fullName, source: { kind: 'manual', at } } as LightContactInput;
    });
    const r = acct(() => store.accounts.upsertLightContacts(id, inputs));
    if (role) for (const pid of r.added) acct(() => store.accounts.updateMember(id, pid, { role }));
    return { ...r, view: accountView(id), accounts: accountsChanged(id) };
  };
  const removeMember = (id: string, pid: string) => {
    accountOr404(id);
    if (!store.accounts.removeMember(id, pid)) throw new HttpError(404, 'that person isn’t on this account');
    return { view: accountView(id), accounts: accountsChanged(id) };
  };

  // ---- org map: Haiku classification + suggested reporting lines (paid; only from a POST by the page) ----
  const orgInferFn = opts.orgInferFn ?? runOrgInference;
  const orgBusy = () => {
    if (orgPromise) throw new HttpError(409, 'an org job is already running — wait for it to finish or cancel it');
  };
  const orgInfer = (id: string, b: Record<string, unknown>) => {
    orgBusy();
    const account = accountOr404(id);
    const view = accountView(id);
    const onAccount = new Set(view.members.map((m) => m.id));
    let ids: string[];
    if (b.ids === undefined || b.ids === null) ids = [...onAccount];
    else {
      ids = parseIds(b.ids, true)!.map((x) => store.accounts.resolveId(x));
      const off = ids.filter((x) => !onAccount.has(x));
      if (off.length) throw new HttpError(400, `${off.length} of \`ids\` ${off.length === 1 ? 'is' : 'are'} not on this account`);
      ids = [...new Set(ids)];
    }
    if (!ids.length) throw new HttpError(400, 'no people on this account to classify');
    const estimateUsd = estimateOrgInferUsd(ids.length);
    const ctl = new AbortController();
    const onShutdown = () => ctl.abort();
    controller.signal.addEventListener('abort', onShutdown, { once: true });
    orgController = ctl;
    orgJob = { accountId: id, kind: 'infer', phase: 'classify', done: 0, total: ids.length, pausedUntil: null, pausedManual: false };
    emitQueue();
    orgPromise = (async () => {
      try {
        const r = await orgInferFn({
          // entities the user set, and company pages walked into this account, count as the account (Phase 2b)
          account: {
            ...account,
            entities: [
              ...new Set([
                ...store.accounts.members(id).map((m) => m.entity),
                ...accountCompanyPages(store.accounts, id).map((u) => {
                  const slug = /\/company\/([^/?#]+)/i.exec(u)?.[1] ?? '';
                  return slug ? `LinkedIn page linkedin.com/company/${slug}` : '';
                }),
              ].filter(Boolean)),
            ],
          },
          members: view.members,
          ids,
          model: opts.orgModel ?? 'haiku',
          signal: ctl.signal,
          costs,
          onProgress: ({ phase, done, total }) => {
            orgJob = { accountId: id, kind: 'infer', phase, done, total, pausedUntil: null, pausedManual: false };
            emitQueue();
          },
        });
        costs.add('org', r.costUsd);
        if (ctl.signal.aborted || !store.accounts.get(id)) return;
        const onNow = new Set(store.accounts.members(id).map((m) => m.personId));
        const n = store.accounts.applyInference(id, [...r.classified].filter(([pid]) => onNow.has(pid)));
        const { applied } = store.accounts.replaceInferredReportsTo(
          id,
          ids.filter((pid) => onNow.has(pid)),
          // weak guesses are never stored as lines (runOrgInference keeps them as `possibleManager`)
          r.edges.filter((e) => onNow.has(e.id) && (!e.managerId || (onNow.has(e.managerId) && e.confidence >= ORG_MIN_EDGE_CONFIDENCE))),
        );
        const extra = [
          r.failedBatches ? `${r.failedBatches} batch${r.failedBatches > 1 ? 'es' : ''} failed` : '',
          r.reportingFallback ? 'reporting lines from title rules' : '',
        ].filter(Boolean);
        accountsChanged(id, `Classified ${n} ${n === 1 ? 'person' : 'people'}; ${applied} reporting line${applied === 1 ? '' : 's'} suggested${extra.length ? ` (${extra.join('; ')})` : ''}`);
      } catch (e) {
        const ec = errorCost(e);
        if (ec.usd > 0) costs.add('org', ec.usd);
        if (ec.incomplete) costs.markIncomplete();
        if (isAbortError(e) || ctl.signal.aborted) {
          if (!controller.signal.aborted) emit({ type: 'notice', level: 'info', message: 'Org inference cancelled — nothing was changed.' });
        } else emit({ type: 'notice', level: 'error', message: `Org inference failed: ${(e as Error)?.message ?? e}` });
      } finally {
        controller.signal.removeEventListener('abort', onShutdown);
        orgJob = null;
        orgPromise = null;
        orgController = null;
        if (!controller.signal.aborted) emitQueue(true);
      }
    })();
    return { started: ids.length, estimateUsd, queue: queueState() };
  };
  const orgCancel = (id: string) => {
    accountOr404(id);
    const cancelled = Boolean(orgController && orgJob?.accountId === id);
    if (cancelled) orgController!.abort();
    return { cancelled, queue: queueState() };
  };

  // ---- org map: web research (paid; sequential passes; only from a POST by the page) ----
  const orgResearchFn = opts.orgResearchFn ?? runOrgResearchPass;
  /** set while a research job waits out a rate-limit pause; POST …/org/resume calls it */
  let orgResume: (() => void) | null = null;
  const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
  /** wait `ms` (null = until resumed); resolves early on resume ('resumed'), else 'timeout'; rejects on abort */
  const orgWait = (ms: number | null, signal: AbortSignal) =>
    new Promise<'resumed' | 'timeout'>((resolve, reject) => {
      let t: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (t) clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        orgResume = null;
      };
      const done = (how: 'resumed' | 'timeout') => {
        cleanup();
        resolve(how);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      if (ms !== null) t = setTimeout(() => done('timeout'), ms);
      orgResume = () => done('resumed');
    });
  /** what the account already holds: marketing people first, most senior first */
  const researchKnown = (id: string): OrgResearchKnown => {
    const ms = [...accountView(id).members].sort(
      (a, b) =>
        Number(b.department === 'marketing') - Number(a.department === 'marketing') ||
        SENIORITIES.indexOf(a.seniority) - SENIORITIES.indexOf(b.seniority),
    );
    const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
    return {
      people: ms.map((m) => ({ name: m.fullName, title: m.title })),
      entities: uniq(ms.map((m) => m.entity)),
      countries: uniq(ms.map((m) => m.country)),
      locations: uniq(ms.map((m) => m.location)).slice(0, 50),
    };
  };
  /** write one pass's findings (each item on its own: one bad item never loses the rest) */
  const persistResearch = (id: string, account: Account, pass: OrgResearchPassId, data: OrgResearchData, runId: string) => {
    const at = new Date().toISOString();
    const out = { added: 0, updated: 0, facts: 0, headcounts: 0, edges: 0, skipped: 0, duplicates: [] as string[] };
    const tryItem = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        if (!(e instanceof AccountError)) throw e;
        out.skipped++;
      }
    };
    for (const p of data.people) {
      tryItem(() => {
        const source: SourceRef = { kind: 'web', at, url: p.evidenceUrl, evidenceUrl: p.evidenceUrl, quote: p.quote };
        const r = store.accounts.upsertLightContacts(id, [{ fullName: p.name, title: p.title, company: p.entity || account.name, source }], { matchNameOnly: true });
        if (r.warnings.length) out.duplicates.push(p.name);
        const pid = r.added[0] ?? r.updated[0] ?? r.merged[0];
        if (!pid) return void out.skipped++;
        if (r.added.length) out.added++;
        else out.updated++;
        store.accounts.applyWebFindings(id, pid, {
          entity: p.entity, country: p.country, subfunction: p.subfunction, confidence: webPersonConfidence(p, account, pass, at.slice(0, 10)), at,
        });
      });
    }
    for (const f of data.facts) {
      const where = [f.entity && !f.text.includes(f.entity) ? f.entity : '', f.country].filter(Boolean).join(', ');
      tryItem(() => {
        out.facts += store.accounts.addOrgFacts(id, [
          { kind: f.kind, text: where ? `${f.text} (${where})` : f.text, evidenceUrl: f.evidenceUrl, quote: f.quote, confidence: f.confidence, runId, foundAt: at },
        ]).added;
      });
    }
    const existing = store.accounts.headcounts(id).filter((h) => h.source === 'web');
    for (const h of data.headcounts) {
      if (existing.some((e) => e.label === h.label && e.count === h.count && e.evidenceUrl === h.evidenceUrl)) continue;
      tryItem(() => {
        existing.push(
          store.accounts.addHeadcount(id, {
            source: 'web', scope: h.scope, label: h.label, count: h.count, url: h.evidenceUrl, evidenceUrl: h.evidenceUrl, quote: h.quote,
            confidence: isOwnDomain(h.evidenceUrl, account.domain) ? 0.9 : 0.6, runId, takenAt: at,
          }),
        );
        out.headcounts++;
      });
    }
    // "A reports to B" naming two people on the account (exactly one match each) → a 'web' line at the fact's confidence
    // (capped at 0.9, only from 0.6 = clearly implied); never over a user line
    const reporting = data.facts.filter((f) => f.kind === 'reporting' && f.subject && f.manager && f.confidence >= ORG_RESEARCH_MIN_EDGE_CONFIDENCE);
    if (reporting.length) {
      const members = accountView(id).members;
      const one = (name: string) => {
        const hits = members.filter((m) => sameName(m.fullName, name));
        return hits.length === 1 ? hits[0]!.id : '';
      };
      for (const f of reporting) {
        const subj = one(f.subject);
        const mgr = one(f.manager);
        if (!subj || !mgr || subj === mgr) continue;
        tryItem(() => {
          if (store.accounts.applyInferredReportsTo(id, subj, mgr, Math.min(0.9, f.confidence), `web: “${f.quote.slice(0, 300)}” ${f.evidenceUrl}`, 'web')) out.edges++;
        });
      }
    }
    return out;
  };

  const orgResearch = (id: string, b: Record<string, unknown>) => {
    orgBusy();
    accountOr404(id);
    let passes: OrgResearchPassId[];
    if (b.passes === undefined || b.passes === null) passes = [...ORG_RESEARCH_PASS_IDS];
    else {
      const ok = new Set<string>(ORG_RESEARCH_PASS_IDS);
      if (!Array.isArray(b.passes) || !b.passes.length || b.passes.length > 20 || b.passes.some((p) => typeof p !== 'string' || !ok.has(p)))
        throw new HttpError(400, `passes must be a non-empty array of: ${ORG_RESEARCH_PASS_IDS.join(', ')}`);
      // canonical order (seed first), each once
      passes = ORG_RESEARCH_PASS_IDS.filter((p) => (b.passes as string[]).includes(p));
    }
    const estimate = estimateOrgResearchUsd(passes);
    const runId = `web-${randomBytes(6).toString('hex')}`;
    const ctl = new AbortController();
    const onShutdown = () => ctl.abort();
    controller.signal.addEventListener('abort', onShutdown, { once: true });
    orgController = ctl;
    const setJob = (phase: string, done: number, extra: { pausedUntil?: string | null; pausedManual?: boolean } = {}) => {
      orgJob = { accountId: id, kind: 'research', phase, done, total: passes.length, pausedUntil: null, pausedManual: false, ...extra };
      emitQueue();
    };
    setJob(passes[0]!, 0);
    orgPromise = (async () => {
      const tot = { added: 0, updated: 0, facts: 0, headcounts: 0, edges: 0, dropped: 0, duplicates: [] as string[] };
      const failed: string[] = [];
      let level = 0;
      let gone = false;
      try {
        for (let i = 0; i < passes.length && !gone; i++) {
          const pass = passes[i]!;
          const label = ORG_RESEARCH_PASSES[pass].label;
          for (;;) {
            if (ctl.signal.aborted) throw abortError();
            const account = store.accounts.get(id);
            if (!account) {
              gone = true;
              break;
            }
            setJob(pass, i);
            const r = await orgResearchFn({
              account,
              pass,
              known: researchKnown(id),
              model: pass === 'seed' ? opts.researchModel : (opts.orgModel ?? 'haiku'),
              signal: ctl.signal,
            });
            if (r.costUsd > 0) costs.add('org', r.costUsd);
            if (r.costIncomplete) costs.markIncomplete();
            if (r.status === 'rate_limited') {
              if (level < backoff.length) {
                const delay = backoff[level++] ?? 60_000;
                setJob(pass, i, { pausedUntil: new Date(Date.now() + delay).toISOString() });
                emit({ type: 'notice', level: 'warn', message: `Web research is rate-limited — pausing for ${Math.max(1, Math.round(delay / 60_000))} min, then retrying “${label}”.` });
                if ((await orgWait(delay, ctl.signal)) === 'resumed') level = 0;
              } else {
                setJob(pass, i, { pausedManual: true });
                emit({ type: 'notice', level: 'warn', message: 'Web research keeps hitting the rate limit — paused. Click Resume when you want to try again.' });
                await orgWait(null, ctl.signal);
                level = 0;
              }
              continue; // the same pass again
            }
            if (r.status === 'error' || !r.data) {
              failed.push(label);
              emit({ type: 'notice', level: 'error', message: `Web research “${label}” failed: ${r.error ?? 'no result'}` });
              break;
            }
            level = 0;
            if (!store.accounts.get(id)) {
              gone = true;
              break;
            }
            const s = persistResearch(id, account, pass, r.data, runId);
            tot.added += s.added;
            tot.updated += s.updated;
            tot.facts += s.facts;
            tot.headcounts += s.headcounts;
            tot.edges += s.edges;
            tot.dropped += r.data.dropped;
            tot.duplicates.push(...s.duplicates);
            accountsChanged(id);
            break;
          }
        }
        if (gone) return;
        const parts = [
          `${tot.added} new ${tot.added === 1 ? 'person' : 'people'}`,
          tot.updated ? `${tot.updated} confirmed` : '',
          `${tot.facts} fact${tot.facts === 1 ? '' : 's'}`,
          tot.headcounts ? `${tot.headcounts} headcount${tot.headcounts === 1 ? '' : 's'}` : '',
          tot.edges ? `${tot.edges} reporting line${tot.edges === 1 ? '' : 's'}` : '',
          tot.dropped ? `${tot.dropped} item${tot.dropped === 1 ? '' : 's'} without evidence dropped` : '',
          tot.duplicates.length
            ? `possible duplicate${tot.duplicates.length === 1 ? '' : 's'} to check: ${[...new Set(tot.duplicates)].slice(0, 5).join(', ')}${new Set(tot.duplicates).size > 5 ? ', …' : ''}`
            : '',
          failed.length ? `failed: ${failed.join(', ')}` : '',
        ].filter(Boolean);
        accountsChanged(id, `Web research done — ${parts.join('; ')}`);
      } catch (e) {
        const ec = errorCost(e);
        if (ec.usd > 0) costs.add('org', ec.usd);
        if (ec.incomplete) costs.markIncomplete();
        if (isAbortError(e) || ctl.signal.aborted) {
          if (!controller.signal.aborted) {
            emit({ type: 'notice', level: 'info', message: 'Web research cancelled — findings from finished passes are kept.' });
            if (store.accounts.get(id)) accountsChanged(id);
          }
        } else emit({ type: 'notice', level: 'error', message: `Web research failed: ${(e as Error)?.message ?? e}` });
      } finally {
        controller.signal.removeEventListener('abort', onShutdown);
        orgResume = null;
        orgJob = null;
        orgPromise = null;
        orgController = null;
        if (!controller.signal.aborted) emitQueue(true);
      }
    })();
    return { started: passes.length, passes, estimate, queue: queueState() };
  };
  /** end a rate-limit pause of the research job now (after the backoff schedule ran out it waits for this) */
  const orgResumeJob = (id: string) => {
    accountOr404(id);
    const resumed = Boolean(orgResume && orgJob?.accountId === id && orgJob.kind === 'research');
    if (resumed) orgResume!();
    return { resumed, queue: queueState() };
  };

  // ---- Chrome extension ----
  const extToken = (rotate = false): string => {
    let t = store.getMeta('ext_token');
    if (!t || rotate) {
      t = randomBytes(24).toString('base64url');
      store.setMeta('ext_token', t);
      store.setMeta('ext_seen', ''); // a new code: not connected until the extension uses it
    }
    return t;
  };
  const pairingCode = (rotate: boolean) => {
    const json = JSON.stringify({ v: 1, u: `http://127.0.0.1:${port}`, t: extToken(rotate) });
    return {
      code: `nb1.${Buffer.from(json).toString('base64url')}`,
      port,
      extensionDir: extensionDir(),
      extension: extensionStatus(),
    };
  };
  /** paired = a code was issued; seenAt = the extension last reached this database with it */
  function extensionStatus(): ExtensionStatus {
    return { paired: !!store.getMeta('ext_token'), seenAt: store.getMeta('ext_seen') || null };
  }
  /** record the extension's contact (throttled); tell the page when it (re)appears so pairing shows as connected */
  const extSeen = () => {
    const last = Date.parse(store.getMeta('ext_seen') ?? '');
    const now = Date.now();
    if (Number.isFinite(last) && now - last < 60_000) return;
    store.setMeta('ext_seen', new Date(now).toISOString());
    emit({ type: 'extension', extension: extensionStatus(), connected: !Number.isFinite(last) || now - last > 10 * 60_000 });
  };
  const extLookup = (url: URL) => {
    const profileUrl = url.searchParams.get('url') ?? '';
    const { id, isConnection } = acct(() => store.accounts.idForProfileUrl(profileUrl));
    const contact = store.accounts.getContact(id);
    const names = new Map(store.accounts.list().map((a) => [a.id, a.name]));
    const suggested = store.accounts.match(url.searchParams.get('company') ?? '', url.searchParams.get('companyUrl') ?? '');
    return {
      id,
      isConnection,
      capturedAt: contact?.capturedAt ?? null,
      accounts: store.accounts.membershipsOf(id).map((m) => ({ id: m.accountId, name: names.get(m.accountId) ?? m.accountId, role: m.role })),
      suggested: suggested ? { id: suggested.id, name: suggested.name } : null,
    };
  };
  const extCapture = (b: Record<string, unknown>) => {
    if (!b.profile || typeof b.profile !== 'object' || Array.isArray(b.profile)) throw new HttpError(400, '`profile` is required');
    const r = acct(() =>
      ingestCapture(store.accounts, {
        profile: b.profile as CapturePayload,
        accountId: strOpt(b.accountId, 'accountId') || undefined,
        accountName: strOpt(b.accountName, 'accountName'),
        role: (strOpt(b.role, 'role') ?? '') as CommitteeRole | '',
        notes: strOpt(b.notes, 'notes'),
      }),
    );
    const verb = r.addedToAccount ? 'Added' : 'Updated';
    const pr = r.contact.profile;
    const saved = {
      experience: pr.experience.length,
      education: pr.education.length,
      sections: Object.keys(pr.other),
      lists: Object.keys(pr.detailsText ?? {}),
    };
    // statuses and sizes only (no profile content): what the extension managed to read, for troubleshooting
    const diag = (b.profile as { detailsDiag?: unknown }).detailsDiag;
    console.log(
      `capture: ${saved.experience} roles, ${saved.education} education, lists [${saved.lists.join(', ')}]` +
        (diag && typeof diag === 'object' ? ` · read ${Object.entries(diag as Record<string, unknown>).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(' ')}` : ''),
    );
    accountsChanged(
      r.account.id,
      `${verb} ${r.contact.fullName} ${r.addedToAccount ? 'to' : 'on'} ${r.account.name}${r.createdAccount ? ' (new account)' : ''} — from LinkedIn`,
    );
    return {
      account: { id: r.account.id, name: r.account.name },
      person: { id: r.contact.id, fullName: r.contact.fullName, title: r.contact.title },
      createdAccount: r.createdAccount,
      addedToAccount: r.addedToAccount,
      isConnection: r.isConnection,
      firstCapture: r.firstCapture,
      saved,
    };
  };

  /**
   * A batch of rows from a list walk (company People tab / people search). Named rows → light contacts on the account
   * (source `extension-list`), "LinkedIn Member" rows → anonymous rows of the run, header/facets → headcount rows of the
   * run (replaced on re-post). Idempotent per run: the same batch again adds nothing. Free and local.
   */
  const extCaptureList = (b: Record<string, unknown>) => {
    const runId = strOpt(b.runId, 'runId') ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw new HttpError(400, '`runId` must be a UUID');
    const pg = b.page;
    if (!pg || typeof pg !== 'object' || Array.isArray(pg)) throw new HttpError(400, '`page` is required');
    const page = pg as Record<string, unknown>;
    const kind = strOpt(page.kind, 'page.kind') as ListPageKind | undefined;
    if (!kind || !LIST_PAGE_KINDS.includes(kind)) throw new HttpError(400, `\`page.kind\` must be one of: ${LIST_PAGE_KINDS.join(', ')}`);
    const pageUrl = strOpt(page.url, 'page.url') ?? '';
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(pageUrl);
    } catch {
      throw new HttpError(400, '`page.url` must be a linkedin.com URL');
    }
    if (pageUrl.length > 2000 || parsedUrl.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(parsedUrl.hostname)) {
      throw new HttpError(400, '`page.url` must be a linkedin.com URL');
    }
    const keywords = (strOpt(page.keywords, 'page.keywords') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const companyUrl = (strOpt(page.companyUrl, 'page.companyUrl') ?? '').slice(0, 2000);
    if (!Array.isArray(b.rows)) throw new HttpError(400, '`rows` must be an array');
    if (b.rows.length > LIST_ROWS_PER_REQUEST) throw new HttpError(400, `too many rows (max ${LIST_ROWS_PER_REQUEST} per request)`);
    const rows: ListCardPayload[] = b.rows.map((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, `rows[${i}] must be an object`);
      const o = r as Record<string, unknown>;
      if (!Number.isInteger(o.idx) || (o.idx as number) < 0 || (o.idx as number) >= 100_000) throw new HttpError(400, `rows[${i}].idx must be a whole number ≥ 0`);
      if (!Array.isArray(o.lines) || o.lines.length > 40 || !o.lines.every((l) => typeof l === 'string' && l.length <= 1000)) {
        throw new HttpError(400, `rows[${i}].lines must be up to 40 strings`);
      }
      if (o.href !== undefined && (typeof o.href !== 'string' || o.href.length > 2000)) throw new HttpError(400, `rows[${i}].href must be a string`);
      return { idx: o.idx as number, lines: o.lines as string[], href: (o.href as string | undefined) ?? '' };
    });
    const header = strOpt(b.header, 'header');
    const facets = strOpt(b.facets, 'facets');
    if ((header?.length ?? 0) > 2000 || (facets?.length ?? 0) > 20_000) throw new HttpError(400, '`header` / `facets` text is too long');
    if (b.final !== undefined && typeof b.final !== 'boolean') throw new HttpError(400, '`final` must be a boolean');
    const stopReason = strOpt(b.stopReason, 'stopReason') ?? '';
    if (stopReason && !LIST_STOP_REASONS.includes(stopReason as ListStopReason)) throw new HttpError(400, `\`stopReason\` must be one of: ${LIST_STOP_REASONS.join(', ')}`);

    // the run (and its account): an existing run keeps its account; a new one resolves it like a profile capture
    let run = store.accounts.getListRun(runId.toLowerCase());
    const accountId = strOpt(b.accountId, 'accountId') || '';
    let createdAccount = false;
    let account;
    if (run) {
      account = accountOr404(run.accountId);
      if (accountId && accountId !== run.accountId) throw new HttpError(409, 'this list run belongs to another account');
      if (run.finishedAt) throw new HttpError(409, 'this list run has already finished — start a new one');
    } else if (accountId) {
      account = store.accounts.get(accountId);
      if (!account) throw new HttpError(404, 'that account no longer exists — pick another one');
    } else {
      const name = (strOpt(b.accountName, 'accountName') ?? '').replace(/\s+/g, ' ').trim();
      account = (name ? store.accounts.find(name) : undefined) ?? store.accounts.match(name, companyUrl);
      if (!account) {
        if (!name) throw new HttpError(400, 'pick an account (or type a name for a new one)');
        const cu = canonicalCompanyUrl(companyUrl);
        account = acct(() => store.accounts.create({ name, ...(cu && !store.accounts.match('', cu) ? { linkedinUrl: cu } : {}) }));
        createdAccount = true;
      }
    }
    const newRun = !run;
    if (!run) run = acct(() => store.accounts.startListRun(account.id, { id: runId, pageKind: kind, url: parsedUrl.href, keywords }));
    if (run.rowsSeen >= LIST_ROWS_PER_RUN) throw new HttpError(409, `this list run already has ${LIST_ROWS_PER_RUN.toLocaleString('en-US')} rows (the most one run may send)`);
    const batch = rows.filter((r) => r.idx < LIST_ROWS_PER_RUN); // a run never holds more than 1,000 rows

    const at = new Date().toISOString();
    const source = { kind: 'extension-list' as const, at, url: run.url, runId: run.id };
    const named: LightContactInput[] = [];
    const anon: { idx: number; headline: string; location: string }[] = [];
    for (const r of batch) {
      const c = parseListCard({ lines: r.lines, href: r.href, pageKind: kind, pageUrl: parsedUrl.href, accountName: account.name });
      if (c.anonymous) anon.push({ idx: r.idx, headline: c.headline, location: c.location });
      else named.push({ fullName: c.fullName, url: c.url, headline: c.headline, title: c.title, company: c.company, location: c.location, source });
    }
    const up = named.length ? acct(() => store.accounts.upsertLightContacts(account.id, named)) : { added: [], updated: [], merged: [], skipped: [], warnings: [] };
    const newAnon = anon.length ? acct(() => store.accounts.addAnonRows(run!.id, anon)) : 0;

    // header + "What they do" → headcount rows of this run (a re-post replaces them)
    const hcSource = kind === 'people-tab' ? 'linkedin-people' : 'linkedin-search';
    // company-wide only for a People tab with no filters at all; anything filtered is a query, labelled with its filters
    const filters = listFilters(parsedUrl.href); // result-set filters only (no page / origin / spelling flags)
    const scope = kind === 'people-tab' && !filters.length ? 'company' : 'query';
    const label = (filters.length === 1 && filters[0]![0] === 'keywords' ? filters[0]![1] : filters.map(([k, v]) => `${k}: ${v}`).join(' · '))
      .replace(/\s+/g, ' ').trim().slice(0, 200);
    let headerCount: number | null = null;
    if (header !== undefined) {
      const n = parsePeopleHeader(header);
      headerCount = n;
      // an empty / unreadable header (e.g. on the final post) keeps the run's earlier snapshot
      if (n !== null) {
        acct(() => store.accounts.replaceRunHeadcounts(account.id, run!.id, [scope], [
          { source: hcSource, scope, count: n, label, url: parsedUrl.href, quote: header.replace(/\s+/g, ' ').trim().slice(0, 200), confidence: 0.9 },
        ]));
      }
    }
    let facetRows = 0;
    // "What they do" on a FILTERED People tab (keywords / facets) counts the filtered result set, not the company's
    // functions: never stored, so it can't replace the company-wide figure
    if (facets !== undefined && kind === 'people-tab' && scope === 'company') {
      const fs = parseFunctionFacets(facets);
      facetRows = fs.length;
      if (fs.length) {
        acct(() => store.accounts.replaceRunHeadcounts(account.id, run!.id, ['function'], fs.map((f) => (
          { source: 'linkedin-people' as const, scope: 'function' as const, count: f.count, label: f.label, url: parsedUrl.href, confidence: 0.9 }
        ))));
      }
    }

    const maxIdx = batch.reduce((m, r) => Math.max(m, r.idx + 1), 0);
    // "Capture headcount only" (extension): the run's first and only post, final, zero rows → marked `counts-only`
    // (left out of the org map's runs and of the anonymous count)
    const countsOnly = newRun && b.final === true && !batch.length;
    run = acct(() => store.accounts.updateListRun(run!.id, {
      rowsSeen: Math.min(LIST_ROWS_PER_RUN, Math.max(run!.rowsSeen, maxIdx)),
      named: store.accounts.runMemberCount(account.id, run!.id),
      anonymous: store.accounts.anonCount(run!.id),
      ...(b.final === true ? { finishedAt: at, stopReason: (countsOnly ? 'counts-only' : stopReason || 'end') as ListStopReason } : {}),
    }));
    if (up.added.length || up.updated.length || up.merged.length) store.accounts.touch(account.id);
    const changed = up.added.length + up.merged.length + newAnon + facetRows > 0 || header !== undefined || b.final === true || createdAccount;
    if (changed) {
      const why = run.stopReason && run.stopReason !== 'end' ? ` (stopped: ${run.stopReason})` : '';
      const hc = [headerCount !== null ? `${headerCount.toLocaleString('en')} members` : '', facetRows ? `${facetRows} “What they do” counts` : ''].filter(Boolean);
      accountsChanged(
        account.id,
        b.final !== true
          ? undefined
          : countsOnly
            ? `Saved LinkedIn headcount for ${account.name}: ${hc.join(', ') || 'no numbers found'}`
            : `Mapped ${run.named} ${run.named === 1 ? 'person' : 'people'}${run.anonymous ? ` + ${run.anonymous} anonymous` : ''} from a LinkedIn list to ${account.name}${why}`,
      );
    }
    return {
      account: { id: account.id, name: account.name },
      createdAccount,
      run,
      added: up.added.length,
      updated: up.updated.length,
      merged: up.merged.length,
      skipped: up.skipped.length,
      anonymous: newAnon,
      totalRows: run.rowsSeen,
      /** what this post stored as headcount: the header's count (null = none read) and the number of function counts */
      headcount: { members: headerCount, functions: facetRows },
    };
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

  /** /ext/* — the Chrome extension. Long-lived capture token (header X-NB-Capture); only adds data, never spends money. */
  const handleExtension = async (req: IncomingMessage, res: ServerResponse, url: URL, method: string) => {
    checkExtensionRequest(req, port);
    const route = `${method} ${url.pathname}`;
    const known = ['GET /ext/ping', 'GET /ext/accounts', 'GET /ext/lookup', 'POST /ext/capture', 'POST /ext/capture-list'];
    if (!known.includes(route)) throw new HttpError(known.some((k) => k.endsWith(` ${url.pathname}`)) ? 405 : 404, 'not found');
    const stored = store.getMeta('ext_token') ?? '';
    if (!stored || !safeEqual(String(req.headers['x-nb-capture'] ?? ''), stored)) {
      throw new HttpError(401, 'not paired (or the pairing was reset) — in Network Builder open Accounts → Chrome extension and pair again');
    }
    if (!route.startsWith('POST ')) notifyIfChanged();
    extSeen();
    switch (route) {
      case 'GET /ext/ping':
        return sendJson(res, 200, { ok: true, app: 'network-builder', accounts: store.accounts.list().length });
      case 'GET /ext/accounts':
        return sendJson(res, 200, {
          accounts: accountList().map((a) => ({ id: a.id, name: a.name, status: a.status, memberCount: a.memberCount, linkedinUrl: store.accounts.get(a.id)?.linkedinUrl ?? '' })),
        });
      case 'GET /ext/lookup':
        return sendJson(res, 200, extLookup(url));
      case 'POST /ext/capture': {
        const body = await readJsonBody(req);
        if (closing) throw new HttpError(503, 'Network Builder is shutting down');
        notifyIfChanged();
        return sendJson(res, 200, extCapture(body));
      }
      case 'POST /ext/capture-list': {
        const body = await readJsonBody(req);
        if (closing) throw new HttpError(503, 'Network Builder is shutting down');
        notifyIfChanged();
        return sendJson(res, 200, extCaptureList(body));
      }
    }
  };

  // ---- HTTP ----
  let port = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    if (url.pathname.startsWith('/ext/')) return handleExtension(req, res, url, method);
    checkHostAndOrigin(req, port);

    let param = '';
    let routePath = url.pathname;
    let param2 = '';
    const dec = (v: string) => {
      try {
        return decodeURIComponent(v);
      } catch {
        throw new HttpError(400, 'invalid id');
      }
    };
    const m = /^\/api\/(lists|lenses)\/([^/]+)(\/refresh)?$/.exec(url.pathname);
    const am = /^\/api\/accounts\/([^/]+)(?:\/(brief|members|contacts)(?:\/([^/]+))?)?$/.exec(url.pathname);
    const om = /^\/api\/accounts\/([^/]+)\/org\/(infer|cancel|research|resume)$/.exec(url.pathname);
    if (om) {
      param = dec(om[1]!);
      routePath = `/api/accounts/:id/org/${om[2]}`;
    } else if (m) {
      param = dec(m[2]!);
      routePath = `/api/${m[1]}/:id${m[3] ?? ''}`;
    } else if (am) {
      param = dec(am[1]!);
      if (am[3]) param2 = dec(am[3]);
      routePath = `/api/accounts/:id${am[2] ? `/${am[2]}` : ''}${am[3] ? '/:pid' : ''}`;
    }
    const route = `${method} ${routePath}`;
    const known = [
      'GET /', 'GET /api/state', 'GET /api/events',
      'POST /api/dossiers', 'POST /api/dossiers/cancel', 'POST /api/dossiers/resume',
      'POST /api/lenses', 'POST /api/lenses/:id/refresh', 'PUT /api/lenses/:id', 'DELETE /api/lenses/:id',
      'GET /api/lists', 'PUT /api/lists/:id', 'DELETE /api/lists/:id',
      'POST /api/export', 'POST /api/snapshot',
      'POST /api/ahoy/check', 'POST /api/ahoy/resolve', 'POST /api/ahoy/plan', 'POST /api/ahoy/send',
      'GET /api/accounts', 'POST /api/accounts', 'GET /api/accounts/:id', 'PUT /api/accounts/:id', 'DELETE /api/accounts/:id',
      'GET /api/accounts/:id/brief', 'POST /api/accounts/:id/members', 'PUT /api/accounts/:id/members/:pid',
      'DELETE /api/accounts/:id/members/:pid', 'POST /api/accounts/:id/contacts', 'POST /api/ext/pair',
      'POST /api/accounts/:id/org/infer', 'POST /api/accounts/:id/org/cancel',
      'POST /api/accounts/:id/org/research', 'POST /api/accounts/:id/org/resume',
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
      case 'GET /api/accounts':
        return sendJson(res, 200, { accounts: accountList() });
      case 'POST /api/accounts':
        return sendJson(res, 200, createAccount(await readJsonBody(req)));
      case 'GET /api/accounts/:id':
        return sendJson(res, 200, accountView(param));
      case 'PUT /api/accounts/:id':
        return sendJson(res, 200, updateAccount(param, await readJsonBody(req)));
      case 'DELETE /api/accounts/:id':
        await readJsonBody(req);
        return sendJson(res, 200, deleteAccount(param));
      case 'GET /api/accounts/:id/brief': {
        const detail = url.searchParams.get('detail') === 'summary' ? 'summary' : 'full';
        return sendJson(res, 200, { markdown: accountMarkdown(accountView(param), detail) });
      }
      case 'POST /api/accounts/:id/members':
        return sendJson(res, 200, addMembers(param, await readJsonBody(req)));
      case 'PUT /api/accounts/:id/members/:pid':
        return sendJson(res, 200, updateMember(param, param2, await readJsonBody(req)));
      case 'DELETE /api/accounts/:id/members/:pid':
        await readJsonBody(req);
        return sendJson(res, 200, removeMember(param, param2));
      case 'POST /api/accounts/:id/contacts':
        return sendJson(res, 200, addLightContacts(param, await readJsonBody(req)));
      case 'POST /api/accounts/:id/org/infer': {
        const body = await readJsonBody(req);
        if (closing) throw new HttpError(503, 'server is shutting down');
        return sendJson(res, 200, orgInfer(param, body));
      }
      case 'POST /api/accounts/:id/org/cancel':
        await readJsonBody(req);
        return sendJson(res, 200, orgCancel(param));
      case 'POST /api/accounts/:id/org/research': {
        const body = await readJsonBody(req);
        if (closing) throw new HttpError(503, 'server is shutting down');
        return sendJson(res, 200, orgResearch(param, body));
      }
      case 'POST /api/accounts/:id/org/resume':
        await readJsonBody(req);
        return sendJson(res, 200, orgResumeJob(param));
      case 'POST /api/ext/pair': {
        const body = await readJsonBody(req);
        return sendJson(res, 200, pairingCode(body.rotate === true));
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
      await Promise.allSettled([...inflight, ...(lensPromise ? [lensPromise] : []), ...(ahoyPromise ? [ahoyPromise] : []), ...(orgPromise ? [orgPromise] : [])]);
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
