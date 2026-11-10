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
  captured: number;
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
