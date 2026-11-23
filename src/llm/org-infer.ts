import {
  ORG_NOISE_FLAGS,
  SENIORITIES,
  SUBFUNCTIONS,
  SUBFUNCTION_LABELS,
  type Account,
  type AccountMember,
  type MemberInference,
  type OrgNoise,
  type Seniority,
  type Subfunction,
} from '../accounts/types';
import { DEFAULTS, type CostTracker } from '../types';
import { ClaudeError, errorCost, runClaude } from './claude';
import { mapWithConcurrency } from './pool';
import { chunk } from './rank';
import { ORG_CLASSIFY_SCHEMA, ORG_REPORTING_SCHEMA } from './schemas';

/**
 * Human-triggered, cheap Haiku pass over an account's people: marketing sub-function, fine seniority, noise flags,
 * team / entity / country and responsibilities per person, then one call that suggests reporting lines over the
 * compact roster. Pure text (no tools, no web). Results are suggestions: user-set values win at view time, and
 * user-set reporting lines are fixed inputs, never outputs.
 */

/** estimate for the UI (classification + the reporting call), per 100 people — calibrated on a live run */
export const ORG_INFER_USD_PER_100 = 0.06;
/** every run makes at least one classification and one reporting call, whatever its size */
export const ORG_INFER_MIN_USD = 0.005;
export const estimateOrgInferUsd = (n: number): number =>
  n > 0 ? Math.max(ORG_INFER_MIN_USD, (n / 100) * ORG_INFER_USD_PER_100) : 0;

/** max people in the reporting call's roster (the most senior are kept); the rest get rule-based suggestions */
export const ORG_ROSTER_MAX = 400;
/** suggested lines below this are not stored as reporting lines; they stay in the inference as `possibleManager` */
export const ORG_MIN_EDGE_CONFIDENCE = 0.45;

/** what the job needs from an account member (AccountMember satisfies it) */
export type OrgMemberInput = Pick<
  AccountMember,
  | 'id' | 'title' | 'headline' | 'location' | 'company' | 'department' | 'subfunction' | 'autoSubfunction' | 'seniority'
  | 'entity' | 'country' | 'team' | 'reportsTo' | 'reportsToSource' | 'noise' | 'autoNoise'
> & { profile?: { about?: string; experience?: { current?: boolean; description?: string }[] } };

export interface OrgEdge {
  id: string;
  /** null = unsure (clears an earlier suggestion) */
  managerId: string | null;
  confidence: number;
  reason: string;
  source: 'llm' | 'rules';
}

export interface OrgInferResult {
  classified: Map<string, MemberInference>;
  edges: OrgEdge[];
  costUsd: number;
  costIncomplete: boolean;
  /** classification batches that failed (their people keep their earlier inference) */
  failedBatches: number;
  /** the reporting call failed (or was skipped) and the rule-based fallback was used */
  reportingFallback: boolean;
}

export interface OrgInferOptions {
  /** `entities`: legal entities / group companies known to belong to the account (people there are in the org) */
  account: Pick<Account, 'name' | 'aliases' | 'domain'> & { entities?: string[] };
  /** every member of the account (the roster managers are picked from) */
  members: OrgMemberInput[];
  /** people to classify / suggest managers for (default: everyone) */
  ids?: string[];
  model?: string;
  batchSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  /** only used to flag unknown spend (killed / timed-out calls); the caller records `costUsd` */
  costs?: CostTracker;
  /** done / total are people throughout (classified so far; reporting: 0 then all) */
  onProgress?: (p: { phase: 'classify' | 'reporting'; done: number; total: number }) => void;
}

const clean = (s: unknown, max = 300): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const SUB = new Set<string>(SUBFUNCTIONS);
const SEN = new Set<string>(SENIORITIES);
const NOISE = new Set<string>(ORG_NOISE_FLAGS);
const rank = (s: Seniority) => (s === 'unknown' ? Infinity : SENIORITIES.indexOf(s));
const norm = (s: string) => s.trim().toLowerCase();

/** ≤600 chars of what the person says they do: about + current role description */
function aboutText(m: OrgMemberInput): string {
  const cur = (m.profile?.experience ?? []).find((e) => e.current)?.description ?? '';
  return clean([m.profile?.about ?? '', cur].filter(Boolean).join(' — '), 600);
}

const companyLine = (a: OrgInferOptions['account']) => {
  const ents = (a.entities ?? []).map((e) => clean(e, 200)).filter(Boolean).slice(0, 20);
  return [a.name, ...(a.aliases ?? [])].filter(Boolean).join(' / ') + (a.domain ? ` (${a.domain})` : '') +
    (ents.length ? `\nKnown entities of this company: ${ents.join('; ')}` : '');
};

/** Classification prompt. People are `p0..pN`; names are never sent (not needed to classify a role). */
export function buildOrgClassifyPrompt(account: OrgInferOptions['account'], batch: OrgMemberInput[]): string {
  const lines = batch.map((m, i) => {
    const row: Record<string, string> = { id: `p${i}`, title: clean(m.title), headline: clean(m.headline, 500), location: clean(m.location, 200), company: clean(m.company, 200) };
    if (m.entity) row.entity = clean(m.entity, 200);
    const about = aboutText(m);
    if (about) row.about = about;
    return JSON.stringify(row);
  });
  return `You map the marketing organisation of one company from LinkedIn-style titles (English and German).
Company: ${companyLine(account)}
Work ONLY from the text given. Do not use outside knowledge about the people or the company, and do not guess.

FIELDS (one result per person, using the exact id given, e.g. "p3"):
- subfunction: one of ${SUBFUNCTIONS.map((s) => `"${s}" (${SUBFUNCTION_LABELS[s]})`).join(', ')}.
  demand-gen covers growth / performance / campaigns / ABM / lead gen; field-marketing = regional / country / field;
  digital-social = web, SEO/SEA, online, social media; leadership = heads the marketing function or a large part of it
  (CMO, VP / Director / Head of Marketing, Marketingleiter). "other" for generic or non-marketing roles.
- seniority: one of ${SENIORITIES.map((s) => `"${s}"`).join(', ')}.
  German: Geschäftsführer(in)/Vorstand → c-level; Bereichsleiter(in) → senior-director; Leiter(in)/Leitung/
  Abteilungsleiter(in) → director; Teamleiter(in) → manager; Referent(in)/Spezialist(in)/Sachbearbeiter(in) → ic;
  Werkstudent(in)/Praktikant(in)/Trainee/Azubi → intern. "unknown" when the title says nothing.
- noise: "" when the person plausibly belongs to the marketing org, else one of ${ORG_NOISE_FLAGS.map((n) => `"${n}"`).join(', ')}:
  hr-marketing = employer branding / recruiting marketing / Personalmarketing; sales-hybrid = mainly a sales role that
  also mentions marketing; not-marketing = not a marketing role at all; stale = the text says they left or the role is
  past; other-employer = their current company is CLEARLY a different company than this one and its group entities
  (e.g. employed by a vendor, agency or partner). A blank or vague company ("Self-employed", "Confidential") is NOT
  other-employer; a subsidiary / country entity of this company is not other-employer.
- vendorFunded: true when the person works for THIS company (or one of its entities) but their role is funded by /
  dedicated to a vendor or partner (e.g. "Partner Marketing Manager for Globex Inc", "MDF-funded", "sponsored by
  Globex"). They ARE part of the marketing org: noise "", subfunction "partner-marketing". false otherwise (always
  false for other-employer).
- team: the team name if stated (e.g. "Brand Studio", "Demand Center"), else "".
- entity: the legal entity / group company if stated or clearly implied by the company text (e.g. "Ledgerly Services GmbH"), else "".
- country: ISO-3166 alpha-2 code from the location (e.g. "DE", "IE"), else "".
- responsibilities: ≤ 240 characters, ONLY from the given about / headline text (what they own or do); "" if not stated.
- confidence: 0..1 that subfunction + seniority are right: 0.9 stated explicitly; 0.6 clear from title + context;
  0.3 a guess from a vague title.
- reason: ≤ 20 words, which words decided it.

Return every id exactly once.

PEOPLE (one JSON object per line):
${lines.join('\n')}`;
}

/** one roster row of the reporting prompt */
interface RosterRow {
  id: string;
  title: string;
  seniority: Seniority;
  subfunction: Subfunction;
  entity: string;
  country: string;
  location: string;
  /** fixed manager (local id) when the user (or web evidence) set it */
  fixedManager?: string;
}

/** Reporting-line prompt over the compact roster; `todo` = local ids that need a manager suggestion. */
export function buildOrgReportingPrompt(account: OrgInferOptions['account'], roster: RosterRow[], todo: string[]): string {
  const lines = roster.map((r) => {
    const row: Record<string, string> = { id: r.id, title: clean(r.title), seniority: r.seniority, subfunction: r.subfunction };
    if (r.entity) row.entity = clean(r.entity, 200);
    if (r.country) row.country = r.country;
    if (r.location) row.location = clean(r.location, 120);
    if (r.fixedManager) row.reportsTo = r.fixedManager;
    return JSON.stringify(row);
  });
  return `You suggest reporting lines inside the marketing organisation of one company.
Company: ${companyLine(account)}
Each row is one person (no names). Rows with "reportsTo" are CONFIRMED lines: keep them, never contradict them.

RULES:
- A manager must be more senior than the person, or a team lead in the same sub-function / entity.
- Prefer a manager in the same entity, then the same sub-function, then the same country, then the head of marketing.
- Only use ids from the roster. Never invent people. Nobody reports to themselves; no loops.
- A regional, entity or country lead (e.g. "Marketingleitung" of one regional subsidiary / branch / country, "Head of
  Marketing UK", "Field Marketing DACH") manages ONLY people of that same region / entity / country. Never attach
  central (group / headquarters) people, people of other entities or people in other countries to them.
- Being the most senior person in this roster does NOT make someone everyone's manager: the real head of the function
  may not be in the roster. When nobody in the roster plausibly leads that person's team, return managerId null — a
  person with no manager is far better than a wrong line.
- managerId null when unsure. Do not force a line.
- confidence 0..1: 0.9 only if a title states it ("reports to", "Assistant to the CMO"); 0.6 same team + clear
  seniority gap; 0.3 a guess from titles only.
- reason: ≤ 20 words.

Return one edge for each of these ids: ${todo.join(', ')}

ROSTER (one JSON object per line):
${lines.join('\n')}`;
}

interface RawInference {
  id?: unknown;
  subfunction?: unknown;
  seniority?: unknown;
  noise?: unknown;
  vendorFunded?: unknown;
  team?: unknown;
  entity?: unknown;
  country?: unknown;
  responsibilities?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

const conf01 = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
};

/** coerce model output: bad enums → other / unknown / '', lengths capped, country must be two letters */
export function normalizeInference(raw: RawInference, model: string, at: string): MemberInference {
  const sf = clean(raw.subfunction, 40).toLowerCase();
  const sen = clean(raw.seniority, 40).toLowerCase();
  const rawNoise = clean(raw.noise, 40).toLowerCase();
  const noise = (NOISE.has(rawNoise) ? rawNoise : '') as OrgNoise | '';
  // vendor-funded is a tag, not noise (a model answering the old way with noise "vendor-funded" means the same)
  const vendorFunded = !noise && (raw.vendorFunded === true || raw.vendorFunded === 'true' || rawNoise === 'vendor-funded');
  const country = clean(raw.country, 10).toUpperCase();
  const confidence = conf01(raw.confidence);
  return {
    subfunction: (vendorFunded && !noise ? 'partner-marketing' : SUB.has(sf) ? sf : 'other') as Subfunction,
    seniority: (SEN.has(sen) ? sen : 'unknown') as Seniority,
    noise,
    vendorFunded,
    team: clean(raw.team, 120),
    entity: clean(raw.entity, 200),
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    responsibilities: clean(raw.responsibilities, 240),
    ...(confidence !== undefined ? { confidence } : {}),
    reason: clean(raw.reason, 300),
    model,
    at,
  };
}

// ---------- rule-based fallback ----------

export interface RuleMember {
  id: string;
  seniority: Seniority;
  subfunction: Subfunction;
  entity: string;
  department: string;
  /** ISO country ('' = unknown): a manager in another known country is never suggested */
  country?: string;
  /** a confirmed line (user / web) — never replaced */
  fixed?: boolean;
}

const isMarketing = (m: RuleMember) => m.department === 'marketing' || m.subfunction !== 'other';
/** the most senior of `pool` (first one on ties) */
const mostSenior = (pool: RuleMember[]) => pool.reduce<RuleMember | undefined>((b, m) => (!b || rank(m.seniority) < rank(b.seniority) ? m : b), undefined);

/**
 * Pure fallback: the most senior person in the same (entity, sub-function) → the most senior marketing person in the
 * same entity → the overall head of marketing. A manager is always strictly more senior, so there are no loops.
 * Confidence per the shared scale: same team + clear seniority gap 0.6 (one step 0.5), same entity 0.45, overall 0.3.
 */
export function suggestManagersRuleBased(members: RuleMember[], targets?: Set<string>): OrgEdge[] {
  const mkt = members.filter((m) => isMarketing(m) && rank(m.seniority) !== Infinity);
  const edges: OrgEdge[] = [];
  for (const m of mkt) {
    if (m.fixed || (targets && !targets.has(m.id))) continue;
    const r = rank(m.seniority);
    const above = (pool: RuleMember[]) => {
      const h = mostSenior(pool.filter((x) => x.id !== m.id));
      return h && rank(h.seniority) < r ? h : undefined;
    };
    // a regional / entity / country lead only manages people of that entity and country; with no entity known the
    // rules don't guess one (a wrong line is worse than "no known manager")
    const sameCountry = (x: RuleMember) => !x.country || !m.country || x.country === m.country;
    const sameEntity = m.entity ? mkt.filter((x) => norm(x.entity) === norm(m.entity) && sameCountry(x)) : [];
    const team = m.subfunction !== 'other' && m.subfunction !== 'leadership' ? above(sameEntity.filter((x) => x.subfunction === m.subfunction)) : undefined;
    if (team) {
      const gap = r - rank(team.seniority);
      edges.push({ id: m.id, managerId: team.id, confidence: gap >= 2 ? 0.6 : 0.5, reason: `Most senior in ${SUBFUNCTION_LABELS[m.subfunction]}${m.entity ? ` at ${m.entity}` : ''} (rule)`, source: 'rules' });
      continue;
    }
    const ent = above(sameEntity);
    if (ent) {
      edges.push({ id: m.id, managerId: ent.id, confidence: 0.45, reason: `Most senior marketing person${m.entity ? ` at ${m.entity}` : ''} (rule)`, source: 'rules' });
      continue;
    }
    const top = above(mkt.filter(sameCountry));
    if (top) edges.push({ id: m.id, managerId: top.id, confidence: 0.3, reason: 'Head of marketing overall (rule)', source: 'rules' });
  }
  return edges;
}

// ---------- edges: validation ----------

/**
 * Keep edges to known roster ids only; drop self-lines, duplicates and anything that would close a loop with the
 * fixed lines or with a more confident suggestion. `graph` = lines that stay (fixed + untouched members).
 */
export function cleanEdges(edges: OrgEdge[], known: Set<string>, graph: Map<string, string>, todo?: Set<string>): OrgEdge[] {
  const seen = new Set<string>();
  const candidates: OrgEdge[] = [];
  for (const e of edges) {
    if (!known.has(e.id) || seen.has(e.id) || (todo && !todo.has(e.id))) continue;
    if (e.managerId !== null && (!known.has(e.managerId) || e.managerId === e.id)) continue;
    seen.add(e.id);
    candidates.push(e);
  }
  const g = new Map(graph);
  for (const e of candidates) g.delete(e.id); // their old lines are being replaced
  const loops = (id: string, manager: string) => {
    let cur: string | undefined = manager;
    for (let i = 0; cur && i <= g.size + 1; i++) {
      if (cur === id) return true;
      cur = g.get(cur);
    }
    return false;
  };
  const out: OrgEdge[] = [];
  for (const e of [...candidates].sort((a, b) => b.confidence - a.confidence)) {
    if (e.managerId === null) {
      out.push(e);
      continue;
    }
    if (loops(e.id, e.managerId)) continue;
    g.set(e.id, e.managerId);
    out.push(e);
  }
  return out;
}

// ---------- the job ----------

const abortWithCost = (usd: number): ClaudeError => {
  const err = new ClaudeError('Aborted', { costUsd: usd, costIncomplete: true, retryable: false });
  err.name = 'AbortError';
  return err;
};
const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

export async function runOrgInference(opts: OrgInferOptions): Promise<OrgInferResult> {
  const model = opts.model ?? 'haiku';
  const batchSize = Math.max(1, opts.batchSize ?? 40);
  const at = new Date().toISOString();
  const byId = new Map(opts.members.map((m) => [m.id, m]));
  const targets = (opts.ids ?? opts.members.map((m) => m.id)).filter((id, i, a) => byId.has(id) && a.indexOf(id) === i);
  const batches = chunk(targets.map((id) => byId.get(id)!), batchSize);
  const classified = new Map<string, MemberInference>();
  let spent = 0;
  let incomplete = false;
  let failedBatches = 0;
  const add = (usd: number, inc = false) => {
    spent += usd;
    if (inc) {
      incomplete = true;
      opts.costs?.markIncomplete();
    }
  };
  const call = async <T>(prompt: string, jsonSchema: Record<string, unknown>): Promise<T | undefined> => {
    const res = await runClaude<T>({
      prompt, model, jsonSchema, tools: [], timeoutMs: DEFAULTS.enrichTimeoutMs, retries: DEFAULTS.retries, signal: opts.signal,
    });
    add(res.costUsd, Boolean(res.costIncomplete));
    return res.data;
  };
  const classifyOnce = async (batch: OrgMemberInput[]) => {
    const data = await call<{ results?: RawInference[] }>(buildOrgClassifyPrompt(opts.account, batch), ORG_CLASSIFY_SCHEMA);
    const found = new Map<string, MemberInference>();
    for (const r of data?.results ?? []) {
      const m = /^p(\d+)$/i.exec(String(r?.id ?? '').trim());
      const person = m ? batch[Number(m[1])] : undefined;
      if (!person || found.has(person.id)) continue;
      found.set(person.id, normalizeInference(r, model, at));
    }
    return found;
  };

  let reportingFallback = false;
  let edges: OrgEdge[] = [];
  try {
    let done = 0;
    const total = targets.length;
    opts.onProgress?.({ phase: 'classify', done: 0, total });
    await mapWithConcurrency(
      batches,
      opts.concurrency ?? 2,
      async (batch) => {
        try {
          const found = await classifyOnce(batch);
          const missing = batch.filter((p) => !found.has(p.id));
          if (missing.length) {
            try {
              for (const [id, inf] of await classifyOnce(missing)) found.set(id, inf);
            } catch (e) {
              if (isAbort(e)) throw e;
              const ec = errorCost(e);
              add(ec.usd, ec.incomplete);
            }
          }
          for (const [id, inf] of found) classified.set(id, inf);
        } catch (e) {
          const ec = errorCost(e);
          add(ec.usd, ec.incomplete);
          if (isAbort(e)) throw e;
          failedBatches++;
        }
        done += batch.length;
        opts.onProgress?.({ phase: 'classify', done, total });
      },
      opts.signal,
    );

    // ---- reporting lines over the compact roster ----
    // people flagged as noise (HR marketing, other employer, not marketing, …) get no manager and manage nobody;
    // vendor-funded people are a tag only, so they stay in and get managers
    const all = opts.members.map((m) => {
      const inf = classified.get(m.id);
      const noise = !m.autoNoise ? m.noise : inf && inf.noise !== undefined ? inf.noise : m.noise;
      return { m, inf, noise };
    });
    const resolved = all.filter((x) => !x.noise).map(({ m, inf }) => {
      const fixed = m.reportsToSource === 'user' || m.reportsToSource === 'web';
      return {
        m,
        fixed,
        seniority: (inf?.seniority && inf.seniority !== 'unknown' ? inf.seniority : m.seniority) as Seniority,
        subfunction: (!m.autoSubfunction ? m.subfunction : inf?.subfunction ?? m.subfunction) as Subfunction,
        entity: m.entity || inf?.entity || '',
        country: m.country || inf?.country || '',
      };
    });
    const byResolved = new Map(resolved.map((r) => [r.m.id, r]));
    const todoIds = new Set(targets.filter((id) => byResolved.has(id) && !byResolved.get(id)!.fixed));
    // lines that stay as they are: confirmed ones, and those of people not in this run
    const graph = new Map<string, string>();
    for (const r of resolved) if (r.m.reportsTo && (r.fixed || !todoIds.has(r.m.id))) graph.set(r.m.id, r.m.reportsTo);
    const known = new Set(resolved.map((r) => r.m.id));
    const rules = () =>
      suggestManagersRuleBased(
        resolved.map((r) => ({ id: r.m.id, seniority: r.seniority, subfunction: r.subfunction, entity: r.entity, country: r.country, department: r.m.department, fixed: r.fixed })),
        todoIds,
      );

    if (todoIds.size && resolved.length > 1) {
      const roster = [...resolved].sort((a, b) => rank(a.seniority) - rank(b.seniority)).slice(0, ORG_ROSTER_MAX);
      const local = new Map(roster.map((r, i) => [r.m.id, `p${i}`]));
      const back = new Map(roster.map((r, i) => [`p${i}`, r.m.id]));
      const rows: RosterRow[] = roster.map((r) => ({
        id: local.get(r.m.id)!,
        title: r.m.title || r.m.headline,
        seniority: r.seniority,
        subfunction: r.subfunction,
        entity: r.entity,
        country: r.country,
        location: r.m.location,
        ...(r.fixed && r.m.reportsTo && local.has(r.m.reportsTo) ? { fixedManager: local.get(r.m.reportsTo)! } : {}),
      }));
      const todoLocal = [...todoIds].filter((id) => local.has(id)).map((id) => local.get(id)!);
      let llm: OrgEdge[] = [];
      opts.onProgress?.({ phase: 'reporting', done: 0, total });
      if (todoLocal.length) {
        try {
          const data = await call<{ edges?: { id?: unknown; managerId?: unknown; confidence?: unknown; reason?: unknown }[] }>(
            buildOrgReportingPrompt(opts.account, rows, todoLocal),
            ORG_REPORTING_SCHEMA,
          );
          for (const e of data?.edges ?? []) {
            const id = back.get(String(e?.id ?? '').trim());
            if (!id) continue;
            const mgrRaw = e?.managerId;
            const managerId = mgrRaw === null || mgrRaw === undefined || mgrRaw === '' ? null : back.get(String(mgrRaw).trim()) ?? `?${String(mgrRaw)}`;
            llm.push({ id, managerId, confidence: conf01(e?.confidence) ?? 0.3, reason: clean(e?.reason, 300), source: 'llm' });
          }
        } catch (e) {
          const ec = errorCost(e);
          add(ec.usd, ec.incomplete);
          if (isAbort(e)) throw e;
          reportingFallback = true;
          llm = [];
        }
      }
      // people outside the roster (or everyone, when the call failed) get the rule-based suggestion
      const covered = reportingFallback ? new Set<string>() : new Set(todoLocal.map((l) => back.get(l)!));
      const ruleEdges = rules().filter((e) => !covered.has(e.id));
      const cleaned = cleanEdges([...llm, ...ruleEdges], known, graph, todoIds);
      // weak guesses (e.g. "the most senior person captured") are not stored as lines: the person stays unplaced and
      // the guess is kept with their classification so the drawer can show "possible manager: X (low)"
      edges = [];
      for (const e of cleaned) {
        if (e.managerId && e.confidence < ORG_MIN_EDGE_CONFIDENCE) {
          const ci = classified.get(e.id);
          if (ci) classified.set(e.id, { ...ci, possibleManager: { id: e.managerId, confidence: e.confidence, reason: e.reason } });
          continue;
        }
        edges.push(e);
      }
      opts.onProgress?.({ phase: 'reporting', done: total, total });
    }
  } catch (e) {
    if (isAbort(e) || opts.signal?.aborted) throw abortWithCost(spent);
    throw e;
  }
  return { classified, edges, costUsd: spent, costIncomplete: incomplete, failedBatches, reportingFallback };
}
