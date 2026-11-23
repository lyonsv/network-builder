import type { AccountsRepo } from '../db/accounts';
import type { ExplorerPerson } from '../types';
import { classify, isOtherEmployer, noiseFromTitle, seniorityFromTitle, subfunctionFromTitle, vendorFundedFromTitle } from './classify';
import { mentionsCompany, normalizeCompany } from './capture';
import {
  COMMITTEE_ROLES,
  DEPARTMENTS,
  ROLE_LABELS,
  TIERS,
  type Account,
  type AccountMember,
  type AccountSummary,
  type AccountView,
  type CommitteeRole,
  type MemberInference,
  type NoiseFlag,
  type OrgNoise,
  type Subfunction,
  type WarmPath,
} from './types';

const dos = (p?: ExplorerPerson) => (p?.dossier && p.dossier.status === 'ok' && p.dossier.dossier ? p.dossier.dossier : null);
const companyOfPerson = (p: ExplorerPerson): string => p.profile?.company || p.company || dos(p)?.currentCompany || '';

export function accountNames(a: Account): string[] {
  return [a.name, ...a.aliases].map(normalizeCompany).filter(Boolean);
}

/** summaries for the account list (cheap: no profiles) */
export function accountSummaries(repo: AccountsRepo, connectionIds: Set<string>): AccountSummary[] {
  const byAccount = new Map<string, ReturnType<AccountsRepo['members']>>();
  for (const m of repo.allMembers()) {
    const arr = byAccount.get(m.accountId) ?? [];
    arr.push(m);
    byAccount.set(m.accountId, arr);
  }
  const contacts = repo.allContacts();
  const captured = new Set(contacts.filter((c) => c.kind === 'full').map((c) => c.id));
  const light = new Set(contacts.filter((c) => c.kind === 'light').map((c) => c.id));
  return repo.list().map((a) => {
    const ms = byAccount.get(a.id) ?? [];
    const roles: Partial<Record<CommitteeRole, number>> = {};
    for (const m of ms) if (m.role) roles[m.role] = (roles[m.role] ?? 0) + 1;
    return {
      id: a.id,
      name: a.name,
      status: a.status,
      domain: a.domain,
      memberIds: ms.map((m) => m.personId),
      memberCount: ms.length,
      captured: ms.filter((m) => captured.has(m.personId)).length,
      light: ms.filter((m) => light.has(m.personId)).length,
      connections: ms.filter((m) => connectionIds.has(m.personId)).length,
      roles,
      updatedAt: a.updatedAt,
    };
  });
}

const deptRank = (d: string) => DEPARTMENTS.indexOf(d as (typeof DEPARTMENTS)[number]);
const tierRank = (t: string) => TIERS.indexOf(t as (typeof TIERS)[number]);
export function sortMembers(ms: AccountMember[]): AccountMember[] {
  return [...ms].sort((a, b) => deptRank(a.department) - deptRank(b.department) || tierRank(a.tier) - tierRank(b.tier) || a.fullName.localeCompare(b.fullName));
}

/** LinkedIn company pages whose People tab was walked into this account (they count as the account / its entities) */
export function accountCompanyPages(repo: AccountsRepo, accountId: string): string[] {
  return [...new Set(repo.listRuns(accountId).filter((r) => r.pageKind === 'people-tab' && r.url).map((r) => r.url))];
}

export interface OrgPlacementInput {
  account: Pick<Account, 'name' | 'aliases' | 'domain' | 'linkedinUrl'>;
  /** entities the user set on this account's members (count as the account) */
  entities: string[];
  /** LinkedIn company pages already captured onto this account (list walks; count as the account) */
  companyPages?: string[];
  title: string;
  /** display company (may be guessed from a headline): used only for the vendor-funded title rule */
  company: string;
  /**
   * employer from a captured full profile's current experience ('' = not known). The only company the
   * `other-employer` rule looks at: never a company guessed from a headline, never an extension-list row.
   */
  employer?: string;
  /** /company/ URL of that current role, when the capture has one */
  companyUrl?: string;
  /** stored user overrides ('' = automatic) */
  noiseOverride: NoiseFlag | 'none' | '';
  subfunctionOverride: Subfunction | '';
  inference?: MemberInference;
}

/**
 * Resolved noise, vendor-funded tag and sub-function of one member (Phase 2b).
 * - Noise: user override ('none' → clean) → inference (even '' = clean) → rules (`isOtherEmployer` first, then
 *   `noiseFromTitle`). `vendor-funded` is never noise: a stored override or older inference holding it reads as the
 *   tag — unless the person's company is clearly another employer, then it reads as `other-employer` (the user's
 *   2026-11-23 rule: only people working for the account or its entities are in the org). A HAND-SET 'vendor-funded'
 *   always means noise '' + the tag (user intent wins). `other-employer` needs `employer` (a captured current role).
 * - Tag: override 'vendor-funded' → inference (`vendorFunded`, or legacy noise 'vendor-funded') → `vendorFundedFromTitle`;
 *   always false when the person ends up with any excluding noise flag (e.g. `other-employer`).
 * - Sub-function: user override → 'partner-marketing' when tagged → inference → `subfunctionFromTitle`.
 */
export function resolveOrgPlacement(x: OrgPlacementInput): { noise: OrgNoise | ''; vendorFunded: boolean; subfunction: Subfunction } {
  const inf = x.inference;
  const hasInf = Boolean(inf && inf.noise !== undefined);
  const other = () => Boolean(x.employer) && isOtherEmployer(x.employer!, x.account, x.entities, x.companyUrl, x.companyPages);
  let noise: OrgNoise | '';
  let tagged: boolean;
  if (x.noiseOverride === 'vendor-funded') {
    // the user's call wins over the heuristic: in the org, tagged
    noise = '';
    tagged = true;
  } else {
    if (x.noiseOverride === 'none') noise = '';
    else if (x.noiseOverride) noise = x.noiseOverride;
    else if (hasInf) noise = inf!.noise === 'vendor-funded' ? (other() ? 'other-employer' : '') : (inf!.noise as OrgNoise | '');
    else noise = other() ? 'other-employer' : noiseFromTitle(x.title);
    // a person on the account with no company known works there (they are on its list): compare the vendor to the account
    tagged = hasInf ? Boolean(inf!.vendorFunded) || inf!.noise === 'vendor-funded' : vendorFundedFromTitle(x.title, x.company || x.account.name);
  }
  // the tag only marks people in the org: any excluding flag (incl. a user's hand-set one) clears it
  const vendorFunded = tagged && !noise;
  const subfunction = x.subfunctionOverride || (vendorFunded ? 'partner-marketing' : inf?.subfunction || subfunctionFromTitle(x.title));
  return { noise, vendorFunded, subfunction };
}

export function buildAccountView(repo: AccountsRepo, account: Account, people: Map<string, ExplorerPerson>): AccountView {
  const rows = repo.members(account.id);
  const contacts = repo.contacts(rows.map((r) => r.personId));
  const allAccounts = new Map(repo.list().map((a) => [a.id, a.name]));
  const others = new Map<string, string[]>();
  for (const m of repo.allMembers()) {
    if (m.accountId === account.id) continue;
    const arr = others.get(m.personId) ?? [];
    arr.push(allAccounts.get(m.accountId) ?? m.accountId);
    others.set(m.personId, arr);
  }

  const entities = [...new Set(rows.map((r) => r.entity).filter(Boolean))];
  const companyPages = accountCompanyPages(repo, account.id);
  const members: AccountMember[] = rows.map((r) => {
    const c = contacts.get(r.personId);
    const p = people.get(r.personId);
    const d = dos(p);
    const title = c?.title || p?.profile?.role || p?.title || '';
    const auto = classify(title || c?.headline || '', p?.profile);
    const inf = r.inference;
    const company = c?.company || (p ? companyOfPerson(p) : '');
    const cur = c?.kind === 'full' ? c.profile?.experience?.find((e) => e.current) : undefined;
    const org = resolveOrgPlacement({
      account,
      entities,
      companyPages,
      title: title || c?.headline || '',
      company,
      employer: cur?.company ?? '',
      companyUrl: cur?.companyUrl ?? '',
      noiseOverride: r.noise,
      subfunctionOverride: r.subfunction,
      ...(inf ? { inference: inf } : {}),
    });
    return {
      id: r.personId,
      fullName: c?.fullName || p?.fullName || '(unknown)',
      title,
      company,
      url: c?.url || p?.url || '',
      location: c?.location || d?.location || p?.profile?.region || '',
      headline: c?.headline || p?.title || '',
      department: r.department || auto.department,
      tier: r.tier || auto.tier,
      autoDepartment: !r.department,
      autoTier: !r.tier,
      role: r.role,
      reportsTo: r.reportsTo,
      notes: r.notes,
      addedAt: r.addedAt,
      isConnection: Boolean(p),
      connectedOn: p?.connectedOn ?? '',
      capturedAt: c?.capturedAt ?? '',
      ...(c ? { profile: c.profile } : {}),
      webSummary: d?.oneLiner ?? '',
      otherAccounts: others.get(r.personId) ?? [],
      kind: c ? c.kind : 'connection',
      subfunction: org.subfunction,
      autoSubfunction: !r.subfunction,
      seniority: inf?.seniority || seniorityFromTitle(title || c?.headline || ''),
      noise: org.noise,
      vendorFunded: org.vendorFunded,
      autoNoise: !r.noise,
      team: r.team || inf?.team || '',
      entity: r.entity || inf?.entity || '',
      country: r.country || inf?.country || '',
      responsibilities: r.responsibilities || inf?.responsibilities || '',
      sources: r.sources,
      confidence: r.confidence,
      reportsToSource: r.reportsToSource,
      reportsToConfidence: r.reportsToConfidence,
      reportsToReason: r.reportsToReason,
      ...(r.inference ? { inference: r.inference } : {}),
    };
  });

  const memberIds = new Set(rows.map((r) => r.personId));
  const names = accountNames(account);
  const warmPaths: WarmPath[] = [];
  for (const p of people.values()) {
    if (memberIds.has(p.id)) continue;
    const cur = companyOfPerson(p);
    const atTitle = / at (.+)$/i.exec(p.title || '')?.[1] ?? '';
    if (names.some((n) => mentionsCompany(cur, n) || (atTitle && mentionsCompany(atTitle, n)))) {
      warmPaths.push({ id: p.id, fullName: p.fullName, title: p.profile?.role || p.title, company: cur, url: p.url, relation: 'current', detail: p.title });
      continue;
    }
    const past = (dos(p)?.career ?? []).find((c) => !c.current && names.some((n) => mentionsCompany(c.company, n)));
    if (past) {
      warmPaths.push({
        id: p.id, fullName: p.fullName, title: p.profile?.role || p.title, company: cur, url: p.url, relation: 'past',
        detail: `${past.role}${past.period ? ` (${past.period})` : ''} at ${past.company}`,
      });
    }
  }
  warmPaths.sort((a, b) => (a.relation === b.relation ? a.fullName.localeCompare(b.fullName) : a.relation === 'current' ? -1 : 1));

  return { account, members: sortMembers(members), warmPaths, gaps: accountGaps(members, warmPaths) };
}

export function accountGaps(members: AccountMember[], warm: WarmPath[]): string[] {
  if (!members.length) return ['No people on this account yet — add them from LinkedIn with the Chrome extension, or from your connections below.'];
  const gaps: string[] = [];
  const has = (r: CommitteeRole) => members.some((m) => m.role === r);
  if (!has('decision-maker')) gaps.push('No decision maker identified');
  if (!has('champion')) gaps.push('No champion yet');
  if (!members.some((m) => m.tier === 'exec' || m.tier === 'vp')) gaps.push('Nobody at VP level or above');
  const unset = members.filter((m) => !m.role).length;
  if (unset) gaps.push(`${unset} ${unset === 1 ? 'person has' : 'people have'} no buying-committee role`);
  if (!members.some((m) => m.isConnection) && !warm.length) gaps.push('No warm path — none of your connections work there');
  return gaps;
}

export const roleLabel = (r: CommitteeRole | '') => (r ? ROLE_LABELS[r] : '');
export { COMMITTEE_ROLES };
