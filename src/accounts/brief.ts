import {
  DEPARTMENT_LABELS,
  ROLE_LABELS,
  TIER_LABELS,
  type AccountMember,
  type AccountView,
  type CapturedProfile,
  type Department,
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

  L.push('## Your warm paths in', '');
  const cur = v.warmPaths.filter((w) => w.relation === 'current');
  const past = v.warmPaths.filter((w) => w.relation === 'past');
  if (!v.warmPaths.length) L.push('_None of your connections work (or are known to have worked) there._');
  if (cur.length) L.push('**Connections who work there now (not yet on the account):**', ...cur.slice(0, 40).map((w) => `- ${w.fullName} — ${w.title || w.detail} · id \`${w.id}\``));
  if (past.length) L.push('', '**Connections who used to work there:**', ...past.slice(0, 40).map((w) => `- ${w.fullName} — now ${w.title}; was ${w.detail} · id \`${w.id}\``));
  return L.join('\n');
}
