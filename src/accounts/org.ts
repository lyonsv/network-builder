/**
 * The marketing org map of one account (v9 Phase 5): who is in the org, the reporting tree, people with no known
 * manager, flagged noise, headcounts (captured vs what LinkedIn reports), entities, facts and recent list runs.
 *
 * `buildOrgMap` is pure: it reads only the AccountView and the data passed in (`OrgMapSources`, loaded from the repo by
 * `orgMapSources`). The explorer page renders straight from it (no client-side tree building) and the MCP server
 * (Phase 6) reuses it. No AI, no network.
 */
import type { AccountsRepo } from '../db/accounts';
import { listFilters } from './list-capture';
import {
  SENIORITIES,
  SUBFUNCTIONS,
  type AccountMember,
  type AccountView,
  type HeadcountSnapshot,
  type HeadcountTotal,
  type ListRun,
  type OrgFact,
  type OrgMap,
  type OrgNode,
  type OrgNoise,
  type Seniority,
  type Subfunction,
} from './types';

export interface OrgMapSources {
  headcounts: HeadcountSnapshot[];
  /** newest first (as `AccountsRepo.listRuns`) */
  runs: ListRun[];
  facts: OrgFact[];
}

export function orgMapSources(repo: AccountsRepo, accountId: string): OrgMapSources {
  return { headcounts: repo.headcounts(accountId), runs: repo.listRuns(accountId), facts: repo.orgFacts(accountId) };
}

/** list-run keywords / filters that aim at marketing people (EN + DE) */
// `brand` only as a word / marketing compound (not "Brandschutz", "Brandenburg")
const MARKETING_QUERY =
  /market|kommunikation|communicat|\bcomms\b|\bpr\b|presse|\bbrand(?:s|ing)?\b|\bbrand[\s-]?(?:manag|market|strateg|design|kommunikation)|\bmarken?\b|\bmarkenf|werbung|advertis|campaign|kampagne/i;
/** LinkedIn's "What they do" function id for Marketing (People tab `facetCurrentFunction=15`, search `functionFacet`) */
const MARKETING_FUNCTION_ID = '15';
const FUNCTION_PARAMS = new Set(['facetCurrentFunction', 'functionFacet']);

/** a run whose keywords / filters target marketing: everyone it listed is in scope (the classifier may still flag them) */
export function isMarketingRun(run: Pick<ListRun, 'keywords' | 'url'>): boolean {
  if (MARKETING_QUERY.test(run.keywords || '')) return true;
  return listFilters(run.url).some(([k, v]) =>
    FUNCTION_PARAMS.has(k) ? (v.match(/\d+/g) ?? ([] as string[])).includes(MARKETING_FUNCTION_ID) : MARKETING_QUERY.test(v));
}

/** same list = same page kind, path and result-set filters (paging and UI flags ignored) */
export function runListKey(run: Pick<ListRun, 'pageKind' | 'url'>): string {
  let path = run.url;
  try {
    const u = new URL(run.url);
    path = `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    /* keep the raw string */
  }
  const f = listFilters(run.url).map(([k, v]) => `${k}=${v.toLowerCase()}`).sort().join('&');
  return `${run.pageKind}|${path}|${f}`;
}

/** the LinkedIn page a snapshot was read from: `company/<slug>` for company pages (any tab / filters), else host + path */
export function snapshotPage(url: string): string {
  try {
    const u = new URL(url);
    const co = /^\/company\/([^/?#]+)/i.exec(u.pathname);
    if (co) return `company/${decodeURIComponent(co[1]!).toLowerCase()}`;
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** the latest snapshot of each distinct page for one label, summed (several entity pages add up; re-reads of a page don't) */
function sumLatestPerPage(rows: HeadcountSnapshot[], label: string): HeadcountTotal | undefined {
  const per = latestBy(rows, (h) => snapshotPage(h.url));
  if (!per.length) return undefined;
  const newest = [...per].sort(byLatest)[0]!;
  return { label, count: per.reduce((n, h) => n + h.count, 0), takenAt: newest.takenAt, pages: per };
}

const senRank = (s: Seniority) => SENIORITIES.indexOf(s);
const byLatest = (a: HeadcountSnapshot, b: HeadcountSnapshot) => (a.takenAt === b.takenAt ? b.id - a.id : a.takenAt < b.takenAt ? 1 : -1);
/** latest snapshot per key; result sorted by count (desc) */
function latestBy(rows: HeadcountSnapshot[], key: (h: HeadcountSnapshot) => string): HeadcountSnapshot[] {
  const out = new Map<string, HeadcountSnapshot>();
  for (const h of [...rows].sort(byLatest)) if (!out.has(key(h))) out.set(key(h), h);
  return [...out.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** in the marketing scope at all (flagged or not)? */
function inScope(m: AccountMember, marketingRuns: Set<string>): boolean {
  // a department the user set by hand wins
  if (!m.autoDepartment) return m.department === 'marketing';
  if (m.department === 'marketing') return true;
  return m.sources.some((s) => s.kind === 'web' || (s.kind === 'extension-list' && Boolean(s.runId) && marketingRuns.has(s.runId!)));
}

export function buildOrgMap(view: AccountView, src: OrgMapSources): OrgMap {
  const byId = new Map(view.members.map((m) => [m.id, m]));
  const marketingRuns = new Set(src.runs.filter(isMarketingRun).map((r) => r.id));
  const scoped = view.members.filter((m) => inScope(m, marketingRuns));
  const flagged = scoped.filter((m) => m.noise).map((m) => ({ id: m.id, noise: m.noise as OrgNoise }));
  const org = scoped.filter((m) => !m.noise);
  const inOrg = new Set(org.map((m) => m.id));

  const cmp = (a: string, b: string) => {
    const x = byId.get(a)!;
    const y = byId.get(b)!;
    return senRank(x.seniority) - senRank(y.seniority) || x.fullName.localeCompare(y.fullName);
  };

  // ---- reporting tree: org members hang under their manager; a manager outside the org is a context node
  const nodes = new Map<string, OrgNode>();
  const parent = new Map<string, string>();
  const node = (id: string): OrgNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, children: [], ...(inOrg.has(id) ? {} : { context: true }) };
      nodes.set(id, n);
    }
    return n;
  };
  const link = (id: string) => {
    // walk up from an org member; context managers continue the chain until someone with no (known) manager
    const seen = new Set<string>();
    let cur = id;
    while (!seen.has(cur)) {
      seen.add(cur);
      const m = byId.get(cur);
      const mgr = m?.reportsTo;
      if (!m || !mgr || !byId.has(mgr) || mgr === cur || parent.has(cur)) return;
      // never draw a loop (the repo refuses cycles; stay safe on odd data)
      let up: string | undefined = mgr;
      const chain = new Set<string>([cur]);
      while (up && !chain.has(up)) {
        chain.add(up);
        up = parent.get(up);
      }
      if (up) return;
      const child = node(cur);
      child.edge = { source: m.reportsToSource || 'user', confidence: m.reportsToConfidence, reason: m.reportsToReason };
      node(mgr).children.push(child);
      parent.set(cur, mgr);
      if (inOrg.has(mgr)) return;
      cur = mgr;
    }
  };
  for (const m of org) link(m.id);
  const sortTree = (n: OrgNode) => {
    n.children.sort((a, b) => cmp(a.id, b.id));
    n.children.forEach(sortTree);
  };
  const roots = [...nodes.values()].filter((n) => !parent.has(n.id) && n.children.length).sort((a, b) => cmp(a.id, b.id));
  roots.forEach(sortTree);

  // ---- unplaced: no manager in the tree and nobody reporting to them
  const groups = new Map<string, { subfunction: Subfunction; entity: string; ids: string[] }>();
  for (const m of org) {
    if (parent.has(m.id) || nodes.get(m.id)?.children.length) continue;
    const k = `${m.subfunction}\u0000${m.entity}`;
    const g = groups.get(k) ?? { subfunction: m.subfunction, entity: m.entity, ids: [] };
    g.ids.push(m.id);
    groups.set(k, g);
  }
  const unplaced = [...groups.values()]
    .map((g) => ({ ...g, ids: g.ids.sort(cmp) }))
    .sort((a, b) => SUBFUNCTIONS.indexOf(a.subfunction) - SUBFUNCTIONS.indexOf(b.subfunction) || (!a.entity ? 1 : 0) - (!b.entity ? 1 : 0) || a.entity.localeCompare(b.entity));

  // ---- headcount
  const bySubfunction = Object.fromEntries(SUBFUNCTIONS.map((s) => [s, 0])) as Record<Subfunction, number>;
  const bySeniority = Object.fromEntries(SENIORITIES.map((s) => [s, 0])) as Record<Seniority, number>;
  for (const m of org) {
    bySubfunction[m.subfunction]++;
    bySeniority[m.seniority]++;
  }
  const li = src.headcounts.filter((h) => h.source === 'linkedin-people' || h.source === 'linkedin-search');
  // company / function counts: latest per (page, label), summed over distinct pages (entity A + entity B)
  const company = sumLatestPerPage(li.filter((h) => h.scope === 'company'), '');
  // function counts only from an UNFILTERED People tab (older rows read off a keyword-filtered tab are ignored)
  const fnRows = li.filter((h) => h.scope === 'function' && !listFilters(h.url).length);
  const fnLabels = new Map<string, string>();
  for (const h of [...fnRows].sort(byLatest)) if (!fnLabels.has(h.label.trim().toLowerCase())) fnLabels.set(h.label.trim().toLowerCase(), h.label.trim());
  const functions = [...fnLabels]
    .map(([k, label]) => sumLatestPerPage(fnRows.filter((h) => h.label.trim().toLowerCase() === k), label)!)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const queries = latestBy(li.filter((h) => h.scope === 'query'), (h) => `${h.source}|${snapshotPage(h.url)}|${h.label.toLowerCase()}`);
  const marketing = functions.find((h) => /^marketing$/i.test(h.label)) ?? functions.find((h) => /marketing/i.test(h.label));
  const web = latestBy(src.headcounts.filter((h) => h.source === 'web'), (h) => `${h.scope}|${h.label.toLowerCase()}`);
  // anonymous: the latest run of each distinct list (re-running the same list never adds up)
  const latestRun = new Map<string, ListRun>();
  // walks only: counts-only captures and runs that read nothing never replace a list's last real walk
  const walks = src.runs.filter((r) => r.stopReason !== 'counts-only');
  // an `abandoned` run (its tab reloaded mid-walk) is partial: used for a list only when it has no other walk
  const newestFirst = (a: ListRun, b: ListRun) => (a.startedAt === b.startedAt ? 0 : a.startedAt < b.startedAt ? 1 : -1);
  const read = walks.filter((r) => r.rowsSeen > 0);
  for (const r of [...read.filter((r) => r.stopReason !== 'abandoned').sort(newestFirst), ...read.filter((r) => r.stopReason === 'abandoned').sort(newestFirst)]) {
    const k = runListKey(r);
    if (!latestRun.has(k)) latestRun.set(k, r);
  }
  const anonymous = [...latestRun.values()].reduce((n, r) => n + r.anonymous, 0);
  let coverage: number | undefined;
  let coverageBasis: 'function' | 'query' | undefined;
  const queryBase = [...queries].sort(byLatest).find((h) => MARKETING_QUERY.test(h.label));
  if (marketing && marketing.count > 0) {
    coverage = org.length / marketing.count;
    coverageBasis = 'function';
  } else if (queryBase && queryBase.count > 0) {
    coverage = org.length / queryBase.count;
    coverageBasis = 'query';
  }
  // more captured than LinkedIn reports (a count from another page / an older read): capped, and said so
  const coverageOver = coverage !== undefined && coverage > 1;
  if (coverageOver) coverage = 1;

  // ---- entities
  const ents = new Map<string, { entity: string; country: string; n: number }>();
  for (const m of org) {
    if (!m.entity && !m.country) continue;
    const k = `${m.entity}\u0000${m.country}`;
    const e = ents.get(k) ?? { entity: m.entity, country: m.country, n: 0 };
    e.n++;
    ents.set(k, e);
  }

  return {
    scope: 'marketing',
    members: org.map((m) => m.id).sort(cmp),
    flagged: flagged.sort((a, b) => cmp(a.id, b.id)),
    roots,
    unplaced,
    headcount: {
      captured: {
        total: org.length,
        named: org.filter((m) => m.fullName && m.fullName !== '(unknown)').length,
        light: org.filter((m) => m.kind === 'light').length,
        full: org.filter((m) => m.kind === 'full').length,
        connections: org.filter((m) => m.kind === 'connection').length,
        vendorFunded: org.filter((m) => m.vendorFunded).length,
        bySubfunction,
        bySeniority,
      },
      linkedin: { ...(company ? { company } : {}), ...(marketing ? { marketing } : {}), functions, queries },
      anonymous,
      web,
      ...(coverage !== undefined ? { coverage, coverageBasis, ...(coverageOver ? { coverageOver: true } : {}) } : {}),
    },
    entities: [...ents.values()].sort((a, b) => b.n - a.n || a.entity.localeCompare(b.entity)),
    facts: [...src.facts].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || a.kind.localeCompare(b.kind)),
    runs: walks.slice(0, 10),
  };
}
