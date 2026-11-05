import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      'network_export', 'network_find_connections_at', 'network_get_list', 'network_get_person', 'network_lens_add', 'network_lens_members',
      'network_lens_remove', 'network_list_lenses', 'network_list_lists', 'network_save_list', 'network_search_people', 'network_set_lens_threshold', 'network_stats',
    ]);
    const search = tools.find((t) => t.name === 'network_search_people')!;
    expect(search.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'network_lens_add')!.annotations?.readOnlyHint).toBe(false);
    // nothing that spends money is exposed
    expect(names.some((n) => /dossier|profile_build|research|score|ahoy/.test(n))).toBe(false);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(['lens_shortlist', 'warm_intro']);
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
