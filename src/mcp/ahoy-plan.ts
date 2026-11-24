/**
 * Turn chosen people into ready-to-send Ahoy `create_proposal` batches: companies, contacts, one deal per company in a
 * pipeline stage, and a "why them" note per person. Pure and deterministic (no model, no network), so Claude passes the
 * batches to Ahoy's create_proposal as they are instead of writing hundreds of operations by hand.
 *
 * Property and association names come from Ahoy's live schema (see AGENTS.md "Ahoy field names"). Every operation
 * carries sources (Ahoy requires 1–7): the user's request, plus the person's LinkedIn profile for facts about them.
 */
import { ahoyCompany, ahoyName } from '../io/explorer-export';
import type { ExplorerPerson, Lens } from '../types';
import { companyOf, isMember, pinOf } from './data';

export const MAX_OPS = 50;
const MAX_SOURCES = 7;

export interface PlanPersonInput {
  person_id: string;
  /** existing Ahoy contact (from search_crm); omit for a new contact */
  contact_id?: string;
  /** existing Ahoy company; omit to create one (once per company name) */
  company_id?: string;
  /** override the company name used for grouping / creation */
  company_name?: string;
  /** an existing open deal for this company in the chosen pipeline; omit to create one */
  deal_id?: string;
}

export interface PlanOptions {
  campaign: string;
  stageId?: string;
  /** the user's request, quoted exactly (Ahoy user_message source) */
  userRequest: string;
  lens?: Lens;
  /** other people in the network, for warm paths in the notes */
  network?: ExplorerPerson[];
  includeDeals?: boolean;
}

type Source = { type: 'user_message'; text: string } | { type: 'web'; url: string; title: string } | { type: 'crm_record'; id: string };
export interface PlannedOp {
  operation: 'create' | 'associate';
  object_type?: string;
  temp_id?: string;
  properties?: Record<string, unknown>;
  association_type?: string;
  source_entity_id?: string;
  target_entity_id?: string;
  sources: Source[];
}
export interface PlannedProposal {
  title: string;
  description: string;
  operations: PlannedOp[];
  companies: string[];
  people: string[];
}
export interface PipelinePlan {
  proposals: PlannedProposal[];
  summary: { companies: number; newCompanies: number; people: number; newContacts: number; deals: number; notes: number; operations: number };
  skipped: { person_id: string; name?: string; why: string }[];
}

const dos = (p: ExplorerPerson) => (p.dossier?.status === 'ok' && p.dossier.dossier ? p.dossier.dossier : null);
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const isUrl = (u: string) => /^https?:\/\/\S+$/i.test(u);

/**
 * The part of the user's request to cite: its first sentence, at most ~240 characters, cut at a word. Still their exact
 * words (Ahoy wants "only as much as holds the fact"), and it keeps every operation's sources small.
 */
export function requestQuote(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const first = t.match(/^.+?[.!?](\s|$)/)?.[0]?.trim() ?? t;
  if (first.length <= 240) return first;
  const cut = first.slice(0, 240);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 120)).trim();
}

/** where a location came from: a web profile (confirmed), the headline (stated) or nowhere */
export function locationWithSource(p: ExplorerPerson): { location: string; source: 'web profile' | 'headline' | '' } {
  const d = dos(p);
  if (d?.location && !/^(unclear|unknown|not )/i.test(d.location)) return { location: d.location, source: 'web profile' };
  if (p.profile?.region) return { location: p.profile.region, source: 'headline' };
  return { location: '', source: '' };
}

function noteFor(p: ExplorerPerson, opts: PlanOptions, company: string): string {
  const out: string[] = [];
  const role = p.profile?.role || p.title || '';
  out.push(`**${p.fullName}** — ${role}${company ? ` at ${company}` : ''}`);
  if (p.title && p.title !== role) out.push(`> ${p.title}`);
  const sc = opts.lens && p.scores?.[opts.lens.id];
  if (sc) out.push(`**Why: ${sc.score}/100 for "${opts.lens!.goal}".** ${sc.reason ?? ''}`);
  const loc = locationWithSource(p);
  if (loc.location) out.push(`- **Location:** ${loc.location} (${loc.source === 'web profile' ? 'confirmed by web research' : 'from their headline, unconfirmed'})`);
  const d = dos(p);
  if (d?.oneLiner) out.push(`- **Background:** ${d.oneLiner}`);
  if (p.connectedOn) out.push(`- **Connected on LinkedIn:** ${p.connectedOn}`);
  const key = company.toLowerCase();
  const warm = (opts.network ?? []).filter((x) => x.id !== p.id && key && companyOf(x).toLowerCase() === key).slice(0, 5);
  if (warm.length) out.push(`- **Also in your network there:** ${warm.map((x) => `${x.fullName} (${x.profile?.role || x.title})`).join('; ')}`);
  out.push(`- **Campaign:** ${opts.campaign} · from network-builder`);
  return out.join('\n');
}

/**
 * Group people by company and build proposals of ≤ 50 operations, never splitting a company (its temp ids must stay in
 * one proposal). A company whose people don't fit in one proposal keeps the first ones; the rest are reported in
 * `skipped`.
 */
export function planPipeline(people: ExplorerPerson[], inputs: PlanPersonInput[], opts: PlanOptions): PipelinePlan {
  const byId = new Map(people.map((p) => [p.id, p]));
  const skipped: PipelinePlan['skipped'] = [];
  const request: Source = { type: 'user_message', text: requestQuote(opts.userRequest) };
  const includeDeals = opts.includeDeals !== false && Boolean(opts.stageId);

  type Unit = { name: string; companyId?: string; dealId?: string; rows: { p: ExplorerPerson; i: PlanPersonInput }[] };
  const units = new Map<string, Unit>();
  for (const i of inputs) {
    const p = byId.get(i.person_id);
    if (!p) {
      skipped.push({ person_id: i.person_id, why: 'unknown person id' });
      continue;
    }
    if (opts.lens && pinOf(opts.lens, p.id) === 'out') {
      skipped.push({ person_id: i.person_id, name: p.fullName, why: 'removed from the lens by the user' });
      continue;
    }
    const name = (i.company_name || ahoyCompany(p)).trim();
    const key = i.company_id ? `id:${i.company_id}` : name ? `name:${name.toLowerCase()}` : `solo:${p.id}`;
    let u = units.get(key);
    if (!u) units.set(key, (u = { name, companyId: i.company_id, dealId: i.deal_id, rows: [] }));
    if (!u.dealId && i.deal_id) u.dealId = i.deal_id;
    if (u.rows.some((r) => r.p.id === p.id)) continue;
    u.rows.push({ p, i });
  }

  const summary = { companies: 0, newCompanies: 0, people: 0, newContacts: 0, deals: 0, notes: 0, operations: 0 };
  const proposals: PlannedProposal[] = [];
  let cur: PlannedProposal | undefined;
  let n = 0;

  for (const u of units.values()) {
    n++;
    const webOf = (p: ExplorerPerson): Source[] => (p.url && isUrl(p.url) ? [{ type: 'web', url: p.url, title: short(`LinkedIn profile of ${p.fullName}`, 200) }] : []);
    const companySources: Source[] = [request, ...u.rows.flatMap((r) => webOf(r.p))].slice(0, Math.min(MAX_SOURCES, 4));
    const companyRef = u.companyId ?? (u.name ? `co_${n}` : undefined);
    const head: PlannedOp[] = [];
    if (!u.companyId && u.name) {
      const props: Record<string, unknown> = { ahoy_name: u.name };
      const ind = u.rows.find((r) => r.p.profile?.industry)?.p.profile?.industry;
      if (ind) props.ahoy_industry = ind;
      head.push({ operation: 'create', object_type: 'ahoy_company', temp_id: companyRef, properties: props, sources: companySources });
    }
    const dealRef = u.dealId ?? (includeDeals ? `deal_${n}` : undefined);
    if (includeDeals && !u.dealId) {
      const dealSources = companySources;
      head.push({
        operation: 'create',
        object_type: 'ahoy_deal',
        temp_id: dealRef,
        properties: { ahoy_name: short(`${u.name || u.rows[0]!.p.fullName} — ${opts.campaign}`, 250) },
        sources: dealSources,
      });
      head.push({ operation: 'associate', association_type: 'ahoy_deal_to_deal_pipeline_stage', source_entity_id: dealRef, target_entity_id: opts.stageId, sources: dealSources });
      if (companyRef) head.push({ operation: 'associate', association_type: 'ahoy_deal_to_company', source_entity_id: dealRef, target_entity_id: companyRef, sources: dealSources });
    }

    const personOps: { p: ExplorerPerson; ops: PlannedOp[]; isNew: boolean }[] = [];
    let m = 0;
    for (const { p, i } of u.rows) {
      m++;
      const src: Source[] = [request, ...webOf(p)];
      const ops: PlannedOp[] = [];
      const contactRef = i.contact_id ?? `p_${n}_${m}`;
      if (!i.contact_id) {
        const [first, last] = ahoyName(p);
        const props: Record<string, unknown> = { ahoy_first_name: first };
        if (last) props.ahoy_last_name = last;
        const role = p.profile?.role || p.title || '';
        if (role) props.ahoy_job_title = role;
        if (p.title) props.ahoy_headline = p.title;
        if (p.url) props.ahoy_linkedin_url = p.url;
        const loc = locationWithSource(p);
        if (loc.source === 'web profile') props.ahoy_location = loc.location; // never write a guessed location
        ops.push({ operation: 'create', object_type: 'ahoy_contact', temp_id: contactRef, properties: props, sources: src });
        if (companyRef) ops.push({ operation: 'associate', association_type: 'ahoy_contact_to_company', source_entity_id: contactRef, target_entity_id: companyRef, sources: src });
      }
      if (dealRef) {
        const dealSrc: Source[] = u.dealId ? [request, { type: 'crm_record', id: u.dealId } as Source, ...webOf(p)] : src;
        ops.push({ operation: 'associate', association_type: 'ahoy_deal_to_contact', source_entity_id: dealRef, target_entity_id: contactRef, sources: dealSrc });
      }
      const noteRef = `n_${n}_${m}`;
      ops.push({
        operation: 'create',
        object_type: 'ahoy_note',
        temp_id: noteRef,
        properties: { ahoy_title: short(`Why ${p.fullName}: ${opts.campaign}`, 250), ahoy_content: noteFor(p, opts, u.name) },
        sources: src,
      });
      ops.push({ operation: 'associate', association_type: 'ahoy_note_to_contact', source_entity_id: noteRef, target_entity_id: contactRef, sources: src });
      if (dealRef) ops.push({ operation: 'associate', association_type: 'ahoy_note_to_deal', source_entity_id: noteRef, target_entity_id: dealRef, sources: src });
      personOps.push({ p, ops, isNew: !i.contact_id });
    }

    // fit the company into one proposal; drop the people that don't fit
    let unitOps = [...head];
    const kept: typeof personOps = [];
    for (const po of personOps) {
      if (unitOps.length + po.ops.length > MAX_OPS) {
        skipped.push({ person_id: po.p.id, name: po.p.fullName, why: `too many people at ${u.name} for one proposal; send them in a second run` });
        continue;
      }
      unitOps = unitOps.concat(po.ops);
      kept.push(po);
    }
    if (!kept.length) continue;
    if (!cur || cur.operations.length + unitOps.length > MAX_OPS) {
      cur = { title: '', description: '', operations: [], companies: [], people: [] };
      proposals.push(cur);
    }
    cur.operations.push(...unitOps);
    cur.companies.push(u.name || kept[0]!.p.fullName);
    cur.people.push(...kept.map((k) => k.p.fullName));
    summary.companies++;
    if (!u.companyId && u.name) summary.newCompanies++;
    if (includeDeals && !u.dealId) summary.deals++;
    summary.people += kept.length;
    summary.newContacts += kept.filter((k) => k.isNew).length;
    summary.notes += kept.length;
  }

  proposals.forEach((pr, idx) => {
    pr.title = short(`network-builder: ${opts.campaign}${proposals.length > 1 ? ` (${idx + 1}/${proposals.length})` : ''}`, 255);
    pr.description =
      `${pr.people.length === 1 ? '1 person' : `${pr.people.length} people`} at ${pr.companies.length === 1 ? pr.companies[0] : `${pr.companies.length} companies (${short(pr.companies.join(', '), 400)})`}. ` +
      `Creates companies and contacts that aren't in Ahoy yet${includeDeals ? ', a deal per company in the chosen pipeline stage' : ''}, ` +
      'and a note on each person explaining why they are a target. Built by network-builder from your LinkedIn network.';
    summary.operations += pr.operations.length;
  });
  return { proposals, summary, skipped };
}

/** default people for a lens: its members, best first */
export function lensMembers(people: ExplorerPerson[], lens: Lens): ExplorerPerson[] {
  return people.filter((p) => isMember(lens, p)).sort((a, b) => (b.scores?.[lens.id]?.score ?? 0) - (a.scores?.[lens.id]?.score ?? 0));
}
