import type { AccountsRepo } from '../db/accounts';
import type { ExplorerPerson } from '../types';
import { classify } from './classify';
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
  const captured = new Set(repo.allContacts().map((c) => c.id));
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

  const members: AccountMember[] = rows.map((r) => {
    const c = contacts.get(r.personId);
    const p = people.get(r.personId);
    const d = dos(p);
    const title = c?.title || p?.profile?.role || p?.title || '';
    const auto = classify(title || c?.headline || '', p?.profile);
    return {
      id: r.personId,
      fullName: c?.fullName || p?.fullName || '(unknown)',
      title,
      company: c?.company || (p ? companyOfPerson(p) : ''),
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
