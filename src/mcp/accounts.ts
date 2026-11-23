import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { accountMarkdown, edgeTag, orgMapMarkdown, profileSections } from '../accounts/brief';
import { buildOrgMap, orgMapSources } from '../accounts/org';
import { canonicalProfileUrl } from '../accounts/capture';
import {
  ACCOUNT_STATUSES,
  COMMITTEE_ROLES,
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  NOISE_FLAGS,
  ROLE_LABELS,
  SUBFUNCTIONS,
  SUBFUNCTION_LABELS,
  TIERS,
  TIER_LABELS,
  type Account,
  type AccountMember,
  type AccountView,
  type LightContactInput,
} from '../accounts/types';
import { accountSummaries, buildAccountView } from '../accounts/view';
import { AccountError } from '../db/accounts';
import type { Store } from '../db/store';
import { CHARACTER_LIMIT, cap } from './data';

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export interface AccountToolCtx {
  db: () => Store;
  ok: (text: string, structured?: Record<string, unknown>) => ToolResult;
  wrap: <A>(fn: (args: A) => Promise<ToolResult> | ToolResult) => (args: A) => Promise<ToolResult>;
  userError: (msg: string) => Error;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const ACCOUNT_INSTRUCTIONS = `
Accounts (ABX): companies the user is targeting. Each has a markdown ABX brief and key people grouped by org chart
(department → seniority), each with a buying-committee role (decision maker, champion, influencer, end user,
gatekeeper, blocker) set by the user, optional "reports to", notes, and — for people captured from LinkedIn with the
Chrome extension — their full profile (about, experience, education). Captured people are usually NOT connections;
they are only reachable through the account tools, never through network search or lenses.
Workflow for "plan a campaign for <company>": network_get_account (one call returns the brief, committee, org chart,
full profiles and warm paths) → network_get_contact for anyone needing more depth → save the plan back into the brief
with network_update_account (brief_mode "append"). Warm paths are the user's connections who work / worked there.

Marketing org map: network_get_org_map returns an account's marketing org — headcounts (captured here vs what LinkedIn
reports), sub-function × seniority, the reporting tree (each line tagged [confirmed] by the user, [inferred 0.6] by AI
or [web 0.9] from web research, with a reason), people with no known manager, flagged people (HR marketing, sales
hybrids, other employers… — not counted) and web facts with evidence URLs. Inferred lines are guesses: say so. You may
set org fields (sub-function, team, entity, country, responsibilities, noise) and confirm or set reporting lines with
network_account_update_person, and add people you found (name, title, LinkedIn URL, evidence URL) with
network_account_add_people \`contacts\` — all local and free. Classifying people, web org research and LinkedIn list
walks cost money or touch LinkedIn: the user starts them in the explorer (Accounts → Marketing org) and the Chrome
extension. Suggest that when the map is thin.`;

function view(s: Store, a: Account): AccountView {
  const people = new Map(s.listExplorerPeople().map((p) => [p.id, p]));
  const v = buildAccountView(s.accounts, a, people);
  return { ...v, org: buildOrgMap(v, orgMapSources(s.accounts, a.id)) };
}

const lightContact = z.object({
  full_name: z.string().min(1).max(200).describe('Their name as shown.'),
  url: z.string().max(2000).optional().describe('LinkedIn profile URL (linkedin.com/in/…), if known — it dedupes best.'),
  title: z.string().max(300).optional().describe('Current job title.'),
  headline: z.string().max(500).optional(),
  company: z.string().max(200).optional().describe('Current employer (the account or one of its entities).'),
  location: z.string().max(200).optional(),
  evidence_url: z.string().max(2000).optional().describe('Where you found them (http/https page), kept as the source.'),
});

export function registerAccountTools(server: McpServer, ctx: AccountToolCtx): void {
  const { db, ok, wrap } = ctx;
  const accountOrThrow = (ref: string): Account => {
    const a = db().accounts.find(ref);
    if (!a) {
      const names = db().accounts.list().map((x) => `${x.name} (\`${x.id}\`)`);
      throw ctx.userError(`No account matches "${ref}".${names.length ? ` Accounts: ${names.slice(0, 30).join(', ')}.` : ' There are no accounts yet — create one with network_create_account.'}`);
    }
    return a;
  };
  const memberOrThrow = (v: AccountView, ref: string): AccountMember => {
    const q = ref.trim();
    const canon = canonicalProfileUrl(q);
    const lc = q.toLowerCase();
    let hits = v.members.filter((m) => m.id === q || (canon && canonicalProfileUrl(m.url) === canon));
    if (!hits.length) hits = v.members.filter((m) => m.fullName.toLowerCase() === lc);
    if (!hits.length) hits = v.members.filter((m) => m.fullName.toLowerCase().includes(lc));
    if (!hits.length) throw ctx.userError(`Nobody called "${ref}" is on ${v.account.name}. People: ${v.members.map((m) => `${m.fullName} (\`${m.id}\`)`).join(', ') || 'none'}.`);
    if (hits.length > 1) throw ctx.userError(`"${ref}" matches several people on ${v.account.name}: ${hits.map((m) => `${m.fullName} (\`${m.id}\`)`).join(', ')}. Use the id.`);
    return hits[0]!;
  };
  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof AccountError) throw ctx.userError(e.message);
      throw e;
    }
  };
  const renderAccount = (v: AccountView, detail: 'full' | 'summary') => {
    let text = accountMarkdown(v, detail);
    if (detail === 'full' && text.length > CHARACTER_LIMIT - 200) {
      text = `${accountMarkdown(v, 'summary')}\n\n_Full profiles omitted to fit the response — call network_get_contact for each person you need in depth._`;
    }
    return text;
  };

  server.registerTool(
    'network_list_accounts',
    {
      title: 'List accounts',
      description: 'All target accounts (ABX) with status, how many key people each has, buying-committee coverage and gaps. Use the name or id with network_get_account.',
      inputSchema: {},
      annotations: { title: 'List accounts', ...READ },
    },
    wrap(async () => {
      const s = db();
      const connIds = new Set(s.listExplorerPeople().map((p) => p.id));
      const rows = accountSummaries(s.accounts, connIds);
      if (!rows.length) return ok('No accounts yet. Create one with network_create_account, or capture people from LinkedIn with the Chrome extension (it creates the account).', { accounts: [] });
      const text = rows
        .map((r) => {
          const roles = Object.entries(r.roles).map(([k, n]) => `${n} ${ROLE_LABELS[k as keyof typeof ROLE_LABELS].toLowerCase()}`).join(', ');
          return `- **${r.name}** (\`${r.id}\`) — ${r.status} · ${r.memberCount} people (${r.connections} connections)${roles ? ` · ${roles}` : ' · no roles set'}${r.domain ? ` · ${r.domain}` : ''}`;
        })
        .join('\n');
      return ok(text, { accounts: rows });
    }),
  );

  server.registerTool(
    'network_get_account',
    {
      title: 'Get an account (ABX context)',
      description:
        'Everything about one target account in one markdown document, ready to plan an ABX campaign: the ABX brief, the buying committee ' +
        '(roles + gaps), the org chart grouped by department → seniority with reporting lines, each person\'s full LinkedIn profile ' +
        '(about, experience, education) and notes, the user\'s warm paths in (connections who work / worked there), and — when mapped — a short ' +
        '"Marketing org" section (counts, top two reporting levels; the full map is network_get_org_map). ' +
        'Accepts the account name (or an alias), its id, or its LinkedIn company URL.',
      inputSchema: {
        account: z.string().min(1).max(300).describe('Account name, alias, id, or linkedin.com/company/… URL.'),
        detail: z.enum(['full', 'summary']).default('full').describe('"full" (default) includes every person\'s profile; "summary" = brief + committee + org chart only.'),
      },
      annotations: { title: 'Get an account', ...READ },
    },
    wrap(async (a) => {
      const acc = accountOrThrow(a.account);
      const v = view(db(), acc);
      return ok(renderAccount(v, a.detail), {
        account: v.account,
        gaps: v.gaps,
        members: v.members.map((m) => ({ ...m, profile: undefined, has_profile: Boolean(m.profile) })),
        warm_paths: v.warmPaths,
        marketing_org: v.org
          ? { in_org: v.org.headcount.captured.total, flagged: v.org.flagged.length, linkedin_marketing: v.org.headcount.linkedin.marketing?.count ?? null, coverage: v.org.headcount.coverage ?? null }
          : null,
      });
    }),
  );

  server.registerTool(
    'network_get_org_map',
    {
      title: 'Get an account\'s marketing org map',
      description:
        'The marketing org of one account: headcounts (people captured here vs LinkedIn\'s company count and its "What they do → Marketing" count — ' +
        'LinkedIn shows only the top 5 functions, so the marketing count and coverage are missing when Marketing is not among them; ' +
        'search counts, anonymous rows, web statements, coverage), sub-function × seniority, the reporting tree with each line\'s provenance ' +
        '([confirmed] by the user, [inferred 0.6] by AI, [web 0.9] from research) and reason, people with no known manager (by sub-function → ' +
        'entity), flagged people (not counted), legal entities, and web structure facts with evidence URLs. Read-only; nothing is classified or ' +
        'researched by this call (the user starts that in the explorer).',
      inputSchema: {
        account: z.string().min(1).max(300).describe('Account name, alias, id, or linkedin.com/company/… URL.'),
        function: z.enum(['marketing']).default('marketing').describe('The function to map (only "marketing" for now).'),
        detail: z
          .enum(['summary', 'full'])
          .default('full')
          .describe('"full" (default) adds line reasons, ids, quotes, responsibilities, list walks and per-person data (≤ 200 people); "summary" is shorter (tree to 3 levels, ≤ 10 per unplaced group, no per-person data) — use it for big orgs.'),
      },
      annotations: { title: 'Get a marketing org map', ...READ },
    },
    wrap(async (a) => {
      const acc = accountOrThrow(a.account);
      const v = view(db(), acc);
      const org = v.org!;
      let text = orgMapMarkdown(v, org, a.detail);
      if (a.detail === 'full' && text.length > CHARACTER_LIMIT - 200) text = `${orgMapMarkdown(v, org, 'summary')}\n\n_Shortened to fit: shown as detail "summary" (line reasons, ids and quotes omitted) — see structuredContent.people, or network_get_contact per person._`;
      // explicit about what a cut loses (ok() would cap again with a generic hint)
      text = cap(text, 'the org map is longer than one response: the rest of the tree / groups is missing. Use network_get_contact for specific people, or the explorer\'s Marketing org view.');
      if (a.detail === 'summary') {
        const { runs: _runs, ...slim } = org;
        return ok(text, { account: { id: acc.id, name: acc.name }, function: a.function, detail: 'summary', org: slim as unknown as Record<string, unknown> });
      }
      const ids = new Set([...org.members, ...org.flagged.map((f) => f.id)]);
      const walk = (n: (typeof org.roots)[number]) => {
        ids.add(n.id);
        n.children.forEach(walk);
      };
      org.roots.forEach(walk);
      const PEOPLE_MAX = 200;
      const inMap = v.members.filter((m) => ids.has(m.id));
      // org members first (as ordered in the map: most senior first), then context / flagged people
      const order = new Map([...org.members, ...org.flagged.map((f) => f.id)].map((id, i) => [id, i]));
      inMap.sort((x, y) => (order.get(x.id) ?? 1e9) - (order.get(y.id) ?? 1e9));
      const people = inMap
        .slice(0, PEOPLE_MAX)
        .map((m) => ({
          id: m.id, full_name: m.fullName, title: m.title, url: m.url, kind: m.kind, is_connection: m.isConnection,
          in_org: org.members.includes(m.id), subfunction: m.subfunction, auto_subfunction: m.autoSubfunction, seniority: m.seniority,
          team: m.team, entity: m.entity, country: m.country, responsibilities: m.responsibilities, noise: m.noise, vendor_funded: m.vendorFunded,
          confidence: m.confidence, reports_to: m.reportsTo, reports_to_source: m.reportsToSource, reports_to_confidence: m.reportsToConfidence,
          reports_to_reason: m.reportsToReason, line: m.reportsTo ? edgeTag({ source: m.reportsToSource, confidence: m.reportsToConfidence, reason: '' }) : '',
          sources: m.sources,
        }));
      return ok(text, {
        account: { id: acc.id, name: acc.name }, function: a.function, detail: 'full', org: org as unknown as Record<string, unknown>,
        people, people_total: inMap.length, people_truncated: inMap.length > PEOPLE_MAX,
      });
    }),
  );

  server.registerTool(
    'network_get_contact',
    {
      title: 'Get a key person on an account',
      description:
        'One person on an account in full: org-chart placement, role, notes and their whole captured LinkedIn profile (every experience ' +
        'entry with descriptions, education, skills, certifications…). include_page_text adds the raw captured page text.',
      inputSchema: {
        account: z.string().min(1).describe('Account name, alias or id.'),
        person: z.string().min(1).describe('Person id, LinkedIn profile URL, or (part of) their name.'),
        include_page_text: z.boolean().default(false).describe('Also return the raw page text captured from LinkedIn (long).'),
      },
      annotations: { title: 'Get a key person', ...READ },
    },
    wrap(async (a) => {
      const acc = accountOrThrow(a.account);
      const v = view(db(), acc);
      const m = memberOrThrow(v, a.person);
      const byId = new Map(v.members.map((x) => [x.id, x]));
      const L = [`# ${m.fullName}${m.title ? ` — ${m.title}` : ''}`, `On account **${acc.name}** · id \`${m.id}\``, ''];
      L.push(`- Org chart: ${DEPARTMENT_LABELS[m.department]}${m.autoDepartment ? ' (auto)' : ''} · ${TIER_LABELS[m.tier]}${m.autoTier ? ' (auto)' : ''}`);
      L.push(`- Buying-committee role: ${m.role ? ROLE_LABELS[m.role] : 'not set'}`);
      if (m.reportsTo && byId.has(m.reportsTo)) L.push(`- Reports to: ${byId.get(m.reportsTo)!.fullName}`);
      const reports = v.members.filter((x) => x.reportsTo === m.id);
      if (reports.length) L.push(`- Direct reports on this account: ${reports.map((x) => x.fullName).join(', ')}`);
      if (m.company) L.push(`- Company: ${m.company}`);
      if (m.location) L.push(`- Location: ${m.location}`);
      if (m.headline) L.push(`- Headline: ${m.headline}`);
      if (m.url) L.push(`- LinkedIn: ${m.url}`);
      L.push(`- ${m.isConnection ? `Your connection${m.connectedOn ? ` since ${m.connectedOn}` : ''}` : 'Not a connection'}`);
      if (m.capturedAt) L.push(`- Profile captured ${m.capturedAt.slice(0, 10)}`);
      if (m.otherAccounts.length) L.push(`- Also on: ${m.otherAccounts.join(', ')}`);
      if (m.notes.trim()) L.push('', `**Notes:** ${m.notes.trim()}`);
      if (m.webSummary) L.push('', `**Web profile:** ${m.webSummary} (more: network_get_person "${m.id}")`);
      if (m.profile) L.push(...profileSections(m.profile, { descMax: 3000, includeRaw: a.include_page_text }));
      else L.push('', m.isConnection ? '_No LinkedIn capture yet — network_get_person has what is known from your network._' : '_No profile captured._');
      return ok(L.join('\n'), { member: m });
    }),
  );

  const accountFields = {
    domain: z.string().max(200).optional().describe('Website domain, e.g. "ledgerly.com".'),
    linkedin_url: z.string().max(300).optional().describe('LinkedIn company page URL (linkedin.com/company/…).'),
    aliases: z.array(z.string().max(120)).max(20).optional().describe('Other names the company goes by (replaces the list).'),
    status: z.enum(ACCOUNT_STATUSES).optional().describe('target · engaged · customer · paused.'),
  };

  server.registerTool(
    'network_create_account',
    {
      title: 'Create an account',
      description: 'Create a target account (ABX). Local and free. Add people with network_account_add_people, or capture them from LinkedIn with the Chrome extension.',
      inputSchema: {
        name: z.string().min(1).max(120).describe('Company name, e.g. "Ledgerly".'),
        ...accountFields,
        brief: z.string().max(100_000).optional().describe('ABX brief in markdown: why this account, pains, triggers, offer, plan.'),
      },
      annotations: { title: 'Create an account', ...WRITE, idempotentHint: false },
    },
    wrap(async (a) => {
      const acc = guard(() =>
        db().accounts.create({ name: a.name, domain: a.domain, linkedinUrl: a.linkedin_url, aliases: a.aliases, status: a.status, brief: a.brief }),
      );
      return ok(`Created account **${acc.name}** (\`${acc.id}\`).`, { account: acc });
    }),
  );

  server.registerTool(
    'network_update_account',
    {
      title: 'Update an account',
      description:
        'Rename an account or change its domain, LinkedIn page, aliases, status or ABX brief. Use brief_mode "append" to add a campaign plan, ' +
        'meeting notes or research to the existing brief without overwriting what the user wrote.',
      inputSchema: {
        account: z.string().min(1).describe('Account name, alias or id.'),
        name: z.string().min(1).max(120).optional(),
        ...accountFields,
        brief: z.string().max(100_000).optional().describe('Markdown.'),
        brief_mode: z.enum(['append', 'replace']).default('append').describe('"append" (default) adds below the current brief; "replace" overwrites it.'),
      },
      annotations: { title: 'Update an account', ...WRITE },
    },
    wrap(async (a) => {
      const acc = accountOrThrow(a.account);
      let brief = a.brief;
      if (brief !== undefined && a.brief_mode === 'append' && acc.brief.trim()) brief = `${acc.brief.trimEnd()}\n\n${brief.trim()}`;
      const next = guard(() =>
        db().accounts.update(acc.id, { name: a.name, domain: a.domain, linkedinUrl: a.linkedin_url, aliases: a.aliases, status: a.status, brief }),
      );
      const changed = (['name', 'domain', 'linkedin_url', 'aliases', 'status', 'brief'] as const).filter((k) => a[k] !== undefined);
      return ok(`Updated **${next.name}**${changed.length ? `: ${changed.join(', ')}` : ' (nothing to change)'}.`, { account: next });
    }),
  );

  server.registerTool(
    'network_account_add_people',
    {
      title: 'Add people to an account',
      description:
        'Put people on an account: your connections (ids from network_search_people / network_find_connections_at, or their LinkedIn URLs) or people ' +
        'already captured from LinkedIn (`people`), and/or people you found elsewhere as light contacts (`contacts`: name, title, LinkedIn URL, ' +
        'evidence URL). Light contacts are deduped (same LinkedIn URL, or same name + compatible title on this account), so adding them twice ' +
        'adds nothing. They stay under the account and never enter the user\'s network. Local and free.',
      inputSchema: {
        account: z.string().min(1).describe('Account name, alias or id.'),
        people: z.array(z.string().min(1)).max(200).optional().describe('Person ids or LinkedIn profile URLs (connections or already captured).'),
        contacts: z.array(lightContact).max(200).optional().describe('People not yet known, as light contacts (source "mcp").'),
        role: z.enum(COMMITTEE_ROLES).optional().describe('Buying-committee role to give everyone added (optional).'),
      },
      annotations: { title: 'Add people to an account', ...WRITE },
    },
    wrap(async (a) => {
      const s = db();
      const acc = accountOrThrow(a.account);
      if (!a.people?.length && !a.contacts?.length) throw ctx.userError('Nothing to add: pass `people` (ids / LinkedIn URLs) and/or `contacts` (light contacts).');
      const parts: string[] = [];
      let r: { added: string[]; already: string[]; unknown: string[] } = { added: [], already: [], unknown: [] };
      if (a.people?.length) {
        const ids = a.people.map((ref) => (canonicalProfileUrl(ref) ? guard(() => s.accounts.idForProfileUrl(ref)).id : ref.trim()));
        r = guard(() => s.accounts.addMembers(acc.id, ids, a.role ? { role: a.role } : {}));
        parts.push(
          `added ${r.added.length}${r.already.length ? `, ${r.already.length} already on it${a.role ? ' (role updated)' : ''}` : ''}.` +
            (r.unknown.length ? ` Not found (not a connection and never captured): ${r.unknown.slice(0, 10).join(', ')} — capture them from LinkedIn with the Chrome extension, or pass them as \`contacts\`.` : ''),
        );
      }
      let light: ReturnType<Store['accounts']['upsertLightContacts']> | undefined;
      if (a.contacts?.length) {
        const at = new Date().toISOString();
        const inputs: LightContactInput[] = a.contacts.map((c, i) => {
          const ev = c.evidence_url?.trim();
          if (ev && !/^https?:\/\/[^\s]+$/i.test(ev)) throw ctx.userError(`contacts[${i}].evidence_url must be an http(s) URL.`);
          return {
            fullName: c.full_name, url: c.url, title: c.title, headline: c.headline, company: c.company, location: c.location,
            source: { kind: 'mcp', at, ...(ev ? { evidenceUrl: ev } : {}) },
          };
        });
        light = guard(() => s.accounts.upsertLightContacts(acc.id, inputs));
        if (a.role) for (const pid of light.added) guard(() => s.accounts.updateMember(acc.id, pid, { role: a.role }));
        const known = light.updated.length + light.merged.length;
        parts.push(
          `${light.added.length} new light contact${light.added.length === 1 ? '' : 's'}${known ? `, ${known} already on it` : ''}` +
            `${light.skipped.length ? `, ${light.skipped.length} skipped (${light.skipped.slice(0, 5).map((x) => `${x.input.fullName || '?'}: ${x.reason}`).join('; ')})` : ''}.` +
            (light.warnings.length ? ` ${light.warnings.slice(0, 5).join(' ')}` : ''),
        );
      }
      return ok(`${acc.name}: ${parts.join(' ')}`, { account_id: acc.id, ...r, ...(light ? { light } : {}) });
    }),
  );

  server.registerTool(
    'network_account_update_person',
    {
      title: 'Update a key person',
      description:
        'Set a person\'s buying-committee role, org-chart placement (department / tier — "" returns to automatic from the title), who they report to ' +
        '(another person on the same account; "" clears it), or your notes (replaces them). Marketing org fields: sub-function, team, legal entity, ' +
        'country, responsibilities, noise ("none" = definitely in the org, "" = automatic, a flag = not counted). confirm_reports_to accepts a ' +
        'suggested (inferred / web) reporting line as the user\'s. Set or confirm lines only when the user asked or a source states it. Local and free.',
      inputSchema: {
        account: z.string().min(1).describe('Account name, alias or id.'),
        person: z.string().min(1).describe('Person id, LinkedIn URL or name (on this account).'),
        role: z.enum([...COMMITTEE_ROLES, '']).optional().describe(`One of ${COMMITTEE_ROLES.join(', ')}, or "" to clear.`),
        department: z.enum([...DEPARTMENTS, '']).optional().describe(`One of ${DEPARTMENTS.join(', ')}, or "" for automatic.`),
        tier: z.enum([...TIERS, '']).optional().describe(`One of ${TIERS.join(', ')}, or "" for automatic.`),
        reports_to: z.string().optional().describe('Id or name of their manager on this account, or "" to clear.'),
        confirm_reports_to: z.boolean().optional().describe('true = accept the current suggested reporting line (it becomes set by the user).'),
        notes: z.string().max(10_000).optional(),
        subfunction: z.enum([...SUBFUNCTIONS, '']).optional().describe(`Marketing sub-function: ${SUBFUNCTIONS.join(', ')}, or "" for automatic.`),
        team: z.string().max(200).optional(),
        entity: z.string().max(200).optional().describe('Legal entity, e.g. "Ledgerly Services GmbH".'),
        country: z.string().regex(/^([A-Za-z]{2})?$/, 'country must be a 2-letter ISO code or ""').optional().describe('ISO-3166 alpha-2, e.g. "DE", or "".'),
        responsibilities: z.string().max(2000).optional(),
        noise: z.enum([...NOISE_FLAGS, 'none', '']).optional().describe(`"none" = in the org; "" = automatic; or a flag: ${NOISE_FLAGS.join(', ')} (vendor-funded is a tag: still in the org).`),
      },
      annotations: { title: 'Update a key person', ...WRITE },
    },
    wrap(async (a) => {
      const s = db();
      const acc = accountOrThrow(a.account);
      const v = view(s, acc);
      const m = memberOrThrow(v, a.person);
      const reportsTo = a.reports_to === undefined ? undefined : a.reports_to.trim() ? memberOrThrow(v, a.reports_to).id : '';
      // confirm needs a line to confirm: check first, so a failing call saves nothing
      if (a.confirm_reports_to === true && reportsTo === undefined && !m.reportsTo) throw ctx.userError(`${m.fullName} has no reporting line to confirm. Set one with reports_to.`);
      guard(() => {
        s.accounts.updateMember(acc.id, m.id, {
          role: a.role, department: a.department, tier: a.tier, reportsTo, notes: a.notes, subfunction: a.subfunction, team: a.team,
          entity: a.entity, country: a.country, responsibilities: a.responsibilities, noise: a.noise,
        });
        // a line set in the same call is already the user's
        if (a.confirm_reports_to === true && reportsTo === undefined) s.accounts.confirmReportsTo(acc.id, m.id);
      });
      const after = view(s, acc).members.find((x) => x.id === m.id)!;
      const line = after.reportsTo
        ? ` · reports to ${v.members.find((x) => x.id === after.reportsTo)?.fullName ?? after.reportsTo} ${edgeTag({ source: after.reportsToSource, confidence: after.reportsToConfidence, reason: '' })}`
        : '';
      const org = [SUBFUNCTION_LABELS[after.subfunction] + (after.autoSubfunction ? ' (auto)' : ''), after.team && `team ${after.team}`, after.entity, after.country, after.noise && `flagged: ${after.noise}`, after.vendorFunded && 'vendor-funded']
        .filter(Boolean)
        .join(' · ');
      return ok(
        `${after.fullName} on ${acc.name}: ${after.role ? ROLE_LABELS[after.role] : 'no role'} · ${DEPARTMENT_LABELS[after.department]} · ${TIER_LABELS[after.tier]}${line}. Marketing org: ${org}.`,
        { member: { ...after, profile: undefined } },
      );
    }),
  );

  server.registerTool(
    'network_account_remove_person',
    {
      title: 'Remove a person from an account',
      description: 'Take someone off an account (their captured profile is kept, so re-adding them is instant). Only do this when the user asks.',
      inputSchema: {
        account: z.string().min(1).describe('Account name, alias or id.'),
        person: z.string().min(1).describe('Person id, LinkedIn URL or name (on this account).'),
      },
      annotations: { title: 'Remove a person from an account', ...WRITE, destructiveHint: true },
    },
    wrap(async (a) => {
      const s = db();
      const acc = accountOrThrow(a.account);
      const m = memberOrThrow(view(s, acc), a.person);
      s.accounts.removeMember(acc.id, m.id);
      return ok(`Removed ${m.fullName} from ${acc.name}.`, { account_id: acc.id, removed: m.id });
    }),
  );

  // account://<id> — the same document as network_get_account, attachable as context
  server.registerResource(
    'account',
    new ResourceTemplate('account://{id}', {
      list: async () => {
        try {
          return { resources: db().accounts.list().map((a) => ({ uri: `account://${a.id}`, name: a.name, description: `ABX context for ${a.name}`, mimeType: 'text/markdown' })) };
        } catch {
          return { resources: [] };
        }
      },
    }),
    { title: 'Account (ABX context)', description: 'A target account: brief, buying committee, org chart, full profiles, warm paths.', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const id = decodeURIComponent(String(vars.id ?? ''));
      const acc = accountOrThrow(id);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderAccount(view(db(), acc), 'full') }] };
    },
  );

  server.registerPrompt(
    'abx_campaign',
    {
      title: 'Plan an ABX campaign',
      description: 'Plan an account-based campaign for one target account from its brief, buying committee and profiles.',
      argsSchema: { account: z.string().describe('Account name, e.g. "Ledgerly"') },
    },
    ({ account }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text:
            `Plan an account-based (ABX) campaign for ${account} using my network-builder tools. Start with network_get_account. ` +
            `Then: (1) summarise the account situation and the buying committee, calling out gaps (no decision maker / champion, ` +
            `missing departments); (2) for each key person, the angle that matters to them given their role, career and what they ` +
            `talk about, citing their profile; (3) the best warm paths in from my connections; (4) a sequenced multi-touch plan ` +
            `(who, channel, message theme, timing) over ~6 weeks; (5) draft the first message to the top 2–3 people. ` +
            `Don't invent facts that aren't in the profiles. Ask me before saving the plan to the account brief with network_update_account.`,
        },
      }],
    }),
  );
}
