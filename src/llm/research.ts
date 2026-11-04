import { computeResearchKey } from '../io/cache';
import { hashSignals } from '../io/signals';
import {
  DEFAULTS,
  type EnrichedFields,
  type PriorResearch,
  type RankedPerson,
  type ResearchOptions,
  type ResearchRecord,
  type ResearchReport,
  type ResearchedPerson,
} from '../types';
import { errorCost, runClaude } from './claude';
import { mapWithConcurrency } from './pool';
import { RESEARCH_SCHEMA } from './schemas';

const SYSTEM_PROMPT =
  'You are a meticulous prospect researcher. Use web search. Never fabricate facts or URLs. Return only the structured output.';

/** Extract `##` headings from the signals markdown so we can tell the model exactly which signals to report on. */
function signalHeadings(md: string): string[] {
  return md
    .split('\n')
    .map((l) => /^##\s+(.+?)\s*#*\s*$/.exec(l)?.[1]?.trim())
    .filter((h): h is string => !!h);
}

function field(label: string, value: string): string {
  return `- ${label}: ${value?.trim() ? value.trim() : '(unknown)'}`;
}

/** "Earlier research" section: prior findings as a starting point, so a new goal costs fewer searches. */
export function priorResearchSection(userPrompt: string, prior: PriorResearch | undefined): string {
  if (!prior?.report) return '';
  const r = prior.report;
  const sameGoal = prior.prompt.trim() === userPrompt.trim();
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join('\n') : '  - (none)');
  return `
## Earlier research on this person (starting point — do not redo it)
Done ${prior.finishedAt ? prior.finishedAt.slice(0, 10) : 'earlier'} with ${prior.model || 'a research model'}${sameGoal ? ' for this same goal (with different signals or model)' : ` for a DIFFERENT goal: "${prior.prompt || 'unknown'}"`}.
- Identity confirmed then: ${r.identityConfirmed ? 'yes' : 'no'} (confidence ${r.confidence})
- Current role then: ${r.currentRole || '(unknown)'}
- Location: ${r.location || '(unknown)'}
- Summary: ${r.summary || '(none)'}
- Findings:
${list((r.signals ?? []).map((s) => `${s.signal} [${s.strength}]: ${s.finding}`))}
- Red flags:
${list(r.redFlags ?? [])}
- Sources seen:
${list((r.sources ?? []).map((s) => `${s.title} — ${s.url}`))}

How to use it: verify identity quickly (one search confirming the role/company is enough), reuse facts that still hold, and spend your searches on the signals specific to THIS goal. Aim for about 4 searches in total. Only cite earlier sources if they support what you state; flag anything that changed (e.g. a new role) in redFlags or the summary.
`;
}

export function buildResearchPrompt(
  userPrompt: string,
  signalsMarkdown: string,
  person: RankedPerson & EnrichedFields,
): string {
  const headings = signalHeadings(signalsMarkdown);
  const signalList = headings.length
    ? headings.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : '(no "##" headings found — treat the whole signals document as a single signal named "General")';

  return `# Research task

## The user's goal
${userPrompt.trim()}

The user is working through their own LinkedIn connections. They want to know whether this person is genuinely a fit for the goal above, and how best to approach them.

## The person
${field('Name', person.fullName)}
${field('Title (from LinkedIn)', person.title)}
${field('Company (from LinkedIn)', person.company)}
${field('LinkedIn URL', person.url)}
${field('Connected with the user on', person.connectedOn)}

## Initial hypothesis (from a quick title-only screen — verify or refute it)
- Fit score: ${person.score}/100 (rank #${person.rank} in the user's network)
- Reason: ${person.fitReason || '(none)'}

This screen only looked at the title and company. Your job is to find real evidence on the web that confirms or contradicts it.
${priorResearchSection(userPrompt, person.priorResearch)}
## Signals to investigate
Investigate each of these signals, as described in the signals document below:
${signalList}

<signals_document>
${signalsMarkdown.trim()}
</signals_document>

## How to research
1. Start by confirming identity. Search for the person's name together with their company and/or title, e.g. "${person.fullName} ${person.company}". Many names are common, so use the company, title and LinkedIn URL slug to make sure you have the right individual. If you cannot confidently tell which person this is, set identityConfirmed=false, confidence="low", and do not attribute other people's details to them.
2. Then work through the signals. Aim for about ${person.priorResearch?.report ? '4' : '8'} searches or fewer in total. Prefer primary sources: company sites, Crunchbase/AngelList/PitchBook snippets, press, podcasts, personal sites, and conference pages.
3. linkedin.com usually blocks fetching, so rely on search-result snippets rather than fetching LinkedIn pages.

## Output rules
- signals: return exactly one entry per signal listed above, in the same order, with "signal" set to the heading text. If you found nothing for a signal, say so in "finding" and set strength="none". Never leave a signal out.
- summary: 3 sentences or fewer. Say who they are and what matters for the goal.
- currentRole and location: as verified on the web. Use "" if unknown.
- fitAssessment: 2-4 sentences on how well they fit the goal, citing the evidence. Say explicitly whether the initial hypothesis held up.
- recommendedApproach: be concrete. Name the channel (e.g. LinkedIn DM, warm intro via X, email), the angle or hook, and the specific ask.
- talkingPoints: 2-5 specific, personalised conversation hooks drawn from what you found (recent posts, investments, shared interests).
- redFlags: anything that cuts against the fit, such as having moved on, a fund closed, being publicly not investing, or an identity mismatch. Use [] if there are none.
- sources: only URLs you actually saw in search results or fetched pages. Never invent or guess URLs.
- confidence: how sure you are about identity and findings overall.
- researchScore: 0-100, your post-research fit score for the goal. Use the same scale as the screen: 90+ means strong direct evidence, and below 40 means weak or no evidence.
- Do not fabricate anything. "Unknown" is better than a guess.`;
}

function errorRecord(id: string, model: string, signalsHash: string, err: unknown, started: number): ResearchRecord {
  return {
    id,
    status: 'error',
    error: (err as Error)?.message ?? String(err),
    costUsd: errorCost(err).usd,
    durationMs: Date.now() - started,
    model,
    signalsHash,
    finishedAt: new Date().toISOString(),
  };
}

function normalizeReport(r: ResearchReport): ResearchReport {
  const score = Number(r.researchScore);
  return {
    ...r,
    researchScore: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    signals: Array.isArray(r.signals) ? r.signals : [],
    talkingPoints: Array.isArray(r.talkingPoints) ? r.talkingPoints : [],
    redFlags: Array.isArray(r.redFlags) ? r.redFlags : [],
    sources: Array.isArray(r.sources) ? r.sources : [],
  };
}

/**
 * Deep-research each person with the research model + web search. Never rejects for a per-person failure
 * (those become status:'error' records). Order is preserved. Rejects with AbortError if aborted.
 */
export async function researchPeople(people: RankedPerson[], opts: ResearchOptions): Promise<ResearchedPerson[]> {
  const signalsHash = hashSignals(opts.signalsMarkdown);
  const model = String(opts.model);

  const records = await mapWithConcurrency(
    people,
    opts.concurrency,
    async (person): Promise<ResearchRecord> => {
      const key = computeResearchKey(person.id, opts.prompt, signalsHash, model);
      // Cache I/O must never sink the whole run: a read error is a miss, a write error is logged on the record.
      let cached: ResearchRecord | undefined;
      try {
        cached = await opts.cache.getResearch(key);
      } catch {
        cached = undefined;
      }
      if (cached) {
        opts.hooks?.onDone?.(person, cached, true);
        return cached;
      }

      // No exact result: start from the latest research on this person for any other goal, if the store has one.
      let subject: RankedPerson & EnrichedFields = person;
      if (!subject.priorResearch && opts.cache.getPriorResearch) {
        try {
          const prior = await opts.cache.getPriorResearch(person.id, key);
          if (prior) subject = { ...person, priorResearch: prior };
        } catch {
          /* prior research is optional context */
        }
      }

      opts.hooks?.onStart?.(person);
      const started = Date.now();
      let rec: ResearchRecord;
      try {
        const res = await runClaude<ResearchReport>({
          prompt: buildResearchPrompt(opts.prompt, opts.signalsMarkdown, subject),
          model: opts.model,
          jsonSchema: RESEARCH_SCHEMA,
          tools: ['WebSearch', 'WebFetch'],
          appendSystemPrompt: SYSTEM_PROMPT,
          timeoutMs: DEFAULTS.researchTimeoutMs,
          retries: DEFAULTS.retries,
          signal: opts.signal,
        });
        if (res.costIncomplete) opts.costs.markIncomplete();
        rec = {
          id: person.id,
          status: 'ok',
          report: normalizeReport(res.data),
          costUsd: res.costUsd,
          durationMs: res.durationMs,
          model,
          signalsHash,
          finishedAt: new Date().toISOString(),
        };
      } catch (e) {
        const ec = errorCost(e);
        if (ec.incomplete) opts.costs.markIncomplete();
        if ((e as Error).name === 'AbortError' || opts.signal?.aborted) {
          opts.costs.add('research', ec.usd);
          throw e;
        }
        rec = errorRecord(person.id, model, signalsHash, e, started);
      }

      opts.costs.add('research', rec.costUsd);
      // Only successful results are cached: an error must never overwrite a good (paid-for) result under
      // the same key, and cache hits only ever return ok records anyway.
      if (rec.status === 'ok') {
        try {
          await opts.cache.setResearch(key, rec);
        } catch (e) {
          rec = { ...rec, error: `result not cached: ${(e as Error).message}` };
        }
      }
      opts.hooks?.onDone?.(person, rec, false);
      return rec;
    },
    opts.signal,
  );

  return people.map((p, i) => ({ ...p, research: records[i] }));
}
