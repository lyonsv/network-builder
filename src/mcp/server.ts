import { existsSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from '../db/store';
import { ahoyPaths, explorerExportFilename, toAhoyFiles, toExplorerCsv } from '../io/explorer-export';
import { ensureDir, writeFileAtomic } from '../io/fs-utils';
import { slugify } from '../io/output';
import { DEFAULT_DB_PATH, DEFAULT_OUT_DIR, expandHome, type ExplorerPerson, type Lens } from '../types';
import {
  cap,
  companyOf,
  depthOf,
  inView,
  isMember,
  lensBucket,
  locationOf,
  matches,
  pastCompanies,
  personDetail,
  personLine,
  personMarkdown,
  personSummary,
  pinOf,
  pinsFor,
  resolveLens,
  scoreIn,
  sortPeople,
  thresholdOf,
  type LensView,
  type SearchFilters,
  type SortKey,
} from './data';
import { ACCOUNT_INSTRUCTIONS, registerAccountTools } from './accounts';

/**
 * network-builder as an MCP server (stdio): read your network, curate lens membership and lists, and export CSVs —
 * from Claude Code or any MCP client. Nothing here spends AI money: web profiles, lens scoring and Ahoy calls stay
 * human-triggered in the explorer UI. Data is re-read from SQLite on every call, so it stays in sync with a running
 * explorer and other network-builder processes.
 */

export const SERVER_INSTRUCTIONS = `network-builder holds the user's LinkedIn network in a local SQLite database.

Data model:
- People: LinkedIn connections (name, headline/title, company, LinkedIn URL, connected date). Each has a stable id.
- Headline profile: AI-parsed role, seniority, function, industry, tags (investor, founder, board member, …) for almost everyone.
- Web profile (only for people the user chose to research): light or deep — career, investments, boards, expertise,
  location, sources; deep ones add recent activity (talks, podcasts, articles) and themes they talk about.
- Lenses: a goal (e.g. "potential angel investors") scored 0–100 for everyone with a reason. Membership = pinned in by
  hand, OR score ≥ the lens threshold and not removed by hand. People the user removed stay out — respect that; never
  suggest re-adding them unless asked.
- Lists: named, ordered selections of people (for outreach / CRM export).
- Ahoy CRM status (if checked in the explorer): in_crm / new / ambiguous, and whether the person was sent to Ahoy.

Typical workflows: find people (network_search_people, network_find_connections_at) → read one in depth
(network_get_person) → curate a lens (network_lens_add / network_lens_remove / network_set_lens_threshold) → save a
list (network_save_list) → export CSV for a CRM (network_export, preset "ahoy" for Ahoy imports).

Not available here by design: starting web research, creating or re-scoring lenses, or sending to Ahoy — those cost
money or touch external systems and are started by the user in the explorer UI (run \`network-builder\`). Suggest it
when a task needs them (e.g. "these 5 have no web profile; research them in the explorer first").
${ACCOUNT_INSTRUCTIONS}`;

export interface NetworkMcpOptions {
  dbPath: string;
  outDir: string;
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const ok = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: cap(text) }],
  ...(structured ? { structuredContent: structured } : {}),
});
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

class UserError extends Error {}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const responseFormat = z
  .enum(['concise', 'detailed'])
  .default('concise')
  .describe('"concise": one markdown line per person (default). "detailed": adds a JSON block with every field.');
const limitArg = (def: number, max: number) => z.number().int().min(1).max(max).default(def).describe(`Max results to return (1–${max}, default ${def}).`);
const offsetArg = z.number().int().min(0).default(0).describe('Results to skip, for paging (use next_offset from the previous call).');
const lensViewArg = z
  .enum(['in', 'candidates', 'removed', 'all'])
  .describe('in = lens members · candidates = not in and not removed · removed = removed by hand · all = in + candidates (removed people are excluded).');

function page<T>(rows: T[], offset: number, limit: number) {
  const items = rows.slice(offset, offset + limit);
  const next = offset + items.length;
  return { items, total: rows.length, count: items.length, offset, has_more: next < rows.length, next_offset: next < rows.length ? next : null };
}

/** Build the MCP server over a database (tests pass a temp DB; the CLI uses the user's). */
export function createNetworkMcpServer(opts: NetworkMcpOptions): { server: McpServer; close: () => void } {
  let store: Store | undefined;
  const db = (): Store => {
    if (store) return store;
    if (opts.dbPath !== ':memory:' && !existsSync(opts.dbPath)) {
      throw new UserError(`No network database at ${opts.dbPath}. Import your LinkedIn connections first: run \`network-builder\` (or \`network-builder import <csv>\`).`);
    }
    store = Store.open(opts.dbPath);
    return store;
  };
  /** fresh snapshot per call: other processes (the explorer, the CLI) change the database */
  const load = () => {
    const s = db();
    return { s, people: s.listExplorerPeople(), lenses: s.listLenses() };
  };
  const lensOrThrow = (lenses: Lens[], ref: string): Lens => {
    const r = resolveLens(lenses, ref);
    if (!r.lens) throw new UserError(r.error!);
    return r.lens;
  };
  const wrap =
    <A>(fn: (args: A) => Promise<ToolResult> | ToolResult) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return await fn(args);
      } catch (e) {
        if (e instanceof UserError) return fail(e.message);
        process.stderr.write(`[network-builder mcp] ${(e as Error)?.stack ?? e}\n`);
        return fail(`network-builder error: ${(e as Error)?.message ?? e}`);
      }
    };
  const knownIds = (people: ExplorerPerson[], ids: string[]) => {
    const byId = new Map(people.map((p) => [p.id, p]));
    const found = ids.map((id) => byId.get(id)).filter((p): p is ExplorerPerson => Boolean(p));
    const unknown = ids.filter((id) => !byId.has(id));
    if (!found.length) throw new UserError(`None of these ids are in the network: ${unknown.slice(0, 5).join(', ')}. Get ids from network_search_people.`);
    return { found, unknown };
  };
  const listing = (rows: ExplorerPerson[], lens: Lens | undefined, fmt: 'concise' | 'detailed', heading: string, pg: ReturnType<typeof page<ExplorerPerson>>) => {
    const lines = [heading, ''];
    if (!pg.items.length) lines.push('_No matches._');
    lines.push(...pg.items.map((p) => personLine(p, lens)));
    if (pg.has_more) lines.push('', `Showing ${pg.offset + 1}–${pg.offset + pg.count} of ${pg.total}. More: offset=${pg.next_offset}.`);
    const items = pg.items.map((p) => personSummary(p, lens));
    if (fmt === 'detailed') lines.push('', '```json', JSON.stringify(items, null, 1), '```');
    void rows;
    return ok(lines.join('\n'), { total: pg.total, count: pg.count, offset: pg.offset, has_more: pg.has_more, next_offset: pg.next_offset, people: items });
  };

  const server = new McpServer({ name: 'network-builder', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });

  // ------------------------------------------------------------------ READ
  server.registerTool(
    'network_search_people',
    {
      title: 'Search my network',
      description:
        'Search the LinkedIn network by free text and filters. Free text matches name, headline, company, parsed profile, and — ' +
        'for researched people — career history, investments, boards, expertise and recent activity/themes. Terms are ANDed; ' +
        'use "quoted phrases". Combine with a lens to rank by fit (sort="score") or restrict to lens members. Use this first ' +
        'to find people and their ids; then network_get_person for depth.',
      inputSchema: {
        query: z.string().max(300).optional().describe('Free text, e.g. `fintech "head of marketing"` or `angel dublin`. Omit to list everyone matching the filters.'),
        seniority: z.array(z.string()).optional().describe('Any of: founder/owner, c-suite, partner, vp, director, head of, manager, senior ic, ic, advisor/board, student, unknown.'),
        function: z.array(z.string()).optional().describe('Any of: investing, general management, sales, marketing, engineering, product, design, data/ai, operations, finance, people/recruiting, legal, consulting, customer success, media/creative, education/research, healthcare, public sector, other.'),
        tags: z.array(z.string()).optional().describe('Match ANY of: investor, angel, vc, founder, exited founder, executive, operator, advisor, board member, recruiter, consultant, academic, creator, public sector, open to work.'),
        company: z.string().optional().describe('Current company contains (case-insensitive).'),
        past_company: z.string().optional().describe('A past employer in their career contains (only known for people with a web profile).'),
        location: z.string().optional().describe('Location contains, e.g. "Dublin" (from web profiles or the headline).'),
        industry: z.string().optional().describe('Industry contains, e.g. "fintech".'),
        has_web_profile: z.enum(['any', 'none', 'some', 'light', 'deep']).default('any').describe('Filter by web profile depth ("some" = light or deep).'),
        lens: z.string().optional().describe('Lens id or goal (see network_list_lenses). Adds score/reason and enables lens_view/min_score/sort="score".'),
        lens_view: lensViewArg.default('all'),
        min_score: z.number().int().min(0).max(100).optional().describe('Only people scoring at least this in the lens.'),
        crm_status: z.enum(['in_crm', 'new', 'ambiguous', 'error', 'unchecked', 'sent']).optional().describe('Ahoy CRM status from the explorer\'s "Check in Ahoy".'),
        sort: z.enum(['score', 'name', 'connected']).optional().describe('Default: score when a lens is given, else name. "connected" = most recent first.'),
        limit: limitArg(25, 200),
        offset: offsetArg,
        response_format: responseFormat,
      },
      annotations: { title: 'Search my network', ...READ },
    },
    wrap(async (a) => {
      const { people, lenses } = load();
      const lens = a.lens ? lensOrThrow(lenses, a.lens) : undefined;
      if ((a.min_score !== undefined || a.sort === 'score') && !lens) throw new UserError('min_score and sort="score" need a lens. Use network_list_lenses to pick one.');
      const f: SearchFilters = { ...a, lens, lens_view: a.lens_view as LensView };
      const rows = sortPeople(people.filter((p) => matches(p, f)), (a.sort ?? (lens ? 'score' : 'name')) as SortKey, lens);
      const pg = page(rows, a.offset, a.limit);
      return listing(rows, lens, a.response_format, `**${pg.total.toLocaleString()} people** match${lens ? ` · lens “${lens.goal}” (${a.lens_view})` : ''}.`, pg);
    }),
  );

  server.registerTool(
    'network_get_person',
    {
      title: 'Get a person',
      description:
        'Everything known about one person: parsed profile, web profile (career, investments, boards, expertise, recent ' +
        'activity and themes, sources), every lens score with reason and membership, and Ahoy CRM status. Accepts an id, a ' +
        'LinkedIn URL, or a name (if several people match a name you get the candidates with ids).',
      inputSchema: {
        person: z.string().min(1).max(300).describe('Person id (from search), LinkedIn profile URL, or full/partial name.'),
        response_format: z.enum(['markdown', 'json']).default('markdown').describe('markdown (readable) or json (all fields).'),
      },
      annotations: { title: 'Get a person', ...READ },
    },
    wrap(async (a) => {
      const { people, lenses } = load();
      const q = a.person.trim();
      const norm = (u: string) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
      let hits = people.filter((p) => p.id === q);
      if (!hits.length && /linkedin\.com\//i.test(q)) hits = people.filter((p) => p.url && norm(p.url) === norm(q));
      if (!hits.length) hits = people.filter((p) => (p.fullName || '').toLowerCase() === q.toLowerCase());
      if (!hits.length) hits = people.filter((p) => (p.fullName || '').toLowerCase().includes(q.toLowerCase()));
      if (!hits.length) throw new UserError(`Nobody matches "${q}". Try network_search_people with a broader query.`);
      if (hits.length > 1) {
        const pg = page(hits, 0, 20);
        return listing(hits, undefined, 'concise', `"${q}" matches ${hits.length} people — call network_get_person again with one of these ids:`, pg);
      }
      const p = hits[0]!;
      const detail = personDetail(p, lenses);
      return a.response_format === 'json'
        ? ok('```json\n' + JSON.stringify(detail, null, 1) + '\n```', detail)
        : ok(personMarkdown(p, lenses), detail);
    }),
  );

  server.registerTool(
    'network_list_lenses',
    {
      title: 'List lenses',
      description: 'All lenses (goals scored across the network) with id, threshold, member count, scored/stale counts and manual adds/removes. Use the id or goal with other tools.',
      inputSchema: {},
      annotations: { title: 'List lenses', ...READ },
    },
    wrap(async () => {
      const { people, lenses } = load();
      if (!lenses.length) return ok('No lenses yet. Lenses are created in the explorer UI (run `network-builder`, then "New lens").', { lenses: [] });
      const rows = lenses.map((l) => ({
        id: l.id,
        goal: l.goal,
        threshold: thresholdOf(l),
        members: people.filter((p) => isMember(l, p)).length,
        scored: l.scored,
        stale: l.stale,
        added_by_hand: (l.pinnedIn ?? []).length,
        removed_by_hand: (l.pinnedOut ?? []).length,
      }));
      const text = rows
        .map((r) => `- **${r.goal}** (\`${r.id}\`) — ${r.members} in lens at score ≥ ${r.threshold} · ${r.scored} scored${r.stale ? `, ${r.stale} stale` : ''} · ${r.added_by_hand} added / ${r.removed_by_hand} removed by hand`)
        .join('\n');
      return ok(text, { lenses: rows });
    }),
  );

  server.registerTool(
    'network_lens_members',
    {
      title: 'Lens members',
      description: 'People in a lens (or its candidates / removed people), sorted by score with each person\'s reason. Use for "who is in my angel investor list?" or to review near-misses (view="candidates").',
      inputSchema: {
        lens: z.string().min(1).describe('Lens id or goal.'),
        view: lensViewArg.default('in'),
        limit: limitArg(50, 200),
        offset: offsetArg,
        response_format: responseFormat,
      },
      annotations: { title: 'Lens members', ...READ },
    },
    wrap(async (a) => {
      const { people, lenses } = load();
      const lens = lensOrThrow(lenses, a.lens);
      const rows = sortPeople(people.filter((p) => inView(lens, p, a.view as LensView)), 'score', lens);
      const pg = page(rows, a.offset, a.limit);
      return listing(rows, lens, a.response_format, `**${lens.goal}** — ${pg.total} ${a.view === 'in' ? 'members' : a.view} (cut-off ${thresholdOf(lens)}).`, pg);
    }),
  );

  server.registerTool(
    'network_find_connections_at',
    {
      title: 'Find connections at a company',
      description:
        'Who in the network works at — or used to work at — a company. Use for warm intros ("who can introduce me to Stripe?"). ' +
        'Current employer comes from headlines and profiles; past employers are only known for people with a web profile.',
      inputSchema: {
        company: z.string().min(2).max(120).describe('Company name (case-insensitive substring), e.g. "Stripe".'),
        include_past: z.boolean().default(true).describe('Also list people whose career history includes the company.'),
        lens: z.string().optional().describe('Optional lens to show each person\'s fit score.'),
        limit: limitArg(50, 200),
      },
      annotations: { title: 'Find connections at a company', ...READ },
    },
    wrap(async (a) => {
      const { people, lenses } = load();
      const lens = a.lens ? lensOrThrow(lenses, a.lens) : undefined;
      const q = a.company.toLowerCase();
      const current = people.filter((p) => companyOf(p).toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q));
      const curIds = new Set(current.map((p) => p.id));
      const past = a.include_past ? people.filter((p) => !curIds.has(p.id) && pastCompanies(p).toLowerCase().includes(q)) : [];
      const sorter = (rows: ExplorerPerson[]) => sortPeople(rows, lens ? 'score' : 'name', lens).slice(0, a.limit);
      const lines = [`## Connections at “${a.company}”`, '', `### Currently (${current.length})`, ...(current.length ? sorter(current).map((p) => personLine(p, lens)) : ['_None found._'])];
      if (a.include_past) {
        lines.push('', `### Previously (${past.length})`, ...(past.length ? sorter(past).map((p) => personLine(p, lens)) : ['_None found among people with a web profile._']));
      }
      const unprofiled = people.filter((p) => depthOf(p) === 'none').length;
      if (a.include_past && unprofiled) lines.push('', `_Past employers are unknown for the ${unprofiled.toLocaleString()} people without a web profile._`);
      return ok(lines.join('\n'), {
        current: sorter(current).map((p) => personSummary(p, lens)),
        past: sorter(past).map((p) => personSummary(p, lens)),
      });
    }),
  );

  server.registerTool(
    'network_stats',
    {
      title: 'Network overview',
      description: 'Overview of the network: size, profile coverage, web profiles, breakdowns by seniority/function/industry/top companies, lenses, lists and AI spend so far. Good first call to orient.',
      inputSchema: { top: z.number().int().min(3).max(50).default(10).describe('How many entries per breakdown.') },
      annotations: { title: 'Network overview', ...READ },
    },
    wrap(async (a) => {
      const { s, people, lenses } = load();
      const count = (vals: string[]) => {
        const m = new Map<string, number>();
        for (const v of vals) if (v) m.set(v, (m.get(v) ?? 0) + 1);
        return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, a.top).map(([name, n]) => ({ name, n }));
      };
      const light = people.filter((p) => depthOf(p) === 'light').length;
      const deep = people.filter((p) => depthOf(p) === 'deep').length;
      const out = {
        people: people.length,
        headline_profiles: people.filter((p) => p.profile).length,
        web_profiles: { light, deep },
        seniority: count(people.map((p) => p.profile?.seniority ?? '')),
        function: count(people.map((p) => p.profile?.function ?? '')),
        industry: count(people.map((p) => p.profile?.industry ?? '')),
        companies: count(people.map((p) => companyOf(p))),
        locations: count(people.map((p) => locationOf(p))),
        lenses: lenses.map((l) => ({ id: l.id, goal: l.goal, members: people.filter((p) => isMember(l, p)).length })),
        lists: s.listLists().length,
        crm_checked: people.filter((p) => p.crm).length,
        spend_usd: s.explorerCosts(),
      };
      const fmt = (xs: { name: string; n: number }[]) => xs.map((x) => `${x.name} (${x.n})`).join(', ') || '–';
      const text = [
        `**${out.people.toLocaleString()} people** · ${out.headline_profiles.toLocaleString()} headline profiles · web profiles: ${light} light, ${deep} deep`,
        `- **Seniority:** ${fmt(out.seniority)}`,
        `- **Function:** ${fmt(out.function)}`,
        `- **Industry:** ${fmt(out.industry)}`,
        `- **Top companies:** ${fmt(out.companies)}`,
        `- **Locations:** ${fmt(out.locations)}`,
        `- **Lenses:** ${out.lenses.map((l) => `${l.goal} (${l.members} in)`).join('; ') || 'none'}`,
        `- **Lists:** ${out.lists} · **Ahoy-checked:** ${out.crm_checked} · **AI spend so far:** $${out.spend_usd.total.toFixed(2)}`,
      ].join('\n');
      return ok(text, out);
    }),
  );

  server.registerTool(
    'network_list_lists',
    {
      title: 'List saved lists',
      description: 'Saved lists (named selections built in the explorer or with network_save_list) with their sizes.',
      inputSchema: {},
      annotations: { title: 'List saved lists', ...READ },
    },
    wrap(async () => {
      const s = db();
      const lists = s.listLists().map((l) => ({ id: l.id, name: l.name, size: l.ids.length, lens_goal: l.prompt, updated_at: l.updatedAt }));
      if (!lists.length) return ok('No saved lists yet. Create one with network_save_list or "Save as list" in the explorer.', { lists });
      return ok(lists.map((l) => `- **${l.name}** (\`${l.id}\`) — ${l.size} people${l.lens_goal ? ` · lens “${l.lens_goal}”` : ''} · updated ${l.updated_at.slice(0, 10)}`).join('\n'), { lists });
    }),
  );

  server.registerTool(
    'network_get_list',
    {
      title: 'Get a saved list',
      description: 'The people in a saved list, in the list\'s order.',
      inputSchema: {
        list: z.string().min(1).describe('List id or name (case-insensitive).'),
        limit: limitArg(100, 500),
        offset: offsetArg,
        response_format: responseFormat,
      },
      annotations: { title: 'Get a saved list', ...READ },
    },
    wrap(async (a) => {
      const { s, people, lenses } = load();
      const list = s.findList(a.list);
      if (!list) throw new UserError(`No list "${a.list}". Use network_list_lists.`);
      const byId = new Map(people.map((p) => [p.id, p]));
      const rows = list.ids.map((id) => byId.get(id)).filter((p): p is ExplorerPerson => Boolean(p));
      const lensId = s.getMeta(`list_lens:${list.id}`);
      const lens = lensId ? lenses.find((l) => l.id === lensId) : undefined;
      const pg = page(rows, a.offset, a.limit);
      return listing(rows, lens, a.response_format, `**${list.name}** — ${rows.length} people${lens ? ` (lens “${lens.goal}”)` : ''}.`, pg);
    }),
  );

  // ------------------------------------------------------------------ WRITE (local, free, reversible)
  const pinTool = (wantIn: boolean) =>
    wrap(async (a: { lens: string; person_ids: string[] }) => {
      const { s, people, lenses } = load();
      const lens = lensOrThrow(lenses, a.lens);
      const { found, unknown } = knownIds(people, [...new Set(a.person_ids)]);
      const r = pinsFor(lens, found, wantIn);
      if (r.in.length) s.setLensPins(lens.id, r.in, 'in');
      if (r.out.length) s.setLensPins(lens.id, r.out, 'out');
      if (r.clear.length) s.setLensPins(lens.id, r.clear, null);
      const fresh = s.listLenses().find((l) => l.id === lens.id) ?? lens;
      const members = s.listExplorerPeople().filter((p) => isMember(fresh, p)).length;
      const changed = r.in.length + r.out.length + r.clear.length;
      const verb = wantIn ? 'Added' : 'Removed';
      const text =
        `${verb} ${changed} of ${found.length} people ${wantIn ? 'to' : 'from'} “${lens.goal}”` +
        (r.unchanged.length ? ` (${r.unchanged.length} already ${wantIn ? 'in' : 'removed'})` : '') +
        `. The lens now has ${members} members.` +
        (wantIn ? '' : ' Removed people stay out even if re-scored; undo with network_lens_add.') +
        (unknown.length ? ` Unknown ids ignored: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}.` : '');
      return ok(text, { lens_id: lens.id, changed, unchanged: r.unchanged.length, unknown, members });
    });
  const pinInput = {
    lens: z.string().min(1).describe('Lens id or goal.'),
    person_ids: z.array(z.string().min(1)).min(1).max(500).describe('Person ids (from network_search_people / network_lens_members).'),
  };
  server.registerTool(
    'network_lens_add',
    {
      title: 'Add people to a lens',
      description: 'Put people into a lens by hand (they stay in whatever their score). Local and reversible (network_lens_remove). Shows up immediately in the explorer.',
      inputSchema: pinInput,
      annotations: { title: 'Add people to a lens', ...WRITE },
    },
    pinTool(true),
  );
  server.registerTool(
    'network_lens_remove',
    {
      title: 'Remove people from a lens',
      description: 'Take people out of a lens by hand (they move to "removed" and stay out even after re-scoring). Also use it to dismiss candidates. Reversible with network_lens_add.',
      inputSchema: pinInput,
      annotations: { title: 'Remove people from a lens', ...WRITE },
    },
    pinTool(false),
  );

  server.registerTool(
    'network_set_lens_threshold',
    {
      title: 'Set a lens cut-off',
      description: 'Change the score at or above which people are in a lens (manual adds/removes still win). Returns the new member count. Use to tighten ("only 85+") or widen a lens.',
      inputSchema: {
        lens: z.string().min(1).describe('Lens id or goal.'),
        threshold: z.number().int().min(0).max(100).describe('New cut-off, 0–100 (default for new lenses: 70).'),
      },
      annotations: { title: 'Set a lens cut-off', ...WRITE },
    },
    wrap(async (a) => {
      const { s, lenses } = load();
      const lens = lensOrThrow(lenses, a.lens);
      const before = thresholdOf(lens);
      s.setLensThreshold(lens.id, a.threshold);
      const fresh = s.listLenses().find((l) => l.id === lens.id)!;
      const members = s.listExplorerPeople().filter((p) => isMember(fresh, p)).length;
      return ok(`“${lens.goal}”: cut-off ${before} → ${a.threshold}. ${members} people are now in the lens.`, { lens_id: lens.id, before, threshold: a.threshold, members });
    }),
  );

  server.registerTool(
    'network_save_list',
    {
      title: 'Save a list',
      description:
        'Create a named list of people, or replace/append to an existing list with that name. Lists appear in the explorer ' +
        '(Lists menu) and can be exported (network_export or `network-builder export --list`). Pass a lens to use its fit ' +
        'scores in CRM exports.',
      inputSchema: {
        name: z.string().min(1).max(100).describe('List name, e.g. "Q4 investor outreach".'),
        person_ids: z.array(z.string().min(1)).min(1).max(2000).describe('Person ids, in the order you want.'),
        mode: z.enum(['replace', 'append']).default('replace').describe('If a list with this name exists: replace its people, or append new ones.'),
        lens: z.string().optional().describe('Optional lens id/goal to attach (fit columns in exports).'),
      },
      annotations: { title: 'Save a list', ...WRITE, idempotentHint: false },
    },
    wrap(async (a) => {
      const { s, people, lenses } = load();
      const lens = a.lens ? lensOrThrow(lenses, a.lens) : undefined;
      const { found, unknown } = knownIds(people, [...new Set(a.person_ids)]);
      const name = a.name.replace(/\s+/g, ' ').trim();
      const now = new Date().toISOString();
      const existing = s.findList(name);
      let ids = found.map((p) => p.id);
      let id: string;
      let createdAt = now;
      if (existing) {
        id = existing.id;
        createdAt = existing.createdAt;
        ids = a.mode === 'append' ? [...existing.ids, ...ids.filter((x) => !existing.ids.includes(x))] : ids;
      } else {
        const base = slugify(name, 60, 'list');
        id = base;
        for (let n = 2; s.hasList(id); n++) id = `${base.slice(0, 56)}-${n}`;
      }
      s.upsertList({ id, name, ids, createdAt, updatedAt: now }, lens?.goal ?? null);
      if (lens) s.setMeta(`list_lens:${id}`, lens.id);
      const verb = existing ? (a.mode === 'append' ? 'Appended to' : 'Replaced') : 'Created';
      return ok(
        `${verb} list **${name}** (\`${id}\`) — ${ids.length} people.` + (unknown.length ? ` Unknown ids ignored: ${unknown.length}.` : '') +
          ` Export it with network_export (list="${name}").`,
        { list_id: id, name, size: ids.length, unknown },
      );
    }),
  );

  server.registerTool(
    'network_export',
    {
      title: 'Export to CSV',
      description:
        'Write a CSV export to the outputs folder and return the file path(s). Source: explicit person_ids, a saved list, or a ' +
        'lens\'s members. Presets: "crm" (HubSpot/Salesforce-friendly columns + fit score), "full" (every field), "ahoy" ' +
        '(separate Companies / Contacts / Notes CSVs with Ahoy CRM field names). Local only — nothing is uploaded.',
      inputSchema: {
        person_ids: z.array(z.string().min(1)).max(5000).optional().describe('Export exactly these people.'),
        list: z.string().optional().describe('Or: a saved list id/name.'),
        lens: z.string().optional().describe('Or: export this lens\'s members (also sets the fit columns for the other sources).'),
        preset: z.enum(['crm', 'full', 'ahoy']).default('crm'),
        name: z.string().max(80).optional().describe('Used in the file name (default: the list or lens name).'),
      },
      annotations: { title: 'Export to CSV', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrap(async (a) => {
      const { s, people, lenses } = load();
      const lens = a.lens ? lensOrThrow(lenses, a.lens) : undefined;
      const sources = [a.person_ids?.length ? 1 : 0, a.list ? 1 : 0].reduce((x, y) => x + y, 0);
      if (sources > 1) throw new UserError('Pass either person_ids or list (optionally with lens for fit columns), not both.');
      let rows: ExplorerPerson[];
      let label: string;
      let listId: string | null = null;
      const byId = new Map(people.map((p) => [p.id, p]));
      if (a.person_ids?.length) {
        rows = knownIds(people, a.person_ids).found;
        label = a.name || (lens ? lens.goal : 'selection');
      } else if (a.list) {
        const list = s.findList(a.list);
        if (!list) throw new UserError(`No list "${a.list}". Use network_list_lists.`);
        rows = list.ids.map((id) => byId.get(id)).filter((p): p is ExplorerPerson => Boolean(p));
        label = a.name || list.name;
        listId = list.id;
      } else if (lens) {
        rows = sortPeople(people.filter((p) => isMember(lens, p)), 'score', lens);
        label = a.name || lens.goal;
      } else throw new UserError('Nothing to export: pass person_ids, list, or lens.');
      if (!rows.length) throw new UserError('That selection is empty — nothing to export.');
      const fitLens = lens ?? (listId ? lenses.find((l) => l.id === s.getMeta(`list_lens:${listId}`)) : undefined);
      await ensureDir(opts.outDir);
      const out = path.join(opts.outDir, explorerExportFilename(label, rows.length));
      let paths: string[];
      if (a.preset === 'ahoy') {
        const f = toAhoyFiles(rows, fitLens);
        const ap = ahoyPaths(out);
        await writeFileAtomic(ap.companies, f.companies);
        await writeFileAtomic(ap.contacts, f.contacts);
        paths = [ap.companies, ap.contacts];
        if (f.counts.notes) {
          await writeFileAtomic(ap.notes, f.notes);
          paths.push(ap.notes);
        }
      } else {
        await writeFileAtomic(out, toExplorerCsv(rows, a.preset, fitLens, lenses));
        paths = [out];
      }
      try {
        s.recordExport({ listId, name: label, preset: a.preset, path: paths[0]!, count: rows.length });
      } catch {
        /* bookkeeping only */
      }
      return ok(`Exported ${rows.length} people (${a.preset}) to:\n${paths.map((p) => `- ${p}`).join('\n')}`, { count: rows.length, preset: a.preset, paths });
    }),
  );

  // ------------------------------------------------------------------ accounts (ABX)
  registerAccountTools(server, { db, ok, wrap, userError: (m) => new UserError(m) });

  // ------------------------------------------------------------------ prompts
  server.registerPrompt(
    'warm_intro',
    {
      title: 'Warm intro path',
      description: 'Find who in my network can introduce me to a company or person.',
      argsSchema: { target: z.string().describe('Company or person you want to reach, e.g. "Stripe"') },
    },
    ({ target }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text:
            `Using my network-builder tools, find the best warm-intro paths to ${target}. Call network_find_connections_at ` +
            `(and network_search_people for related terms). For the top 5, call network_get_person and explain why each is a good ` +
            `connector (current vs past role, seniority, how recently we connected, anything they've been talking about). ` +
            `Suggest a one-line ask for each. Don't start web research — if someone needs it, tell me to run it in the explorer.`,
        },
      }],
    }),
  );
  server.registerPrompt(
    'lens_shortlist',
    {
      title: 'Shortlist from a lens',
      description: 'Build a ranked, reasoned shortlist from a lens and save it as a list.',
      argsSchema: {
        lens: z.string().describe('Lens id or goal, e.g. "angel investors"'),
        size: z.string().optional().describe('How many people (default 20)'),
      },
    },
    ({ lens, size }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text:
            `From my network-builder lens "${lens}", build a shortlist of the best ${size || '20'} people. Use network_lens_members ` +
            `(view "in", then "candidates" for near-misses), check the most promising with network_get_person, and prefer people ` +
            `with confirmed web profiles. Show the shortlist as a table (name, role, score, one-line why). Then ask me before ` +
            `saving it with network_save_list.`,
        },
      }],
    }),
  );

  return {
    server,
    close: () => {
      store?.close();
      store = undefined;
    },
  };
}

/** `network-builder mcp` — stdio transport. stdout carries the protocol only; logs go to stderr. */
export async function runMcpServer(flags: { db?: string; outDir?: string }): Promise<void> {
  const dbPath = flags.db ? path.resolve(expandHome(flags.db)) : DEFAULT_DB_PATH;
  const outDir = flags.outDir ? path.resolve(expandHome(flags.outDir)) : DEFAULT_OUT_DIR;
  const { server, close } = createNetworkMcpServer({ dbPath, outDir });
  const transport = new StdioServerTransport();
  const shutdown = () => {
    close();
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
  await server.connect(transport);
  process.stderr.write(`[network-builder mcp] serving ${dbPath} over stdio\n`);
}

// re-exported for tests
export { inView, isMember, lensBucket, pinOf, scoreIn };
