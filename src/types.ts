import type { AccountSummary } from './accounts/types';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- Paths & defaults ----------
/** where earlier versions kept their data (still used when it holds a database and ~/.network-builder doesn't exist) */
export const LEGACY_DATA_HOME = path.join(os.homedir(), 'git', 'reports', 'network-builder');
/**
 * Data folder: $NETWORK_BUILDER_HOME, else ~/.network-builder — unless only an earlier version's folder exists,
 * in which case keep using it so existing users don't lose their database.
 */
export function resolveDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.NETWORK_BUILDER_HOME?.trim();
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  const home = path.join(os.homedir(), '.network-builder');
  // whichever folder actually holds a database wins (an empty ~/.network-builder never hides an existing one)
  if (existsSync(path.join(home, 'network.db'))) return home;
  if (existsSync(path.join(LEGACY_DATA_HOME, 'network.db'))) return LEGACY_DATA_HOME;
  return home;
}
export const REPORTS_ROOT = resolveDataHome();
export const DEFAULT_SIGNALS_PATH = path.join(REPORTS_ROOT, 'signals.md');
export const DEFAULT_OUT_DIR = path.join(REPORTS_ROOT, 'outputs');
export const DEFAULT_CACHE_DIR = path.join(REPORTS_ROOT, '.cache');
/** single SQLite store for people, profiles, rankings, research, lists, exports and spend */
export const DEFAULT_DB_PATH = path.join(REPORTS_ROOT, 'network.db');

export const DEFAULTS = {
  batchSize: 75,
  rankConcurrency: 4,
  researchConcurrency: 4,
  rankModel: 'haiku',
  researchModel: 'sonnet',
  enrichModel: 'haiku',
  enrichBatchSize: 50,
  enrichConcurrency: 4,
  rankTimeoutMs: 3 * 60_000,
  /** profile batches emit ~60 output tokens per person; 100-person batches sometimes exceeded 3 min */
  enrichTimeoutMs: 5 * 60_000,
  researchTimeoutMs: 15 * 60_000,
  retries: 2,
  /** rough per-person research cost with web search (Sonnet default; Opus measured ~$0.20–0.30) */
  estUsdPerResearch: 0.15,
} as const;

export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

// ---------- People / CSV ----------
export type CanonicalField =
  | 'fullName' | 'firstName' | 'lastName' | 'title' | 'company' | 'url' | 'email' | 'connectedOn';

/** canonical field -> original header text as found in the CSV */
export type ColumnMap = Partial<Record<CanonicalField, string>>;

export interface Person {
  /** stable id: sha1(normalized url || `${fullName}|${company}`).slice(0,12) */
  id: string;
  /** 1-based index among data rows (after header) */
  rowIndex: number;
  fullName: string;
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  url: string;
  email: string;
  /** ISO YYYY-MM-DD when parseable, else raw string, else '' */
  connectedOn: string;
  /** unmapped columns, original header -> value */
  extra: Record<string, string>;
}

export interface ParseResult {
  people: Person[];
  /** 0-based line index of the detected header row (after any "Notes:" preamble) */
  headerRow: number;
  columnMap: ColumnMap;
  /** rows dropped (blank / no name and no url / duplicate id) */
  skipped: number;
  warnings: string[];
}

// ---------- Ranking (Haiku) ----------
export interface RankResult {
  id: string;
  /** 0-100 */
  score: number;
  reason: string;
}

export interface RankedPerson extends Person {
  score: number;
  fitReason: string;
  /** 1-based after sorting by score desc, tie-break connectedOn desc */
  rank: number;
  /** false when Haiku ranking failed / skipped this person (score is a placeholder 0) */
  ranked: boolean;
}

// ---------- Research (Sonnet by default, --research-model to change) ----------
export type SignalStrength = 'none' | 'weak' | 'moderate' | 'strong';
export type Confidence = 'low' | 'medium' | 'high';

export interface SignalFinding {
  signal: string;
  finding: string;
  strength: SignalStrength;
}

export interface Source {
  title: string;
  url: string;
}

export interface ResearchReport {
  /** did research confidently identify the right individual */
  identityConfirmed: boolean;
  summary: string;
  currentRole: string;
  location: string;
  signals: SignalFinding[];
  fitAssessment: string;
  recommendedApproach: string;
  talkingPoints: string[];
  redFlags: string[];
  sources: Source[];
  confidence: Confidence;
  /** 0-100 post-research fit score */
  researchScore: number;
}

export interface ResearchRecord {
  id: string;
  status: 'ok' | 'error';
  report?: ResearchReport;
  error?: string;
  costUsd: number;
  durationMs: number;
  model: string;
  /** sha1(signalsMarkdown).slice(0,12) — cache hits require a match, so editing signals.md re-runs research */
  signalsHash: string;
  /** ISO timestamp */
  finishedAt: string;
  /** set on records reused from the shared research cache in this session (costUsd is the original cost; $0 now) */
  fromCache?: boolean;
}

// ---------- Profile enrichment (Haiku, title/headline parsing; goal-independent) ----------
export type Seniority =
  | 'founder/owner' | 'c-suite' | 'partner' | 'vp' | 'director' | 'head of' | 'manager'
  | 'senior ic' | 'ic' | 'advisor/board' | 'student' | 'unknown';

export type JobFunction =
  | 'investing' | 'general management' | 'sales' | 'marketing' | 'engineering' | 'product' | 'design'
  | 'data/ai' | 'operations' | 'finance' | 'people/recruiting' | 'legal' | 'consulting'
  | 'customer success' | 'media/creative' | 'education/research' | 'healthcare' | 'public sector' | 'other';

export const PERSONA_TAGS = [
  'investor', 'angel', 'vc', 'founder', 'exited founder', 'executive', 'operator', 'advisor',
  'board member', 'recruiter', 'consultant', 'academic', 'creator', 'public sector', 'open to work',
] as const;
export type PersonaTag = (typeof PERSONA_TAGS)[number];

/** Cheap structured profile parsed from name/title/company only (no web). Cached per person+title, reused across goals. */
export interface Profile {
  /** current company as parsed from title ("VP Sales at Acme" -> "Acme"), else the CSV company, else '' */
  company: string;
  /** cleaned role, e.g. "VP Sales" */
  role: string;
  seniority: Seniority;
  function: JobFunction;
  /** short sector guess, 1–3 words lowercase (e.g. "fintech", "venture capital", "saas"), '' if unclear */
  industry: string;
  tags: PersonaTag[];
  /** geography if the title states it (e.g. "EMEA", "Ireland"), else '' */
  region: string;
}

export interface EnrichedFields {
  /** absent until enrichment ran for this person */
  profile?: Profile;
  /**
   * Latest successful research on this person from ANY earlier run (possibly a different goal), attached from
   * the database when there is no exact (person+goal+signals+model) result. Used as context by ranking and
   * as a starting point by research; shown in the report as "earlier research".
   */
  priorResearch?: PriorResearch;
}

export interface PriorResearch {
  /** the goal that research was done for */
  prompt: string;
  model: string;
  finishedAt: string;
  report: ResearchReport;
}

export interface ResearchedPerson extends RankedPerson, EnrichedFields {
  research?: ResearchRecord;
}

// ---------- Claude CLI runner ----------
export type ModelId = 'haiku' | 'sonnet' | 'opus' | (string & {});

export interface ClaudeCallOptions {
  prompt: string;
  model: ModelId;
  /** JSON Schema object; serialized to --json-schema */
  jsonSchema: Record<string, unknown>;
  /** built-in tool names; [] or undefined => --tools "" */
  tools?: string[];
  /**
   * MCP tool names (e.g. mcp__claude_ai_Ahoy__search_crm). When set, the user's MCP servers / claude.ai connectors
   * load (no --strict-mcp-config) and ONLY these tools are allowed; built-in tools are disallowed.
   */
  mcpTools?: string[];
  appendSystemPrompt?: string;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

export interface ClaudeResult<T> {
  data: T;
  costUsd: number;
  /** true when an earlier attempt timed out, so its spend is unknown and costUsd is a lower bound */
  costIncomplete?: boolean;
  durationMs: number;
  rawResult: string;
}

/** Raw stdout shape of `claude -p --output-format json` */
export interface ClaudeCliJson {
  type?: string;
  subtype?: string;
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

export type CostStage = 'rank' | 'research' | 'enrich' | 'dossier' | 'lens' | 'ahoy';

export interface CostTracker {
  add(stage: CostStage, usd: number): void;
  total(): number;
  byStage(): Record<CostStage, number>;
  /** record that some spend is unknown (timed-out / killed calls) so totals are a lower bound */
  markIncomplete(): void;
  isIncomplete(): boolean;
}

// ---------- Cache ----------
export interface RunMeta {
  runKey: string;
  inputPath: string;
  prompt: string;
  rankModel: string;
  researchModel: string;
  createdAt: string;
  updatedAt: string;
  totalPeople: number;
}

export interface RunCache {
  readonly dir: string;
  readonly runKey: string;
  /** sync lookup; ranks are loaded into memory on open */
  getRank(id: string): RankResult | undefined;
  /** merge + atomically persist ranks.json (writes serialized internally) */
  setRanks(results: RankResult[]): Promise<void>;
  /**
   * Research records live in a cache shared across runs (<cacheRoot>/research/<key>.json), keyed by
   * computeResearchKey(personId, prompt, signalsHash, model). Returns only status 'ok' records, and
   * always undefined when the cache was opened with fresh: true.
   */
  getResearch(key: string): Promise<ResearchRecord | undefined>;
  setResearch(key: string, rec: ResearchRecord): Promise<void>;
  /** latest ok research for the person from any goal/signals/model, excluding `excludeKey` (SQLite store only) */
  getPriorResearch?(personId: string, excludeKey?: string): Promise<PriorResearch | undefined>;
  writeMeta(meta: RunMeta): Promise<void>;
}

/** Shared, goal-independent profile cache: <cacheRoot>/profiles/<key>.json */
export interface ProfileCache {
  readonly dir: string;
  get(key: string): Promise<Profile | undefined>;
  /** personId lets the store link the profile to the person (stats, exports); optional for legacy callers */
  set(key: string, profile: Profile, personId?: string): Promise<void>;
}

// ---------- Progress hooks ----------
export interface RankBatchInfo {
  batchIndex: number;
  totalBatches: number;
  size: number;
  costUsd: number;
  fromCache: boolean;
}

export interface RankHooks {
  onBatchStart?(info: Omit<RankBatchInfo, 'costUsd' | 'fromCache'>): void;
  onBatchDone?(info: RankBatchInfo): void;
  onBatchError?(info: Omit<RankBatchInfo, 'costUsd' | 'fromCache'>, err: Error): void;
}

export interface ResearchHooks {
  onStart?(person: RankedPerson): void;
  onDone?(person: RankedPerson, rec: ResearchRecord, fromCache: boolean): void;
}

export interface EnrichOptions {
  batchSize: number;
  concurrency: number;
  model: ModelId;
  cache: ProfileCache;
  costs: CostTracker;
  signal?: AbortSignal;
  /** same batch-progress shape as ranking */
  hooks?: RankHooks;
}

export interface RankOptions {
  prompt: string;
  batchSize: number;
  concurrency: number;
  model: ModelId;
  cache: RunCache;
  costs: CostTracker;
  signal?: AbortSignal;
  hooks?: RankHooks;
}

export interface ResearchOptions {
  prompt: string;
  signalsMarkdown: string;
  concurrency: number;
  model: ModelId;
  cache: RunCache;
  costs: CostTracker;
  signal?: AbortSignal;
  hooks?: ResearchHooks;
}

// ---------- Run config ----------
export interface RunConfig {
  inputPath: string;
  prompt: string;
  batchSize: number;
  rankConcurrency: number;
  researchConcurrency: number;
  signalsPath: string;
  outDir: string;
  cacheDir: string;
  rankModel: ModelId;
  researchModel: ModelId;
  dbPath: string;
  dryRun: boolean;
  fresh: boolean;
}

export interface OutputFilenameOptions {
  prompt: string;
  date: Date;
  total: number;
}

// ---------- Interactive report (HTML UI + local server) ----------
/** Everything needed to reopen a run later (`network-builder serve`). Stored in the JSON sidecar. */
export interface ReportMeta {
  version: 1;
  prompt: string;
  inputPath: string;
  createdAt: string;
  updatedAt: string;
  totalPeople: number;
  rankModel: string;
  researchModel: string;
  signalsPath: string;
  /** rank cache root, so serve can reuse the shared research cache */
  cacheDir: string;
  outDir: string;
  /** file stem shared by .csv/.json/.html in outDir */
  stem: string;
  estUsdPerResearch: number;
  /** cumulative spend across all sessions on this report (ranking + research) */
  costs?: { rank: number; research: number; enrich?: number };
  /** run key of the ranking (rankings table) — absent in reports written before the SQLite store */
  runKey?: string;
  /** SQLite store this report reads/writes (lists, research); absent → DEFAULT_DB_PATH */
  dbPath?: string;
}

/** JSON sidecar shape (v1). Older sidecars were a bare ResearchedPerson[]. */
export interface ReportFile {
  meta: ReportMeta;
  people: ResearchedPerson[];
  /** saved selections (e.g. CRM upload lists); absent in older files = [] */
  lists?: SavedList[];
}

export interface SavedList {
  /** slug id, unique per report */
  id: string;
  name: string;
  /** person ids, in the order the user built the list */
  ids: string[];
  createdAt: string;
  updatedAt: string;
}

export interface QueueState {
  queued: string[];
  running: string[];
  /** monotonically increasing per server session; clients ignore snapshots older than one already applied */
  seq: number;
}

export interface CostSnapshot {
  /** profile enrichment (Haiku title parsing); absent in snapshots from older reports */
  enrich?: number;
  rank: number;
  research: number;
  total: number;
  incomplete: boolean;
}

/** Embedded in the HTML (<script id="nb-data" type="application/json">) and returned by GET /api/state. */
export interface ReportState extends ReportFile {
  /** null when the page is a static snapshot (no server) */
  api: { token: string } | null;
  queue: QueueState;
  costs: CostSnapshot;
  paths: { csv: string; json: string; html: string };
}

/** Server-sent events on GET /api/events (event name = `type`, data = JSON of the whole object). */
export type ServerEvent =
  | { type: 'queued'; ids: string[]; queue: QueueState }
  | { type: 'started'; id: string; queue: QueueState }
  | {
      type: 'done';
      id: string;
      person: ResearchedPerson;
      queue: QueueState;
      costs: CostSnapshot;
      /** set when a (forced) re-run failed and the previous ok result was kept */
      error?: string;
    }
  | { type: 'cancelled'; ids: string[]; queue: QueueState }
  | {
      type: 'saved';
      paths: { csv: string; json: string; html: string };
      at: string;
      /** people changed server-side outside research (e.g. background profile backfill): clients refetch /api/state */
      reload?: boolean;
    }
  | { type: 'hello'; queue: QueueState; costs: CostSnapshot }
  | { type: 'lists'; lists: SavedList[] };

// =====================================================================================
// v6: Network explorer — goal-free dossiers + lenses (see src/web/CONTRACT.md "v6")
// =====================================================================================

/** 'light' = Haiku, 1–2 web searches, snippets only. 'deep' = research model (Sonnet), several searches + fetches. */
export type DossierDepth = 'light' | 'deep';

export interface CareerEntry {
  role: string;
  company: string;
  /** e.g. "2015–2021", "2019–present", '' if unknown */
  period: string;
  current: boolean;
}

/** Goal-independent knowledge about a person. Never contains judgements about a specific goal. */
export interface Dossier {
  identityConfirmed: boolean;
  confidence: Confidence;
  /** one neutral sentence: who they are */
  oneLiner: string;
  currentRole: string;
  currentCompany: string;
  location: string;
  career: CareerEntry[];
  education: string[];
  /** angel/VC/LP activity described neutrally ('' if none found) */
  investingSummary: string;
  /** named portfolio companies / funds if found */
  investments: string[];
  boards: string[];
  expertise: string[];
  /** exits, awards, notable achievements, press */
  notable: string[];
  /** podcasts, blogs, talks, social presence */
  publicPresence: string[];
  /** what they've said/done publicly in roughly the last 12 months, newest first (deep dossiers; [] on older/light ones) */
  recentActivity: RecentActivityItem[];
  /** 3–6 short topic phrases they've been talking about lately, derived only from recentActivity */
  recentThemes: string[];
  sources: Source[];
}

export type RecentActivityKind = 'post' | 'article' | 'podcast' | 'talk' | 'interview' | 'news' | 'announcement' | 'other';

export interface RecentActivityItem {
  /** YYYY-MM or YYYY-MM-DD, '' if unknown */
  date: string;
  kind: RecentActivityKind;
  title: string;
  /** one line: what they said / argued, not just that they appeared */
  summary: string;
  url: string;
}

export interface DossierRecord {
  personId: string;
  depth: DossierDepth;
  status: 'ok' | 'error' | 'rate_limited';
  dossier?: Dossier;
  error?: string;
  model: string;
  costUsd: number;
  durationMs: number;
  /** ISO */
  createdAt: string;
  /** true when converted from older goal-specific research */
  legacy?: boolean;
  /** goal-specific notes kept from legacy research (shown collapsed as "Legacy goal notes") */
  legacyNotes?: {
    goal: string;
    fitAssessment: string;
    recommendedApproach: string;
    talkingPoints: string[];
    redFlags: string[];
    researchScore: number;
  };
}

/** A goal you score the whole network against, e.g. "potential angel investors". */
export interface Lens {
  /** slug, unique */
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  rankModel: string;
  /** model used to re-score the top candidates ('' = no rerank) */
  rerankModel: string;
  rerankTop: number;
  /** people scored with the current inputs */
  scored: number;
  /** people whose inputs (title/profile/dossier) changed since scoring */
  stale: number;
  /** members = (score ≥ threshold and not pinned out) or pinned in */
  threshold: number;
  /** person ids added by hand (in the lens whatever their score) */
  pinnedIn: string[];
  /** person ids removed by hand (out of the lens whatever their score) */
  pinnedOut: string[];
}

/** What a score was based on (strongest input available when scored). */
export type EvidenceBasis = 'headline' | 'dossier-light' | 'dossier-deep';

export interface LensScore {
  lensId: string;
  personId: string;
  score: number;
  reason: string;
  basis: EvidenceBasis;
  /** model that produced the final score ('haiku' first pass, or the rerank model) */
  model: string;
  /** hash of the inputs the score was computed from; differs from current → stale */
  inputHash: string;
  scoredAt: string;
}

/** One row in the explorer. Lens scores are keyed by lens id. */
export interface ExplorerPerson extends Person {
  profile?: Profile;
  /** best available dossier (deep preferred over light; newest first) */
  dossier?: DossierRecord;
  scores: Record<string, { score: number; reason: string; basis: EvidenceBasis; stale: boolean }>;
  /** Ahoy CRM reconciliation (v7), when checked */
  crm?: CrmMatch;
}

// ---------- v7: Ahoy CRM ----------
/** in_crm: the contact exists · new: no such contact · ambiguous: several candidates, you pick · error: the check failed */
export type CrmStatus = 'in_crm' | 'new' | 'ambiguous' | 'error';
/** in_crm: company exists with a domain · no_domain: exists without one · new: not in the CRM · none: no company known */
export type CrmCompanyStatus = 'in_crm' | 'no_domain' | 'new' | 'none';
export interface CrmCandidate {
  id: string;
  name: string;
  /** title / company / email — enough to tell candidates apart */
  detail: string;
}
export interface CrmMatch {
  status: CrmStatus;
  contactId?: string;
  contactName?: string;
  contactEmail?: string;
  companyId?: string;
  /** the company name as it is (or will be) in the CRM */
  companyName?: string;
  companyDomain?: string;
  companyStatus: CrmCompanyStatus;
  /** for matched contacts: is the contact linked (ahoy_contact_to_company) to the company found? */
  linkedToCompany?: 'yes' | 'no' | 'unknown';
  candidates?: CrmCandidate[];
  reason: string;
  checkedAt: string;
  /** you picked a candidate or "new" in the explorer */
  resolvedByHand?: boolean;
  /** sent to Ahoy as a proposal (awaiting / after approval in the Ahoy app) */
  sent?: { at: string; proposalId: string; url: string; title: string };
}

export type JobKind = 'dossier' | 'lens';

export interface JobQueueState {
  /** dossier jobs: person ids */
  queued: { id: string; depth: DossierDepth }[];
  running: { id: string; depth: DossierDepth }[];
  /** when web search is rate-limited, the queue pauses until this ISO time */
  pausedUntil: string | null;
  /** true after repeated rate limits: the queue stays paused until a human clicks Resume (POST /api/dossiers/resume) */
  pausedManual?: boolean;
  /** lens scoring in progress */
  lensJob: { lensId: string; phase: 'score' | 'rerank'; done: number; total: number } | null;
  /** Ahoy check / send in progress */
  ahoyJob?: { kind: 'check' | 'send'; done: number; total: number } | null;
  seq: number;
}

export interface ExplorerCosts {
  enrich: number;
  dossier: number;
  lens: number;
  /** legacy goal-specific research spend */
  research: number;
  /** Ahoy CRM checks and sends */
  ahoy?: number;
  total: number;
  incomplete: boolean;
}

/** GET /api/state and embedded snapshot. */
export interface ExplorerState {
  version: 6;
  generatedAt: string;
  people: ExplorerPerson[];
  lenses: Lens[];
  lists: SavedList[];
  /** null when static snapshot */
  api: { token: string } | null;
  queue: JobQueueState;
  costs: ExplorerCosts;
  /** lens estimate = n/1000 × lensUsdPer1000 + min(rerankTop, n)/100 × lensRerankUsdPer100 */
  estimates: {
    lightUsd: number;
    deepUsd: number;
    lensUsdPer1000: number;
    lensRerankUsdPer100: number;
    ahoyCheckUsdPerPerson?: number;
    ahoySendUsdPerProposal?: number;
  };
  dbPath: string;
  /** accounts (ABX) — summaries only; GET /api/accounts/:id for the full view */
  accounts?: AccountSummary[];
}

export type ExplorerEvent =
  | { type: 'hello'; queue: JobQueueState; costs: ExplorerCosts }
  | { type: 'queue'; queue: JobQueueState }
  | { type: 'person'; person: ExplorerPerson; costs: ExplorerCosts; error?: string }
  | { type: 'lens'; lens: Lens; scores?: { personId: string; score: number; reason: string; basis: EvidenceBasis }[]; costs: ExplorerCosts }
  | { type: 'lenses'; lenses: Lens[] }
  | { type: 'lists'; lists: SavedList[] }
  /** Ahoy reconciliation results / sent markers for some people */
  | { type: 'crm'; updates: { id: string; crm: CrmMatch | null }[]; costs: ExplorerCosts }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  /** accounts changed (`changed` = the account touched; `notice` = e.g. a capture from the Chrome extension) */
  | { type: 'accounts'; accounts: AccountSummary[]; changed?: string; notice?: string }
  /** another process changed the database: clients should refetch GET /api/state */
  | { type: 'reload'; reason: string };
