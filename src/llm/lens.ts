import { inputHash } from '../db/hash';
import type { Store } from '../db/store';
import { DEFAULTS, type CostTracker, type EvidenceBasis, type ExplorerPerson, type Lens, type LensScore } from '../types';
import { errorCost, runClaude } from './claude';
import { mapWithConcurrency } from './pool';
import { chunk } from './rank';
import { LENS_SCHEMA } from './schemas';

/**
 * Measured live (2026-11): pass 1 Haiku ≈ $0.0015 per 6 people (≈ $0.25/1000) → rounded up to $0.30/1000.
 * Rerank with Sonnet ≈ $0.025 per 6 people (≈ $0.0042/person) → rounded up to $0.50 per 100 reranked.
 */
export const LENS_USD_PER_1000 = 0.3;
export const LENS_RERANK_USD_PER_100 = 0.5;

/** Estimated cost of scoring `n` people: first pass over all n + rerank of min(rerankTop, n). */
export function estimateLensUsd(n: number, rerankTop: number): number {
  const first = (Math.max(0, n) / 1000) * LENS_USD_PER_1000;
  const rerank = (Math.min(Math.max(0, rerankTop), Math.max(0, n)) / 100) * LENS_RERANK_USD_PER_100;
  return first + rerank;
}

const SCORE_BATCH = 60;
const RERANK_BATCH = 25;
const SCORE_CONCURRENCY = 8;
const RERANK_CONCURRENCY = 6;

const one = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function basisOf(p: ExplorerPerson): EvidenceBasis {
  if (p.dossier?.status !== 'ok' || !p.dossier.dossier) return 'headline';
  return p.dossier.depth === 'deep' ? 'dossier-deep' : 'dossier-light';
}

/** Compact, goal-free digest of a person's dossier for the scoring prompt. `max` bounds its length. */
export function dossierDigest(p: ExplorerPerson, max: number): string {
  const rec = p.dossier;
  const d = rec?.status === 'ok' ? rec.dossier : undefined;
  if (!d) return '';
  const career = d.career
    .slice(0, max > 800 ? 8 : 5)
    .map((c) => `${c.role}${c.company ? ` @ ${c.company}` : ''}${c.period ? ` (${c.period})` : ''}`);
  const parts = [
    `${rec!.depth} web profile, confidence ${d.confidence}${d.identityConfirmed ? '' : ', identity UNCONFIRMED'}`,
    d.oneLiner,
    d.location && `location: ${d.location}`,
    career.length ? `career: ${career.join('; ')}` : '',
    d.investingSummary && `investing: ${d.investingSummary}`,
    d.investments.length ? `investments: ${d.investments.slice(0, 10).join(', ')}` : '',
    d.boards.length ? `boards: ${d.boards.slice(0, 6).join('; ')}` : '',
    d.expertise.length ? `expertise: ${d.expertise.slice(0, 6).join(', ')}` : '',
    d.notable.length ? `notable: ${d.notable.slice(0, max > 800 ? 4 : 2).join('; ')}` : '',
    d.recentThemes?.length ? `recently talking about: ${d.recentThemes.slice(0, 6).join('; ')}` : '',
    d.recentActivity?.length
      ? `recent: ${d.recentActivity
          .slice(0, 3)
          .map((r) => `${r.date ? `${r.date} ` : ''}${r.title}`)
          .join('; ')}`
      : '',
  ]
    .filter(Boolean)
    .map((x) => one(String(x)));
  return cut(parts.join(' | '), max);
}

function personLine(p: ExplorerPerson, i: number, digestMax: number): string {
  const pr = p.profile;
  const obj: Record<string, string> = {
    id: `p${i}`,
    name: one(p.fullName) || '(no name)',
    headline: one(p.title) || '(none)',
  };
  const company = one(pr?.company || p.company);
  if (company) obj.company = company;
  if (pr) {
    const profile = [pr.seniority, pr.function, pr.industry, pr.tags.length ? `tags: ${pr.tags.join(', ')}` : '', pr.region]
      .filter((x) => x && x !== 'unknown' && x !== 'other')
      .join('; ');
    if (profile) obj.profile = profile;
  }
  const digest = dossierDigest(p, digestMax);
  if (digest) obj.dossier = digest;
  return JSON.stringify(obj);
}

export const LENS_RUBRIC = `HOW TO SCORE (0-100): score the CREDIBILITY OF THE EVIDENCE that the person fits the goal, not keyword matches.

1. PRIMARY OCCUPATION FIRST. Decide what the person mainly does from the headline's main role/employer and any dossier.
   Labels tacked onto a headline ("| Angel Investor", "| Advisor", "| Investor") are self-descriptions: weaker than their
   main job, and they do NOT outrank an institutional role.
2. EVIDENCE LADDER (strongest first):
   a. Dossier facts — verified web research: named roles and employers, named investments/portfolio, board seats, exits.
   b. An institutional role that IS the goal (for investor goals: Partner / GP / Principal / Venture Partner / MD at a named
      fund; for "head of marketing": Head/VP/Director of Marketing at a named company).
   c. Senior roles that strongly imply it (for investor goals: exited founder, C-level at a scaled company, chair /
      non-executive director roles).
   d. Self-applied labels in the headline with no supporting role, employer or dossier.
   e. Vague or aspirational wording ("investing monthly", "passionate about startups").
3. DISCOUNT when the primary occupation points elsewhere: e.g. a recruiter, salesperson or consultant whose headline also
   says "Angel Investor" is plausible but unproven (about 50-65 headline-only) unless a dossier shows real investments.
4. A BLAND HEADLINE IS NOT EVIDENCE OF ABSENCE: senior governance or executive roles without detail are plausible (about
   50-60 headline-only). Raise them only with evidence; dossier evidence of the goal (e.g. named angel investments, exec
   career at a major company) can lift them to 85+.
5. "POTENTIAL" / "COULD" GOALS SCORE CAPACITY, NOT JUST TRACK RECORD. For goals like "potential angel investors", the
   question is whether this person plausibly could and would do it. For investor goals, CAPACITY is strong evidence on
   its own: exited founder; founder/CEO of a listed, acquired or well-funded scaled company; C-level / VP / partner at a
   scaled, listed or late-stage tech company (equity wealth); board / NED roles; senior finance or investment-firm roles.
   Capacity with startup closeness → 75-85 even with NO named investments; named investments, scout or syndicate roles
   → 88+. A dossier that finds "no investing evidence" is NEUTRAL (most angels are not public) — it must NOT pull a
   capacity profile below 70. Only score low when the dossier shows the person lacks capacity (junior, non-tech career)
   or contrary evidence. Private-equity / buyout roles are capital professionals: plausible (60-75), not institutional
   startup investors.
6. A dossier marked "identity UNCONFIRMED" or low confidence counts only as weak evidence.
7. Do not invent facts. Judge only from the fields given.

BANDS: 90-100 strong, specific evidence of an established fit · 75-89 strong evidence, a step removed · 60-74 plausible
with some evidence · 40-59 possible, indirect or weak evidence · 10-39 unlikely · 0-9 no signal or contrary evidence.

CALIBRATION (goal "potential angel investors", headline only): "Partner at Northwind Ventures" → 88-95;
"VC and angel investor, Venture Partner at Bluefield Capital" → 95+; "Founder at <recruitment firm> | … Talent | Angel
Investor" → 55-65; "Board Chair | INED | Adviser" → 50-60 (85+ with a dossier showing an exec career and named angel
investments); "Bridging daily, investing monthly" → 55-65; "Senior IT Recruitment Consultant" → ≤10. With a dossier: "CMO of a listed
payments company, ex-COO of a SaaS unicorn, public-company board; no angel deals found" → 78-85; "exited co-founder of a media-analytics startup, no investing found"
→ 75-82; "founder/CEO of a listed fintech" → 78-85; "VP Product at a unicorn, two prior exits" → 75-82;
"founder of a 10-person agency, no exits" → 25-40.
Apply the same logic to any other goal (e.g. "heads of marketing": "Head of Marketing at X" → 90+, "Marketing
Manager" → 60-70, "Founder | growth enthusiast" → 30-45).`;

/** Lens scoring prompt (pass 1 = Haiku over everyone; rerank = stronger model over the top band, longer digests). */
export function buildLensPrompt(goal: string, batch: ExplorerPerson[], mode: 'score' | 'rerank'): string {
  const digestMax = mode === 'rerank' ? 1500 : 600;
  const lines = batch.map((p, i) => personLine(p, i, digestMax));
  const intro =
    mode === 'rerank'
      ? `You are re-checking the strongest candidates in a professional network (LinkedIn connections) for a goal.
They were shortlisted by a quick first pass; score each one independently and carefully on the absolute scale below.`
      : 'You are screening a professional network (LinkedIn connections) against a goal.';
  return `${intro}

GOAL: ${goal.trim()}

${LENS_RUBRIC}

FIELDS per person (JSON, one per line): id; name; headline (their LinkedIn headline, self-written); company (parsed
employer, may be missing); profile (model-parsed seniority; function; industry; tags; region — if it disagrees with the
headline, trust the headline); dossier (goal-free web research digest, if any — strongest evidence).

REASON: 1-2 sentences. Start with the evidence basis in brackets — [headline] or [dossier] — then name the specific
evidence (role, employer, investments…) and why it does or doesn't fit the goal.

Return every id exactly once with the exact id string (e.g. "p3"). Do not skip anyone.

PEOPLE:
${lines.join('\n')}`;
}

interface LensOutput {
  results: { id: string; score: number; reason: string }[];
}

function clamp(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0;
}

async function scoreBatchOnce(
  goal: string,
  batch: ExplorerPerson[],
  mode: 'score' | 'rerank',
  model: string,
  signal?: AbortSignal,
): Promise<{ found: Map<string, { score: number; reason: string }>; usd: number; incomplete: boolean }> {
  const res = await runClaude<LensOutput>({
    prompt: buildLensPrompt(goal, batch, mode),
    model,
    jsonSchema: LENS_SCHEMA,
    tools: [],
    timeoutMs: mode === 'rerank' ? 6 * 60_000 : DEFAULTS.rankTimeoutMs,
    retries: DEFAULTS.retries,
    signal,
  });
  const found = new Map<string, { score: number; reason: string }>();
  for (const r of res.data?.results ?? []) {
    const m = /^p(\d+)$/i.exec(String(r?.id ?? '').trim());
    const person = m ? batch[Number(m[1])] : undefined;
    if (!person || found.has(person.id)) continue;
    found.set(person.id, { score: clamp(r.score), reason: one(String(r.reason ?? '')) });
  }
  return { found, usd: res.costUsd, incomplete: Boolean(res.costIncomplete) };
}

/** One batch with a single retry for ids the model skipped. Batch failures (not aborts) yield no scores. */
async function runBatch(
  goal: string,
  batch: ExplorerPerson[],
  mode: 'score' | 'rerank',
  model: string,
  costs: CostTracker,
  signal?: AbortSignal,
): Promise<Map<string, { score: number; reason: string }>> {
  let usd = 0;
  try {
    const first = await scoreBatchOnce(goal, batch, mode, model, signal);
    usd += first.usd;
    if (first.incomplete) costs.markIncomplete();
    const missing = batch.filter((p) => !first.found.has(p.id));
    if (missing.length) {
      try {
        const second = await scoreBatchOnce(goal, missing, mode, model, signal);
        usd += second.usd;
        if (second.incomplete) costs.markIncomplete();
        for (const [k, v] of second.found) first.found.set(k, v);
      } catch (e) {
        const ec = errorCost(e);
        usd += ec.usd;
        if (ec.incomplete) costs.markIncomplete();
        if ((e as Error).name === 'AbortError') throw e;
      }
    }
    return first.found;
  } catch (e) {
    const ec = errorCost(e);
    usd += ec.usd;
    if (ec.incomplete) costs.markIncomplete();
    if ((e as Error).name === 'AbortError' || signal?.aborted) throw e;
    return new Map();
  } finally {
    costs.add('lens', usd);
  }
}

/**
 * Score `people` against a lens. Pass 1: lens.rankModel over everyone given, in batches. Pass 2 (when
 * lens.rerankModel and rerankTop > 0): the stronger model re-scores those of `people` who land in the lens's top
 * `rerankTop` overall (using existing scores of `allPeople` for everyone not being re-scored).
 * Scores are persisted with store.setLensScores as batches finish. People whose batch failed get no score (they stay
 * unscored/stale and can be retried). Rejects only with AbortError.
 */
export async function scoreLens(opts: {
  lens: Lens;
  people: ExplorerPerson[];
  allPeople?: ExplorerPerson[];
  store: Store;
  costs: CostTracker;
  signal?: AbortSignal;
  onProgress?(p: { phase: 'score' | 'rerank'; done: number; total: number }): void;
  /** called with each batch's persisted scores (lets the server stream results to the UI) */
  onScores?(scores: LensScore[]): void;
}): Promise<LensScore[]> {
  const { lens, store, costs, signal } = opts;
  const final = new Map<string, LensScore>();
  const byId = new Map(opts.people.map((p) => [p.id, p]));
  const mk = (p: ExplorerPerson, s: { score: number; reason: string }, model: string): LensScore => ({
    lensId: lens.id,
    personId: p.id,
    score: s.score,
    reason: s.reason,
    basis: basisOf(p),
    model,
    inputHash: inputHash({ title: p.title, company: p.company, profile: p.profile, dossier: p.dossier }),
    scoredAt: new Date().toISOString(),
  });

  // ---- pass 1
  const rankModel = lens.rankModel || DEFAULTS.rankModel;
  const batches = chunk(opts.people, SCORE_BATCH);
  let done = 0;
  opts.onProgress?.({ phase: 'score', done: 0, total: opts.people.length });
  await mapWithConcurrency(
    batches,
    SCORE_CONCURRENCY,
    async (batch) => {
      const found = await runBatch(lens.goal, batch, 'score', rankModel, costs, signal);
      const scores = batch.filter((p) => found.has(p.id)).map((p) => mk(p, found.get(p.id)!, rankModel));
      store.setLensScores(scores);
      // people this batch failed to score may still hold an older, "fresh-looking" score: mark it stale
      store.markLensScoresStale(lens.id, batch.filter((p) => !found.has(p.id)).map((p) => p.id));
      for (const s of scores) final.set(s.personId, s);
      if (scores.length) opts.onScores?.(scores);
      done += batch.length;
      opts.onProgress?.({ phase: 'score', done, total: opts.people.length });
    },
    signal,
  );

  // ---- pass 2: rerank the top band
  if (!lens.rerankModel || lens.rerankTop <= 0 || final.size === 0) return [...final.values()];
  const overall = new Map<string, number>();
  for (const p of opts.allPeople ?? []) {
    const s = p.scores[lens.id];
    if (s && !byId.has(p.id)) overall.set(p.id, s.score);
  }
  for (const s of final.values()) overall.set(s.personId, s.score);
  const band = new Set(
    [...overall.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, lens.rerankTop)
      .map(([id]) => id),
  );
  const toRerank = opts.people.filter((p) => final.has(p.id) && band.has(p.id));
  if (!toRerank.length) return [...final.values()];

  let rdone = 0;
  const reranked = new Set<string>();
  opts.onProgress?.({ phase: 'rerank', done: 0, total: toRerank.length });
  try {
    await mapWithConcurrency(
      chunk(toRerank, RERANK_BATCH),
      RERANK_CONCURRENCY,
      async (batch) => {
        const found = await runBatch(lens.goal, batch, 'rerank', lens.rerankModel, costs, signal);
        const scores = batch.filter((p) => found.has(p.id)).map((p) => mk(p, found.get(p.id)!, lens.rerankModel));
        store.setLensScores(scores);
        for (const s of scores) {
          final.set(s.personId, s);
          reranked.add(s.personId);
        }
        if (scores.length) opts.onScores?.(scores);
        rdone += batch.length;
        opts.onProgress?.({ phase: 'rerank', done: rdone, total: toRerank.length });
      },
      signal,
    );
  } finally {
    // Band members whose rerank failed or was interrupted hold only first-pass scores: mark them stale so
    // "Update stale" re-checks them instead of them silently passing as final.
    try {
      store.markLensScoresStale(lens.id, toRerank.filter((p) => !reranked.has(p.id)).map((p) => p.id));
    } catch {
      /* best effort (e.g. DB closing) */
    }
  }
  return [...final.values()];
}
