/**
 * Accounts (ABX): a company you're focused on, the key people there grouped by org-chart position, and a markdown
 * brief — kept apart from the LinkedIn-connections network. People captured from LinkedIn live in `contacts`, never in
 * `people`, so lenses, the People view, network search and exports only ever see your real connections.
 */

export const ACCOUNT_STATUSES = ['target', 'engaged', 'customer', 'paused'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Org-chart column. Derived from the title (or the headline profile for connections) unless set by hand. */
export const DEPARTMENTS = [
  'executive', 'engineering', 'it-security', 'data-ai', 'product', 'design', 'sales', 'customer', 'marketing',
  'finance', 'people', 'legal', 'operations', 'board', 'other',
] as const;
export type Department = (typeof DEPARTMENTS)[number];
export const DEPARTMENT_LABELS: Record<Department, string> = {
  executive: 'Executive',
  engineering: 'Engineering',
  'it-security': 'IT & Security',
  'data-ai': 'Data & AI',
  product: 'Product',
  design: 'Design',
  sales: 'Sales & Partnerships',
  customer: 'Customer',
  marketing: 'Marketing',
  finance: 'Finance & Procurement',
  people: 'People / HR',
  legal: 'Legal & Compliance',
  operations: 'Operations & Strategy',
  board: 'Board & Advisors',
  other: 'Other',
};

/** Org-chart row (seniority), most senior first. */
export const TIERS = ['exec', 'vp', 'director', 'manager', 'ic', 'board', 'unknown'] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_LABELS: Record<Tier, string> = {
  exec: 'C-level & founders',
  vp: 'VP',
  director: 'Director / Head of',
  manager: 'Manager / Lead',
  ic: 'Individual contributor',
  board: 'Board & advisors',
  unknown: 'Unknown level',
};

/** Buying-committee role — set by you (never guessed). '' = not set yet. */
export const COMMITTEE_ROLES = ['decision-maker', 'champion', 'influencer', 'user', 'gatekeeper', 'blocker'] as const;
export type CommitteeRole = (typeof COMMITTEE_ROLES)[number];
export const ROLE_LABELS: Record<CommitteeRole, string> = {
  'decision-maker': 'Decision maker',
  champion: 'Champion',
  influencer: 'Influencer',
  user: 'End user',
  gatekeeper: 'Gatekeeper / procurement',
  blocker: 'Blocker',
};

// ---------- v9: marketing org map (shared vocabulary) ----------

/** Marketing sub-functions. demand-gen covers growth/performance/campaigns/ABM; field-marketing = regional/country/field;
 *  digital-social = web, SEO/SEA, social. */
export const SUBFUNCTIONS = [
  'leadership', 'brand', 'product-marketing', 'demand-gen', 'content', 'comms-pr', 'events', 'partner-marketing',
  'marketing-ops', 'digital-social', 'field-marketing', 'other',
] as const;
export type Subfunction = (typeof SUBFUNCTIONS)[number];
export const SUBFUNCTION_LABELS: Record<Subfunction, string> = {
  leadership: 'Leadership',
  brand: 'Brand',
  'product-marketing': 'Product marketing',
  'demand-gen': 'Demand gen & growth',
  content: 'Content',
  'comms-pr': 'Comms & PR',
  events: 'Events',
  'partner-marketing': 'Partner marketing',
  'marketing-ops': 'Marketing ops & tech',
  'digital-social': 'Digital, web & social',
  'field-marketing': 'Field & regional',
  other: 'Other',
};

/** Fine seniority ladder, most senior first. */
export const SENIORITIES = [
  'c-level', 'svp', 'vp', 'senior-director', 'director', 'head', 'senior-manager', 'manager', 'lead', 'senior-ic', 'ic',
  'junior', 'intern', 'unknown',
] as const;
export type Seniority = (typeof SENIORITIES)[number];
/** each fine seniority → the org-chart row (TIERS) */
export const SENIORITY_TIER: Record<Seniority, Tier> = {
  'c-level': 'exec', svp: 'vp', vp: 'vp', 'senior-director': 'director', director: 'director', head: 'director',
  'senior-manager': 'manager', manager: 'manager', lead: 'manager', 'senior-ic': 'ic', ic: 'ic', junior: 'ic', intern: 'ic',
  unknown: 'unknown',
};

/**
 * Values the member `noise` column accepts. Every flag except `vendor-funded` keeps a person out of the org.
 * `vendor-funded` is a TAG (Phase 2b): a marketer employed by the account (or one of its entities) whose role is funded
 * by / dedicated to a vendor stays in the org and every headcount; it is kept here so a stored or hand-set
 * `noise = 'vendor-funded'` still means "tag this person" (see `ORG_NOISE_FLAGS`, `AccountMember.vendorFunded`).
 * `other-employer` = the person's current company is clearly not the account or one of its entities.
 */
export const NOISE_FLAGS = ['hr-marketing', 'sales-hybrid', 'vendor-funded', 'not-marketing', 'stale', 'other-employer'] as const;
export type NoiseFlag = (typeof NOISE_FLAGS)[number];
/** the noise flags that exclude a person from the org (all but the `vendor-funded` tag) */
export type OrgNoise = Exclude<NoiseFlag, 'vendor-funded'>;
export const ORG_NOISE_FLAGS = NOISE_FLAGS.filter((f): f is OrgNoise => f !== 'vendor-funded');

export const SOURCE_KINDS = ['extension-profile', 'extension-list', 'web', 'connection', 'manual', 'mcp'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
/** where a fact about a person came from */
export interface SourceRef {
  kind: SourceKind;
  at: string;
  url?: string;
  evidenceUrl?: string;
  quote?: string;
  runId?: string;
}
/** who set a reporting line: '' none, 'user' by hand (always wins), 'inferred' by the AI/rules, 'web' from research */
export type ReportsToSource = '' | 'user' | 'inferred' | 'web';
/** 0..1; null/undefined = not assessed. Stated in a source 0.9; same team + clear seniority gap 0.6; title only 0.3. */
export type Confidence01 = number;
export const confidenceBadge = (c: Confidence01 | null | undefined): 'high' | 'medium' | 'low' | '' =>
  c === null || c === undefined || !Number.isFinite(c) ? '' : c >= 0.75 ? 'high' : c >= 0.45 ? 'medium' : 'low';

/** last AI classification of a member (stored in account_members.inference_json; user overrides win at view time) */
export interface MemberInference {
  subfunction?: Subfunction;
  seniority?: Seniority;
  /** an excluding flag or '' (older stored results may hold 'vendor-funded': read as the tag, not as noise) */
  noise?: NoiseFlag | '';
  /** employed by the account, role funded by / dedicated to a vendor (a tag; the person stays in the org) */
  vendorFunded?: boolean;
  team?: string;
  entity?: string;
  country?: string;
  responsibilities?: string;
  confidence?: Confidence01;
  reason?: string;
  model?: string;
  at?: string;
  /** a reporting-line guess too weak to store as a line (< 0.45): shown as "possible manager" only */
  possibleManager?: { id: string; confidence: number; reason: string };
}

export const HEADCOUNT_SOURCES = ['linkedin-people', 'linkedin-search', 'web', 'user'] as const;
export type HeadcountSource = (typeof HEADCOUNT_SOURCES)[number];
export const HEADCOUNT_SCOPES = ['company', 'function', 'query'] as const;
export type HeadcountScope = (typeof HEADCOUNT_SCOPES)[number];
export interface HeadcountSnapshot {
  id: number;
  accountId: string;
  takenAt: string;
  source: HeadcountSource;
  scope: HeadcountScope;
  label: string;
  count: number;
  url: string;
  evidenceUrl: string;
  quote: string;
  confidence: Confidence01 | null;
  runId: string;
}

export const LIST_PAGE_KINDS = ['people-tab', 'search'] as const;
export type ListPageKind = (typeof LIST_PAGE_KINDS)[number];
/**
 * `counts-only`: set by the server for a "Capture headcount only" post (zero rows, final) — not a walk.
 * `abandoned`: set by the server for an open run with no activity for 10 minutes (the tab reloaded or closed mid-walk).
 */
export const LIST_STOP_REASONS = ['end', 'cap', 'cancelled', 'checkpoint', 'rate-limit', 'login', 'stalled', 'error', 'counts-only', 'abandoned'] as const;
export type ListStopReason = (typeof LIST_STOP_REASONS)[number];
/** one walk over a LinkedIn people list (company People tab or a search) by the extension */
export interface ListRun {
  id: string;
  accountId: string;
  pageKind: ListPageKind;
  url: string;
  keywords: string;
  startedAt: string;
  finishedAt: string;
  rowsSeen: number;
  named: number;
  anonymous: number;
  stopReason: ListStopReason | '';
  /** last activity: the start or the latest post */
  updatedAt: string;
}
/** a "LinkedIn Member" row (no name) seen in a list run — counts toward headcount, never becomes a contact */
export interface AnonRow {
  runId: string;
  idx: number;
  headline: string;
  location: string;
}

export const ORG_FACT_KINDS = ['team', 'entity', 'reporting', 'leadership', 'hiring', 'headcount', 'other'] as const;
export type OrgFactKind = (typeof ORG_FACT_KINDS)[number];
export interface OrgFact {
  id: number;
  accountId: string;
  kind: OrgFactKind;
  text: string;
  evidenceUrl: string;
  quote: string;
  confidence: Confidence01 | null;
  foundAt: string;
  runId: string;
}

/** a person seen in a list / added by hand without a full profile capture */
export interface LightContactInput {
  fullName: string;
  url?: string;
  title?: string;
  headline?: string;
  company?: string;
  location?: string;
  source: SourceRef;
}

export interface Account {
  id: string;
  name: string;
  domain: string;
  /** normalised https://www.linkedin.com/company/<slug> or '' */
  linkedinUrl: string;
  /** other names the company goes by (used to match captures and your connections) */
  aliases: string[];
  status: AccountStatus;
  /** ABX context in markdown: why this account, pains, triggers, strategy, notes */
  brief: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceEntry {
  title: string;
  company: string;
  /** /company/<slug> URL when the capture had one */
  companyUrl?: string;
  employmentType?: string;
  /** as shown, e.g. "Jan 2021 - Present · 3 yrs 10 mos" */
  dates: string;
  current: boolean;
  location?: string;
  description?: string;
}

export interface EducationEntry {
  school: string;
  detail: string;
}

/** A LinkedIn profile as captured by the Chrome extension, parsed on the server. */
export interface CapturedProfile {
  url: string;
  fullName: string;
  headline: string;
  location: string;
  /** current role, from the first current experience entry, else the headline */
  title: string;
  company: string;
  companyUrl: string;
  about: string;
  experience: ExperienceEntry[];
  education: EducationEntry[];
  /** any other sections (skills, certifications, volunteering, …): heading → lines */
  other: Record<string, string[]>;
  /** the page's visible text — kept so nothing is lost when LinkedIn changes its markup */
  rawText: string;
  /** the full-list pages' text (experience, education, skills, …), cleaned — kept for the same reason */
  detailsText?: Record<string, string>;
}

export interface Contact {
  /** same id scheme as people (`personId(url)`), and equal to the connection's id when they're a connection */
  id: string;
  url: string;
  fullName: string;
  headline: string;
  title: string;
  company: string;
  location: string;
  profile: CapturedProfile;
  capturedAt: string;
  captureCount: number;
  /** 'full' = a profile captured by the extension; 'light' = name/title/URL only (a list row or added by hand) */
  kind: 'full' | 'light';
  sources: SourceRef[];
}

export interface AccountMemberRow {
  accountId: string;
  personId: string;
  /** '' = automatic (from the title) */
  department: Department | '';
  tier: Tier | '';
  role: CommitteeRole | '';
  /** person id of their manager within the account, '' if unknown */
  reportsTo: string;
  notes: string;
  addedAt: string;
  updatedAt: string;
  /** user override; '' = automatic (inference, then title) */
  subfunction: Subfunction | '';
  team: string;
  /** legal entity, e.g. "Ledgerly Services GmbH" */
  entity: string;
  /** ISO-3166 alpha-2 or '' */
  country: string;
  responsibilities: string;
  /** user override: '' automatic | 'none' (not noise) | a flag */
  noise: NoiseFlag | 'none' | '';
  sources: SourceRef[];
  /** the person is in this org/role now */
  confidence: Confidence01 | null;
  reportsToSource: ReportsToSource;
  reportsToConfidence: Confidence01 | null;
  reportsToReason: string;
  inference?: MemberInference;
}

/** One person on an account, resolved for display: captured profile and/or connection data. */
export interface AccountMember {
  id: string;
  fullName: string;
  title: string;
  company: string;
  url: string;
  location: string;
  headline: string;
  department: Department;
  tier: Tier;
  /** true when department/tier came from the title rather than set by hand */
  autoDepartment: boolean;
  autoTier: boolean;
  role: CommitteeRole | '';
  reportsTo: string;
  notes: string;
  addedAt: string;
  /** in your LinkedIn connections */
  isConnection: boolean;
  connectedOn: string;
  /** captured from LinkedIn by the extension */
  capturedAt: string;
  profile?: CapturedProfile;
  /** one-liner from a web profile (connections you researched) */
  webSummary: string;
  /** other accounts this person is on */
  otherAccounts: string[];
  /** 'full' captured profile, 'light' (list row / added by hand), or a connection with no capture */
  kind: 'full' | 'light' | 'connection';
  /** resolved: user override, else inference, else from the title */
  subfunction: Subfunction;
  /** true when subfunction was not set by hand */
  autoSubfunction: boolean;
  seniority: Seniority;
  /** resolved excluding noise flag; '' = in the org. Never 'vendor-funded' (that is the `vendorFunded` tag). */
  noise: OrgNoise | '';
  /** tag: works for the account, role funded by / dedicated to a vendor. Stays in the org and every headcount. */
  vendorFunded: boolean;
  /** true when noise was not set by hand (false + noise '' = the user said "not noise") */
  autoNoise: boolean;
  team: string;
  entity: string;
  country: string;
  responsibilities: string;
  sources: SourceRef[];
  confidence: Confidence01 | null;
  reportsToSource: ReportsToSource;
  reportsToConfidence: Confidence01 | null;
  reportsToReason: string;
  inference?: MemberInference;
}

export interface WarmPath {
  id: string;
  fullName: string;
  title: string;
  company: string;
  url: string;
  /** 'current' = works there now; 'past' = their career history includes it */
  relation: 'current' | 'past';
  detail: string;
}

export interface AccountSummary {
  id: string;
  name: string;
  status: AccountStatus;
  domain: string;
  memberIds: string[];
  memberCount: number;
  /** members with a full profile captured by the extension */
  captured: number;
  /** members known only from a list row / added by hand (no full profile) */
  light: number;
  connections: number;
  /** committee roles covered, e.g. { 'decision-maker': 1, champion: 2 } */
  roles: Partial<Record<CommitteeRole, number>>;
  updatedAt: string;
}

export interface AccountView {
  account: Account;
  members: AccountMember[];
  warmPaths: WarmPath[];
  gaps: string[];
  /** the marketing org map (`src/accounts/org.ts`); set by the explorer server's account endpoints */
  org?: OrgMap;
}

// ---------- v9 Phase 5: org map (built by `buildOrgMap`, read by the page and MCP) ----------

/** a LinkedIn count: the latest snapshot of each distinct page, summed */
export interface HeadcountTotal {
  label: string;
  count: number;
  /** newest of the summed snapshots */
  takenAt: string;
  /** the snapshots summed (one per page), largest first */
  pages: HeadcountSnapshot[];
}

/** one person in the reporting tree */
export interface OrgNode {
  id: string;
  children: OrgNode[];
  /** the line to this person's manager (absent on a root) */
  edge?: { source: ReportsToSource; confidence: Confidence01 | null; reason: string };
  /**
   * true = not in the org scope (e.g. the CEO a CMO reports to, or a flagged manager): shown for context, never
   * counted. Their own manager chain is followed upwards.
   */
  context?: boolean;
}

export interface OrgMap {
  scope: 'marketing';
  /** ids in the org: marketing department OR seen through a marketing-scoped source (list run keywords, web research), minus flagged */
  members: string[];
  /** in scope but carrying an excluding noise flag (never `vendor-funded`): listed, never counted */
  flagged: { id: string; noise: OrgNoise }[];
  /** tops of the reporting trees (a member with at least one report and no manager in the tree) */
  roots: OrgNode[];
  /** members with no known manager and nobody reporting to them, by sub-function → entity */
  unplaced: { subfunction: Subfunction; entity: string; ids: string[] }[];
  headcount: {
    captured: {
      /** = members.length */
      total: number;
      named: number;
      light: number;
      full: number;
      /** your connections without a capture */
      connections: number;
      vendorFunded: number;
      bySubfunction: Record<Subfunction, number>;
      bySeniority: Record<Seniority, number>;
    };
    /**
     * what LinkedIn reports — the LATEST snapshot per (page, label), never summed across re-reads of a page; company and
     * function counts of DIFFERENT pages (entity company pages) are added up (`pages` lists what was summed)
     */
    linkedin: {
      /** People tab header ("N associated members"), summed over company pages */
      company?: HeadcountTotal;
      /** People tab "What they do" → Marketing (function-scoped) */
      marketing?: HeadcountTotal;
      /** every "What they do" function */
      functions: HeadcountTotal[];
      /** search / filtered list result counts — query-scoped (they count a keyword query, not the org); latest per page + label */
      queries: HeadcountSnapshot[];
    };
    /** anonymous ("LinkedIn Member") rows: the latest run per list (URL filters) only, summed over distinct lists */
    anonymous: number;
    /** headcount statements found by web research, latest per label */
    web: HeadcountSnapshot[];
    /** captured members ÷ the LinkedIn marketing count (function facet, else a "marketing" query count) */
    coverage?: number;
    coverageBasis?: 'function' | 'query';
    /** captured more people than the LinkedIn count: `coverage` is capped at 1 */
    coverageOver?: boolean;
  };
  entities: { entity: string; country: string; n: number }[];
  facts: OrgFact[];
  /** list walks, newest first, at most 10 (counts-only captures left out) */
  runs: ListRun[];
}

/** what the extension posts */
export interface CapturePayload {
  url: string;
  fullName: string;
  headline?: string;
  location?: string;
  currentCompany?: string;
  about?: string;
  sections?: Record<string, { heading?: string; items: { lines: string[]; sub?: string[][]; companyUrl?: string }[] }>;
  rawText?: string;
  /** the person's full lists (linkedin.com/in/<slug>/details/<kind>/): page text + list items when readable */
  details?: Record<string, { text?: string; items?: { lines: string[]; sub?: string[][]; companyUrl?: string }[] }>;
  /** per list: how reading it went (status + size), logged for troubleshooting — never stored */
  detailsDiag?: Record<string, string>;
}
