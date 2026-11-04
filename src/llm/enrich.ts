import { computeProfileKey } from '../io/cache';
import {
  DEFAULTS,
  PERSONA_TAGS,
  type EnrichOptions,
  type EnrichedFields,
  type JobFunction,
  type Person,
  type PersonaTag,
  type Profile,
  type Seniority,
} from '../types';
import { errorCost, runClaude } from './claude';
import { mapWithConcurrency } from './pool';
import { chunk } from './rank';
import { ENRICH_SCHEMA, FUNCTION_VALUES, SENIORITY_VALUES } from './schemas';

function clean(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Haiku prompt that turns a LinkedIn name/title/company into structured, filterable fields.
 * Pure text parsing — no tools, no web — so it's cheap enough to run on an entire network.
 */
export function buildEnrichPrompt(batch: Person[]): string {
  // JSON lines, not "a | b | c": LinkedIn headlines use "|" themselves to separate segments.
  const lines = batch.map((p, i) =>
    JSON.stringify({ id: `p${i}`, name: clean(p.fullName), title: clean(p.title), company: clean(p.company) }),
  );
  return `You turn LinkedIn connection headlines into structured profile fields for filtering a contact list.
Work ONLY from the text given. Do not use outside knowledge about the person or company, and do not guess.
When something is not stated, use "unknown" (seniority), "other" (function) or "" (text fields).

FIELDS (one result per person, using the exact id given, e.g. "p3"):
- company: the CURRENT employer named in the headline. If the company column is filled, prefer it.
  Parse "Role at Company", "Role @ Company", "Role, Company", "Role - Company", "Company | Role".
  For "A | B | C" headlines take the company tied to the first/primary role. "" if no company is named
  (e.g. "Business Builder & Advisor" → ""). Strip trailing noise like "(Series A)" only if clearly not part of the name.
- role: the primary role, cleaned and short, without the company (e.g. "VP Sales EMEA", "Founder & CEO", "Partner"). "" if none.
- seniority — exactly one of: ${SENIORITY_VALUES.map((v) => `"${v}"`).join(', ')}
  * founder/owner: founder, co-founder, owner, proprietor (even if also CEO)
  * c-suite: CEO/CTO/CFO/COO/CMO/CRO/CPO/Chief X (not a founder)
  * partner: partner / managing partner / general partner / GP / principal at a fund, law or consulting firm
  * vp: VP / SVP / EVP / vice president
  * director: director / managing director (non-fund) / senior director
  * head of: "Head of X", "Lead of a department"
  * manager: manager / team lead / account manager / strategic account manager
  * senior ic: senior / staff / principal / lead engineer-type individual contributors
  * ic: other individual contributors (engineer, designer, analyst, associate, executive (sales), specialist)
  * advisor/board: the PRIMARY identity is advisor / board member / chair / NED / fractional
  * student: student, graduate, intern
  * unknown: not determinable (e.g. "Mobile Commerce", "Improving AI ROI & Productivity")
- function — exactly one of: ${FUNCTION_VALUES.map((v) => `"${v}"`).join(', ')}
  * investing: VC, angel, fund, LP, investment, private equity, family office
  * general management: founder/CEO/GM/MD/president/business owner without a narrower function
  * sales covers BD, partnerships, account management, revenue; marketing covers growth, brand, comms, PR
  * data/ai covers data science, ML, AI, analytics; engineering covers software/hardware/devops/IT
  * people/recruiting covers HR, talent, recruiting; media/creative covers writers, directors, journalists, film, content
  * other when nothing fits or the headline is too vague
- industry: short sector guess ONLY if the headline or company name makes it evident, 1–3 lowercase words
  (e.g. "venture capital", "fintech", "saas", "healthcare", "media", "data centres"). "" if unclear.
- tags: zero or more of: ${PERSONA_TAGS.map((t) => `"${t}"`).join(', ')}
  * investor: any investing activity (VC, angel, LP, "investor", fund partner/principal)
  * angel: "angel" stated; vc: works at/runs a venture fund (partner, principal, GP, VC, "ventures" firm)
  * founder: founder/co-founder; exited founder: "exited", "sold", "acquired by", "ex-founder", "serial entrepreneur"
  * executive: C-suite, VP or above at an operating company; operator: hands-on operating exec/"operator"
  * advisor: advisor/adviser/mentor/fractional; board member: board, chair, NED, non-exec
  * recruiter: recruiting/talent acquisition/headhunter; consultant: consultant/consulting
  * academic: professor, lecturer, researcher, PhD; creator: writer, podcaster, author, creator, director (film)
  * public sector: government, civil service, enterprise agency; open to work: "open to work", "seeking", "looking for"
  Add every tag the text supports (e.g. "Partner at Acme Ventures" → ["investor","vc"];
  "Angel Investor" → ["investor","angel"]; "Founder & CEO at X" → ["founder","executive"]).
- region: geography explicitly in the headline (e.g. "EMEA", "Germany", "UK & Ireland", "DACH"). "" otherwise.

Return every id exactly once.

PEOPLE (one JSON object per line; "company" is the CSV company column, often empty):
${lines.join('\n')}`;
}

interface RawProfile {
  id?: unknown;
  company?: unknown;
  role?: unknown;
  seniority?: unknown;
  function?: unknown;
  industry?: unknown;
  tags?: unknown;
  region?: unknown;
}

const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const SENIORITY = new Set<string>(SENIORITY_VALUES);
const FUNCTIONS = new Set<string>(FUNCTION_VALUES);
const TAGS = new Set<string>(PERSONA_TAGS);

/** Coerce model output into a valid Profile (invalid enums → unknown/other, unknown tags dropped). */
export function normalizeProfile(raw: RawProfile, person: Person): Profile {
  const seniority = str(raw.seniority).toLowerCase();
  const fn = str(raw.function).toLowerCase();
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.map((t) => str(t).toLowerCase()).filter((t) => TAGS.has(t)))]
    : [];
  return {
    company: str(raw.company) || clean(person.company),
    role: str(raw.role),
    seniority: (SENIORITY.has(seniority) ? seniority : 'unknown') as Seniority,
    function: (FUNCTIONS.has(fn) ? fn : 'other') as JobFunction,
    industry: str(raw.industry, 40).toLowerCase(),
    tags: tags as PersonaTag[],
    region: str(raw.region, 40),
  };
}

async function enrichBatchOnce(
  batch: Person[],
  opts: EnrichOptions,
): Promise<{ found: Map<string, Profile>; costUsd: number; costIncomplete: boolean }> {
  const res = await runClaude<{ results?: RawProfile[] }>({
    prompt: buildEnrichPrompt(batch),
    model: opts.model,
    jsonSchema: ENRICH_SCHEMA,
    tools: [],
    timeoutMs: DEFAULTS.enrichTimeoutMs,
    retries: DEFAULTS.retries,
    signal: opts.signal,
  });
  const found = new Map<string, Profile>();
  for (const r of res.data?.results ?? []) {
    const m = /^p(\d+)$/i.exec(String(r?.id ?? '').trim());
    if (!m) continue;
    const person = batch[Number(m[1])];
    if (!person || found.has(person.id)) continue;
    found.set(person.id, normalizeProfile(r, person));
  }
  return { found, costUsd: res.costUsd, costIncomplete: Boolean(res.costIncomplete) };
}

const keyFor = (p: Person, model: string) => computeProfileKey(p.id, p.title, p.company, model);

/**
 * Attach a Profile to everyone (Haiku, batched, cached per person+title in the shared profile cache).
 * People that already carry a profile are left alone. Failures leave `profile` unset (never cached) so a
 * rerun retries them; this function only rejects on abort.
 */
export async function enrichProfiles<T extends Person & EnrichedFields>(people: T[], opts: EnrichOptions): Promise<T[]> {
  const model = String(opts.model);
  const profiles = new Map<string, Profile>();
  const todo: T[] = [];
  await mapWithConcurrency(
    people,
    32,
    async (p) => {
      if (p.profile) return;
      let hit: Profile | undefined;
      try {
        hit = await opts.cache.get(keyFor(p, model));
      } catch {
        /* unreadable cache entry = miss */
      }
      if (hit) profiles.set(p.id, hit);
      else todo.push(p);
    },
    opts.signal,
  );
  // keep CSV order for batching (mapWithConcurrency may finish out of order)
  const order = new Map(people.map((p, i) => [p.id, i]));
  todo.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

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
        const first = await enrichBatchOnce(batch, opts);
        addCost(first.costUsd, first.costIncomplete);
        const found = first.found;
        const missing = batch.filter((p) => !found.has(p.id));
        if (missing.length > 0) {
          try {
            const second = await enrichBatchOnce(missing, opts);
            addCost(second.costUsd, second.costIncomplete);
            for (const [id, pr] of second.found) found.set(id, pr);
          } catch (e) {
            if ((e as Error).name === 'AbortError') throw e;
            const ec = errorCost(e);
            addCost(ec.usd, ec.incomplete);
          }
        }
        await Promise.all(
          batch.map(async (p) => {
            const pr = found.get(p.id);
            if (!pr) return;
            profiles.set(p.id, pr);
            try {
              await opts.cache.set(keyFor(p, model), pr, p.id);
            } catch {
              /* a cache write failure only costs a re-enrich next run */
            }
          }),
        );
        opts.costs.add('enrich', cost);
        opts.hooks?.onBatchDone?.({ ...info, costUsd: cost, fromCache: false });
      } catch (e) {
        const ec = errorCost(e);
        addCost(ec.usd, ec.incomplete);
        opts.costs.add('enrich', cost);
        if ((e as Error).name === 'AbortError') throw e;
        opts.hooks?.onBatchError?.(info, e as Error);
      }
    },
    opts.signal,
  );

  return people.map((p) => (p.profile || !profiles.has(p.id) ? p : { ...p, profile: profiles.get(p.id)! }));
}
