import {
  DEPARTMENT_LABELS,
  ROLE_LABELS,
  SENIORITIES,
  SUBFUNCTIONS,
  SUBFUNCTION_LABELS,
  TIER_LABELS,
  type AccountMember,
  type AccountView,
  type CapturedProfile,
  type Department,
  type HeadcountSnapshot,
  type HeadcountTotal,
  type OrgMap,
  type OrgNode,
} from './types';

/**
 * One account as markdown for an LLM: the ABX brief, the buying committee, the org chart (department → seniority),
 * full profiles, and your warm paths in. This is what `network_get_account` returns and what the explorer's
 * "Copy for AI" button copies — so a campaign can be planned from a single call.
 */

export type BriefDetail = 'summary' | 'full';

const oneLine = (s: string, max = 300) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

function memberLine(m: AccountMember, byId: Map<string, AccountMember>): string {
  const bits = [`**${m.fullName}**`, m.title ? `— ${m.title}` : ''];
  const tags: string[] = [];
  if (m.role) tags.push(ROLE_LABELS[m.role]);
  if (m.reportsTo && byId.has(m.reportsTo)) tags.push(`reports to ${byId.get(m.reportsTo)!.fullName}`);
  if (m.isConnection) tags.push('your connection');
  if (!m.capturedAt && !m.isConnection) tags.push('no profile');
  tags.push(`id \`${m.id}\``);
  return `- ${bits.filter(Boolean).join(' ')}${tags.length ? ` · ${tags.join(' · ')}` : ''}`;
}

function profileBlock(m: AccountMember, byId: Map<string, AccountMember>, detail: BriefDetail): string[] {
  const out = [`### ${m.fullName}${m.title ? ` — ${m.title}` : ''}`];
  const facts: string[] = [];
  if (m.company) facts.push(`Company: ${m.company}`);
  facts.push(`Org chart: ${DEPARTMENT_LABELS[m.department]} · ${TIER_LABELS[m.tier]}`);
  if (m.role) facts.push(`Buying-committee role: ${ROLE_LABELS[m.role]}`);
  if (m.reportsTo && byId.has(m.reportsTo)) facts.push(`Reports to: ${byId.get(m.reportsTo)!.fullName}`);
  const reports = [...byId.values()].filter((x) => x.reportsTo === m.id).map((x) => x.fullName);
  if (reports.length) facts.push(`Direct reports here: ${reports.join(', ')}`);
  if (m.location) facts.push(`Location: ${m.location}`);
  if (m.headline && m.headline !== m.title) facts.push(`Headline: ${oneLine(m.headline, 240)}`);
  if (m.url) facts.push(`LinkedIn: ${m.url}`);
  facts.push(m.isConnection ? `Your connection${m.connectedOn ? ` since ${m.connectedOn}` : ''}` : 'Not a connection');
  if (m.otherAccounts.length) facts.push(`Also on: ${m.otherAccounts.join(', ')}`);
  out.push(...facts.map((f) => `- ${f}`));
  if (m.notes.trim()) out.push('', `**Your notes:** ${m.notes.trim()}`);
  if (m.webSummary) out.push('', `**Web profile:** ${m.webSummary}`);
  const p = m.profile;
  if (p && detail === 'full') out.push(...profileSections(p));
  return out;
}

export function profileSections(p: CapturedProfile, opts: { descMax?: number; includeRaw?: boolean } = {}): string[] {
  const out: string[] = [];
  const descMax = opts.descMax ?? 500;
  if (p.about) out.push('', `**About:** ${oneLine(p.about, 1500)}`);
  if (p.experience?.length) {
    out.push('', '**Experience:**');
    for (const e of p.experience.slice(0, 30)) {
      const head = [e.title, e.company && `at ${e.company}`, e.employmentType && `[${e.employmentType}]`, e.dates && `(${e.dates})`, e.location && `· ${e.location}`].filter(Boolean).join(' ');
      out.push(`- ${head}${e.description ? ` — ${oneLine(e.description, descMax)}` : ''}`);
    }
  }
  if (p.education?.length) {
    out.push('', '**Education:**', ...p.education.slice(0, 10).map((e) => `- ${e.school}${e.detail ? ` — ${e.detail}` : ''}`));
  }
  for (const [k, v] of Object.entries(p.other ?? {})) {
    if (!v.length) continue;
    out.push('', `**${k[0]!.toUpperCase()}${k.slice(1)}:** ${oneLine(v.join('; '), 1500)}`);
  }
  if (opts.includeRaw && p.detailsText) {
    for (const [k, t] of Object.entries(p.detailsText)) out.push('', `**Full ${k.replace(/-/g, ' ')} list (as captured):**`, '```', t.slice(0, 15_000), '```');
  }
  if ((opts.includeRaw || (!p.experience?.length && !p.about)) && p.rawText) {
    out.push('', '**Page text (as captured):**', '```', p.rawText.slice(0, opts.includeRaw ? 20_000 : 3000), '```');
  }
  return out;
}

export function accountMarkdown(v: AccountView, detail: BriefDetail = 'full'): string {
  const { account: a, members } = v;
  const byId = new Map(members.map((m) => [m.id, m]));
  const L: string[] = [`# Account: ${a.name}`, ''];
  const meta = [`Status: ${a.status}`];
  if (a.domain) meta.push(`Domain: ${a.domain}`);
  if (a.linkedinUrl) meta.push(`LinkedIn: ${a.linkedinUrl}`);
  if (a.aliases.length) meta.push(`Also known as: ${a.aliases.join(', ')}`);
  meta.push(`${members.length} key ${members.length === 1 ? 'person' : 'people'} (${members.filter((m) => m.isConnection).length} your connections)`);
  meta.push(`account id \`${a.id}\``);
  L.push(meta.join(' · '), '');

  L.push('## ABX brief', '', a.brief.trim() || '_No brief yet. Ask the user for the account context (why now, pains, triggers, offer), or draft one and save it with network_update_account._', '');

  L.push('## Buying committee', '');
  const roleOrder = Object.keys(ROLE_LABELS) as (keyof typeof ROLE_LABELS)[];
  for (const r of roleOrder) {
    const ms = members.filter((m) => m.role === r);
    if (ms.length) L.push(`- **${ROLE_LABELS[r]}:** ${ms.map((m) => `${m.fullName}${m.title ? ` (${m.title})` : ''}`).join('; ')}`);
  }
  if (!members.some((m) => m.role)) L.push('- _No roles set yet._');
  if (v.gaps.length) L.push('', `**Gaps:** ${v.gaps.join(' · ')}`);
  L.push('');

  L.push('## Org chart (department → seniority)', '');
  if (!members.length) L.push('_Nobody yet._', '');
  const depts = [...new Set(members.map((m) => m.department))] as Department[];
  for (const d of depts) {
    L.push(`### ${DEPARTMENT_LABELS[d]}`);
    const ms = members.filter((m) => m.department === d);
    const tiers = [...new Set(ms.map((m) => m.tier))];
    for (const t of tiers) {
      L.push(`_${TIER_LABELS[t]}_`);
      L.push(...ms.filter((m) => m.tier === t).map((m) => memberLine(m, byId)));
    }
    L.push('');
  }

  if (members.length) {
    L.push(detail === 'full' ? '## People (full profiles)' : '## People', '');
    for (const m of members) L.push(...profileBlock(m, byId, detail), '');
  }

  if (v.org && hasOrgData(v.org)) L.push(...orgSummarySection(v, v.org), '');

  L.push('## Your warm paths in', '');
  const cur = v.warmPaths.filter((w) => w.relation === 'current');
  const past = v.warmPaths.filter((w) => w.relation === 'past');
  if (!v.warmPaths.length) L.push('_None of your connections work (or are known to have worked) there._');
  if (cur.length) L.push('**Connections who work there now (not yet on the account):**', ...cur.slice(0, 40).map((w) => `- ${w.fullName} — ${w.title || w.detail} · id \`${w.id}\``));
  if (past.length) L.push('', '**Connections who used to work there:**', ...past.slice(0, 40).map((w) => `- ${w.fullName} — now ${w.title}; was ${w.detail} · id \`${w.id}\``));
  return L.join('\n');
}

// ---------- v9 Phase 6: the marketing org map as markdown (network_get_org_map, and a short section in accountMarkdown) ----------

const day = (iso: string) => (iso || '').slice(0, 10);
const conf = (c: number | null | undefined) => (c === null || c === undefined || !Number.isFinite(c) ? '' : String(Math.round(c * 100) / 100));

/** anything worth a "Marketing org" section: people in scope or a LinkedIn / web count */
export function hasOrgData(o: OrgMap): boolean {
  const h = o.headcount;
  return Boolean(o.members.length || o.flagged.length || h.linkedin.marketing || h.linkedin.company || h.linkedin.queries.length || h.web.length || o.facts.length);
}

/** the reporting-line tag on a tree edge: `[confirmed]` (set or accepted by the user), `[inferred 0.6]`, `[web 0.9]` */
export function edgeTag(e: OrgNode['edge']): string {
  if (!e) return '';
  if (e.source === 'user' || !e.source) return '[confirmed]';
  const c = conf(e.confidence);
  return `[${e.source}${c ? ` ${c}` : ''}]`;
}

function totalLine(t: HeadcountTotal): string {
  const pages = t.pages.length > 1 ? ` (sum of ${t.pages.length} company pages)` : '';
  return `${t.count.toLocaleString('en-US')}${pages} · ${day(t.takenAt)}`;
}
function snapLine(h: HeadcountSnapshot): string {
  const src = h.evidenceUrl || h.url;
  const bits = [day(h.takenAt), src, h.confidence !== null ? `confidence ${conf(h.confidence)}` : ''].filter(Boolean);
  return `${h.count.toLocaleString('en-US')} · ${bits.join(' · ')}`;
}

function memberTags(m: AccountMember): string[] {
  const t: string[] = [SUBFUNCTION_LABELS[m.subfunction]];
  if (m.seniority !== 'unknown') t.push(m.seniority);
  if (m.entity || m.country) t.push([m.entity, m.country].filter(Boolean).join(' · '));
  if (m.team) t.push(`team: ${m.team}`);
  if (m.vendorFunded) t.push('vendor-funded');
  if (m.role) t.push(ROLE_LABELS[m.role]);
  if (m.isConnection) t.push('your connection');
  if (m.kind === 'light') t.push('light (no full profile)');
  return t;
}

function treeLines(n: OrgNode, byId: Map<string, AccountMember>, depth: number, maxDepth: number, full: boolean, out: string[]): void {
  const m = byId.get(n.id);
  const name = m ? m.fullName : n.id;
  const pad = '  '.repeat(depth);
  const parts = [`${pad}- **${name}**${m?.title ? ` — ${m.title}` : ''}`];
  if (n.context) parts.push('(context: outside the marketing org)');
  else if (m) parts.push(`· ${memberTags(m).join(' · ')}`);
  const tag = edgeTag(n.edge);
  if (tag) parts.push(tag);
  if (full && n.edge?.reason && n.edge.source !== 'user') parts.push(`— ${oneLine(n.edge.reason, 200)}`);
  if (full) parts.push(`· id \`${n.id}\``);
  out.push(parts.join(' '));
  if (depth + 1 >= maxDepth) {
    const below = countBelow(n);
    if (below) out.push(`${pad}  - _… ${below} more below (network_get_org_map)_`);
    return;
  }
  for (const c of n.children) treeLines(c, byId, depth + 1, maxDepth, full, out);
}
const countBelow = (n: OrgNode): number => n.children.reduce((s, c) => s + 1 + countBelow(c), 0);

/** the short "## Marketing org" section of `accountMarkdown`: counts, the top two levels, a pointer to the full map */
function orgSummarySection(v: AccountView, o: OrgMap): string[] {
  const byId = new Map(v.members.map((m) => [m.id, m]));
  const h = o.headcount;
  const L = ['## Marketing org', ''];
  const bits = [`${h.captured.total} in the org on this account`];
  if (h.linkedin.marketing) bits.push(`LinkedIn "What they do → Marketing": ${h.linkedin.marketing.count}`);
  if (h.coverage !== undefined) bits.push(`coverage ${Math.round(h.coverage * 100)}%${h.coverageOver ? '+' : ''}`);
  if (o.flagged.length) bits.push(`${o.flagged.length} flagged (not counted)`);
  const unplaced = o.unplaced.reduce((n, g) => n + g.ids.length, 0);
  if (unplaced) bits.push(`${unplaced} with no known manager`);
  L.push(bits.join(' · '));
  if (o.roots.length) {
    L.push('', '**Reporting lines (top two levels):**');
    for (const r of o.roots) treeLines(r, byId, 0, 2, false, L);
  }
  L.push('', '_Full tree, sub-functions, headcounts and evidence: network_get_org_map._');
  return L;
}

/**
 * The marketing org map as one markdown document: headcounts (captured vs LinkedIn), sub-function × seniority, the
 * reporting tree with provenance tags, people with no known manager, flagged people, entities, web facts with
 * evidence. `summary` drops edge reasons, ids, quotes, responsibilities and list runs, puts the short sections first,
 * shows the tree to 3 levels and at most 10 people per "no known manager" group (20 flagged), each with "N more".
 */
export function orgMapMarkdown(v: AccountView, o: OrgMap, detail: BriefDetail = 'full'): string {
  const full = detail === 'full';
  const byId = new Map(v.members.map((m) => [m.id, m]));
  const name = (id: string) => byId.get(id)?.fullName ?? id;
  const h = o.headcount;
  const c = h.captured;
  const L: string[] = [`# Marketing org: ${v.account.name}`, ''];
  if (!hasOrgData(o)) {
    L.push(
      '_No marketing org mapped yet._ The user loads it in the explorer: capture the headcount and walk a LinkedIn search with the ' +
        'Chrome extension, then "Classify" and "Research on the web" in the Marketing org view. People can also be added here with ' +
        'network_account_add_people (`contacts`).',
    );
    return L.join('\n');
  }

  L.push('## Headcount', '', '| Measure | Count | Source |', '|---|---|---|');
  L.push(`| In the org (captured here) | ${c.total} | ${c.full} full profiles · ${c.light} light · ${c.connections} connections${c.vendorFunded ? ` · ${c.vendorFunded} vendor-funded` : ''} |`);
  if (h.linkedin.marketing) L.push(`| LinkedIn "What they do → ${h.linkedin.marketing.label}" | ${totalLine(h.linkedin.marketing)} | company People tab |`);
  if (h.linkedin.company) L.push(`| LinkedIn associated members (whole company) | ${totalLine(h.linkedin.company)} | company People tab |`);
  if (h.coverage !== undefined) L.push(`| Coverage | ${Math.round(h.coverage * 100)}%${h.coverageOver ? '+' : ''} | captured ÷ ${h.coverageBasis === 'function' ? 'LinkedIn Marketing function count' : 'a marketing search count'} |`);
  for (const q of h.linkedin.queries) L.push(`| LinkedIn ${q.source === 'linkedin-search' ? 'search' : 'list'} "${q.label}" (counts a query, not the org) | ${snapLine(q)} | ${q.source} |`);
  if (h.anonymous) L.push(`| "LinkedIn Member" rows (outside your network, not named) | ${h.anonymous} | list walks |`);
  if (o.flagged.length) L.push(`| Flagged, not counted | ${o.flagged.length} | classifier / user |`);
  for (const w of h.web) L.push(`| Web: ${w.scope} "${w.label}" | ${snapLine(w)} | web research |`);
  if (full && h.linkedin.functions.length > 1) {
    L.push('', `Other LinkedIn functions: ${h.linkedin.functions.filter((f) => f !== h.linkedin.marketing).map((f) => `${f.label} ${f.count}`).join(' · ')}`);
  }

  const orgMembers = o.members.map((id) => byId.get(id)).filter((m): m is AccountMember => Boolean(m));
  const subs = SUBFUNCTIONS.filter((s) => c.bySubfunction[s]);
  const sens = SENIORITIES.filter((s) => c.bySeniority[s]);
  if (subs.length) {
    L.push('', '## Sub-function × seniority', '', `| Sub-function | ${sens.join(' | ')} | Total |`, `|---|${sens.map(() => '---|').join('')}---|`);
    for (const sf of subs) {
      const row = sens.map((sn) => orgMembers.filter((m) => m.subfunction === sf && m.seniority === sn).length || '');
      L.push(`| ${SUBFUNCTION_LABELS[sf]} | ${row.join(' | ')} | ${c.bySubfunction[sf]} |`);
    }
  }

  // summary keeps big orgs readable: short sections first, the tree to 3 levels, at most 10 per "no manager" group
  const PER_GROUP = full ? Infinity : 10;
  const more = (n: number, what: string) => `- _… ${n} more ${what} (detail "full" or network_get_contact)_`;
  const tree = () => {
    L.push('', '## Reporting tree', '', '_Tags: [confirmed] = set or accepted by the user; [inferred 0.6] = suggested by AI / rules; [web 0.9] = from web research (number = confidence 0–1)._', '');
    if (!o.roots.length) L.push('_No reporting lines known yet._');
    for (const r of o.roots) treeLines(r, byId, 0, full ? 50 : 3, full, L);
  };
  const unplacedSection = () => {
    if (!o.unplaced.length) return;
    L.push('', '## No known manager');
    for (const g of o.unplaced) {
      L.push('', `**${SUBFUNCTION_LABELS[g.subfunction]}${g.entity ? ` · ${g.entity}` : ''}** (${g.ids.length})`);
      for (const id of g.ids.slice(0, PER_GROUP)) {
        const m = byId.get(id);
        if (!m) continue;
        const pm = m.inference?.possibleManager;
        L.push(`- ${m.fullName}${m.title ? ` — ${m.title}` : ''}${m.seniority !== 'unknown' ? ` · ${m.seniority}` : ''}${full && pm ? ` · possible manager ${name(pm.id)} (${conf(pm.confidence)})` : ''}${full ? ` · id \`${id}\`` : ''}`);
      }
      if (g.ids.length > PER_GROUP) L.push(more(g.ids.length - PER_GROUP, 'in this group'));
    }
  };
  const responsibilities = () => {
    const resp = orgMembers.filter((m) => m.responsibilities.trim());
    if (resp.length) L.push('', '## Responsibilities', '', ...resp.map((m) => `- **${m.fullName}:** ${oneLine(m.responsibilities, 400)}`));
  };
  const flagged = () => {
    if (!o.flagged.length) return;
    L.push('', '## Flagged (in scope, not counted)', '');
    const lim = full ? Infinity : 20;
    for (const f of o.flagged.slice(0, lim)) {
      const m = byId.get(f.id);
      L.push(`- ${name(f.id)}${m?.title ? ` — ${m.title}` : ''} · ${f.noise}${m && !m.autoNoise ? ' (set by the user)' : ''}${full ? ` · id \`${f.id}\`` : ''}`);
    }
    if (o.flagged.length > lim) L.push(more(o.flagged.length - lim, 'flagged'));
  };
  const entities = () => {
    if (o.entities.length) L.push('', '## Entities', '', ...o.entities.map((e) => `- ${[e.entity || '(entity unknown)', e.country].filter(Boolean).join(' · ')}: ${e.n}`));
  };
  const facts = () => {
    if (!o.facts.length) return;
    L.push('', '## Structure facts (web research)', '');
    for (const f of o.facts) {
      const q = full && f.quote ? ` — “${oneLine(f.quote, 300)}”` : '';
      L.push(`- [${f.kind}${f.confidence !== null ? ` ${conf(f.confidence)}` : ''}] ${oneLine(f.text, 400)} (${f.evidenceUrl})${q}`);
    }
  };
  const runs = () => {
    if (!o.runs.length) return;
    L.push('', '## LinkedIn list walks (newest first)', '');
    for (const r of o.runs) L.push(`- ${day(r.startedAt)} ${r.pageKind}${r.keywords ? ` "${r.keywords}"` : ''}: ${r.rowsSeen} rows (${r.named} named, ${r.anonymous} anonymous)${r.stopReason ? ` · ${r.stopReason}` : ''}`);
  };
  if (full) {
    tree();
    unplacedSection();
    responsibilities();
    flagged();
    entities();
    facts();
    runs();
  } else {
    flagged();
    entities();
    facts();
    tree();
    unplacedSection();
  }
  return L.join('\n');
}
