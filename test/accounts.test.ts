import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountMarkdown } from '../src/accounts/brief';
import { canonicalCompanyUrl, canonicalProfileUrl, normalizeCompany, parseCapture, parseExperience, sectionsFromText, splitHeadline } from '../src/accounts/capture';
import { classify, departmentFromTitle, tierFromTitle } from '../src/accounts/classify';
import { ingestCapture } from '../src/accounts/ingest';
import type { CapturePayload } from '../src/accounts/types';
import { buildAccountView } from '../src/accounts/view';
import { Store } from '../src/db/store';
import { createNetworkMcpServer } from '../src/mcp/server';
import type { Person } from '../src/types';

const mk = (id: string, name: string, title: string, url = `https://www.linkedin.com/in/${id}`): Person => ({
  id, rowIndex: 0, fullName: name, firstName: name.split(' ')[0]!, lastName: name.split(' ').slice(1).join(' '),
  title, company: '', url, email: '', connectedOn: '2023-01-01', extra: {},
});

/** what the extension sends for a (fictional) Ledgerly CFO */
const capture = (over: Partial<CapturePayload> = {}): CapturePayload => ({
  url: 'https://www.linkedin.com/in/Riley-Moss-ledgerly/?miniProfileUrn=x',
  fullName: 'Riley Moss',
  headline: 'CFO at Ledgerly | ex-Globex',
  location: 'Dublin, Ireland',
  currentCompany: 'Ledgerly',
  about: 'Finance leader scaling B2B SaaS.',
  sections: {
    experience: {
      heading: 'Experience',
      items: [
        {
          lines: ['Chief Financial Officer', 'Ledgerly · Full-time', 'Mar 2022 - Present · 2 yrs 9 mos', 'Dublin, Ireland · Hybrid', 'Leads finance, procurement and IT.'],
          companyUrl: 'https://www.linkedin.com/company/ledgerly/',
        },
        {
          lines: ['Globex', 'Full-time · 6 yrs', 'London'],
          sub: [
            ['VP Finance', 'Jan 2019 - Feb 2022 · 3 yrs 2 mos', 'Ran FP&A.'],
            ['Finance Director', 'Mar 2016 - Dec 2018 · 2 yrs 10 mos'],
          ],
          companyUrl: 'https://www.linkedin.com/company/globex/',
        },
      ],
    },
    education: { heading: 'Education', items: [{ lines: ['Trinity College Dublin', 'BBS, Business', '2008 - 2012'] }] },
    skills: { heading: 'Skills', items: [{ lines: ['Financial Planning'] }, { lines: ['SaaS Metrics'] }] },
  },
  rawText: 'Riley Moss\nCFO at Ledgerly\nAbout\nFinance leader scaling B2B SaaS.',
  ...over,
});

describe('capture parsing', () => {
  it('canonicalises profile and company URLs', () => {
    expect(canonicalProfileUrl('https://linkedin.com/in/Riley-Moss/?x=1')).toBe('https://www.linkedin.com/in/riley-moss');
    expect(canonicalProfileUrl('https://www.linkedin.com/company/ledgerly')).toBe('');
    expect(canonicalCompanyUrl('https://www.linkedin.com/company/Ledgerly/life/')).toBe('https://www.linkedin.com/company/ledgerly');
    expect(normalizeCompany('Ledgerly, Inc.')).toBe('ledgerly');
    expect(normalizeCompany('Initech Ltd')).toBe('initech');
    expect(splitHeadline('VP Sales at Initech | Speaker')).toEqual({ title: 'VP Sales', company: 'Initech' });
  });

  it('parses single and grouped experience, education and other sections', () => {
    const p = parseCapture(capture());
    expect(p.url).toBe('https://www.linkedin.com/in/riley-moss-ledgerly');
    expect(p.title).toBe('Chief Financial Officer');
    expect(p.company).toBe('Ledgerly');
    expect(p.companyUrl).toBe('https://www.linkedin.com/company/ledgerly');
    expect(p.experience).toHaveLength(3);
    expect(p.experience[0]).toMatchObject({ title: 'Chief Financial Officer', company: 'Ledgerly', employmentType: 'Full-time', current: true, location: 'Dublin, Ireland · Hybrid', description: 'Leads finance, procurement and IT.' });
    expect(p.experience[1]).toMatchObject({ title: 'VP Finance', company: 'Globex', current: false, description: 'Ran FP&A.' });
    expect(p.experience[2]).toMatchObject({ title: 'Finance Director', company: 'Globex' });
    expect(p.education).toEqual([{ school: 'Trinity College Dublin', detail: 'BBS, Business · 2008 - 2012' }]);
    expect(p.other.Skills).toEqual(['Financial Planning', 'SaaS Metrics']);
  });

  it('falls back to the page text when LinkedIn markup changed', () => {
    const raw = ['Sam Ortiz', 'Head of IT at Initech', 'About', 'About', 'Runs IT.', 'Experience', 'Head of IT', 'Initech · Full-time', 'Jan 2021 - Present · 3 yrs',
      'IT Manager', 'Initrode', '2017 - 2020', 'Education', 'UCD', 'People also viewed', 'Someone Else'].join('\n');
    const p = parseCapture({ url: 'https://www.linkedin.com/in/sam-ortiz', fullName: 'Sam Ortiz', headline: 'Head of IT at Initech', rawText: raw });
    expect(p.about).toBe('Runs IT.');
    expect(p.experience.map((e) => [e.title, e.company])).toEqual([['Head of IT', 'Initech'], ['IT Manager', 'Initrode']]);
    expect(p.education[0]!.school).toBe('UCD');
    expect(sectionsFromText(raw)['education']).toEqual(['UCD']); // stops at "People also viewed"
  });

  it('rejects non-profile pages and nameless captures with a clear message', () => {
    expect(() => parseCapture(capture({ url: 'https://www.linkedin.com/feed/' }))).toThrow(/profile URL/);
    expect(() => parseCapture(capture({ fullName: '  ' }))).toThrow(/name/);
  });

  it('reads a single role\'s nested description', () => {
    const [e] = parseExperience([{ lines: ['Head of IT', 'Initech', 'Jan 2021 - Present · 3 yrs'], sub: [['Runs IT and security.'], ['Skills: ITIL · Okta']] }]);
    expect(e).toMatchObject({ title: 'Head of IT', company: 'Initech', description: 'Runs IT and security.\nSkills: ITIL · Okta' });
  });

  it('skips grouped companies whose roles are missing', () => {
    expect(parseExperience([{ lines: ['Globex', '5 yrs 2 mos'] }])).toEqual([]);
  });
});

describe('org-chart classification', () => {
  it.each([
    ['Chief Financial Officer', 'finance', 'exec'],
    ['CEO & Co-founder', 'executive', 'exec'],
    ['SVP Engineering', 'engineering', 'vp'],
    ['Vice President, Sales EMEA', 'sales', 'vp'],
    ['Head of Procurement', 'finance', 'director'],
    ['Senior Director, Product Marketing', 'marketing', 'director'],
    ['Engineering Manager', 'engineering', 'manager'],
    ['Data Scientist', 'data-ai', 'ic'],
    ['CISO', 'it-security', 'exec'],
    ['Customer Success Lead', 'customer', 'manager'],
    ['Non-Executive Director', 'board', 'board'],
    ['Founder & Board Member', 'executive', 'exec'],
    ['Board Advisor', 'board', 'board'],
    ['', 'other', 'unknown'],
  ])('%s → %s / %s', (title, dept, tier) => {
    expect(departmentFromTitle(title)).toBe(dept);
    expect(tierFromTitle(title)).toBe(tier);
  });
  it('falls back to the headline profile for vague titles', () => {
    expect(classify('Building things', { company: '', role: '', seniority: 'vp', function: 'product', industry: '', tags: [], region: '' })).toEqual({ department: 'product', tier: 'vp' });
  });
});

describe('accounts store + ingest', () => {
  let dir = '';
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nb-acct-'));
    store = Store.open(path.join(dir, 'network.db'));
    store.upsertPeople([mk('jo-park', 'Jo Park', 'Head of Sales at Ledgerly'), mk('al-vance', 'Al Vance', 'Partner at Northwind Ventures')], 'test.csv');
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the account from the capture, keeps the contact out of the network, and refreshes on re-capture', () => {
    const r = ingestCapture(store.accounts, { profile: capture(), role: 'decision-maker', notes: 'Met at SaaStock' });
    expect(r.createdAccount).toBe(true);
    expect(r.account).toMatchObject({ name: 'Ledgerly', linkedinUrl: 'https://www.linkedin.com/company/ledgerly' });
    expect(r.isConnection).toBe(false);
    // the network (people table, explorer list) is untouched
    expect(store.listExplorerPeople().map((p) => p.fullName).sort()).toEqual(['Al Vance', 'Jo Park']);

    const again = ingestCapture(store.accounts, { profile: capture({ headline: 'CFO at Ledgerly' }), accountName: 'ledgerly inc', notes: 'Follow up in Q1' });
    expect(again.createdAccount).toBe(false);
    expect(again.addedToAccount).toBe(false);
    expect(store.accounts.list()).toHaveLength(1);
    const m = store.accounts.members(r.account.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ role: 'decision-maker', notes: 'Met at SaaStock\nFollow up in Q1' });
    expect(store.accounts.getContact(m[0]!.personId)!.captureCount).toBe(2);
  });

  it('files a captured connection under their existing person id', () => {
    const r = ingestCapture(store.accounts, {
      profile: capture({ url: 'https://www.linkedin.com/in/jo-park/', fullName: 'Jo Park', currentCompany: 'Ledgerly', sections: {} }),
    });
    expect(r.isConnection).toBe(true);
    expect(store.getPeople([r.contact.id]).get(r.contact.id)?.fullName).toBe('Jo Park');
  });

  it('builds the org chart view with warm paths, gaps and reporting lines', () => {
    const r = ingestCapture(store.accounts, { profile: capture(), role: 'decision-maker' });
    const id = r.account.id;
    const ann = ingestCapture(store.accounts, {
      profile: { url: 'https://www.linkedin.com/in/ann-lee-x', fullName: 'Ann Lee', headline: 'Procurement Manager at Ledgerly' },
      accountId: id,
    });
    store.accounts.updateMember(id, ann.contact.id, { reportsTo: r.contact.id, role: 'gatekeeper' });
    expect(() => store.accounts.updateMember(id, r.contact.id, { reportsTo: ann.contact.id })).toThrow(/loop/);
    expect(() => store.accounts.updateMember(id, r.contact.id, { role: 'boss' as never })).toThrow(/role must be/);

    const people = new Map(store.listExplorerPeople().map((p) => [p.id, p]));
    const v = buildAccountView(store.accounts, store.accounts.get(id)!, people);
    expect(v.members.map((m) => [m.fullName, m.department, m.tier])).toEqual([
      ['Riley Moss', 'finance', 'exec'],
      ['Ann Lee', 'finance', 'manager'],
    ]);
    expect(v.warmPaths.map((w) => [w.fullName, w.relation])).toEqual([['Jo Park', 'current']]);
    expect(v.gaps).toContain('No champion yet');
    expect(v.gaps).not.toContain('No decision maker identified');

    const md = accountMarkdown(v);
    expect(md).toContain('# Account: Ledgerly');
    expect(md).toContain('**Decision maker:** Riley Moss (Chief Financial Officer)');
    expect(md).toContain('reports to Riley Moss');
    expect(md).toContain('VP Finance at Globex');
    expect(md).toContain('Jo Park');

    // removing a manager clears reporting lines that pointed at them
    store.accounts.removeMember(id, r.contact.id);
    expect(store.accounts.members(id)[0]!.reportsTo).toBe('');
  });

  it('validates account fields and refuses duplicate names', () => {
    store.accounts.create({ name: 'Initech', domain: 'https://www.initech.example/about' });
    expect(store.accounts.find('initech ltd')!.domain).toBe('initech.example');
    expect(() => store.accounts.create({ name: 'Initech, Inc.' })).toThrow(/already exists/);
    expect(() => store.accounts.create({ name: 'X', linkedinUrl: 'https://example.com' })).toThrow(/linkedin/i);
    expect(() => store.accounts.create({ name: 'Y', status: 'hot' as never })).toThrow(/status/);
  });
});

describe('account MCP tools', () => {
  let dir = '';
  let client: Client;
  let close: () => void;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; structuredContent?: any; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), data: r.structuredContent, isError: Boolean(r.isError) };
  };
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nb-acct-mcp-'));
    const dbPath = path.join(dir, 'network.db');
    const s = Store.open(dbPath);
    s.upsertPeople([mk('jo-park', 'Jo Park', 'Head of Sales at Ledgerly')], 'test.csv');
    ingestCapture(s.accounts, { profile: capture(), role: 'decision-maker' });
    s.close();
    const mcp = createNetworkMcpServer({ dbPath, outDir: path.join(dir, 'out') });
    close = mcp.close;
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 't', version: '0' });
    await Promise.all([mcp.server.connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gets an account by name with full profiles, and keeps captured people out of network search', async () => {
    const r = await call('network_get_account', { account: 'ledgerly' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('## Org chart');
    expect(r.text).toContain('Leads finance, procurement and IT.');
    expect(r.data.warm_paths.map((w: any) => w.fullName)).toEqual(['Jo Park']);
    expect((await call('network_search_people', { query: 'riley' })).data.total).toBe(0);
    expect((await call('network_list_accounts')).text).toContain('**Ledgerly**');
    const c = await call('network_get_contact', { account: 'Ledgerly', person: 'riley' });
    expect(c.text).toContain('Ran FP&A.');
    expect((await call('network_get_account', { account: 'Nope' })).isError).toBe(true);
  });

  it('adds connections, sets roles and reporting lines, appends to the brief', async () => {
    const jo = (await call('network_get_account', { account: 'Ledgerly' })).data.warm_paths[0].id;
    const add = await call('network_account_add_people', { account: 'Ledgerly', people: [jo, 'https://www.linkedin.com/in/stranger'], role: 'champion' });
    expect(add.data.added).toEqual([jo]);
    expect(add.data.unknown).toHaveLength(1);
    const up = await call('network_account_update_person', { account: 'Ledgerly', person: 'Jo Park', reports_to: 'Riley Moss' });
    expect(up.text).toContain('reports to Riley Moss');
    await call('network_update_account', { account: 'Ledgerly', brief: 'Why now: new CFO.', brief_mode: 'replace' });
    await call('network_update_account', { account: 'Ledgerly', brief: 'Plan: exec dinner.' });
    const md = (await call('network_get_account', { account: 'Ledgerly', detail: 'summary' })).text;
    expect(md).toContain('Why now: new CFO.\n\nPlan: exec dinner.');
    expect(md).toContain('**Champion:** Jo Park');
    const res = await client.readResource({ uri: 'account://ledgerly' });
    expect((res.contents[0] as { text: string }).text).toContain('# Account: Ledgerly');
  });
});
