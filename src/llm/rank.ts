import { DEFAULTS, type EnrichedFields, type Person, type RankOptions, type RankResult, type RankedPerson } from '../types';
import { errorCost, runClaude } from './claude';
import { mapWithConcurrency } from './pool';
import { RANK_SCHEMA } from './schemas';

export function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

function clean(s: string): string {
  return s.replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Builds the Haiku ranking prompt. People are referenced by local ids p0..pN to save tokens. */
/** 1–2 line digest of earlier web research on a person, for the ranking prompt. */
export function priorDigest(p: EnrichedFields): string {
  const r = p.priorResearch?.report;
  if (!r) return '';
  const summary = clean(r.summary ?? '');
  const parts = [
    r.identityConfirmed === false ? '(identity unconfirmed)' : '',
    r.currentRole ? `role: ${clean(r.currentRole)}` : '',
    r.location ? `location: ${clean(r.location)}` : '',
    summary ? `summary: ${summary.length > 200 ? `${summary.slice(0, 199)}…` : summary}` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

export function buildRankPrompt(userPrompt: string, batch: (Person & EnrichedFields)[]): string {
  const withProfiles = batch.some((p) => p.profile);
  const withPrior = batch.some((p) => p.priorResearch?.report);
  const lines = batch.map((p, i) => {
    const pr = p.profile;
    const parts = [
      `p${i}`,
      clean(p.fullName) || '(no name)',
      clean(p.title) || '(no title)',
      clean(pr?.company || p.company) || '(no company)',
    ];
    if (withProfiles) {
      parts.push(
        pr
          ? [pr.seniority, pr.function, pr.tags.length ? `tags: ${pr.tags.join(', ')}` : '', pr.industry]
              .filter(Boolean)
              .join('; ')
          : '(no profile)',
      );
    }
    parts.push(p.connectedOn ? `connected ${clean(p.connectedOn)}` : '(connected ?)');
    if (withPrior) parts.push(priorDigest(p) || '-');
    return parts.join(' | ');
  });
  const header = [
    'id | name | title | company',
    withProfiles ? ' | parsed profile (seniority; function; tags; industry)' : '',
    ' | connected',
    withPrior ? ' | earlier web research (if any)' : '',
  ].join('');

  return `You are screening a professional network (LinkedIn connections) against a goal.

GOAL: ${userPrompt.trim()}

Score every person 0-100 for how well they fit the goal, using this rubric:
- 90-100: near-certain strong fit from title/company alone
- 70-89: likely fit
- 40-69: plausible fit
- 10-39: weak fit
- 0-9: no signal

Rules:
- Judge ONLY from the fields given (${withProfiles ? 'name, title, company, model-parsed profile, connection date' : 'name, title, company, connection date'}${withPrior ? ', earlier web research' : ''}). Do not invent facts about anyone.${withProfiles ? '\n- The profile column was parsed from the title by a model: when it disagrees with the title, trust the title.' : ''}${withPrior ? '\n- The earlier-research column is verified web research done for a previous goal. Treat it as stronger evidence than the title (e.g. a confirmed current role), but judge fit against THIS goal.' : ''}
- Each reason is 1-2 sentences naming the specific evidence (e.g. the title or company) and why it does or does not fit the goal.
- Return every id exactly once, using the exact id string (e.g. "p3"). Do not skip anyone.

PEOPLE (${header}):
${lines.join('\n')}`;
}

interface RankOutput {
  results: RankResult[];
}

function clampScore(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** One Haiku call over a batch. Returns map real id -> result plus cost. */
async function rankBatchOnce(
  batch: Person[],
  opts: RankOptions,
): Promise<{ found: Map<string, RankResult>; costUsd: number; costIncomplete: boolean }> {
  const res = await runClaude<RankOutput>({
    prompt: buildRankPrompt(opts.prompt, batch),
    model: opts.model,
    jsonSchema: RANK_SCHEMA,
    tools: [],
    timeoutMs: DEFAULTS.rankTimeoutMs,
    retries: DEFAULTS.retries,
    signal: opts.signal,
  });
  const found = new Map<string, RankResult>();
  for (const r of res.data?.results ?? []) {
    const m = /^p(\d+)$/i.exec(String(r?.id ?? '').trim());
    if (!m) continue;
    const person = batch[Number(m[1])];
    if (!person || found.has(person.id)) continue;
    found.set(person.id, { id: person.id, score: clampScore(r.score), reason: String(r.reason ?? '').trim() });
  }
  return { found, costUsd: res.costUsd, costIncomplete: Boolean(res.costIncomplete) };
}

function sortAndRank(people: Person[], results: Map<string, RankResult>, rankedIds: Set<string>): RankedPerson[] {
  const ranked: RankedPerson[] = people.map((p) => {
    const r = results.get(p.id);
    return { ...p, score: r?.score ?? 0, fitReason: r?.reason ?? 'not ranked', rank: 0, ranked: rankedIds.has(p.id) };
  });
  ranked.sort((a, b) => b.score - a.score || (b.connectedOn || '').localeCompare(a.connectedOn || '') || a.rowIndex - b.rowIndex);
  ranked.forEach((p, i) => (p.rank = i + 1));
  return ranked;
}

/** Rank ALL people with Haiku (batched, bounded concurrency, cached). Returns sorted with rank assigned. */
export async function rankPeople(people: Person[], opts: RankOptions): Promise<RankedPerson[]> {
  const results = new Map<string, RankResult>();
  /** ids genuinely scored by the model (cache hit or this run); others carry a placeholder 0 */
  const rankedIds = new Set<string>();
  const todo: Person[] = [];
  for (const p of people) {
    const hit = opts.cache.getRank(p.id);
    if (hit) {
      results.set(p.id, hit);
      rankedIds.add(p.id);
    } else todo.push(p);
  }

  const batches = chunk(todo, opts.batchSize);
  const cachedCount = people.length - todo.length;
  const totalBatches = batches.length + (cachedCount > 0 ? 1 : 0);

  if (cachedCount > 0) {
    opts.hooks?.onBatchDone?.({ batchIndex: 0, totalBatches, size: cachedCount, costUsd: 0, fromCache: true });
  }
  const offset = cachedCount > 0 ? 1 : 0;

  await mapWithConcurrency(
    batches,
    opts.concurrency,
    async (batch, i) => {
      const info = { batchIndex: i + offset, totalBatches, size: batch.length };
      opts.hooks?.onBatchStart?.(info);
      let cost = 0;
      const addCost = (usd: number, incomplete: boolean) => {
        cost += usd;
        if (incomplete) opts.costs.markIncomplete();
      };
      try {
        const first = await rankBatchOnce(batch, opts);
        addCost(first.costUsd, first.costIncomplete);
        const found = first.found;

        const missing = batch.filter((p) => !found.has(p.id));
        if (missing.length > 0) {
          try {
            const second = await rankBatchOnce(missing, opts);
            addCost(second.costUsd, second.costIncomplete);
            for (const [id, r] of second.found) found.set(id, r);
          } catch (e) {
            if ((e as Error).name === 'AbortError') throw e; // spend counted by the outer catch
            const ec = errorCost(e);
            addCost(ec.usd, ec.incomplete);
          }
        }

        const batchResults = batch.map(
          (p) => found.get(p.id) ?? { id: p.id, score: 0, reason: 'not ranked' },
        );
        for (const r of batchResults) results.set(r.id, r);
        for (const id of found.keys()) rankedIds.add(id);
        // only cache genuinely ranked people so "not ranked" ones are retried next run
        await opts.cache.setRanks(batchResults.filter((r) => found.has(r.id)));
        opts.costs.add('rank', cost);
        opts.hooks?.onBatchDone?.({ ...info, costUsd: cost, fromCache: false });
      } catch (e) {
        const ec = errorCost(e);
        addCost(ec.usd, ec.incomplete);
        opts.costs.add('rank', cost);
        if ((e as Error).name === 'AbortError') throw e;
        const msg = (e as Error).message;
        for (const p of batch) results.set(p.id, { id: p.id, score: 0, reason: `ranking failed: ${msg}` });
        opts.hooks?.onBatchError?.(info, e as Error);
      }
    },
    opts.signal,
  );

  return sortAndRank(people, results, rankedIds);
}
