import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { accountMarkdown, profileSections } from '../accounts/brief';
import { canonicalProfileUrl } from '../accounts/capture';
import {
  ACCOUNT_STATUSES,
  COMMITTEE_ROLES,
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  ROLE_LABELS,
  TIERS,
  TIER_LABELS,
  type Account,
  type AccountMember,
  type AccountView,
} from '../accounts/types';
import { accountSummaries, buildAccountView } from '../accounts/view';
import { AccountError } from '../db/accounts';
import type { Store } from '../db/store';
import { CHARACTER_LIMIT } from './data';

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
with network_update_account (brief_mode "append"). Warm paths are the user's connections who work / worked there.`;

function view(s: Store, a: Account): AccountView {
  const people = new Map(s.listExplorerPeople().map((p) => [p.id, p]));
  return buildAccountView(s.accounts, a, people);
}

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
        '(about, experience, education) and notes, and the user\'s warm paths in (connections who work / worked there). ' +
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
        'already captured from LinkedIn. People who are not connections and were never captured must be captured with the Chrome extension first.',
      inputSchema: {
        account: z.string().min(1).describe('Account name, alias or id.'),
        people: z.array(z.string().min(1)).min(1).max(200).describe('Person ids or LinkedIn profile URLs.'),
        role: z.enum(COMMITTEE_ROLES).optional().describe('Buying-committee role to give everyone added (optional).'),
      },
      annotations: { title: 'Add people to an account', ...WRITE },
    },
    wrap(async (a) => {
      const s = db();
      const acc = accountOrThrow(a.account);
      const ids = a.people.map((ref) => (canonicalProfileUrl(ref) ? guard(() => s.accounts.idForProfileUrl(ref)).id : ref.trim()));
      const r = guard(() => s.accounts.addMembers(acc.id, ids, a.role ? { role: a.role } : {}));
      const text =
        `${acc.name}: added ${r.added.length}${r.already.length ? `, ${r.already.length} already on it${a.role ? ' (role updated)' : ''}` : ''}.` +
        (r.unknown.length ? ` Not found (not a connection and never captured): ${r.unknown.slice(0, 10).join(', ')} — capture them from LinkedIn with the Chrome extension.` : '');
      return ok(text, { account_id: acc.id, ...r });
    }),
  );

  server.registerTool(
    'network_account_update_person',
    {
      title: 'Update a key person',
      description:
        'Set a person\'s buying-committee role, org-chart placement (department / tier — "" returns to automatic from the title), who they report to ' +
        '(another person on the same account; "" clears it), or your notes (replaces them).',
      inputSchema: {
        account: z.string().min(1).describe('Account name, alias or id.'),
        person: z.string().min(1).describe('Person id, LinkedIn URL or name (on this account).'),
        role: z.enum([...COMMITTEE_ROLES, '']).optional().describe(`One of ${COMMITTEE_ROLES.join(', ')}, or "" to clear.`),
        department: z.enum([...DEPARTMENTS, '']).optional().describe(`One of ${DEPARTMENTS.join(', ')}, or "" for automatic.`),
        tier: z.enum([...TIERS, '']).optional().describe(`One of ${TIERS.join(', ')}, or "" for automatic.`),
        reports_to: z.string().optional().describe('Id or name of their manager on this account, or "" to clear.'),
        notes: z.string().max(10_000).optional(),
      },
      annotations: { title: 'Update a key person', ...WRITE },
    },
    wrap(async (a) => {
      const s = db();
      const acc = accountOrThrow(a.account);
      const v = view(s, acc);
      const m = memberOrThrow(v, a.person);
      const reportsTo = a.reports_to === undefined ? undefined : a.reports_to.trim() ? memberOrThrow(v, a.reports_to).id : '';
      guard(() => s.accounts.updateMember(acc.id, m.id, { role: a.role, department: a.department, tier: a.tier, reportsTo, notes: a.notes }));
      const after = view(s, acc).members.find((x) => x.id === m.id)!;
      return ok(
        `${after.fullName} on ${acc.name}: ${after.role ? ROLE_LABELS[after.role] : 'no role'} · ${DEPARTMENT_LABELS[after.department]} · ${TIER_LABELS[after.tier]}` +
          `${after.reportsTo ? ` · reports to ${v.members.find((x) => x.id === after.reportsTo)?.fullName ?? after.reportsTo}` : ''}.`,
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
