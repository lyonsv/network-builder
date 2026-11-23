import {
  ORG_FACT_KINDS,
  SUBFUNCTIONS,
  type Account,
  type HeadcountScope,
  type OrgFactKind,
  type Subfunction,
} from '../accounts/types';
import { DEFAULTS } from '../types';
import { ClaudeError, errorCost, runClaude } from './claude';
import { CLI_RATE_LIMIT_RE } from './dossier';
import { ORG_RESEARCH_SCHEMA } from './schemas';

/**
 * Human-triggered web research on one account's marketing organisation: `claude -p` with WebSearch + WebFetch on the
 * user's subscription, in sequential passes (company site → press → jobs → events → headcount). Every person, fact and
 * headcount must carry the URL of a page the model saw plus a verbatim quote, or it is dropped. linkedin.com is never
 * used as evidence (WebFetch can't read it and snippets can't be verified); `site:` is ignored by WebSearch, so prompts
 * never rely on it. The server persists each pass as it finishes; nothing here touches the database.
 */

export const ORG_RESEARCH_PASS_IDS = ['seed', 'press', 'jobs', 'events', 'headcount'] as const;
export type OrgResearchPassId = (typeof ORG_RESEARCH_PASS_IDS)[number];

export interface OrgResearchPass {
  id: OrgResearchPassId;
  label: string;
  /** default model ('sonnet' for the seed pass, else 'haiku'); the server may override */
  model: 'sonnet' | 'haiku';
  budget: { searches: number; fetches: number };
  /** what this pass looks for (prompt text) */
  focus: string;
  /** distinct searches to run before stopping, unless the topic is clearly exhausted */
  minSearches: number;
  /** spend estimate for this pass (USD) */
  usd: { min: number; max: number };
}

/** the layer below the C-level that a run must try to cover (seed + press) */
const LEADERSHIP_CHECKLIST = `Work through this checklist of roles; search for each one you haven't found yet (by role words, in the
company's languages) before you stop:
  [ ] Head of / Director / VP Marketing (Leiter(in) Marketing, Marketingleiter(in), Bereichsleiter(in) Marketing)
  [ ] Brand / Marke (Head of Brand, Leiter(in) Markenführung / Brand Management)
  [ ] Communications / PR (Head of Communications, Leiter(in) Unternehmenskommunikation, Pressesprecher(in))
  [ ] Digital / E-Commerce / Online Marketing (Head of Digital, Leiter(in) Digital / Online-Marketing)
  [ ] CRM / Customer Marketing / Loyalty
  [ ] Product Marketing / Category / Trade Marketing
  [ ] Country or regional marketing leads (per country site / legal entity)`;

export const ORG_RESEARCH_PASSES: Record<OrgResearchPassId, OrgResearchPass> = {
  seed: {
    id: 'seed',
    label: 'Company site',
    model: 'sonnet',
    budget: { searches: 8, fetches: 6 },
    focus: `The company's OWN pages: management / leadership / board pages (also per country site), about and locations
pages, the imprint (Impressum) for legal entities and managing directors, and any marketing / communications team or
contact pages. Identify the executive marketing reports to, the legal entities / country organisations (incl. a service
or holding entity where group marketing may sit) — and then, BELOW the C-level, the marketing and communications
leadership layer.
${LEADERSHIP_CHECKLIST}`,
    minSearches: 5,
    usd: { min: 0.1, max: 0.6 },
  },
  press: {
    id: 'press',
    label: 'Press & news',
    model: 'haiku',
    budget: { searches: 5, fetches: 3 },
    focus: `The newsroom, press releases and news coverage: press contacts (Pressekontakt) and spokespeople, appointments
("joins as … marketing", "neuer Leiter Marketing", "übernimmt die Leitung"), promotions and reorganisations of
marketing or communications, and interviews quoting marketing / communications leaders.
${LEADERSHIP_CHECKLIST}`,
    minSearches: 3,
    usd: { min: 0.05, max: 0.2 },
  },
  jobs: {
    id: 'jobs',
    label: 'Jobs & careers',
    model: 'haiku',
    budget: { searches: 5, fetches: 3 },
    focus: `The careers page and job ads for marketing / communications roles: team names, "reports to" / "berichtet an"
lines, which legal entity and location is hiring, and team-size statements ("a team of 12"). Record each open role as a
hiring fact (title, team, entity, location). A reporting line becomes a reporting fact only when BOTH people are named;
otherwise record it as a team fact (e.g. "Content team reports to the Head of Brand").`,
    minSearches: 3,
    usd: { min: 0.05, max: 0.2 },
  },
  events: {
    id: 'events',
    label: 'Events & talks',
    model: 'haiku',
    budget: { searches: 5, fetches: 3 },
    focus: `Conference speaker pages, podcasts, webinars, award entries and agency case studies that name the company's
marketing people, their titles and what they are responsible for.`,
    minSearches: 3,
    usd: { min: 0.05, max: 0.2 },
  },
  headcount: {
    id: 'headcount',
    label: 'Headcount',
    model: 'haiku',
    budget: { searches: 4, fetches: 2 },
    focus: `Employee counts (company site, annual report / Geschäftsbericht, press kit, register filings) and statements
about the size of the marketing or communications team. Record numbers as headcounts and size statements as headcount
facts.`,
    minSearches: 2,
    usd: { min: 0.05, max: 0.2 },
  },
};

/**
 * Whole run (all five passes). Calibrated on a first live run: seed (Sonnet) $0.135, a Haiku press pass $0.078; the
 * ranges leave room for the fuller leadership checklist (more searches) and larger companies.
 */
/** web reporting lines need at least "clearly implied" (0.6); stored at min(fact confidence, 0.9) */
export const ORG_RESEARCH_MIN_EDGE_CONFIDENCE = 0.6;

export const ORG_RESEARCH_USD_ESTIMATE = { min: 0.3, max: 1.4 };

export function estimateOrgResearchUsd(passes: readonly OrgResearchPassId[]): { min: number; max: number } {
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    min: r(passes.reduce((s, p) => s + ORG_RESEARCH_PASSES[p].usd.min, 0)),
    max: r(passes.reduce((s, p) => s + ORG_RESEARCH_PASSES[p].usd.max, 0)),
  };
}

/** what the account already holds (people to confirm, not repeat; entities / countries seen) */
export interface OrgResearchKnown {
  people: { name: string; title: string }[];
  entities: string[];
  countries: string[];
  locations?: string[];
}

export type OrgResearchAccount = Pick<Account, 'name' | 'aliases' | 'domain' | 'linkedinUrl'>;

const one = (s: unknown, max = 300): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

const DACH_TLD = /\.(de|at|ch)$/i;
const DACH_FORM = /\b(GmbH|mbH|AG|KGaA|KG|SE|e\.\s?V\.|OHG|GbR)\b/;
const DACH_PLACE = /\b(Germany|Deutschland|Austria|Österreich|Switzerland|Schweiz|Berlin|München|Munich|Hamburg|Frankfurt|Köln|Cologne|Stuttgart|Düsseldorf|Wien|Vienna|Zürich|Zurich)\b/i;

/** search in German as well when the account looks German-speaking (domain, legal form, entities, countries, places) */
export function isDach(account: OrgResearchAccount, known?: Pick<OrgResearchKnown, 'entities' | 'countries' | 'locations'>): boolean {
  if (DACH_TLD.test((account.domain ?? '').trim())) return true;
  if ([account.name, ...(account.aliases ?? []), ...(known?.entities ?? [])].some((n) => DACH_FORM.test(n ?? ''))) return true;
  if ((known?.countries ?? []).some((c) => ['DE', 'AT', 'CH'].includes((c ?? '').toUpperCase()))) return true;
  return (known?.locations ?? []).some((l) => DACH_PLACE.test(l ?? ''));
}

/** max known people listed in the prompt */
export const ORG_RESEARCH_KNOWN_MAX = 80;

export function buildOrgResearchPrompt(
  account: OrgResearchAccount,
  passId: OrgResearchPassId,
  known: OrgResearchKnown,
  today: string = new Date().toISOString().slice(0, 10),
): string {
  const pass = ORG_RESEARCH_PASSES[passId];
  const dach = isDach(account, known);
  const company = [
    `Name: ${one(account.name, 200)}`,
    (account.aliases ?? []).length ? `Also known as: ${account.aliases.map((a) => one(a, 120)).filter(Boolean).join('; ')}` : '',
    account.domain ? `Website domain: ${one(account.domain, 200)}` : '',
    account.linkedinUrl ? `LinkedIn company page (context only — do not search, fetch or cite it): ${one(account.linkedinUrl, 300)}` : '',
    known.entities.length ? `Known legal entities / group companies: ${known.entities.map((e) => one(e, 200)).slice(0, 20).join('; ')}` : '',
    known.countries.length ? `Countries seen so far: ${[...new Set(known.countries)].slice(0, 20).join(', ')}` : '',
  ].filter(Boolean);
  const people = known.people.slice(0, ORG_RESEARCH_KNOWN_MAX).map((p) => `- ${one(p.name, 120)}${p.title ? ` — ${one(p.title, 160)}` : ''}`);
  const name = one(account.name, 120);

  return `Map the MARKETING organisation of one company from public web sources. Today is ${today}.
This is one pass of several; this pass: ${pass.label.toUpperCase()}.

COMPANY
${company.join('\n')}

PEOPLE ALREADY KNOWN (${known.people.length}${known.people.length > people.length ? `, first ${people.length} shown` : ''})
${people.length ? `${people.join('\n')}\nReturn one of them only when a page you saw confirms or updates their role — don't spend searches on them.` : '(none yet)'}

THIS PASS
${pass.focus}

SEARCH RULES
- Budget: at most ${pass.budget.searches} WebSearch calls and ${pass.budget.fetches} WebFetch calls in total. Run at least ${pass.minSearches} DISTINCT searches
  (different role words / languages / page types) before you stop, unless the results clearly show there is nothing more to find.
- Do not search or cite linkedin.com. WebFetch cannot read it and its snippets cannot be verified; never use a LinkedIn page as evidence.
- The search tool ignores "site:" — put the domain or company name in the query as plain words instead (e.g. "${name} Leadership Team", "${name} Marketing Director").
- Prefer primary sources: the company's own site (all country sites), its newsroom and careers pages, then reputable press, conference and agency pages.
- When the company's own site (management page, Impressum, newsroom) confirms a person you first saw in a third-party
  article, use the company's own page as evidenceUrl and quote it.
${dach ? `- This company is German-speaking: search in GERMAN as well as English, e.g. "${name} Leitung Marketing", "${name} Unternehmenskommunikation", "${name} Pressekontakt", "${name} Stellenanzeige Marketing berichtet an", "${name} Impressum Geschäftsführer". German pages count as sources; quote them in German.\n` : ''}- Group companies have many legal entities and country sites, and group marketing may sit in a service or holding entity. For every person and fact, record the entity (legal name exactly as written, e.g. "Ledgerly Services GmbH") and country (ISO code such as DE, AT, US) when the source says so; else "".

EVIDENCE RULE (strict — anything that breaks it is discarded)
- Every person, fact and headcount needs evidenceUrl = the exact http(s) URL of a page you actually saw in results or fetched. Never invent, guess or construct URLs.
- And quote = a short VERBATIM excerpt (≤ 300 characters) from that page that states the item.
- Only people who CURRENTLY hold the role according to the source. date = the source's date (YYYY, YYYY-MM or YYYY-MM-DD) or "".
- Never invent names, titles, entities or numbers. Leaving something out is better than guessing.

OUTPUT
- people: marketing, communications / PR, brand, digital, events and partner-marketing people, plus the executive marketing
  reports to (CEO / CMO / board member responsible for marketing). Not sales, HR or other functions.
  name = full personal name only (no "Dr.", no team or mailbox names); title as written; entity; country;
  subfunction = one of ${SUBFUNCTIONS.map((s) => `"${s}"`).join(', ')} or "" if unclear; evidenceUrl; quote; date.
- facts: structure facts. kind: "team" (a named marketing / comms team and what it does), "entity" (a legal entity or
  country organisation and its role), "reporting" (one named person reports to another: subject and manager = their full
  names exactly as in people), "leadership" (who leads marketing or comms), "hiring" (an open marketing role: title, team,
  entity, location), "headcount" (a statement about team size), "other". text = one plain sentence.
  subject / manager = "" unless kind is "reporting". confidence 0..1: 0.9 the page states it directly, 0.6 clearly
  implied, 0.3 weak hint.
- headcounts: numbers stated on a page: label (e.g. "employees", "marketing team"), scope ("company" or "function"),
  count (whole number), evidenceUrl, quote.
- searchesRun: how many web searches you actually completed.
- rateLimited: true if ANY search or fetch failed, errored, was refused or was rate-limited. Finding nothing is NOT rate-limited.
- Empty arrays are a valid answer.`;
}

const SYSTEM_PROMPT =
  'You are a careful researcher mapping a company\'s marketing organisation from public web sources. Every item you return must cite a page you saw and quote it verbatim. Respect the search budget. Return only the structured output.';

// ---------- normalisation ----------

export interface OrgResearchPerson {
  name: string;
  title: string;
  entity: string;
  country: string;
  subfunction: Subfunction | '';
  evidenceUrl: string;
  quote: string;
  date: string;
}
export interface OrgResearchFact {
  kind: OrgFactKind;
  text: string;
  entity: string;
  country: string;
  subject: string;
  manager: string;
  evidenceUrl: string;
  quote: string;
  confidence: number;
}
export interface OrgResearchHeadcount {
  label: string;
  scope: Extract<HeadcountScope, 'company' | 'function'>;
  count: number;
  evidenceUrl: string;
  quote: string;
}
export interface OrgResearchData {
  people: OrgResearchPerson[];
  facts: OrgResearchFact[];
  headcounts: OrgResearchHeadcount[];
  searchesRun: number;
  rateLimited: boolean;
  /** items discarded for missing / non-http(s) / linkedin.com evidence, a missing quote or bad values */
  dropped: number;
}

/** http(s) URL that is not on linkedin.com → the URL, else '' */
export function evidenceUrlOk(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^https?:\/\/\S+$/i.test(s) || s.length > 2000) return '';
  let host = '';
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (!host || host === 'linkedin.com' || host.endsWith('.linkedin.com') || host === 'lnkd.in') return '';
  return s;
}

const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const SUB = new Set<string>(SUBFUNCTIONS);
const KINDS = new Set<string>(ORG_FACT_KINDS);
const country = (v: unknown) => {
  const c = one(v, 10).toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : '';
};
const conf01 = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(0.9, Math.max(0, n)) : d;
};
const NOT_A_PERSON_WORDS = [
  'team', 'teams', 'press', 'presse', 'pressestelle', 'pressebüro', 'pressebuero', 'pressesprecher', 'pressekontakt',
  'marketing', 'marketingteam', 'marketingabteilung', 'office', 'kontakt', 'contact', 'redaktion', 'abteilung',
  'department', 'kommunikation', 'kommunikationsabteilung', 'unternehmenskommunikation', 'communications', 'info',
  'newsroom', 'media', 'medien', 'kundenservice', 'support',
];
/** whole words (letters/digits on neither side, Unicode-aware so "Pressebüro" ≠ a prefix match) */
const NOT_A_PERSON = new RegExp(`(?<![\\p{L}\\p{N}])(${NOT_A_PERSON_WORDS.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
/** a plausible personal name: 2+ words, letters, no mailbox / team words */
function personName(v: unknown): string {
  let n = one(v, 120);
  // strip every leading honorific ("Dr. Prof. …", "Frau Dr. …")
  for (let prev = ''; prev !== n; ) {
    prev = n;
    n = n.replace(/^(dr\.?|prof\.?|mr\.?|mrs\.?|ms\.?|herr|frau)\s+/i, '').trim();
  }
  if (!n || /[@\d/]|https?:/i.test(n)) return '';
  if (n.split(/\s+/).length < 2) return '';
  // whole words only (surnames like "Presser" or "Teamann" stay); German compounds listed explicitly
  if (NOT_A_PERSON.test(n)) return '';
  return n;
}

interface RawOrgResearch {
  people?: unknown;
  facts?: unknown;
  headcounts?: unknown;
  searchesRun?: unknown;
  rateLimited?: unknown;
}

/** keep only items with an http(s), non-LinkedIn evidence URL and a quote; clamp lengths; enum-check; dedupe */
export function normalizeOrgResearch(raw: RawOrgResearch | null | undefined, domain = ''): OrgResearchData {
  let dropped = 0;
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

  const people: OrgResearchPerson[] = [];
  const seen = new Set<string>();
  for (const p of list(raw?.people)) {
    const evidenceUrl = evidenceUrlOk(p.evidenceUrl);
    const quote = one(p.quote, 300);
    const name = personName(p.name);
    if (!evidenceUrl || !quote || !name) {
      dropped++;
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      // the same person twice: keep the company's own page as evidence when one of them is on it
      const i = people.findIndex((x) => x.name.toLowerCase() === key);
      if (i >= 0 && domain && !isOwnDomain(people[i]!.evidenceUrl, domain) && isOwnDomain(evidenceUrl, domain)) {
        people[i] = { ...people[i]!, evidenceUrl, quote };
      }
      continue;
    }
    seen.add(key);
    const sub = one(p.subfunction, 40);
    const date = one(p.date, 10);
    people.push({
      name,
      title: one(p.title, 300),
      entity: one(p.entity, 200),
      country: country(p.country),
      subfunction: SUB.has(sub) ? (sub as Subfunction) : '',
      evidenceUrl,
      quote,
      date: DATE_RE.test(date) ? date : '',
    });
  }

  const facts: OrgResearchFact[] = [];
  for (const f of list(raw?.facts)) {
    const evidenceUrl = evidenceUrlOk(f.evidenceUrl);
    const quote = one(f.quote, 300);
    const text = one(f.text, 500);
    if (!evidenceUrl || !quote || !text) {
      dropped++;
      continue;
    }
    const kind = one(f.kind, 20);
    const k = (KINDS.has(kind) ? kind : 'other') as OrgFactKind;
    facts.push({
      kind: k,
      text,
      entity: one(f.entity, 200),
      country: country(f.country),
      subject: k === 'reporting' ? personName(f.subject) : '',
      manager: k === 'reporting' ? personName(f.manager) : '',
      evidenceUrl,
      quote,
      confidence: conf01(f.confidence, 0.5),
    });
  }

  const headcounts: OrgResearchHeadcount[] = [];
  for (const h of list(raw?.headcounts)) {
    const evidenceUrl = evidenceUrlOk(h.evidenceUrl);
    const quote = one(h.quote, 300);
    const count = Number(h.count);
    const scope = h.scope === 'function' ? 'function' : h.scope === 'company' ? 'company' : '';
    if (!evidenceUrl || !quote || !scope || !Number.isInteger(count) || count <= 0 || count > 10_000_000) {
      dropped++;
      continue;
    }
    headcounts.push({ label: one(h.label, 200) || (scope === 'company' ? 'employees' : 'team'), scope, count, evidenceUrl, quote });
  }

  const sr = Number(raw?.searchesRun);
  return {
    people,
    facts,
    headcounts,
    searchesRun: Number.isInteger(sr) && sr >= 0 ? sr : 0,
    rateLimited: raw?.rateLimited === true,
    dropped,
  };
}

export const isEmptyOrgResearch = (d: OrgResearchData): boolean => !d.people.length && !d.facts.length && !d.headcounts.length;

/** a flagged answer that still holds findings counts as ok (partial information is information) */
export function classifyOrgRateLimited(d: OrgResearchData): boolean {
  return d.rateLimited && (isEmptyOrgResearch(d) || d.searchesRun === 0);
}

function host(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** the evidence URL is on the account's own domain (or a subdomain) */
export function isOwnDomain(url: string, domain: string): boolean {
  const h = host(url);
  const d = (domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  return Boolean(d && h) && (h === d || h.endsWith(`.${d}`));
}

/**
 * How sure we are that a web-found person holds this role now: 0.9 when the company's own site states it (management
 * page, Impressum, newsroom), 0.6 from press, 0.4 from directories / third-party pages or a source older than 24 months.
 * Member confidence only goes up, so a later own-site confirmation lifts a person first found in an article.
 */
export function webPersonConfidence(
  p: Pick<OrgResearchPerson, 'evidenceUrl' | 'date'>,
  account: Pick<Account, 'domain'>,
  pass: OrgResearchPassId,
  today: string = new Date().toISOString().slice(0, 10),
): number {
  if (p.date) {
    const [y, m] = p.date.split('-').map(Number);
    const [ty, tm] = today.split('-').map(Number);
    if (y && ty && (ty - y) * 12 + ((tm ?? 1) - (m ?? 1)) > 24) return 0.4;
  }
  if (isOwnDomain(p.evidenceUrl, account.domain)) return 0.9;
  return pass === 'press' ? 0.6 : 0.4;
}

// ---------- one pass ----------

export interface OrgResearchPassResult {
  pass: OrgResearchPassId;
  status: 'ok' | 'rate_limited' | 'error';
  data?: OrgResearchData;
  error?: string;
  model: string;
  costUsd: number;
  costIncomplete?: boolean;
  durationMs: number;
}

export interface OrgResearchPassOptions {
  account: OrgResearchAccount;
  pass: OrgResearchPassId;
  known: OrgResearchKnown;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  today?: string;
}

/**
 * Run one research pass. Never rejects except with AbortError (the error carries the spend so far, see `errorCost`):
 * failures become status 'error', rate limiting (CLI error or model-reported with no findings) 'rate_limited' so the
 * caller can back off and retry the same pass. The caller records `costUsd` (stage 'org') and persists `data`.
 */
export async function runOrgResearchPass(opts: OrgResearchPassOptions): Promise<OrgResearchPassResult> {
  const pass = ORG_RESEARCH_PASSES[opts.pass];
  const model = opts.model || pass.model;
  const started = Date.now();
  try {
    const res = await runClaude<RawOrgResearch>({
      prompt: buildOrgResearchPrompt(opts.account, opts.pass, opts.known, opts.today),
      model,
      jsonSchema: ORG_RESEARCH_SCHEMA,
      tools: ['WebSearch', 'WebFetch'],
      appendSystemPrompt: SYSTEM_PROMPT,
      timeoutMs: opts.timeoutMs ?? (pass.model === 'sonnet' ? DEFAULTS.researchTimeoutMs : 10 * 60_000),
      // web search is rate-limit prone: one retry here, then the job backs off
      retries: 1,
      signal: opts.signal,
    });
    const data = normalizeOrgResearch(res.data, opts.account.domain);
    const base = { pass: opts.pass, model, costUsd: res.costUsd, durationMs: res.durationMs, ...(res.costIncomplete ? { costIncomplete: true } : {}) };
    if (classifyOrgRateLimited(data)) return { ...base, status: 'rate_limited', error: 'web search was rate-limited' };
    return { ...base, status: 'ok', data };
  } catch (e) {
    if ((e as Error).name === 'AbortError' || opts.signal?.aborted) throw e;
    const { usd, incomplete } = errorCost(e);
    const msg = (e as Error).message ?? String(e);
    const errText = e instanceof ClaudeError ? `${msg}\n${e.details.stderr ?? ''}` : msg;
    return {
      pass: opts.pass,
      model,
      status: CLI_RATE_LIMIT_RE.test(errText) ? 'rate_limited' : 'error',
      error: msg.slice(0, 500),
      costUsd: usd,
      ...(incomplete ? { costIncomplete: true } : {}),
      durationMs: Date.now() - started,
    };
  }
}
