import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOrgMap, isMarketingRun, orgMapSources, runListKey } from '../src/accounts/org';
import type { ListRun, OrgMap, OrgNode, SourceRef } from '../src/accounts/types';
import { buildAccountView } from '../src/accounts/view';
import { Store } from '../src/db/store';

// A fictional 15-person Ledgerly org. No real companies or people.
const PEOPLE_TAB = 'https://www.linkedin.com/company/ledgerly/people/?keywords=marketing';
const SEARCH = 'https://www.linkedin.com/search/results/people/?keywords=kommunikation&currentCompany=%5B%221234%22%5D&page=2';

describe('buildOrgMap (marketing org of a fictional Ledgerly)', () => {
  let dir = '';
  let store: Store;
  const ids: Record<string, string> = {};
  let map: OrgMap;

  const add = (key: string, fullName: string, title: string, source: SourceRef) => {
    const r = store.accounts.upsertLightContacts('ledgerly', [{ fullName, title, url: `https://www.linkedin.com/in/${key}-ledgerly`, source }]);
    ids[key] = r.added[0]!;
  };
  const build = () => {
    const v = buildAccountView(store.accounts, store.accounts.get('ledgerly')!, new Map());
    return buildOrgMap(v, orgMapSources(store.accounts, 'ledgerly'));
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nb-orgmap-'));
    store = Store.open(path.join(dir, 'network.db'));
    const acc = store.accounts.create({ name: 'Ledgerly', linkedinUrl: 'https://www.linkedin.com/company/ledgerly' });
    expect(acc.id).toBe('ledgerly');
    const runA = store.accounts.startListRun('ledgerly', { pageKind: 'people-tab', url: PEOPLE_TAB, keywords: 'marketing' });
    const at = '2026-11-01T10:00:00.000Z';
    const listA: SourceRef = { kind: 'extension-list', at, url: PEOPLE_TAB, runId: runA.id };
    add('riley', 'Riley Moss', 'Chief Marketing Officer', listA);
    add('jonas', 'Jonas Müller-Brandt', 'Head of Brand', listA);
    add('ava', 'Ava Lindqvist', 'Brand Manager', listA);
    add('ben', 'Ben Ortiz', 'Senior Content Marketing Manager', listA);
    add('mia', 'Mia Chen', 'Director Demand Generation', listA);
    add('dev', 'Dev Rao', 'Performance Marketing Manager', listA);
    add('noor', 'Noor Haddad', 'Marketing Operations Manager', listA);
    add('lena', 'Lena Vogel', 'Leiterin Unternehmenskommunikation', listA);
    add('tom', 'Tom Becker', 'Pressereferent', listA);
    add('sara', 'Sara Lund', 'Event Manager', listA);
    add('kai', 'Kai Wolf', 'Partner Marketing Manager', listA);
    add('pia', 'Pia Roth', 'HR Marketing Specialist', listA); // people dept + hr-marketing noise → flagged
    add('max', 'Max Kurz', 'Sales Director', listA); // a "Past: marketing" hit from the keyword list → user says not marketing
    add('olga', 'Olga Petrova', 'CEO', { kind: 'manual', at }); // executive, out of scope; the CMO's manager
    add('finn', 'Finn Hale', 'Software Engineer', { kind: 'manual', at }); // out of scope entirely

    const A = store.accounts;
    A.updateMember('ledgerly', ids.riley!, { reportsTo: ids.olga! });
    A.updateMember('ledgerly', ids.jonas!, { reportsTo: ids.riley! });
    A.applyInferredReportsTo('ledgerly', ids.ava!, ids.jonas!, 0.6, 'same team, more senior', 'inferred');
    A.applyInferredReportsTo('ledgerly', ids.ben!, ids.jonas!, 0.45, 'content sits with brand', 'inferred');
    A.applyInferredReportsTo('ledgerly', ids.mia!, ids.riley!, 0.9, 'web: “reports to the CMO” https://ledgerly.example/jobs/1', 'web');
    A.applyInferredReportsTo('ledgerly', ids.dev!, ids.mia!, 0.6, 'same team', 'inferred');
    A.updateMember('ledgerly', ids.lena!, { entity: 'Ledgerly Services GmbH', country: 'de' });
    A.updateMember('ledgerly', ids.tom!, { entity: 'Ledgerly Services GmbH', country: 'DE' });
    A.updateMember('ledgerly', ids.kai!, { noise: 'vendor-funded' });
    A.updateMember('ledgerly', ids.max!, { noise: 'not-marketing' });

    // run A, then the same list again (B): anonymous rows count once (latest run of a list), not 3 + 2
    A.addAnonRows(runA.id, [{ idx: 20 }, { idx: 21 }, { idx: 22 }]);
    A.updateListRun(runA.id, { rowsSeen: 23, anonymous: 3, finishedAt: at, stopReason: 'end' });
    const runB = A.startListRun('ledgerly', { pageKind: 'people-tab', url: `${PEOPLE_TAB}&page=3`, keywords: 'marketing' });
    A.addAnonRows(runB.id, [{ idx: 20 }, { idx: 21 }]);
    A.updateListRun(runB.id, { rowsSeen: 22, anonymous: 2 });
    const runC = A.startListRun('ledgerly', { pageKind: 'search', url: SEARCH, keywords: 'kommunikation' });
    A.updateListRun(runC.id, { rowsSeen: 5, anonymous: 1 });

    A.addHeadcount('ledgerly', { source: 'linkedin-people', scope: 'company', count: 1200, takenAt: '2026-11-01T10:00:00.000Z', runId: runA.id });
    A.addHeadcount('ledgerly', { source: 'linkedin-people', scope: 'company', count: 1250, takenAt: '2026-11-02T10:00:00.000Z', runId: runB.id });
    A.addHeadcount('ledgerly', { source: 'linkedin-people', scope: 'function', label: 'Marketing', count: 40, takenAt: '2026-11-01T10:00:00.000Z', runId: runA.id });
    A.addHeadcount('ledgerly', { source: 'linkedin-people', scope: 'function', label: 'Marketing', count: 44, takenAt: '2026-11-02T10:00:00.000Z', runId: runB.id });
    A.addHeadcount('ledgerly', { source: 'linkedin-people', scope: 'function', label: 'Sales', count: 90, takenAt: '2026-11-02T10:00:00.000Z', runId: runB.id });
    A.addHeadcount('ledgerly', { source: 'linkedin-search', scope: 'query', label: 'kommunikation', count: 30, takenAt: '2026-11-03T10:00:00.000Z', runId: runC.id });
    A.addHeadcount('ledgerly', { source: 'web', scope: 'company', label: 'employees', count: 1300, evidenceUrl: 'https://ledgerly.example/about', quote: '1,300 people' });
    A.addOrgFacts('ledgerly', [
      { kind: 'team', text: 'A central brand team serves all countries.', evidenceUrl: 'https://ledgerly.example/press/1', quote: 'central brand team', confidence: 0.6 },
      { kind: 'entity', text: 'Ledgerly Services GmbH runs group marketing.', evidenceUrl: 'https://ledgerly.example/imprint', quote: 'Ledgerly Services GmbH', confidence: 0.9 },
    ]);
    map = build();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const find = (nodes: OrgNode[], id: string): OrgNode | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const c = find(n.children, id);
      if (c) return c;
    }
    return undefined;
  };
  const kids = (n: OrgNode | undefined) => new Set((n?.children ?? []).map((c) => c.id));

  it('scopes to marketing: marketing titles + everyone from a marketing-keyword list; flagged listed, not counted', () => {
    const inOrg = new Set(map.members);
    for (const k of ['riley', 'jonas', 'ava', 'ben', 'mia', 'dev', 'noor', 'lena', 'tom', 'sara', 'kai']) expect(inOrg.has(ids[k]!), k).toBe(true);
    for (const k of ['pia', 'max', 'olga', 'finn']) expect(inOrg.has(ids[k]!), k).toBe(false);
    expect(Object.fromEntries(map.flagged.map((f) => [f.id, f.noise]))).toEqual({ [ids.pia!]: 'hr-marketing', [ids.max!]: 'not-marketing' });
    expect(map.flagged.some((f) => f.id === ids.kai)).toBe(false); // vendor-funded is a tag, never flagged
    expect(map.headcount.captured).toMatchObject({ total: 11, named: 11, light: 11, full: 0, connections: 0, vendorFunded: 1 });
    expect(map.headcount.captured.bySubfunction['partner-marketing']).toBe(1);
    expect(Object.values(map.headcount.captured.bySeniority).reduce((a, b) => a + b, 0)).toBe(11);
  });

  it('builds the reporting tree with the out-of-scope CEO as a context root and edge provenance', () => {
    expect(map.roots.map((r) => r.id)).toEqual([ids.olga]);
    const olga = map.roots[0]!;
    expect(olga.context).toBe(true);
    expect(kids(olga)).toEqual(new Set([ids.riley]));
    const riley = find(map.roots, ids.riley!)!;
    expect(riley.context).toBeUndefined();
    expect(riley.edge).toEqual({ source: 'user', confidence: 1, reason: '' });
    expect(kids(riley)).toEqual(new Set([ids.jonas, ids.mia]));
    expect(kids(find(map.roots, ids.jonas!))).toEqual(new Set([ids.ava, ids.ben]));
    expect(kids(find(map.roots, ids.mia!))).toEqual(new Set([ids.dev]));
    expect(find(map.roots, ids.jonas!)!.edge).toMatchObject({ source: 'user', confidence: 1 });
    expect(find(map.roots, ids.ava!)!.edge).toEqual({ source: 'inferred', confidence: 0.6, reason: 'same team, more senior' });
    expect(find(map.roots, ids.mia!)!.edge).toMatchObject({ source: 'web', confidence: 0.9 });
    // children: most senior first
    const rk = riley.children.map((c) => c.id);
    expect(rk.indexOf(ids.mia!)).toBeLessThan(rk.indexOf(ids.jonas!)); // director before head
  });

  it('groups people without a known manager by sub-function, then entity', () => {
    const placed = new Set(map.unplaced.flatMap((g) => g.ids));
    expect(placed).toEqual(new Set([ids.noor, ids.lena, ids.tom, ids.sara, ids.kai]));
    const comms = map.unplaced.find((g) => g.subfunction === 'comms-pr')!;
    expect(comms).toMatchObject({ entity: 'Ledgerly Services GmbH' });
    expect(new Set(comms.ids)).toEqual(new Set([ids.lena, ids.tom]));
    expect(map.unplaced.find((g) => g.ids.includes(ids.kai!))!.subfunction).toBe('partner-marketing');
    expect(map.unplaced.find((g) => g.ids.includes(ids.noor!))!.subfunction).toBe('marketing-ops');
    expect(map.entities).toEqual([{ entity: 'Ledgerly Services GmbH', country: 'DE', n: 2 }]);
  });

  it('headcounts: latest snapshot per scope + label, anonymous from the latest run per list, coverage', () => {
    const h = map.headcount;
    expect(h.linkedin.company?.count).toBe(1250);
    expect(h.linkedin.marketing?.count).toBe(44);
    expect(h.linkedin.functions.map((f) => [f.label, f.count])).toEqual([['Sales', 90], ['Marketing', 44]]);
    expect(h.linkedin.queries.map((f) => [f.label, f.count])).toEqual([['kommunikation', 30]]);
    expect(h.web.map((w) => w.count)).toEqual([1300]);
    expect(h.anonymous).toBe(2 + 1); // runs A + B are the same list: only B (latest) counts; C is another list
    expect(h.coverage).toBeCloseTo(11 / 44);
    expect(h.coverageBasis).toBe('function');
    expect(map.facts.map((f) => f.kind)).toEqual(['entity', 'team']); // most confident first
    expect(map.runs).toHaveLength(3);
  });

  it('a user edge replaces an inferred one; resetting to auto unplaces; flagged managers become context nodes', () => {
    store.accounts.updateMember('ledgerly', ids.ava!, { reportsTo: ids.riley! });
    let m = build();
    expect(find(m.roots, ids.ava!)!.edge).toMatchObject({ source: 'user', confidence: 1 });
    expect(kids(find(m.roots, ids.riley!)).has(ids.ava!)).toBe(true);
    store.accounts.updateMember('ledgerly', ids.ava!, { reportsToSource: 'auto' });
    m = build();
    expect(find(m.roots, ids.ava!)).toBeUndefined();
    expect(m.unplaced.some((g) => g.ids.includes(ids.ava!))).toBe(true);
    // someone in the org reporting to a flagged person: the flagged one is shown as context, not counted
    store.accounts.updateMember('ledgerly', ids.sara!, { reportsTo: ids.pia! });
    m = build();
    const pia = find(m.roots, ids.pia!)!;
    expect(pia.context).toBe(true);
    expect(kids(pia)).toEqual(new Set([ids.sara]));
    expect(m.members).not.toContain(ids.pia);
  });

  it('coverage falls back to a marketing query count; no LinkedIn numbers → no coverage', () => {
    const v = buildAccountView(store.accounts, store.accounts.get('ledgerly')!, new Map());
    const src = orgMapSources(store.accounts, 'ledgerly');
    const noFn = buildOrgMap(v, { ...src, headcounts: src.headcounts.filter((x) => x.scope !== 'function') });
    expect(noFn.headcount.coverageBasis).toBe('query');
    expect(noFn.headcount.coverage).toBeCloseTo(11 / 30);
    const none = buildOrgMap(v, { headcounts: [], runs: [], facts: [] });
    expect(none.headcount.coverage).toBeUndefined();
    expect(none.headcount.anonymous).toBe(0);
    // without its marketing-keyword run, a Sales Director from that list is out of scope (not even flagged)
    expect(none.flagged.map((f) => f.id)).toEqual([]);
  });
});

describe('org map helpers', () => {
  it('isMarketingRun: LinkedIn’s "What they do → Marketing" facet (function 15) counts; brand only as a word', () => {
    expect(isMarketingRun({ keywords: '', url: 'https://www.linkedin.com/company/ledgerly/people/?facetCurrentFunction=15' })).toBe(true);
    expect(isMarketingRun({ keywords: '', url: 'https://www.linkedin.com/search/results/people/?functionFacet=%5B%2215%22%5D&currentCompany=%5B%221234%22%5D' })).toBe(true);
    expect(isMarketingRun({ keywords: '', url: 'https://www.linkedin.com/company/ledgerly/people/?facetCurrentFunction=8' })).toBe(false);
    expect(isMarketingRun({ keywords: '', url: 'https://www.linkedin.com/company/ledgerly/people/?facetCurrentFunction=150' })).toBe(false);
    for (const k of ['Brandschutz', 'Brandenburg', 'Brandt']) expect(isMarketingRun({ keywords: k, url: '' }), k).toBe(false);
    for (const k of ['brand', 'Brand Manager', 'branding', 'Brandmanager', 'Marke', 'Markenführung']) expect(isMarketingRun({ keywords: k, url: '' }), k).toBe(true);
  });
  it('isMarketingRun: keywords or URL filters aimed at marketing (EN + DE)', () => {
    expect(isMarketingRun({ keywords: 'marketing', url: '' })).toBe(true);
    expect(isMarketingRun({ keywords: '', url: 'https://www.linkedin.com/search/results/people/?keywords=Unternehmenskommunikation' })).toBe(true);
    expect(isMarketingRun({ keywords: '', url: 'https://www.linkedin.com/company/ledgerly/people/' })).toBe(false);
    expect(isMarketingRun({ keywords: 'engineering', url: '' })).toBe(false);
  });
  it('runListKey: paging and UI flags do not make a new list', () => {
    const a = runListKey({ pageKind: 'search', url: 'https://www.linkedin.com/search/results/people/?keywords=marketing&page=1&origin=X' });
    const b = runListKey({ pageKind: 'search', url: 'https://linkedin.com/search/results/people/?origin=Y&keywords=Marketing&page=4' });
    const c = runListKey({ pageKind: 'search', url: 'https://www.linkedin.com/search/results/people/?keywords=brand' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('LinkedIn counts across entity pages', () => {
  const view = { account: { id: 'x' }, members: [], warmPaths: [], gaps: [] } as unknown as Parameters<typeof buildOrgMap>[0];
  let id = 0;
  const snap = (url: string, scope: 'company' | 'function', count: number, takenAt: string, label = '') =>
    ({ id: ++id, accountId: 'x', takenAt, source: 'linkedin-people', scope, label, count, url, evidenceUrl: '', quote: '', confidence: 0.9, runId: `r${id}` }) as const;
  const A = 'https://www.linkedin.com/company/ledgerly-a/people/';
  const B = 'https://www.linkedin.com/company/ledgerly-b/people/';
  it('sums the latest read of each page (A then B never shows only B); re-reading a page replaces it', () => {
    const m = buildOrgMap(view, {
      runs: [], facts: [],
      headcounts: [
        snap(A, 'company', 900, '2026-11-01'), snap(A, 'company', 1000, '2026-11-05'), snap(B, 'company', 80, '2026-11-06'),
        snap(A, 'function', 380, '2026-11-01', 'Marketing'), snap(A, 'function', 400, '2026-11-05', 'Marketing'),
        snap(B, 'function', 30, '2026-11-06', 'Marketing'), snap(B, 'function', 12, '2026-11-06', 'Sales'),
      ],
    });
    expect(m.headcount.linkedin.company).toMatchObject({ count: 1080, takenAt: '2026-11-06' });
    expect(m.headcount.linkedin.company!.pages.map((p) => p.count)).toEqual([1000, 80]);
    expect(m.headcount.linkedin.marketing).toMatchObject({ label: 'Marketing', count: 430 });
    expect(m.headcount.linkedin.functions.map((f) => [f.label, f.count])).toEqual([['Marketing', 430], ['Sales', 12]]);
  });
  it('function counts from a filtered People tab are ignored; counts-only and empty runs never hide a walk', () => {
    const run = (rid: string, startedAt: string, rowsSeen: number, anonymous: number, stopReason: ListRun['stopReason']) =>
      ({ id: rid, accountId: 'x', pageKind: 'people-tab', url: B, keywords: 'marketing', startedAt, finishedAt: startedAt, updatedAt: startedAt, rowsSeen, named: rowsSeen, anonymous, stopReason }) as const;
    const m = buildOrgMap(view, {
      facts: [],
      headcounts: [snap(A, 'function', 400, '2026-11-01', 'Marketing'), snap(`${A}?keywords=brand`, 'function', 7, '2026-11-09', 'Marketing')],
      runs: [run('c1', '2026-11-09', 0, 0, 'counts-only'), run('e1', '2026-11-08', 0, 0, 'checkpoint'), run('w1', '2026-11-02', 120, 6, 'end')],
    });
    expect(m.headcount.linkedin.marketing?.count).toBe(400);
    expect(m.headcount.anonymous).toBe(6);
    expect(m.runs.map((r) => r.id)).toEqual(['e1', 'w1']);
  });
  it('an abandoned (partial) run never replaces a list’s finished walk for the anonymous count, but stands in when it is the only one', () => {
    const run = (rid: string, url: string, startedAt: string, rowsSeen: number, anonymous: number, stopReason: ListRun['stopReason']) =>
      ({ id: rid, accountId: 'x', pageKind: 'search', url, keywords: 'marketing', startedAt, finishedAt: startedAt, updatedAt: startedAt, rowsSeen, named: rowsSeen, anonymous, stopReason }) as const;
    const S1 = 'https://www.linkedin.com/search/results/people/?keywords=marketing&currentCompany=%5B%221%22%5D';
    const S2 = 'https://www.linkedin.com/search/results/people/?keywords=brand&currentCompany=%5B%221%22%5D';
    const m = buildOrgMap(view, {
      facts: [],
      headcounts: [],
      runs: [run('a1', S1, '2026-11-09', 40, 2, 'abandoned'), run('w1', S1, '2026-11-02', 120, 6, 'end'), run('a2', S2, '2026-11-09', 30, 3, 'abandoned')],
    });
    expect(m.headcount.anonymous).toBe(6 + 3);
    expect(m.runs.map((r) => r.id)).toEqual(['a1', 'w1', 'a2']);
  });
  it('coverage above 100% is capped and flagged', () => {
    const members = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, fullName: `Person ${i}`, title: 'Marketing Manager', headline: '', department: 'marketing', autoDepartment: true, seniority: 'manager',
      subfunction: 'other', noise: '', vendorFunded: false, kind: 'light', sources: [], reportsTo: '', reportsToSource: '', reportsToConfidence: null,
      reportsToReason: '', entity: '', country: '', confidence: null,
    }));
    const m = buildOrgMap({ ...view, members } as unknown as Parameters<typeof buildOrgMap>[0], {
      runs: [], facts: [], headcounts: [snap(A, 'function', 3, '2026-11-01', 'Marketing')],
    });
    expect(m.headcount).toMatchObject({ coverage: 1, coverageOver: true, coverageBasis: 'function' });
  });
});

describe('explorer.html loads nothing from the network', () => {
  it('has no http(s) script / stylesheet / image / iframe sources', () => {
    const html = readFileSync(path.join(__dirname, '../src/web/explorer.html'), 'utf8');
    expect(html).not.toMatch(/<(script|img|iframe|link|source|video|audio)\b[^>]*\b(src|href)\s*=\s*["']?\s*(https?:)?\/\//i);
    expect(html).not.toMatch(/@import\s+(url\()?["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/\bfetch\(\s*["'`]https?:/i);
  });
});
