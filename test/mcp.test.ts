import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/store';
import { inputHash } from '../src/db/hash';
import { createNetworkMcpServer } from '../src/mcp/server';
import type { DossierRecord, LensScore, Person, Profile } from '../src/types';

const mk = (id: string, name: string, title: string, url = `https://www.linkedin.com/in/${id}/`): Person => ({
  id, rowIndex: 0, fullName: name, firstName: name.split(' ')[0]!, lastName: name.split(' ').slice(1).join(' '),
  title, company: '', url, email: '', connectedOn: '2022-0' + (id.charCodeAt(0) % 9 + 1) + '-01', extra: {},
});
const prof = (over: Partial<Profile>): Profile => ({ company: '', role: '', seniority: 'unknown', function: 'other', industry: '', tags: [], region: '', ...over });

let dir = '';
let client: Client;
let close: () => void;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; structuredContent?: any; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), data: r.structuredContent, isError: Boolean(r.isError) };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nb-mcp-'));
  const dbPath = path.join(dir, 'network.db');
  const store = Store.open(dbPath);
  const people = [
    mk('ann', 'Ann Angel', 'Partner at Northwind Ventures'),
    mk('bob', 'Bob Builder', 'Tech Recruiter | Angel Investor'),
    mk('cat', 'Cat Chair', 'Board Chair'),
    mk('dan', 'Dan Dev', 'Engineer at Globex'),
    mk('eve', 'Eve Example', 'Head of Marketing at Globex'),
    mk('eve2', 'Eve Example', 'Designer at Initech'),
  ];
  store.upsertPeople(people, 'test.csv');
  store.setProfile('k-ann', prof({ company: 'Northwind Ventures', role: 'Partner', seniority: 'partner', function: 'investing', industry: 'venture capital', tags: ['investor', 'vc'], region: 'Dublin' }), 'ann');
  store.setProfile('k-bob', prof({ company: 'Hire Co', role: 'Recruiter', seniority: 'senior ic', function: 'people/recruiting', tags: ['recruiter', 'angel'] }), 'bob');
  store.setProfile('k-eve', prof({ company: 'Globex', role: 'Head of Marketing', seniority: 'head of', function: 'marketing', industry: 'saas' }), 'eve');
  store.setProfile('k-dan', prof({ company: 'Globex', role: 'Engineer', seniority: 'ic', function: 'engineering' }), 'dan');
  const dossier: DossierRecord = {
    personId: 'cat', depth: 'deep', status: 'ok', model: 'sonnet', costUsd: 0.1, durationMs: 1, createdAt: '2026-11-01T00:00:00.000Z',
    dossier: {
      identityConfirmed: true, confidence: 'high', oneLiner: 'Former Stripe EMEA VP, now board chair.', currentRole: 'Chair', currentCompany: 'Harbor Group',
      location: 'Dublin, Ireland', career: [{ role: 'VP EMEA', company: 'Stripe', period: '2015–2020', current: false }], education: [],
      investingSummary: 'Angel in fintech', investments: ['Ledgerly'], boards: ['Harbor Group'], expertise: [], notable: [], publicPresence: [],
      recentActivity: [{ date: '2026-09', kind: 'podcast', title: 'Scaling payments', summary: 'On AI agents in fintech', url: '' }],
      recentThemes: ['AI agents in fintech'], sources: [{ title: 's', url: 'https://example.com' }],
    },
  };
  store.addDossier(dossier);
  const lens = store.createLens({ goal: 'potential angel investors', rankModel: 'haiku', rerankModel: '', rerankTop: 0 });
  const all = store.listExplorerPeople();
  const score = (id: string, s: number): LensScore => {
    const p = all.find((x) => x.id === id)!;
    return { lensId: lens.id, personId: id, score: s, reason: `reason ${id}`, basis: 'headline', model: 'haiku', inputHash: inputHash(p), scoredAt: new Date().toISOString() };
  };
  store.setLensScores([score('ann', 95), score('bob', 60), score('cat', 85), score('dan', 5), score('eve', 30), score('eve2', 10)]);
  store.setLensPins(lens.id, ['cat'], 'out'); // removed by hand
  store.close();

  const srv = createNetworkMcpServer({ dbPath, outDir: path.join(dir, 'outputs') });
  close = srv.close;
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([srv.server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('network-builder MCP server', () => {
  it('lists the tools with annotations and the prompts', async () => {
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'network_account_add_people', 'network_account_remove_person', 'network_account_update_person', 'network_create_account',
      'network_export', 'network_find_connections_at', 'network_get_account', 'network_get_contact', 'network_get_list', 'network_get_org_map', 'network_get_person', 'network_lens_add', 'network_lens_members',
      'network_lens_remove', 'network_list_accounts', 'network_list_lenses', 'network_list_lists', 'network_save_list', 'network_search_people', 'network_set_lens_threshold', 'network_stats', 'network_update_account',
    ]);
    const search = tools.find((t) => t.name === 'network_search_people')!;
    expect(search.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'network_lens_add')!.annotations?.readOnlyHint).toBe(false);
    // nothing that spends money is exposed
    expect(names.some((n) => /dossier|profile_build|research|score|ahoy|infer|classify|walk/.test(n))).toBe(false);
    expect(tools.find((t) => t.name === 'network_get_org_map')!.annotations?.readOnlyHint).toBe(true);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(['abx_campaign', 'lens_shortlist', 'warm_intro']);
  });

  it('searches free text across headline, profile and web profile', async () => {
    expect((await call('network_search_people', { query: 'stripe' })).data.people.map((p: any) => p.id)).toEqual(['cat']);
    expect((await call('network_search_people', { query: '"ai agents"' })).data.people.map((p: any) => p.id)).toEqual(['cat']);
    expect((await call('network_search_people', { query: 'globex' })).data.total).toBe(2);
    const r = await call('network_search_people', { function: ['marketing'], company: 'globex' });
    expect(r.data.people.map((p: any) => p.id)).toEqual(['eve']);
    expect((await call('network_search_people', { tags: ['angel'] })).data.people.map((p: any) => p.id)).toEqual(['bob']);
    expect((await call('network_search_people', { has_web_profile: 'deep' })).data.people.map((p: any) => p.id)).toEqual(['cat']);
    expect((await call('network_search_people', { location: 'dublin' })).data.total).toBe(2);
    expect((await call('network_search_people', { past_company: 'stripe' })).data.people.map((p: any) => p.id)).toEqual(['cat']);
  });

  it('applies lens membership exactly like the explorer (threshold, pins, removed hidden from "all")', async () => {
    const members = await call('network_lens_members', { lens: 'angel' });
    expect(members.data.people.map((p: any) => p.id)).toEqual(['ann']); // cat (85) was removed by hand
    expect((await call('network_lens_members', { lens: 'angel', view: 'removed' })).data.people.map((p: any) => p.id)).toEqual(['cat']);
    const all = await call('network_search_people', { lens: 'potential angel investors', lens_view: 'all' });
    expect(all.data.people.map((p: any) => p.id)).not.toContain('cat');
    expect(all.data.people[0].id).toBe('ann'); // sorted by score
    const min = await call('network_search_people', { lens: 'angel', min_score: 50, lens_view: 'all' });
    expect(min.data.people.map((p: any) => p.id)).toEqual(['ann', 'bob']);
  });

  it('pages results', async () => {
    const a = await call('network_search_people', { limit: 2 });
    expect(a.data).toMatchObject({ total: 6, count: 2, has_more: true, next_offset: 2 });
    const last = await call('network_search_people', { limit: 2, offset: 4 });
    expect(last.data).toMatchObject({ count: 2, has_more: false, next_offset: null });
  });

  it('gets a person by id, URL or name and disambiguates', async () => {
    const byId = await call('network_get_person', { person: 'cat' });
    expect(byId.text).toContain('Former Stripe EMEA VP');
    expect(byId.text).toContain('removed by hand');
    expect(byId.data.web_profile.recent_themes).toEqual(['AI agents in fintech']);
    expect((await call('network_get_person', { person: 'https://linkedin.com/in/ann' })).data.id).toBe('ann');
    const two = await call('network_get_person', { person: 'eve example' });
    expect(two.text).toContain('matches 2 people');
    expect(two.data.people).toHaveLength(2);
    const none = await call('network_get_person', { person: 'zzz' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('network_search_people');
  });

  it('gives actionable errors', async () => {
    const r = await call('network_lens_members', { lens: 'marketing' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('network_list_lenses');
    const s = await call('network_search_people', { min_score: 50 });
    expect(s.isError).toBe(true);
  });

  it('adds/removes lens members with minimal pins and changes the threshold', async () => {
    let r = await call('network_lens_add', { lens: 'angel', person_ids: ['bob', 'cat', 'nope'] });
    expect(r.text).toContain('Added 2 of 2');
    expect(r.data.unknown).toEqual(['nope']);
    expect((await call('network_lens_members', { lens: 'angel' })).data.people.map((p: any) => p.id).sort()).toEqual(['ann', 'bob', 'cat']);
    // cat scores 85 ≥ 70 → adding cleared the "out" pin rather than pinning in
    const lenses = await call('network_list_lenses');
    expect(lenses.data.lenses[0]).toMatchObject({ members: 3, added_by_hand: 1, removed_by_hand: 0 });
    r = await call('network_lens_remove', { lens: 'angel', person_ids: ['ann', 'eve'] });
    expect(r.data.members).toBe(2);
    expect((await call('network_lens_members', { lens: 'angel', view: 'removed' })).data.people.map((p: any) => p.id).sort()).toEqual(['ann', 'eve']);
    r = await call('network_set_lens_threshold', { lens: 'angel', threshold: 90 });
    expect(r.data).toMatchObject({ before: 70, threshold: 90 });
  });

  it('saves lists and exports CSVs (crm, ahoy)', async () => {
    let r = await call('network_save_list', { name: 'Q4 outreach', person_ids: ['ann', 'bob'], lens: 'angel' });
    expect(r.data).toMatchObject({ size: 2 });
    r = await call('network_save_list', { name: 'q4 outreach', person_ids: ['eve'], mode: 'append' });
    expect(r.text).toContain('Appended');
    expect(r.data.size).toBe(3);
    const got = await call('network_get_list', { list: 'Q4 outreach' });
    expect(got.data.people.map((p: any) => p.id)).toEqual(['ann', 'bob', 'eve']);
    expect((await call('network_list_lists')).data.lists).toHaveLength(1);

    const crm = await call('network_export', { list: 'Q4 outreach' });
    expect(crm.data.paths).toHaveLength(1);
    const csv = readFileSync(crm.data.paths[0], 'utf8');
    expect(csv).toContain('"Fit Score"');
    expect(csv).toContain('"95"');
    const ahoy = await call('network_export', { lens: 'angel', preset: 'ahoy' });
    expect(ahoy.data.paths.map((p: string) => path.basename(p).replace(/^.*_ahoy-/, ''))).toEqual(['companies.csv', 'contacts.csv', 'notes.csv']);
    for (const p of ahoy.data.paths) expect(existsSync(p)).toBe(true);
    expect((await call('network_export', {})).isError).toBe(true);
  });

  it('reports stats', async () => {
    const r = await call('network_stats');
    expect(r.data).toMatchObject({ people: 6, web_profiles: { light: 0, deep: 1 } });
    expect(r.data.lenses[0]).toMatchObject({ members: 1 });
  });

  it('finds current and past connections at a company', async () => {
    const r = await call('network_find_connections_at', { company: 'Stripe' });
    expect(r.data.current).toHaveLength(0);
    expect(r.data.past.map((p: any) => p.id)).toEqual(['cat']);
    expect((await call('network_find_connections_at', { company: 'globex' })).data.current).toHaveLength(2);
  });

  it('explains a missing database', async () => {
    const srv = createNetworkMcpServer({ dbPath: path.join(dir, 'missing.db'), outDir: dir });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't2', version: '1' });
    await Promise.all([srv.server.connect(a), c.connect(b)]);
    const r = (await c.callTool({ name: 'network_stats', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('network-builder import');
    expect(existsSync(path.join(dir, 'missing.db'))).toBe(false);
    await c.close();
  });
});

describe('marketing org map over MCP (fictional Ledgerly)', () => {
  const PEOPLE_TAB = 'https://www.linkedin.com/company/ledgerly/people/';
  const ids: Record<string, string> = {};
  beforeEach(() => {
    const s = Store.open(path.join(dir, 'network.db'));
    const A = s.accounts;
    A.create({ name: 'Ledgerly', linkedinUrl: 'https://www.linkedin.com/company/ledgerly' });
    const run = A.startListRun('ledgerly', { pageKind: 'search', url: 'https://www.linkedin.com/search/results/people/?keywords=marketing', keywords: 'marketing' });
    const at = '2026-11-01T10:00:00.000Z';
    const add = (key: string, fullName: string, title: string, kind: 'extension-list' | 'manual' = 'extension-list') => {
      const r = A.upsertLightContacts('ledgerly', [{ fullName, title, url: `https://www.linkedin.com/in/${key}-ledgerly`, source: { kind, at, ...(kind === 'extension-list' ? { runId: run.id } : {}) } }]);
      ids[key] = r.added[0]!;
    };
    add('riley', 'Riley Moss', 'Chief Marketing Officer');
    add('jonas', 'Jonas Müller-Brandt', 'Head of Brand');
    add('ava', 'Ava Lindqvist', 'Brand Manager');
    add('pia', 'Pia Roth', 'HR Marketing Specialist');
    add('olga', 'Olga Petrova', 'CEO', 'manual');
    A.updateMember('ledgerly', ids.riley!, { reportsTo: ids.olga! });
    A.updateMember('ledgerly', ids.jonas!, { reportsTo: ids.riley! });
    A.applyInferredReportsTo('ledgerly', ids.ava!, ids.jonas!, 0.6, 'same team, more senior', 'inferred');
    A.updateMember('ledgerly', ids.pia!, { noise: 'hr-marketing' });
    A.updateListRun(run.id, { rowsSeen: 4, named: 4, anonymous: 0, finishedAt: at, stopReason: 'end' });
    A.addHeadcount('ledgerly', { source: 'linkedin-people', scope: 'function', label: 'Marketing', count: 40, url: PEOPLE_TAB, takenAt: at });
    A.addHeadcount('ledgerly', { source: 'linkedin-people', scope: 'company', count: 1200, url: PEOPLE_TAB, takenAt: at });
    A.addOrgFacts('ledgerly', [{ kind: 'team', text: 'Brand and content sit under the CMO.', evidenceUrl: 'https://ledgerly.example/press/new-cmo', quote: 'reporting to the CMO', confidence: 0.9 }]);
    s.close();
  });

  it('returns the tree, headcounts, flagged people and edge provenance (read-only)', async () => {
    const r = await call('network_get_org_map', { account: 'Ledgerly' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('# Marketing org: Ledgerly');
    expect(r.text).toMatch(/In the org \(captured here\) \| 3 \|/);
    expect(r.text).toContain('What they do → Marketing" | 40');
    expect(r.text).toContain('Coverage | 8%');
    expect(r.text).toMatch(/\*\*Olga Petrova\*\* — CEO \(context/);
    expect(r.text).toMatch(/\*\*Jonas Müller-Brandt\*\*.*\[confirmed\]/);
    expect(r.text).toMatch(/\*\*Ava Lindqvist\*\*.*\[inferred 0\.6\] — same team, more senior/);
    expect(r.text).toContain('Pia Roth — HR Marketing Specialist · hr-marketing (set by the user)');
    expect(r.text).toContain('https://ledgerly.example/press/new-cmo');
    const org = r.data.org;
    expect(org.headcount.captured.total).toBe(3);
    expect(org.headcount.linkedin.marketing.count).toBe(40);
    expect(org.flagged).toEqual([{ id: ids.pia, noise: 'hr-marketing' }]);
    expect(org.roots[0].id).toBe(ids.olga);
    expect(org.roots[0].context).toBe(true);
    const ava = r.data.people.find((p: any) => p.id === ids.ava);
    expect(ava).toMatchObject({ reports_to: ids.jonas, reports_to_source: 'inferred', reports_to_confidence: 0.6, line: '[inferred 0.6]', in_org: true });
    // the account document carries a short section with a pointer
    const acc = await call('network_get_account', { account: 'Ledgerly', detail: 'summary' });
    expect(acc.text).toContain('## Marketing org');
    expect(acc.text).toContain('network_get_org_map');
    expect(acc.data.marketing_org).toMatchObject({ in_org: 3, flagged: 1, linkedin_marketing: 40 });
    // an account with no org data says how to load it
    await call('network_create_account', { name: 'Initech' });
    expect((await call('network_get_org_map', { account: 'Initech' })).text).toContain('No marketing org mapped yet');
  });

  it('confirms suggested lines and sets org fields (free, local)', async () => {
    const up = await call('network_account_update_person', {
      account: 'Ledgerly', person: 'Ava Lindqvist', confirm_reports_to: true, subfunction: 'content', team: 'Brand studio',
      entity: 'Ledgerly Services GmbH', country: 'DE', responsibilities: 'Owns the brand book.',
    });
    expect(up.isError).toBe(false);
    expect(up.text).toContain('reports to Jonas Müller-Brandt [confirmed]');
    expect(up.data.member).toMatchObject({ reportsToSource: 'user', subfunction: 'content', autoSubfunction: false, team: 'Brand studio', entity: 'Ledgerly Services GmbH' });
    const r = await call('network_get_org_map', { account: 'Ledgerly' });
    expect(r.text).not.toMatch(/Ava Lindqvist.*\[inferred/);
    expect(r.text).toContain('Ledgerly Services GmbH · DE: 1');
    expect(r.text).toContain('**Ava Lindqvist:** Owns the brand book.');
    // nothing to confirm → an actionable error; "none" brings a flagged person back into the org
    expect((await call('network_account_update_person', { account: 'Ledgerly', person: 'Pia Roth', confirm_reports_to: true })).isError).toBe(true);
    await call('network_account_update_person', { account: 'Ledgerly', person: 'Pia Roth', noise: 'none' });
    expect((await call('network_get_org_map', { account: 'Ledgerly' })).data.org.headcount.captured.total).toBe(4);
  });

  it('a failing confirm saves nothing; country must be a 2-letter code', async () => {
    const bad = await call('network_account_update_person', { account: 'Ledgerly', person: 'Pia Roth', confirm_reports_to: true, team: 'Should not save' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('no reporting line to confirm');
    const pia = (await call('network_get_org_map', { account: 'Ledgerly' })).data.people.find((p: any) => p.id === ids.pia);
    expect(pia.team).toBe('');
    expect((await call('network_account_update_person', { account: 'Ledgerly', person: 'Pia Roth', country: 'D1' })).isError).toBe(true);
    expect((await call('network_account_update_person', { account: 'Ledgerly', person: 'Pia Roth', country: '' })).isError).toBe(false);
  });

  it('keeps big orgs bounded: summary is short and has no per-person data; full caps people at 200', async () => {
    const s = Store.open(path.join(dir, 'network.db'));
    const at = '2026-11-02T10:00:00.000Z';
    const rows = Array.from({ length: 500 }, (_, i) => ({ fullName: `Person ${i} Example`, title: i % 2 ? 'Marketing Manager' : 'Content Marketing Specialist', url: `https://www.linkedin.com/in/person-${i}-example`, source: { kind: 'manual' as const, at } }));
    s.accounts.upsertLightContacts('ledgerly', rows);
    // a deep chain of 6 under the CMO
    const chain = Array.from({ length: 6 }, (_, i) => s.accounts.idForProfileUrl(`https://www.linkedin.com/in/person-${i}-example`).id);
    chain.forEach((id, i) => s.accounts.updateMember('ledgerly', id, { reportsTo: i ? chain[i - 1]! : ids.riley! }));
    s.close();
    const sum = await call('network_get_org_map', { account: 'Ledgerly', detail: 'summary' });
    expect(sum.text.length).toBeLessThan(25_000);
    expect(sum.text).not.toContain('[truncated');
    expect(sum.text).toMatch(/… \d+ more in this group/);
    expect(sum.text).toMatch(/… \d+ more below/);
    expect(sum.text.indexOf('## Flagged')).toBeLessThan(sum.text.indexOf('## Reporting tree'));
    expect(sum.data.people).toBeUndefined();
    expect(sum.data.org.runs).toBeUndefined();
    expect(sum.data.org.headcount.captured.total).toBe(503);
    const full = await call('network_get_org_map', { account: 'Ledgerly' });
    expect(full.data.people).toHaveLength(200);
    expect(full.data.people_total).toBeGreaterThan(500);
    expect(full.data.people_truncated).toBe(true);
    expect(full.text.length).toBeLessThan(26_000);
  });

  it('adds light contacts with source "mcp" and dedupes them on a second call', async () => {
    const contacts = [
      { full_name: 'Sam Okafor', title: 'Content Lead', url: 'https://www.linkedin.com/in/sam-okafor-ledgerly', evidence_url: 'https://ledgerly.example/team' },
      { full_name: 'Noor Haddad', title: 'Marketing Operations Manager' },
    ];
    const first = await call('network_account_add_people', { account: 'Ledgerly', contacts });
    expect(first.isError).toBe(false);
    expect(first.data.light.added).toHaveLength(2);
    const again = await call('network_account_add_people', { account: 'Ledgerly', contacts });
    expect(again.data.light.added).toHaveLength(0);
    expect(again.text).toContain('2 already on it');
    const sam = (await call('network_get_org_map', { account: 'Ledgerly' })).data.people.find((p: any) => p.full_name === 'Sam Okafor');
    expect(sam.sources[0]).toMatchObject({ kind: 'mcp', evidenceUrl: 'https://ledgerly.example/team' });
    // light contacts never enter the network
    expect((await call('network_search_people', { query: 'okafor' })).data.total).toBe(0);
    expect((await call('network_account_add_people', { account: 'Ledgerly', contacts: [{ full_name: 'X Y', evidence_url: 'ftp://x' }] })).isError).toBe(true);
    expect((await call('network_account_add_people', { account: 'Ledgerly' })).isError).toBe(true);
  });

  it('never reaches paid code: nothing the MCP server imports is under src/llm/', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const seen = new Set<string>();
    const walk = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      for (const m of readFileSync(f, 'utf8').matchAll(/(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
        const base = path.resolve(path.dirname(f), m[1]!);
        const hit = [`${base}.ts`, path.join(base, 'index.ts')].find((c) => existsSync(c));
        if (hit) walk(hit);
      }
    };
    walk(path.join(root, 'src/mcp/server.ts'));
    const files = [...seen].map((f) => path.relative(root, f).split(path.sep).join('/'));
    expect(files).toContain('src/accounts/org.ts');
    expect(files.filter((f) => f.startsWith('src/llm/'))).toEqual([]);
  });
});
