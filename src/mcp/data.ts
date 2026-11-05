import type { ExplorerPerson, Lens } from '../types';

/**
 * Pure helpers over explorer data for the MCP server: lens membership (same rules as the explorer page), search,
 * filters and compact/detailed formatting. No I/O here.
 */

export type LensView = 'in' | 'candidates' | 'removed' | 'all';
export type CrmFilter = 'in_crm' | 'new' | 'ambiguous' | 'error' | 'unchecked' | 'sent';

// ---------------------------------------------------------------- lens membership (mirrors explorer.html)
export const thresholdOf = (l: Lens): number => (Number.isFinite(Number(l.threshold)) ? Number(l.threshold) : 70);
export function pinOf(l: Lens, id: string): 'in' | 'out' | '' {
  if ((l.pinnedIn ?? []).includes(id)) return 'in';
  if ((l.pinnedOut ?? []).includes(id)) return 'out';
  return '';
}
export function scoreIn(p: ExplorerPerson, l: Lens): number | undefined {
  const s = p.scores?.[l.id];
  return s ? Number(s.score) : undefined;
}
export const byScore = (l: Lens, p: ExplorerPerson): boolean => (scoreIn(p, l) ?? -1) >= thresholdOf(l);
/** in = pinned in, or (score ≥ threshold and not pinned out) */
export function isMember(l: Lens, p: ExplorerPerson): boolean {
  const pin = pinOf(l, p.id);
  return pin === 'in' ? true : pin === 'out' ? false : byScore(l, p);
}
export function lensBucket(l: Lens, p: ExplorerPerson): 'in' | 'candidates' | 'removed' {
  if (isMember(l, p)) return 'in';
  return pinOf(l, p.id) === 'out' ? 'removed' : 'candidates';
}
export function inView(l: Lens, p: ExplorerPerson, view: LensView): boolean {
  const b = lensBucket(l, p);
  // removed people only show under "removed" (the user's explicit choice), never under "all"
  return view === 'all' ? b !== 'removed' : b === view;
}

/**
 * Minimal pins (same as the explorer): add → pin "in" only where the score alone wouldn't include them, else clear;
 * remove → always pin "out" (members leave; candidates are dismissed and stay out after re-scores).
 */
export function pinsFor(l: Lens, people: ExplorerPerson[], wantIn: boolean): { in: string[]; out: string[]; clear: string[]; unchanged: string[] } {
  const r = { in: [] as string[], out: [] as string[], clear: [] as string[], unchanged: [] as string[] };
  for (const p of people) {
    const want: 'in' | 'out' | '' = wantIn ? (byScore(l, p) ? '' : 'in') : 'out';
    if (pinOf(l, p.id) === want) r.unchanged.push(p.id);
    else if (want === 'in') r.in.push(p.id);
    else if (want === 'out') r.out.push(p.id);
    else r.clear.push(p.id);
  }
  return r;
}

/** lens by exact id, exact goal (case-insensitive), or a unique goal substring */
export function resolveLens(lenses: Lens[], ref: string): { lens?: Lens; error?: string } {
  const q = ref.trim().toLowerCase();
  if (!q) return { error: 'Empty lens reference. Use network_list_lenses to see lenses.' };
  const exact = lenses.find((l) => l.id === ref.trim()) ?? lenses.find((l) => l.goal.trim().toLowerCase() === q);
  if (exact) return { lens: exact };
  const partial = lenses.filter((l) => l.goal.toLowerCase().includes(q) || l.id.includes(q));
  if (partial.length === 1) return { lens: partial[0] };
  if (partial.length > 1) {
    return { error: `"${ref}" matches ${partial.length} lenses: ${partial.map((l) => `"${l.goal}" (${l.id})`).join(', ')}. Pass the lens id.` };
  }
  return { error: `No lens "${ref}". Use network_list_lenses to see lenses (lenses are created in the explorer UI).` };
}

// ---------------------------------------------------------------- search
const dos = (p: ExplorerPerson) => (p.dossier?.status === 'ok' && p.dossier.dossier ? p.dossier.dossier : null);
export const companyOf = (p: ExplorerPerson): string => p.profile?.company || p.company || dos(p)?.currentCompany || '';
export const locationOf = (p: ExplorerPerson): string => dos(p)?.location || p.profile?.region || '';
export const depthOf = (p: ExplorerPerson): 'none' | 'light' | 'deep' => (dos(p) ? (p.dossier!.depth === 'deep' ? 'deep' : 'light') : 'none');
export function pastCompanies(p: ExplorerPerson): string {
  const d = dos(p);
  return d ? (d.career ?? []).map((c) => `${c.company} ${c.role}`).join(' \u0001 ') : '';
}

/** everything free-text search looks at (lowercased) */
export function haystack(p: ExplorerPerson): string {
  const d = dos(p);
  const pr = p.profile;
  const parts: string[] = [p.fullName, p.title, p.company, p.email];
  if (pr) parts.push(pr.company, pr.role, pr.seniority, pr.function, pr.industry, (pr.tags ?? []).join(' '), pr.region);
  if (d) {
    parts.push(d.oneLiner, d.currentRole, d.currentCompany, d.location, d.investingSummary);
    for (const c of d.career ?? []) parts.push(c.role, c.company);
    parts.push(...(d.investments ?? []), ...(d.boards ?? []), ...(d.expertise ?? []), ...(d.notable ?? []), ...(d.education ?? []));
    parts.push(...(d.recentThemes ?? []));
    for (const r of d.recentActivity ?? []) parts.push(r.title, r.summary);
  }
  return parts.filter(Boolean).join(' \u0001 ').toLowerCase();
}

/** terms are ANDed; "quoted phrases" stay together (same as the explorer search box) */
export function parseQuery(q: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  const s = (q || '').toLowerCase();
  while ((m = re.exec(s))) {
    const t = (m[1] !== undefined ? m[1] : m[2] ?? '').trim();
    if (t) out.push(t);
  }
  return out;
}

export interface SearchFilters {
  query?: string;
  seniority?: string[];
  function?: string[];
  tags?: string[];
  company?: string;
  past_company?: string;
  location?: string;
  industry?: string;
  has_web_profile?: 'any' | 'none' | 'light' | 'deep' | 'some';
  lens?: Lens;
  min_score?: number;
  lens_view?: LensView;
  crm_status?: CrmFilter;
}

export function matches(p: ExplorerPerson, f: SearchFilters, terms = parseQuery(f.query ?? '')): boolean {
  if (terms.length) {
    const hay = haystack(p);
    for (const t of terms) if (!hay.includes(t)) return false;
  }
  const lc = (s: string | undefined) => (s ?? '').toLowerCase();
  if (f.seniority?.length && !f.seniority.map(lc).includes(lc(p.profile?.seniority))) return false;
  if (f.function?.length && !f.function.map(lc).includes(lc(p.profile?.function))) return false;
  if (f.tags?.length) {
    const tags = (p.profile?.tags ?? []).map(lc);
    if (!f.tags.map(lc).some((t) => tags.includes(t))) return false;
  }
  if (f.company && !lc(companyOf(p)).includes(lc(f.company))) return false;
  if (f.past_company && !lc(pastCompanies(p)).includes(lc(f.past_company))) return false;
  if (f.location && !lc(locationOf(p)).includes(lc(f.location))) return false;
  if (f.industry && !lc(p.profile?.industry).includes(lc(f.industry))) return false;
  const dp = depthOf(p);
  if (f.has_web_profile === 'none' && dp !== 'none') return false;
  if (f.has_web_profile === 'some' && dp === 'none') return false;
  if ((f.has_web_profile === 'light' || f.has_web_profile === 'deep') && dp !== f.has_web_profile) return false;
  if (f.lens) {
    if (!inView(f.lens, p, f.lens_view ?? 'all')) return false;
    if (f.min_score !== undefined && (scoreIn(p, f.lens) ?? -1) < f.min_score) return false;
  }
  if (f.crm_status) {
    const c = p.crm;
    if (f.crm_status === 'unchecked' ? Boolean(c) : f.crm_status === 'sent' ? !c?.sent : c?.status !== f.crm_status) return false;
  }
  return true;
}

export type SortKey = 'score' | 'name' | 'connected';
export function sortPeople(rows: ExplorerPerson[], sort: SortKey, lens?: Lens): ExplorerPerson[] {
  const byName = (a: ExplorerPerson, b: ExplorerPerson) => (a.fullName || '').localeCompare(b.fullName || '');
  if (sort === 'score' && lens) {
    return [...rows].sort((a, b) => (scoreIn(b, lens) ?? -1) - (scoreIn(a, lens) ?? -1) || byName(a, b));
  }
  if (sort === 'connected') return [...rows].sort((a, b) => (b.connectedOn || '').localeCompare(a.connectedOn || '') || byName(a, b));
  return [...rows].sort(byName);
}

// ---------------------------------------------------------------- formatting
export function personSummary(p: ExplorerPerson, lens?: Lens): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: p.id,
    name: p.fullName,
    title: p.title,
    company: companyOf(p),
    seniority: p.profile?.seniority ?? '',
    function: p.profile?.function ?? '',
    location: locationOf(p),
    linkedin: p.url,
    web_profile: depthOf(p),
  };
  if (p.email) out.email = p.email;
  if (lens) {
    const s = p.scores?.[lens.id];
    out.lens = { score: s?.score ?? null, reason: s?.reason ?? '', in_lens: isMember(lens, p), pin: pinOf(lens, p.id) || null };
  }
  if (p.crm) out.crm = { status: p.crm.status, sent: Boolean(p.crm.sent) };
  return out;
}

export function personLine(p: ExplorerPerson, lens?: Lens): string {
  const bits = [`**${p.fullName || '(no name)'}**`];
  const co = companyOf(p);
  bits.push(`— ${p.title || '(no title)'}${co && !(p.title || '').toLowerCase().includes(co.toLowerCase()) ? ` @ ${co}` : ''}`);
  const loc = locationOf(p);
  if (loc) bits.push(`· ${loc}`);
  if (lens) {
    const s = p.scores?.[lens.id];
    const pin = pinOf(lens, p.id);
    bits.push(`· score ${s ? s.score : '–'}${isMember(lens, p) ? ' (in lens' + (pin === 'in' ? ', added by hand' : '') + ')' : pin === 'out' ? ' (removed)' : ''}`);
    if (s?.reason) bits.push(`— ${s.reason.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  const dp = depthOf(p);
  if (dp !== 'none') bits.push(`· ${dp} web profile`);
  if (p.crm) bits.push(`· Ahoy: ${p.crm.sent ? 'sent' : p.crm.status}`);
  bits.push(`\`${p.id}\``);
  return `- ${bits.join(' ')}`;
}

export function personDetail(p: ExplorerPerson, lenses: Lens[]): Record<string, unknown> {
  const d = dos(p);
  return {
    id: p.id,
    name: p.fullName,
    first_name: p.firstName,
    last_name: p.lastName,
    title: p.title,
    company: companyOf(p),
    linkedin: p.url,
    email: p.email || null,
    connected_on: p.connectedOn || null,
    profile: p.profile ?? null,
    web_profile: d
      ? {
          depth: p.dossier!.depth,
          created_at: p.dossier!.createdAt,
          identity_confirmed: d.identityConfirmed,
          confidence: d.confidence,
          one_liner: d.oneLiner,
          current_role: d.currentRole,
          current_company: d.currentCompany,
          location: d.location,
          career: d.career,
          education: d.education,
          investing_summary: d.investingSummary,
          investments: d.investments,
          boards: d.boards,
          expertise: d.expertise,
          notable: d.notable,
          public_presence: d.publicPresence,
          recent_activity: d.recentActivity ?? [],
          recent_themes: d.recentThemes ?? [],
          sources: d.sources,
        }
      : null,
    lenses: lenses.map((l) => {
      const s = p.scores?.[l.id];
      return {
        lens_id: l.id,
        goal: l.goal,
        score: s?.score ?? null,
        reason: s?.reason ?? null,
        basis: s?.basis ?? null,
        stale: s?.stale ?? null,
        in_lens: isMember(l, p),
        pin: pinOf(l, p.id) || null,
      };
    }),
    crm: p.crm ?? null,
  };
}

export function personMarkdown(p: ExplorerPerson, lenses: Lens[]): string {
  const d = dos(p);
  const L: string[] = [`## ${p.fullName}`, '', `${p.title || ''}`, ''];
  const facts: [string, string][] = [
    ['Id', `\`${p.id}\``],
    ['Company', companyOf(p)],
    ['Role', p.profile?.role ?? ''],
    ['Seniority / function', [p.profile?.seniority, p.profile?.function].filter(Boolean).join(' · ')],
    ['Industry', p.profile?.industry ?? ''],
    ['Tags', (p.profile?.tags ?? []).join(', ')],
    ['Location', locationOf(p)],
    ['LinkedIn', p.url],
    ['Email', p.email],
    ['Connected', p.connectedOn],
  ];
  for (const [k, v] of facts) if (v) L.push(`- **${k}:** ${v}`);
  if (d) {
    L.push('', `### Web profile (${p.dossier!.depth}, ${d.identityConfirmed ? 'identity confirmed' : 'identity NOT confirmed'}, ${d.confidence} confidence)`, '', d.oneLiner);
    if (d.career?.length) L.push('', '**Career**', ...d.career.map((c) => `- ${c.role}${c.company ? `, ${c.company}` : ''}${c.period ? ` (${c.period})` : ''}`));
    if (d.investingSummary) L.push('', `**Investing:** ${d.investingSummary}`);
    if (d.investments?.length) L.push(`**Investments:** ${d.investments.join('; ')}`);
    if (d.boards?.length) L.push(`**Boards:** ${d.boards.join('; ')}`);
    if (d.expertise?.length) L.push(`**Expertise:** ${d.expertise.join('; ')}`);
    if (d.notable?.length) L.push(`**Notable:** ${d.notable.join('; ')}`);
    if (d.recentThemes?.length) L.push('', `**Talking about lately:** ${d.recentThemes.join('; ')}`);
    if (d.recentActivity?.length) {
      L.push('', '**Recent activity**', ...d.recentActivity.map((r) => `- ${[r.date, r.kind].filter(Boolean).join(' ')}: ${r.title}${r.summary ? ` — ${r.summary}` : ''}${r.url ? ` (${r.url})` : ''}`));
    }
    if (d.sources?.length) L.push('', '**Sources:** ' + d.sources.map((s) => s.url).filter(Boolean).join(' · '));
  } else {
    L.push('', '_No web profile yet (start one from the explorer UI if this person matters)._');
  }
  if (lenses.length) {
    L.push('', '### Lenses');
    for (const l of lenses) {
      const s = p.scores?.[l.id];
      const pin = pinOf(l, p.id);
      L.push(`- **${l.goal}** (\`${l.id}\`): ${s ? `${s.score}/100` : 'not scored'}${isMember(l, p) ? ' · IN lens' : pin === 'out' ? ' · removed by hand' : ' · not in lens'}${pin === 'in' ? ' (added by hand)' : ''}${s?.stale ? ' · stale' : ''}${s?.reason ? ` — ${s.reason}` : ''}`);
    }
  }
  if (p.crm) {
    const c = p.crm;
    L.push('', '### Ahoy CRM', `- **Status:** ${c.status}${c.contactName ? ` (${c.contactName})` : ''}`);
    if (c.companyName) L.push(`- **Company:** ${c.companyName} · ${c.companyStatus}${c.companyDomain ? ` · ${c.companyDomain}` : ''}`);
    if (c.sent) L.push(`- **Sent:** ${c.sent.at} — ${c.sent.url || c.sent.proposalId}`);
    if (c.reason) L.push(`- ${c.reason}`);
  }
  return L.join('\n');
}

/** cap text tool output (keeps the response inside the client's budget) */
export const CHARACTER_LIMIT = 25_000;
export function cap(text: string, hint = 'Narrow the search or use offset/limit to page.'): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return `${text.slice(0, CHARACTER_LIMIT)}\n\n… [truncated at ${CHARACTER_LIMIT.toLocaleString()} characters — ${hint}]`;
}
