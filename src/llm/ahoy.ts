import { ahoyCompany, ahoyLocation, ahoyName, ahoyNote, ahoyNoteTitle } from '../io/explorer-export';
import type { CostTracker, CrmCandidate, CrmMatch, ExplorerPerson, Lens } from '../types';
import { runClaude } from './claude';
import { mapWithConcurrency } from './pool';

/**
 * Ahoy CRM integration through the user's Ahoy MCP connector (claude.ai connector or `claude mcp add`), driven by
 * `claude -p` subprocesses — no API keys here. Reads use search_crm / get_crm_object / get_associations. Writes ONLY
 * go through create_proposal: nothing changes in the CRM until the user approves the proposal in the Ahoy app.
 */
const NS = process.env.NB_AHOY_TOOL_PREFIX || 'mcp__claude_ai_Ahoy__';
export const AHOY_READ_TOOLS = [`${NS}search_crm`, `${NS}get_crm_object`, `${NS}get_associations`];
export const AHOY_PROPOSAL_TOOL = `${NS}create_proposal`;

/** measured ≈ $0.004 per person (Haiku, 2–4 tool calls each) */
export const AHOY_CHECK_USD_PER_PERSON = 0.005;
/** one create_proposal call (Haiku copying ≤50 operations) */
export const AHOY_SEND_USD_PER_PROPOSAL = 0.02;
const MAX_OPS = 50;

// ---------------------------------------------------------------- check (read-only)

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['in_crm', 'new', 'ambiguous'] },
          contactId: { type: 'string' },
          contactName: { type: 'string' },
          contactEmail: { type: 'string' },
          companyId: { type: 'string' },
          companyName: { type: 'string' },
          companyDomain: { type: 'string' },
          linkedToCompany: { type: 'string', enum: ['yes', 'no', 'unknown'] },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, name: { type: 'string' }, detail: { type: 'string' } },
              required: ['id', 'name', 'detail'],
            },
          },
          reason: { type: 'string' },
        },
        required: ['id', 'status', 'reason'],
      },
    },
  },
  required: ['results'],
} as const;

interface RawCheck {
  id: string;
  status: 'in_crm' | 'new' | 'ambiguous';
  contactId?: string;
  contactName?: string;
  contactEmail?: string;
  companyId?: string;
  companyName?: string;
  companyDomain?: string;
  linkedToCompany?: 'yes' | 'no' | 'unknown';
  candidates?: CrmCandidate[];
  reason: string;
}

export function checkPrompt(people: ExplorerPerson[]): string {
  const lines = people.map((p, i) =>
    JSON.stringify({
      id: `p${i + 1}`,
      name: ahoyName(p).filter(Boolean).join(' ') || p.fullName,
      linkedin: p.url || '',
      email: p.email || '',
      company: ahoyCompany(p),
      title: p.title || '',
    }),
  );
  return `You reconcile LinkedIn connections against the user's Ahoy CRM with the Ahoy tools. READ-ONLY: never create,
update or propose anything.

For EACH person:
1. CONTACT — search_crm with object_type "ahoy_contact": by email if given, else by full name (if nothing, try the
   LinkedIn slug or a shorter name). Request properties ["ahoy_first_name","ahoy_last_name","ahoy_email",
   "ahoy_job_title","ahoy_linkedin_url"]. It is the same person when the LinkedIn URL matches, or the email matches,
   or the full name matches AND company/title are consistent.
   - exactly one same person → status "in_crm" with contactId/contactName/contactEmail
   - several plausible records → status "ambiguous" with up to 5 candidates {id, name, detail: "title · company · email"}
   - nobody → status "new"
2. COMPANY (if a company is given) — search_crm with object_type "ahoy_company" for the name; if nothing, try a shorter
   variant ("Acme Ventures Ltd" → "Acme", "KPMG UK" → "KPMG"). Request ["ahoy_name","ahoy_domain"]. Return companyId,
   companyName exactly as stored in the CRM, and companyDomain ("" when the record has no domain). Not found → omit
   companyId and return companyName as given.
3. For "in_crm" contacts only: get_associations(entity_id=<contactId>, association_type="ahoy_contact_to_company") →
   linkedToCompany "yes" if linked to the company from step 2, "no" if linked elsewhere or nowhere, "unknown" otherwise.

Be efficient: one search per step unless a variant is needed. reason: one short sentence on how you decided.
Return every id exactly once.

PEOPLE (JSON lines):
${lines.join('\n')}`;
}

/** raw model output → CrmMatch (company status derived from what was found, never trusted blindly) */
export function normalizeMatch(raw: RawCheck | undefined, p: ExplorerPerson, at = new Date().toISOString()): CrmMatch {
  if (!raw) return { status: 'error', companyStatus: 'none', reason: 'The check returned no result for this person.', checkedAt: at };
  const company = (raw.companyName || ahoyCompany(p) || '').trim();
  const companyId = (raw.companyId || '').trim();
  const domain = (raw.companyDomain || '').trim();
  const companyStatus = companyId ? (domain ? 'in_crm' : 'no_domain') : company ? 'new' : 'none';
  const candidates = (raw.candidates ?? []).filter((c) => c && c.id).slice(0, 5);
  let status: CrmMatch['status'] = raw.status;
  if (status === 'in_crm' && !raw.contactId) status = candidates.length ? 'ambiguous' : 'new';
  if (status === 'ambiguous' && !candidates.length) status = 'new';
  const m: CrmMatch = { status, companyStatus, reason: raw.reason || '', checkedAt: at };
  if (status === 'in_crm') {
    m.contactId = raw.contactId;
    if (raw.contactName) m.contactName = raw.contactName;
    if (raw.contactEmail) m.contactEmail = raw.contactEmail;
    m.linkedToCompany = raw.linkedToCompany ?? 'unknown';
  }
  if (status === 'ambiguous') m.candidates = candidates;
  if (companyId) m.companyId = companyId;
  if (company) m.companyName = company;
  if (domain) m.companyDomain = domain;
  if (p.crm?.sent) m.sent = p.crm.sent;
  return m;
}

export interface CheckOptions {
  people: ExplorerPerson[];
  costs: CostTracker;
  signal?: AbortSignal;
  model?: string;
  batchSize?: number;
  concurrency?: number;
  /** each batch's results as they land */
  onResults?: (updates: { id: string; crm: CrmMatch }[]) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Reconcile people against Ahoy (read-only). Failed batches come back as status "error" (retry later). */
export async function checkAhoy(o: CheckOptions): Promise<{ id: string; crm: CrmMatch }[]> {
  const batches: ExplorerPerson[][] = [];
  const size = Math.max(1, o.batchSize ?? 8);
  for (let i = 0; i < o.people.length; i += size) batches.push(o.people.slice(i, i + size));
  const all: { id: string; crm: CrmMatch }[] = [];
  let done = 0;
  o.onProgress?.(0, o.people.length);
  await mapWithConcurrency(
    batches,
    Math.max(1, o.concurrency ?? 4),
    async (batch) => {
      let updates: { id: string; crm: CrmMatch }[];
      try {
        const res = await runClaude<{ results: RawCheck[] }>({
          prompt: checkPrompt(batch),
          model: o.model ?? 'haiku',
          jsonSchema: CHECK_SCHEMA as unknown as Record<string, unknown>,
          mcpTools: AHOY_READ_TOOLS,
          timeoutMs: 6 * 60_000,
          retries: 1,
          signal: o.signal,
        });
        o.costs.add('ahoy', res.costUsd);
        const byKey = new Map((res.data.results ?? []).map((r) => [r.id, r]));
        updates = batch.map((p, i) => ({ id: p.id, crm: normalizeMatch(byKey.get(`p${i + 1}`), p) }));
      } catch (e) {
        if (o.signal?.aborted) throw e;
        const usd = (e as { details?: { costUsd?: number } })?.details?.costUsd ?? 0;
        if (usd > 0) o.costs.add('ahoy', usd);
        const at = new Date().toISOString();
        const msg = ahoyErrorMessage(e);
        updates = batch.map((p) => ({ id: p.id, crm: { status: 'error' as const, companyStatus: 'none' as const, reason: msg, checkedAt: at, ...(p.crm?.sent ? { sent: p.crm.sent } : {}) } }));
      }
      all.push(...updates);
      o.onResults?.(updates);
      done += batch.length;
      o.onProgress?.(done, o.people.length);
    },
    o.signal,
  );
  return all;
}

export function ahoyErrorMessage(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/mcp|tool.*(not|un)available|no .*ahoy|not connected|authenticat/i.test(m)) {
    return 'Ahoy is not reachable from Claude Code — check `claude mcp list` shows Ahoy as connected.';
  }
  return `Ahoy check failed: ${m.slice(0, 200)}`;
}

// ---------------------------------------------------------------- send (proposals only)

export interface AhoyOperation {
  operation: 'create' | 'associate';
  object_type?: string;
  temp_id?: string;
  properties?: Record<string, unknown>;
  association_type?: string;
  source_entity_id?: string;
  target_entity_id?: string;
}
export interface AhoyProposalPlan {
  title: string;
  description: string;
  operations: AhoyOperation[];
  /** people whose records/notes are in this proposal */
  personIds: string[];
}
export interface AhoySendPlan {
  proposals: AhoyProposalPlan[];
  summary: { newContacts: number; newCompanies: number; notes: number; existingContacts: number; linkedCompanies: number };
  skipped: { id: string; name: string; why: string }[];
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s);

/**
 * Deterministic proposal plan (no model involved): new companies, new contacts linked to their company, and a note on
 * every contact (new or existing). Only checked people are included; ambiguous/errored/already-sent ones are skipped.
 * A company created in a proposal is referenced by temp_id, so each company's people stay in the same proposal.
 */
export function planAhoySend(people: ExplorerPerson[], lens?: Pick<Lens, 'id' | 'goal'> | null, label = 'network-builder'): AhoySendPlan {
  const skipped: AhoySendPlan['skipped'] = [];
  const ready: ExplorerPerson[] = [];
  for (const p of people) {
    const c = p.crm;
    const name = p.fullName || '';
    if (!c) skipped.push({ id: p.id, name, why: 'not checked against Ahoy yet' });
    else if (c.status === 'ambiguous') skipped.push({ id: p.id, name, why: 'ambiguous match — pick the right record first' });
    else if (c.status === 'error') skipped.push({ id: p.id, name, why: 'the Ahoy check failed — check again' });
    else if (c.sent) skipped.push({ id: p.id, name, why: 'already sent to Ahoy' });
    else ready.push(p);
  }

  // group by company: new companies are created once and referenced by temp_id within one proposal
  type Unit = { key: string; createCompany: AhoyOperation | null; companyRef: string | null; people: ExplorerPerson[] };
  const units = new Map<string, Unit>();
  // the per-person check sometimes finds a company but returns its id for only some of the people who work there:
  // reuse any id seen for the same company name, so an existing company is never created a second time
  const knownCompanyIds = new Map<string, string>();
  for (const p of ready) {
    const c = p.crm!;
    if (c.companyId && c.companyName?.trim()) knownCompanyIds.set(c.companyName.trim().toLowerCase(), c.companyId);
  }
  let tc = 0;
  for (const p of ready) {
    const c = p.crm!;
    const coName = (c.companyName || ahoyCompany(p)).trim();
    const companyId = c.companyId || (coName ? knownCompanyIds.get(coName.toLowerCase()) : undefined);
    const key = companyId ? `id:${companyId}` : coName ? `new:${coName.toLowerCase()}` : `solo:${p.id}`;
    let u = units.get(key);
    if (!u) {
      let createCompany: AhoyOperation | null = null;
      let companyRef: string | null = null;
      if (companyId) companyRef = companyId;
      else if (coName && c.status === 'new') {
        companyRef = `company_${++tc}`;
        const props: Record<string, unknown> = { ahoy_name: coName };
        if (p.profile?.industry) props.ahoy_industry = p.profile.industry;
        createCompany = { operation: 'create', object_type: 'ahoy_company', temp_id: companyRef, properties: props };
      }
      u = { key, createCompany, companyRef, people: [] };
      units.set(key, u);
    }
    u.people.push(p);
  }

  const summary = { newContacts: 0, newCompanies: 0, notes: 0, existingContacts: 0, linkedCompanies: 0 };
  const proposals: AhoyProposalPlan[] = [];
  let cur: AhoyProposalPlan | null = null;
  const open = () => {
    cur = { title: '', description: '', operations: [], personIds: [] };
    proposals.push(cur);
    return cur;
  };
  let tp = 0;
  for (const u of units.values()) {
    const perPerson = u.people.map((p) => personOps(p, u.companyRef, lens, ++tp));
    let companyPending = u.createCompany;
    for (const [i, ops] of perPerson.entries()) {
      const need = ops.length + (companyPending ? 1 : 0);
      let target = cur as AhoyProposalPlan | null;
      if (!target || target.operations.length + need > MAX_OPS) {
        // a temp company can't be referenced from another proposal: once it's been created, later people of the same
        // new company in a new proposal are linked by name in the note instead (rare: >10 people at one new company)
        if (target && !companyPending && u.createCompany) ops.splice(0, ops.length, ...ops.filter((o) => o.association_type !== 'ahoy_contact_to_company'));
        target = open();
      }
      if (companyPending) {
        target.operations.push(companyPending);
        summary.newCompanies++;
        companyPending = null;
      }
      target.operations.push(...ops);
      target.personIds.push(u.people[i]!.id);
      const c = u.people[i]!.crm!;
      if (c.status === 'new') summary.newContacts++;
      else summary.existingContacts++;
      if (ops.some((o) => o.association_type === 'ahoy_contact_to_company')) summary.linkedCompanies++;
      if (ops.some((o) => o.object_type === 'ahoy_note')) summary.notes++;
    }
  }
  const n = proposals.length;
  proposals.forEach((pr, i) => {
    // Ahoy caps titles at 255 chars; keep well under it (the full goal is in the description) and keep the (i/n) suffix
    const goal = lens ? lens.goal.trim() : 'contacts';
    const short = [...goal].length > 100 ? `${[...goal].slice(0, 99).join('').trimEnd()}…` : goal;
    pr.title = `${label}: ${short}${n > 1 ? ` (${i + 1}/${n})` : ''}`;
    pr.description =
      `From network-builder${lens ? ` (lens “${lens.goal}”)` : ''}: ${pr.personIds.length} people. Creates new contacts and companies ` +
      'that were not found in Ahoy, links contacts to their companies, and adds a note with the fit score and research to each contact. ' +
      'Existing contacts only get a note.';
  });
  return { proposals, summary, skipped };
}

function personOps(p: ExplorerPerson, companyRef: string | null, lens: Pick<Lens, 'id' | 'goal'> | null | undefined, n: number): AhoyOperation[] {
  const c = p.crm!;
  const ops: AhoyOperation[] = [];
  let contactRef = c.contactId ?? '';
  if (c.status === 'new') {
    const [first, last] = ahoyName(p);
    contactRef = `contact_${n}`;
    const props: Record<string, unknown> = { ahoy_first_name: first };
    if (last) props.ahoy_last_name = last;
    const title = p.profile?.role || p.title || '';
    if (title) props.ahoy_job_title = title;
    if (p.title) props.ahoy_headline = p.title;
    if (p.url) props.ahoy_linkedin_url = p.url;
    const loc = ahoyLocation(p);
    if (loc) props.ahoy_location = loc;
    if (p.email && isEmail(p.email)) props.ahoy_email = [p.email];
    ops.push({ operation: 'create', object_type: 'ahoy_contact', temp_id: contactRef, properties: props });
    if (companyRef) {
      ops.push({ operation: 'associate', association_type: 'ahoy_contact_to_company', source_entity_id: contactRef, target_entity_id: companyRef });
    }
  }
  const content = ahoyNote(p, lens);
  if (content && contactRef) {
    const noteRef = `note_${n}`;
    ops.push({ operation: 'create', object_type: 'ahoy_note', temp_id: noteRef, properties: { ahoy_title: ahoyNoteTitle(lens), ahoy_content: content } });
    ops.push({ operation: 'associate', association_type: 'ahoy_note_to_contact', source_entity_id: noteRef, target_entity_id: contactRef });
  }
  return ops;
}

const TOOL_MISSING_RE = /not (available|connected|loaded)|requires? OAuth|no such tool|tool .*(missing|unavailable)/i;
const TOOL_MISSING_ATTEMPTS = 4;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    proposalId: { type: 'string', description: 'the id create_proposal returned' },
    url: { type: 'string', description: 'the proposal url create_proposal returned' },
    operationCount: { type: 'integer', description: 'how many operations you sent' },
    error: { type: 'string', description: 'only if create_proposal failed: its error message' },
    toolMissing: {
      type: 'boolean',
      description: 'true ONLY if create_proposal was not among your tools, so you could not call it at all',
    },
  },
  required: ['proposalId', 'url', 'operationCount'],
} as const;

/** Create ONE Ahoy proposal with exactly these operations (Haiku passes them through verbatim). */
export async function sendAhoyProposal(
  plan: AhoyProposalPlan,
  o: { costs: CostTracker; signal?: AbortSignal; model?: string; run?: typeof runClaude; retryDelayMs?: number },
): Promise<{ proposalId: string; url: string }> {
  const args = { title: plan.title, description: plan.description, operations: plan.operations };
  const prompt = `Call the Ahoy create_proposal tool EXACTLY ONCE with these arguments, copied verbatim — do not add,
remove, reorder or change any operation, property, temp_id or value. Do not call any other tool.

ARGUMENTS (JSON):
${JSON.stringify(args)}

Then return the proposal id and url from the tool result, and operationCount = ${plan.operations.length} if you sent
all operations. If the tool returned an error, return proposalId "" and url "" with the error message.`;
  type Out = { proposalId: string | number; url: string; operationCount: number; error?: string; toolMissing?: boolean };
  // claude.ai connectors load asynchronously in `claude -p`, so a session sometimes starts without the Ahoy tool. That
  // is the ONE case we retry: without the tool nothing can have been written. Any other failure (timeout, tool error,
  // wrong op count) is never retried — a retry could create a duplicate proposal.
  const missing = (d: Out) => !String(d.proposalId ?? '').trim() && (d.toolMissing === true || TOOL_MISSING_RE.test(d.error || ''));
  let d: Out | null = null;
  for (let attempt = 0; attempt < TOOL_MISSING_ATTEMPTS; attempt++) {
    if (attempt) await sleep((o.retryDelayMs ?? 4000) * attempt, o.signal);
    const res = await (o.run ?? runClaude)<Out>({
      prompt,
      model: o.model ?? 'haiku',
      jsonSchema: PROPOSAL_SCHEMA as unknown as Record<string, unknown>,
      mcpTools: [AHOY_PROPOSAL_TOOL],
      timeoutMs: 5 * 60_000,
      retries: 0,
      signal: o.signal,
    });
    o.costs.add('ahoy', res.costUsd);
    d = res.data;
    if (!missing(d)) break;
  }
  d = d!;
  if (missing(d)) throw new Error(`the Ahoy connector didn't load in the background Claude session (${TOOL_MISSING_ATTEMPTS} tries) — nothing was sent; try again`);
  if (d.error || !String(d.proposalId ?? '').trim()) throw new Error(d.error || 'create_proposal returned no proposal id');
  if (Number(d.operationCount) !== plan.operations.length) {
    throw new Error(`proposal ${d.proposalId} was created with ${d.operationCount} of ${plan.operations.length} operations — review or reject it in Ahoy`);
  }
  return { proposalId: String(d.proposalId), url: String(d.url || '') };
}
