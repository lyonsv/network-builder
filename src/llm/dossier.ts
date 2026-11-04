import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../io/fs-utils';
import {
  DEFAULTS,
  REPORTS_ROOT,
  type Confidence,
  type Dossier,
  type DossierDepth,
  type DossierRecord,
  type ExplorerPerson,
  type RecentActivityItem,
  type RecentActivityKind,
  type Source,
} from '../types';
import { ClaudeError, errorCost, runClaude } from './claude';
import { DOSSIER_SCHEMA } from './schemas';

export const DEFAULT_DOSSIER_PATH = path.join(REPORTS_ROOT, 'dossier.md');

/** Rough per-person spend (measured: light ≈ $0.01–0.02 with Haiku; deep ≈ $0.12–0.20 with Sonnet incl. recent activity). */
export const DOSSIER_ESTIMATES = { lightUsd: 0.015, deepUsd: 0.17 };

/** Default before the recent-activity section existed (used to upgrade untouched user files). */
export const PREVIOUS_DEFAULT_DOSSIER_MD = `# Dossier: what to capture about each person

This file tells the profile builder what to look for. It is GOAL-FREE: capture who the person is,
not whether they fit any particular list. The same dossier is reused for every lens
("angel investors", "heads of marketing", "potential customers"...). Edit freely.

## Identity
- Confirm it is the same person as the LinkedIn connection: match name + headline employer/role,
  and the LinkedIn URL slug if it appears in results. Common names need two matching facts.
- If you can't confirm, say so (identityConfirmed=false, confidence low) and keep only facts tied to
  the matching person.

## Career
- Current role and company. Past notable roles: role, company, years where shown.
- Founder history: companies founded, outcomes (acquired, IPO, shut down) with years.

## Investing & governance
- Angel investments, VC/fund roles, LP positions, syndicates (named companies/funds where found).
- Board seats, chair / non-executive director roles, advisory roles.

## Expertise & notable
- Domains/industries they are known for; skills they speak or write about.
- Exits, awards, rankings, notable press.

## Public presence
- Podcasts, blogs/newsletters, talks, active social accounts.

## Location & education
- City/country; universities/degrees if shown.
`;

/** Section appended to user-edited templates that predate it. */
export const RECENT_ACTIVITY_SECTION = `## Recent activity (last 12 months)
- What they have been saying and doing publicly lately: posts, articles, newsletter issues, podcast
  appearances, talks, interviews, news quotes, announcements (new role, fund, company, raise).
- For each item: date, type, title, link, and one line on WHAT they said or argued.
- Then 3–6 short themes they keep coming back to (e.g. "AI agents in fintech", "European startup funding").
`;

export const DEFAULT_DOSSIER_MD = `# Dossier: what to capture about each person

This file tells the profile builder what to look for. It is GOAL-FREE: capture who the person is,
not whether they fit any particular list. The same dossier is reused for every lens
("angel investors", "heads of marketing", "potential customers"...). Edit freely.

## Identity
- Confirm it is the same person as the LinkedIn connection: match name + headline employer/role,
  and the LinkedIn URL slug if it appears in results. Common names need two matching facts.
- If you can't confirm, say so (identityConfirmed=false, confidence low) and keep only facts tied to
  the matching person.

## Career
- Current role and company. Past notable roles: role, company, years where shown.
- Founder history: companies founded, outcomes (acquired, IPO, shut down) with years.

## Investing & governance
- Angel investments, VC/fund roles, LP positions, syndicates (named companies/funds where found).
- Board seats, chair / non-executive director roles, advisory roles.

## Expertise & notable
- Domains/industries they are known for; skills they speak or write about.
- Exits, awards, rankings, notable press.

## Public presence
- Podcasts, blogs/newsletters, talks, active social accounts.

## Recent activity (last 12 months)
- What they have been saying and doing publicly lately: posts, articles, newsletter issues, podcast
  appearances, talks, interviews, news quotes, announcements (new role, fund, company, raise).
- For each item: date, type, title, link, and one line on WHAT they said or argued.
- Then 3–6 short themes they keep coming back to (e.g. "AI agents in fintech", "European startup funding").

## Location & education
- City/country; universities/degrees if shown.
`;

export async function ensureDossierTemplate(filePath: string): Promise<{ path: string; content: string; created: boolean }> {
  try {
    const content = await readFile(filePath, 'utf8');
    return { path: filePath, content: await upgradeDossierTemplate(filePath, content), created: false };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await ensureDir(path.dirname(filePath));
  // 'wx' never overwrites a file created concurrently
  try {
    await writeFile(filePath, DEFAULT_DOSSIER_MD, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return { path: filePath, content: await readFile(filePath, 'utf8'), created: false };
  }
  return { path: filePath, content: DEFAULT_DOSSIER_MD, created: true };
}

/**
 * Add the recent-activity section to an existing template that predates it. Untouched default → replaced with the new
 * default; user-edited → section appended. Always backs up to `<file>.bak` first. Never removes user content.
 */
export async function upgradeDossierTemplate(filePath: string, content: string): Promise<string> {
  if (/^##\s*Recent activity/im.test(content)) return content;
  const next =
    content.trim() === PREVIOUS_DEFAULT_DOSSIER_MD.trim()
      ? DEFAULT_DOSSIER_MD
      : `${content.replace(/\s*$/, '')}\n\n${RECENT_ACTIVITY_SECTION}`;
  try {
    await writeFile(`${filePath}.bak`, content, 'utf8');
    await writeFile(filePath, next, 'utf8');
    return next;
  } catch {
    return content; // read-only location etc.: use the file as-is
  }
}

/** "https://www.linkedin.com/in/janetexample/" → "janetexample" */
export function linkedinSlug(url: string): string {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url ?? '');
  if (!m?.[1]) return '';
  try {
    return decodeURIComponent(m[1]).replace(/\/+$/, '');
  } catch {
    return m[1];
  }
}

const one = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim();

const DEPTH_RULES: Record<DossierDepth, string> = {
  light: `BUDGET: at most 2 WebSearch calls in total. Use only the search result snippets — do NOT fetch any pages.
Suggested searches: (1) "<full name>" plus the headline's main employer or role words; (2) only if needed,
"<full name>" with the LinkedIn slug or "former"/"board"/"investor" to surface career history. Stop as soon as you have enough.
recentActivity / recentThemes: do NOT spend searches on them. Only include an item if a snippet you already have shows a
dated recent post, talk, interview or news item; otherwise return [] for both.`,
  deep: `BUDGET: at most 8 WebSearch calls in total. Spend up to 5 on identity/career/investing/boards and reserve 2–3 for
RECENT ACTIVITY (see below). You MAY fetch a few non-LinkedIn pages (company bios, press, podcast episode pages, blog or
Substack/Medium posts, conference speaker pages, Crunchbase-style directories, personal sites) with WebFetch.
Never fetch linkedin.com — post and profile pages are login-walled; use a LinkedIn post only if a search snippet shows its
text. Prefer primary sources; cite every page you relied on.`,
};

/** Instructions for the recent-activity part of a deep dossier. `today` is YYYY-MM-DD. */
export function recentActivityRules(today: string): string {
  return `RECENT ACTIVITY (deep only) — today is ${today}; look back ~12 months (since ${twelveMonthsBefore(today)}).
- Spend 2–3 searches, e.g. "<full name>" podcast OR interview OR talk; "<full name>" wrote OR newsletter OR blog ${today.slice(0, 4)};
  "<full name>" <current company> news. Open the most promising primary pages (their blog/Substack/Medium post, the podcast
  episode page, the conference session page, the news article quoting them) to read what they actually said.
- recentActivity: up to 8 items, NEWEST FIRST: {date "YYYY-MM-DD" or "YYYY-MM" ("" only if clearly recent but undated),
  kind (post|article|podcast|talk|interview|news|announcement|other), title, summary, url}.
  summary = ONE line stating WHAT they said, argued or announced (e.g. "Argues AI agents will replace most SMB bookkeeping
  within 3 years"), not merely that they appeared somewhere. Skip items older than ~12 months and undated items you can't
  place. Only real URLs you saw.
- recentThemes: 3–6 short topic phrases they keep coming back to, derived ONLY from recentActivity items ([] if none).
- If nothing recent is found, return [] for both — that is a valid answer.`;
}

function twelveMonthsBefore(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 7);
}

function existingDigest(p: ExplorerPerson): string {
  const d = p.dossier?.status === 'ok' ? p.dossier.dossier : undefined;
  if (!d) return '';
  const career = d.career.slice(0, 6).map((c) => `${c.role}${c.company ? `, ${c.company}` : ''}${c.period ? ` (${c.period})` : ''}`);
  return [
    `An earlier ${p.dossier!.depth} profile (${p.dossier!.createdAt.slice(0, 10)}, confidence ${d.confidence}) found:`,
    d.oneLiner && `- ${one(d.oneLiner)}`,
    career.length ? `- career: ${career.join('; ')}` : '',
    d.investingSummary && `- investing: ${one(d.investingSummary)}`,
    d.boards.length ? `- boards: ${d.boards.join('; ')}` : '',
    d.recentThemes?.length ? `- recent themes: ${d.recentThemes.join('; ')}` : '',
    d.sources.length ? `- sources: ${d.sources.slice(0, 6).map((s) => s.url).join(' ')}` : '',
    'Verify and extend it; keep facts that still hold, correct anything wrong.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Goal-free dossier prompt. The template (dossier.md) says what to capture; depth sets the search budget. */
export function buildDossierPrompt(
  person: ExplorerPerson,
  depth: DossierDepth,
  template: string,
  today: string = new Date().toISOString().slice(0, 10),
): string {
  const slug = linkedinSlug(person.url);
  const pr = person.profile;
  const facts = [
    `Name: ${one(person.fullName) || '(unknown)'}`,
    `LinkedIn headline: ${one(person.title) || '(none)'}`,
    person.company ? `Company (from CSV): ${one(person.company)}` : '',
    pr?.company ? `Employer parsed from headline: ${one(pr.company)}` : '',
    pr?.region ? `Region from headline: ${one(pr.region)}` : '',
    person.url ? `LinkedIn URL: ${person.url}${slug ? ` (slug: ${slug})` : ''}` : '',
    person.connectedOn ? `Connected on: ${person.connectedOn}` : '',
  ].filter(Boolean);
  const prior = depth === 'deep' ? existingDigest(person) : '';

  return `Build a short, NEUTRAL, GOAL-FREE profile ("dossier") of one person from a professional network, using web search.
Do not judge whether they fit any goal or list — just record verifiable facts about who they are.

PERSON
${facts.join('\n')}
${prior ? `\n${prior}\n` : ''}
${DEPTH_RULES[depth]}
${depth === 'deep' ? `\n${recentActivityRules(today)}\n` : ''}
IDENTITY: many people share names. Only use results that match this person. Two independent matching facts CONFIRM
identity (set identityConfirmed=true): e.g. the LinkedIn slug matches the name — slugs often include middle initials or
numbers ("janetexample" = Jane T. Example) — AND a role/employer/field consistent with the headline (a "Board Chair | INED"
headline is consistent with non-executive chair roles); or the same employer + location. Results that only share the name
don't count. If results conflict or you can't tell, set identityConfirmed=false, confidence "low", and leave fields empty
rather than mixing people up. Don't hedge every field once identity is confirmed.

RULES
- Facts only, from what you actually saw in results. Never invent roles, dates, companies, investments or URLs.
- career: current + notable past roles as {role, company, period ("2015–2021", "2019–present" or ""), current}. Newest first.
- investingSummary: neutral description of angel/VC/LP/syndicate activity if found (named companies/funds in investments[]); "" if none found.
- boards: board, chair, non-executive and formal advisory roles. notable: exits, awards, rankings, press.
- oneLiner: one neutral sentence on who they are (e.g. "London-based former EMEA VP at a large tech company, now non-executive chair of two companies").
- sources: every page/result you relied on ({title, url}); only URLs you actually saw.
- recentActivity / recentThemes: see the depth rules above (deep: required search effort; light: snippets only, else []).
- searchesRun: how many web searches you actually completed.
- rateLimited: set true if ANY web search failed, errored, was refused or was rate-limited (even if you still found something).
  A search that simply found nothing relevant is NOT rate-limited.
- If nothing reliable is found, return empty fields with confidence "low" — that is a valid answer.

WHAT TO CAPTURE (user's template):
${template.trim()}`;
}

const SYSTEM_PROMPT =
  'You are a careful, neutral researcher building factual profiles of professionals from public web sources. Respect the search budget. Return only the structured output.';

interface RawDossier extends Partial<Dossier> {
  rateLimited?: boolean;
  searchesRun?: number;
}

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => one(String(x ?? ''))).filter(Boolean) : [];

const CONF: Confidence[] = ['low', 'medium', 'high'];

export function normalizeDossier(raw: RawDossier): Dossier {
  const sources: Source[] = Array.isArray(raw.sources)
    ? raw.sources
        .map((s) => ({ title: one(String(s?.title ?? '')), url: String(s?.url ?? '').trim() }))
        .filter((s) => /^https?:\/\//i.test(s.url))
    : [];
  return {
    identityConfirmed: Boolean(raw.identityConfirmed),
    confidence: CONF.includes(raw.confidence as Confidence) ? (raw.confidence as Confidence) : 'low',
    oneLiner: one(String(raw.oneLiner ?? '')),
    currentRole: one(String(raw.currentRole ?? '')),
    currentCompany: one(String(raw.currentCompany ?? '')),
    location: one(String(raw.location ?? '')),
    career: Array.isArray(raw.career)
      ? raw.career
          .map((c) => ({
            role: one(String(c?.role ?? '')),
            company: one(String(c?.company ?? '')),
            period: one(String(c?.period ?? '')),
            current: Boolean(c?.current),
          }))
          .filter((c) => c.role || c.company)
      : [],
    education: arr(raw.education),
    investingSummary: one(String(raw.investingSummary ?? '')),
    investments: arr(raw.investments),
    boards: arr(raw.boards),
    expertise: arr(raw.expertise),
    notable: arr(raw.notable),
    publicPresence: arr(raw.publicPresence),
    recentActivity: normalizeRecent(raw.recentActivity),
    recentThemes: arr(raw.recentThemes).slice(0, 6),
    sources,
  };
}

const KINDS: RecentActivityKind[] = ['post', 'article', 'podcast', 'talk', 'interview', 'news', 'announcement', 'other'];
const DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;

/** Coerce model output: valid kinds/dates, http(s) urls only, newest first (undated last), max 8. */
export function normalizeRecent(v: unknown): RecentActivityItem[] {
  if (!Array.isArray(v)) return [];
  const items = v
    .map((x): RecentActivityItem => {
      const o = (x ?? {}) as Partial<RecentActivityItem>;
      const date = one(String(o.date ?? ''));
      const url = String(o.url ?? '').trim();
      return {
        date: DATE_RE.test(date) ? date : '',
        kind: KINDS.includes(o.kind as RecentActivityKind) ? (o.kind as RecentActivityKind) : 'other',
        title: one(String(o.title ?? '')),
        summary: one(String(o.summary ?? '')),
        url: /^https?:\/\//i.test(url) ? url : '',
      };
    })
    .filter((i) => i.title || i.summary);
  // stable sort: dated items newest first, undated keep their order at the end
  return items
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => {
      if (a.i.date && b.i.date) return a.i.date < b.i.date ? 1 : a.i.date > b.i.date ? -1 : a.idx - b.idx;
      if (a.i.date) return -1;
      if (b.i.date) return 1;
      return a.idx - b.idx;
    })
    .map((x) => x.i)
    .slice(0, 8);
}

/**
 * Fallback only when the model omitted the flag AND ran no searches: its own text says searches were rate-limited.
 * Deliberately narrow — "searches failed to find…", "blocked by name ambiguity" etc. are normal "nothing found" answers.
 */
const RATE_LIMIT_TEXT_RE = /rate[\s-]?limit|too many (?:requests|searches)|\b429\b|search (?:quota|limit) (?:reached|exhausted|exceeded)/i;

function dossierText(d: Dossier): string {
  return [d.oneLiner, d.currentRole, d.investingSummary, ...d.notable, ...d.career.map((c) => `${c.role} ${c.company}`)].join('\n');
}

/** true when the dossier carries no usable facts */
export function isEmptyDossier(d: Dossier): boolean {
  return !d.career.length && !d.investments.length && !d.boards.length && !d.sources.length && !d.currentRole && !d.investingSummary;
}

/**
 * Decide whether a model answer means "searches were rate-limited, try again later" (→ requeue, store nothing)
 * vs a real answer. A flagged answer that still contains facts counts as ok (partial information is information).
 */
export function classifyRateLimited(raw: RawDossier, d: Dossier): boolean {
  // An explicit flag from the model wins. A flagged answer that still has facts counts as ok (partial info is info).
  if (raw.rateLimited === true) return isEmptyDossier(d) || raw.searchesRun === 0;
  if (raw.rateLimited === false) return false;
  // Flag missing: only infer rate limiting when no searches ran, the answer is empty, and the text says so.
  const noSearches = raw.searchesRun === undefined || raw.searchesRun === 0;
  return noSearches && isEmptyDossier(d) && RATE_LIMIT_TEXT_RE.test(dossierText(d));
}

const CLI_RATE_LIMIT_RE = /rate.?limit|\b429\b|too many requests|usage limit/i;

/**
 * Build one goal-free dossier. Never rejects except with AbortError: failures become status 'error', and rate
 * limiting (CLI error or model-reported) becomes status 'rate_limited' so the caller can requeue and back off.
 * The caller adds `costUsd` to its cost tracker (stage 'dossier') and stores ok/error records.
 */
export async function buildDossier(
  person: ExplorerPerson,
  opts: { depth: DossierDepth; model: string; template: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<DossierRecord> {
  const depth = opts.depth;
  const model = opts.model || (depth === 'light' ? DEFAULTS.rankModel : DEFAULTS.researchModel);
  const started = Date.now();
  const base = { personId: person.id, depth, model, createdAt: '' };
  try {
    const res = await runClaude<RawDossier>({
      prompt: buildDossierPrompt(person, depth, opts.template),
      model,
      jsonSchema: DOSSIER_SCHEMA,
      tools: depth === 'light' ? ['WebSearch'] : ['WebSearch', 'WebFetch'],
      appendSystemPrompt: SYSTEM_PROMPT,
      timeoutMs: opts.timeoutMs ?? (depth === 'light' ? 4 * 60_000 : DEFAULTS.researchTimeoutMs),
      // light lookups are cheap but rate-limit prone: one retry, then let the queue back off
      retries: depth === 'light' ? 1 : DEFAULTS.retries,
      signal: opts.signal,
    });
    const raw = res.data ?? {};
    const dossier = normalizeDossier(raw);
    const createdAt = new Date().toISOString();
    if (classifyRateLimited(raw, dossier)) {
      return { ...base, status: 'rate_limited', error: 'web search was rate-limited', costUsd: res.costUsd, durationMs: res.durationMs, createdAt };
    }
    return { ...base, status: 'ok', dossier, costUsd: res.costUsd, durationMs: res.durationMs, createdAt };
  } catch (e) {
    if ((e as Error).name === 'AbortError' || opts.signal?.aborted) throw e;
    const { usd } = errorCost(e);
    const msg = (e as Error).message ?? String(e);
    const errText = e instanceof ClaudeError ? `${msg}\n${e.details.stderr ?? ''}` : msg;
    return {
      ...base,
      status: CLI_RATE_LIMIT_RE.test(errText) ? 'rate_limited' : 'error',
      error: msg.slice(0, 500),
      costUsd: usd,
      durationMs: Date.now() - started,
      createdAt: new Date().toISOString(),
    };
  }
}
