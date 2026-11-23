import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_NOISE_FLAGS, SENIORITIES, SUBFUNCTIONS } from '../src/accounts/types';
import type { OrgMemberInput, RuleMember } from '../src/llm/org-infer';

// runClaude is mocked: these tests never call the real Claude Code CLI.
const runClaude = vi.fn();
vi.mock('../src/llm/claude', async (orig) => ({
  ...(await orig<typeof import('../src/llm/claude')>()),
  runClaude: (...a: unknown[]) => runClaude(...a),
}));

const { buildArgs, ClaudeError } = await import('../src/llm/claude');
const { buildOrgClassifyPrompt, buildOrgReportingPrompt, normalizeInference, runOrgInference, suggestManagersRuleBased, cleanEdges, estimateOrgInferUsd, ORG_INFER_USD_PER_100, ORG_INFER_MIN_USD, ORG_MIN_EDGE_CONFIDENCE } =
  await import('../src/llm/org-infer');
const { ORG_CLASSIFY_SCHEMA, ORG_REPORTING_SCHEMA } = await import('../src/llm/schemas');
const { createCostTracker } = await import('../src/llm/costs');

const account = { name: 'Ledgerly', aliases: ['Ledgerly Group'], domain: 'ledgerly.example' };
const mem = (id: string, title: string, over: Partial<OrgMemberInput> = {}): OrgMemberInput => ({
  id, title, headline: `${title} at Ledgerly`, location: 'Munich, Germany', company: 'Ledgerly', department: 'marketing',
  subfunction: 'other', autoSubfunction: true, seniority: 'unknown', entity: '', country: '', team: '', reportsTo: '', reportsToSource: '', noise: '', autoNoise: true,
  ...over,
});
const ok = (data: unknown, costUsd = 0.004) => ({ data, costUsd, durationMs: 1, rawResult: '' });
const inf = (id: string, subfunction: string, seniority: string, extra: Record<string, unknown> = {}) => ({
  id, subfunction, seniority, noise: '', team: '', entity: '', country: 'DE', responsibilities: '', confidence: 0.6, reason: 'title', ...extra,
});

beforeEach(() => runClaude.mockReset());

describe('org inference prompts + schemas', () => {
  it('classify prompt uses local ids, no names, caps the about text, and lists the vocab', () => {
    const long = 'Owns the brand platform. '.repeat(60);
    const p = buildOrgClassifyPrompt(account, [
      { ...mem('x1', 'Head of Brand'), profile: { about: long, experience: [{ current: true, description: 'Leads the Brand Studio.' }] } },
      mem('x2', 'Werkstudent Marketing'),
    ]);
    expect(p).toContain('"id":"p0","title":"Head of Brand"');
    expect(p).toContain('"id":"p1","title":"Werkstudent Marketing"');
    expect(p).not.toContain('x1');
    expect(p).toContain('Company: Ledgerly / Ledgerly Group (ledgerly.example)');
    const about = /"about":"([^"]*)"/.exec(p)![1]!;
    expect(about.length).toBeLessThanOrEqual(600);
    for (const v of [...SUBFUNCTIONS, ...SENIORITIES, ...ORG_NOISE_FLAGS]) expect(p).toContain(`"${v}"`);
    // Phase 2b rules: vendor-funded is a tag (in the org, partner-marketing); other-employer is noise; blank company is not
    expect(p).not.toContain('"vendor-funded"');
    expect(p).toMatch(/vendorFunded: true when the person works for THIS company/);
    expect(p).toMatch(/They ARE part of the marketing org: noise "", subfunction "partner-marketing"/);
    expect(p).toMatch(/other-employer = their current company is CLEARLY a different company/);
    expect(p).toMatch(/A blank or vague company .* is NOT\s+other-employer/);
  });

  it('schema enums match the shared vocabulary', () => {
    const item = (ORG_CLASSIFY_SCHEMA as any).properties.results.items.properties;
    expect(item.subfunction.enum).toEqual([...SUBFUNCTIONS]);
    expect(item.seniority.enum).toEqual([...SENIORITIES]);
    expect(item.noise.enum).toEqual(['', ...ORG_NOISE_FLAGS]);
    expect(item.noise.enum).toContain('other-employer');
    expect(item.noise.enum).not.toContain('vendor-funded');
    expect(item.vendorFunded).toEqual({ type: 'boolean' });
    expect((ORG_CLASSIFY_SCHEMA as any).properties.results.items.required).toContain('vendorFunded');
    expect((ORG_REPORTING_SCHEMA as any).properties.edges.items.required).toEqual(['id', 'managerId', 'confidence', 'reason']);
    expect(ORG_INFER_USD_PER_100).toBeCloseTo(0.06);
    // calibrated: a live run on 12 people cost $0.0075 → the estimate must not be far below that
    expect(estimateOrgInferUsd(12)).toBeGreaterThanOrEqual(0.0072);
    expect(estimateOrgInferUsd(1)).toBe(ORG_INFER_MIN_USD);
    expect(estimateOrgInferUsd(200)).toBeCloseTo(0.12);
    expect(estimateOrgInferUsd(0)).toBe(0);
  });

  it('reporting prompt marks confirmed lines and lists the ids to do', () => {
    const p = buildOrgReportingPrompt(account, [
      { id: 'p0', title: 'CMO', seniority: 'c-level', subfunction: 'leadership', entity: '', country: 'DE', location: 'Munich' },
      { id: 'p1', title: 'Head of Brand', seniority: 'head', subfunction: 'brand', entity: '', country: 'DE', location: 'Munich', fixedManager: 'p0' },
    ], ['p1']);
    expect(p).toContain('"id":"p1","title":"Head of Brand","seniority":"head","subfunction":"brand","country":"DE","location":"Munich","reportsTo":"p0"');
    expect(p).toContain('Return one edge for each of these ids: p1');
    // entity, then sub-function, then country (a comms IC belongs under the comms head, not the country lead)
    expect(p).toContain('Prefer a manager in the same entity, then the same sub-function, then the same country, then the head of marketing.');
  });

  it('claude -p args for the job: no tools, strict MCP config, never --bare', () => {
    const args = buildArgs({ prompt: 'x', model: 'haiku', jsonSchema: ORG_CLASSIFY_SCHEMA, tools: [] });
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(-2)).toEqual(['--tools', '']);
    expect(args).not.toContain('--bare');
    expect(args).toEqual(['-p', '--model', 'haiku', '--output-format', 'json', '--json-schema', JSON.stringify(ORG_CLASSIFY_SCHEMA),
      '--no-session-persistence', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--tools', '']);
  });

  it('normalizes bad enums and caps fields', () => {
    const n = normalizeInference(
      { subfunction: 'wizardry', seniority: 'Overlord', noise: 'maybe', country: 'Germany', confidence: 7, responsibilities: 'x'.repeat(500), team: ' Brand  Studio ' },
      'haiku', 't',
    );
    expect(n).toMatchObject({ subfunction: 'other', seniority: 'unknown', noise: '', country: '', confidence: 1, team: 'Brand Studio', model: 'haiku', at: 't' });
    expect(n.responsibilities).toHaveLength(240);
    expect(normalizeInference({ subfunction: 'Brand', seniority: 'HEAD', noise: 'hr-marketing', country: 'de' }, 'haiku', 't'))
      .toMatchObject({ subfunction: 'brand', seniority: 'head', noise: 'hr-marketing', country: 'DE' });
  });

  it('vendor-funded is a tag: partner-marketing, never noise; other-employer is noise and never tagged', () => {
    expect(normalizeInference({ subfunction: 'brand', seniority: 'manager', noise: '', vendorFunded: true }, 'haiku', 't'))
      .toMatchObject({ subfunction: 'partner-marketing', noise: '', vendorFunded: true });
    // a model answering the pre-2b way
    expect(normalizeInference({ subfunction: 'brand', seniority: 'manager', noise: 'vendor-funded' }, 'haiku', 't'))
      .toMatchObject({ subfunction: 'partner-marketing', noise: '', vendorFunded: true });
    expect(normalizeInference({ subfunction: 'brand', seniority: 'manager', noise: 'other-employer', vendorFunded: true }, 'haiku', 't'))
      .toMatchObject({ subfunction: 'brand', noise: 'other-employer', vendorFunded: false });
    expect(normalizeInference({ subfunction: 'brand', seniority: 'manager', noise: '', vendorFunded: false }, 'haiku', 't'))
      .toMatchObject({ subfunction: 'brand', vendorFunded: false });
  });

  it('classify prompt lists known entities of the account', () => {
    const p = buildOrgClassifyPrompt({ ...account, entities: ['Ledgerly Services GmbH', 'Ledgerly UK Ltd'] }, [mem('x1', 'Brand Manager')]);
    expect(p).toContain('Known entities of this company: Ledgerly Services GmbH; Ledgerly UK Ltd');
  });
});

describe('rule-based managers (fictional 8-person Ledgerly org)', () => {
  const org: RuleMember[] = [
    { id: 'cmo', seniority: 'c-level', subfunction: 'leadership', entity: 'Ledgerly AG', department: 'marketing' },
    { id: 'brand-head', seniority: 'head', subfunction: 'brand', entity: 'Ledgerly AG', department: 'marketing' },
    { id: 'brand-ic', seniority: 'ic', subfunction: 'brand', entity: 'Ledgerly AG', department: 'marketing' },
    { id: 'brand-sm', seniority: 'senior-manager', subfunction: 'brand', entity: 'Ledgerly AG', department: 'marketing' },
    { id: 'dg-mgr', seniority: 'manager', subfunction: 'demand-gen', entity: 'Ledgerly AG', department: 'marketing' },
    { id: 'uk-dir', seniority: 'director', subfunction: 'field-marketing', entity: 'Ledgerly UK Ltd', department: 'marketing' },
    { id: 'uk-ic', seniority: 'ic', subfunction: 'content', entity: 'Ledgerly UK Ltd', department: 'marketing' },
    { id: 'cfo', seniority: 'c-level', subfunction: 'other', entity: 'Ledgerly AG', department: 'finance' },
  ];
  it('team head → entity head → overall head, with the scale confidences', () => {
    const e = Object.fromEntries(suggestManagersRuleBased(org).map((x) => [x.id, [x.managerId, x.confidence]]));
    expect(e).toEqual({
      'brand-head': ['cmo', 0.45], // most senior in brand → most senior marketing in the entity
      'brand-ic': ['brand-head', 0.6],
      'brand-sm': ['brand-head', 0.5], // one step below: weaker
      'dg-mgr': ['cmo', 0.45], // alone in demand gen
      'uk-dir': ['cmo', 0.3], // heads the UK entity → overall head
      'uk-ic': ['uk-dir', 0.45],
    });
    // the CMO has nobody above; the CFO isn't in marketing
  });
  it('confirmed lines and non-targets are left alone', () => {
    const fixed = org.map((m) => (m.id === 'brand-ic' ? { ...m, fixed: true } : m));
    const ids = suggestManagersRuleBased(fixed, new Set(['brand-ic', 'uk-ic'])).map((x) => x.id);
    expect(ids).toEqual(['uk-ic']);
  });
  it('cleanEdges drops unknown ids, self lines and loops (keeping the more confident edge)', () => {
    const known = new Set(['a', 'b', 'c']);
    const out = cleanEdges(
      [
        { id: 'a', managerId: 'b', confidence: 0.6, reason: '', source: 'llm' },
        { id: 'b', managerId: 'a', confidence: 0.3, reason: '', source: 'llm' }, // loop with the stronger a→b
        { id: 'c', managerId: 'c', confidence: 0.9, reason: '', source: 'llm' }, // self
        { id: 'z', managerId: 'a', confidence: 0.9, reason: '', source: 'llm' }, // unknown
        { id: 'c', managerId: 'zz', confidence: 0.9, reason: '', source: 'llm' }, // unknown manager
      ],
      known,
      new Map(),
    );
    expect(out.map((e) => `${e.id}>${e.managerId}`)).toEqual(['a>b']);
    // a fixed line c→a makes a→c a loop
    expect(cleanEdges([{ id: 'a', managerId: 'c', confidence: 0.6, reason: '', source: 'llm' }], known, new Map([['c', 'a']]))).toEqual([]);
  });
});

describe('runOrgInference (stubbed runClaude)', () => {
  const members = [
    mem('m-cmo', 'Chief Marketing Officer', { seniority: 'c-level', subfunction: 'leadership' }),
    mem('m-brand', 'Head of Brand', { seniority: 'head' }),
    mem('m-dg', 'Demand Gen Manager', { seniority: 'manager' }),
    mem('m-user', 'Content Lead', { seniority: 'lead', reportsTo: 'm-brand', reportsToSource: 'user' }),
  ];

  it('classifies in batches, retries missing ids once, normalizes enums, cleans edges, sums cost incl. failures', async () => {
    runClaude
      // batch 1 (m-cmo, m-brand): only p0 answered + garbage id → retry for m-brand
      .mockResolvedValueOnce(ok({ results: [inf('p0', 'leadership', 'c-level'), inf('p7', 'brand', 'head')] }))
      // retry for m-brand: bad enums
      .mockResolvedValueOnce(ok({ results: [inf('p0', 'brandish', 'boss', { noise: 'eh', country: 'Bavaria' })] }))
      // batch 2 (m-dg, m-user) fails outright (after its own retries), with spend
      .mockRejectedValueOnce(new ClaudeError('overloaded', { costUsd: 0.002 }))
      // reporting: an edge to an unknown id, a self-line, a loop and a good one; m-user is fixed and not asked
      .mockResolvedValueOnce(ok({
        edges: [
          { id: 'p1', managerId: 'p0', confidence: 0.6, reason: 'brand under CMO' },
          { id: 'p0', managerId: 'p1', confidence: 0.2, reason: 'loop' },
          { id: 'p2', managerId: 'p99', confidence: 0.9, reason: 'unknown' },
          { id: 'p3', managerId: 'p0', confidence: 0.9, reason: 'fixed person' },
        ],
      }));
    const progress: string[] = [];
    const r = await runOrgInference({
      account, members, batchSize: 2, concurrency: 1, costs: createCostTracker(), onProgress: (p) => progress.push(`${p.phase}:${p.done}/${p.total}`),
    });
    expect(runClaude).toHaveBeenCalledTimes(4);
    for (const c of runClaude.mock.calls) expect(c[0]).toMatchObject({ model: 'haiku', tools: [] });
    expect(r.classified.get('m-cmo')).toMatchObject({ subfunction: 'leadership', seniority: 'c-level', model: 'haiku' });
    expect(r.classified.get('m-brand')).toMatchObject({ subfunction: 'other', seniority: 'unknown', noise: '', country: '' });
    expect(r.classified.has('m-dg')).toBe(false);
    expect(r.failedBatches).toBe(1);
    expect(r.edges.map((e) => `${e.id}>${e.managerId}`)).toEqual(['m-brand>m-cmo']);
    expect(r.costUsd).toBeCloseTo(0.004 * 3 + 0.002);
    // progress counts people throughout (never batches)
    expect(progress).toEqual(['classify:0/4', 'classify:2/4', 'classify:4/4', 'reporting:0/4', 'reporting:4/4']);
    // the reporting roster lists the user's line as fixed and never asks for it
    const rp = runClaude.mock.calls[3]![0].prompt as string;
    expect(rp).toContain('"reportsTo":"p');
    expect(rp).toMatch(/Return one edge for each of these ids: (p\d, ){2}p\d\n/);
  });

  it('falls back to the title rules when the reporting call fails', async () => {
    runClaude
      .mockResolvedValueOnce(ok({ results: [inf('p0', 'brand', 'head'), inf('p1', 'demand-gen', 'manager'), inf('p2', 'content', 'lead')] }))
      .mockRejectedValueOnce(new ClaudeError('bad', { costUsd: 0.001 }));
    // the rules only place people within a known entity (no entity → no rule-based guess)
    const r = await runOrgInference({ account, members: members.map((m) => ({ ...m, entity: 'Ledgerly AG' })), ids: ['m-brand', 'm-dg', 'm-user'] });
    expect(r.reportingFallback).toBe(true);
    expect(r.edges.map((e) => [e.id, e.managerId, e.source])).toEqual([
      ['m-brand', 'm-cmo', 'rules'],
      ['m-dg', 'm-cmo', 'rules'],
    ]);
    expect(r.costUsd).toBeCloseTo(0.005);
  });

  it('people flagged as noise get no manager and manage nobody', async () => {
    const team = [
      ...members.slice(0, 3),
      mem('m-hr', 'HR Marketing Specialist', { seniority: 'ic', noise: 'hr-marketing' }),
      mem('m-vendor', 'Marketing Director', { seniority: 'director', noise: 'other-employer', autoNoise: false, company: 'Globex Inc' }),
    ];
    runClaude
      .mockResolvedValueOnce(ok({ results: [
        inf('p0', 'leadership', 'c-level'), inf('p1', 'brand', 'head'), inf('p2', 'demand-gen', 'manager', { noise: 'not-marketing' }),
        inf('p3', 'other', 'ic', { noise: 'hr-marketing' }), inf('p4', 'leadership', 'director', { noise: '' }), // the user's flag wins
      ] }))
      .mockResolvedValueOnce(ok({ edges: [
        { id: 'p1', managerId: 'p0', confidence: 0.6, reason: 'ok' },
        { id: 'p2', managerId: 'p0', confidence: 0.6, reason: 'should not be asked' },
      ] }));
    const r = await runOrgInference({ account, members: team });
    const rp = runClaude.mock.calls[1]![0].prompt as string;
    expect(rp).not.toContain('HR Marketing Specialist');
    expect(rp).not.toContain('Marketing Director');
    expect(rp).not.toContain('Demand Gen Manager'); // newly flagged not-marketing
    expect(r.edges.map((e) => `${e.id}>${e.managerId}`)).toEqual(['m-brand>m-cmo']);
  });

  it('vendor-funded people stay in the roster and get a manager; other-employer people do not', async () => {
    const team = [
      ...members.slice(0, 2),
      mem('m-pm', 'Partner Marketing Manager for Globex Inc', { seniority: 'manager' }),
      mem('m-globex', 'Partner Marketing Manager', { seniority: 'manager', company: 'Globex Inc' }),
    ];
    runClaude
      .mockResolvedValueOnce(ok({ results: [
        // classify batch = the ids asked for: m-brand, m-pm, m-globex
        inf('p0', 'brand', 'head'),
        inf('p1', 'brand', 'manager', { vendorFunded: true }), inf('p2', 'partner-marketing', 'manager', { noise: 'other-employer' }),
      ] }))
      // roster by seniority: p0 m-cmo, p1 m-brand, p2 m-pm (m-globex is noise, not listed)
      .mockResolvedValueOnce(ok({ edges: [
        { id: 'p1', managerId: 'p0', confidence: 0.6, reason: 'ok' },
        { id: 'p2', managerId: 'p0', confidence: 0.6, reason: 'partner marketing under the CMO' },
      ] }));
    const r = await runOrgInference({ account, members: team, ids: ['m-brand', 'm-pm', 'm-globex'] });
    expect(r.classified.get('m-pm')).toMatchObject({ subfunction: 'partner-marketing', noise: '', vendorFunded: true });
    expect(r.classified.get('m-globex')).toMatchObject({ noise: 'other-employer', vendorFunded: false });
    const rp = runClaude.mock.calls[1]![0].prompt as string;
    expect(rp).toContain('Partner Marketing Manager for Globex Inc');
    expect(rp).toContain('"subfunction":"partner-marketing"');
    expect(rp).not.toContain('"title":"Partner Marketing Manager"');
    expect(r.edges.map((e) => `${e.id}>${e.managerId}`).sort()).toEqual(['m-brand>m-cmo', 'm-pm>m-cmo']);
  });

  it('an abort rejects with the spend so far', async () => {
    const ctl = new AbortController();
    runClaude.mockImplementationOnce(async () => {
      ctl.abort();
      const e = new ClaudeError('Aborted', { costUsd: 0.003, costIncomplete: true });
      e.name = 'AbortError';
      throw e;
    });
    const err = await runOrgInference({ account, members, signal: ctl.signal }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(err.details.costUsd).toBeCloseTo(0.003);
  });
});

describe('regional leads never collect central / foreign staff (fictional Ledgerly)', () => {
  // a regional subsidiary's marketing lead is the most senior person captured; the real head of marketing is not
  const team = [
    mem('lead', 'Marketingleitung', { seniority: 'head', entity: 'Ledgerly Niederlassung Nord GmbH', country: 'DE', location: 'Hamburg, Germany' }),
    mem('nord-ic', 'Marketing Manager', { seniority: 'manager', entity: 'Ledgerly Niederlassung Nord GmbH', country: 'DE', location: 'Hamburg, Germany' }),
    mem('central-pm', 'Portfolio Marketing Manager', { seniority: 'manager', entity: 'Ledgerly AG', country: 'DE', location: 'Stuttgart, Germany' }),
    mem('central-ev', 'Event Manager', { seniority: 'manager', entity: '', country: 'DE', location: 'Stuttgart, Germany' }),
    mem('fr', 'Chargée de marketing', { seniority: 'ic', entity: 'Ledgerly France SAS', country: 'FR', location: 'Paris, France' }),
    mem('ie', 'Marketing Executive', { seniority: 'ic', entity: '', country: 'IE', location: 'Dublin, Ireland' }),
  ];
  const ids = ['lead', 'nord-ic', 'central-pm', 'central-ev', 'fr', 'ie'];

  it('the rules only place people under a lead of their own entity and country', () => {
    const rm: RuleMember[] = team.map((m) => ({ id: m.id, seniority: m.seniority, subfunction: m.id === 'lead' ? 'leadership' : 'other', entity: m.entity, country: m.country, department: 'marketing' }));
    const e = suggestManagersRuleBased(rm);
    // only the same-entity line is strong enough to store; the 0.3 "overall head" guesses stay possible managers
    expect(e.filter((x) => x.confidence >= ORG_MIN_EDGE_CONFIDENCE).map((x) => `${x.id}>${x.managerId}`)).toEqual(['nord-ic>lead']);
    expect(e.some((x) => (x.id === 'fr' || x.id === 'ie') && x.managerId === 'lead')).toBe(false); // other countries: never
  });

  it('the prompt says so, and weak guesses are kept as "possible manager", never stored as lines', async () => {
    runClaude
      .mockResolvedValueOnce(ok({ results: ids.map((_, i) => inf(`p${i}`, i === 0 ? 'leadership' : 'other', ['head', 'manager', 'manager', 'manager', 'ic', 'ic'][i]!)) }))
      // the model hangs everyone under the most senior person captured — only the same-entity line is confident
      .mockResolvedValueOnce(ok({ edges: [
        { id: 'p1', managerId: 'p0', confidence: 0.6, reason: 'same regional entity' },
        { id: 'p2', managerId: 'p0', confidence: 0.3, reason: 'most senior captured' },
        { id: 'p3', managerId: 'p0', confidence: 0.3, reason: 'most senior captured' },
        { id: 'p4', managerId: 'p0', confidence: 0.3, reason: 'most senior captured' },
        { id: 'p5', managerId: null, confidence: 0.2, reason: 'no lead in Ireland' },
      ] }));
    const r = await runOrgInference({ account, members: team, concurrency: 1 });
    const rp = runClaude.mock.calls[1]![0].prompt as string;
    expect(rp).toMatch(/regional, entity or country lead/);
    expect(rp).toMatch(/return managerId null/);
    const lines = r.edges.filter((e) => e.managerId).map((e) => `${e.id}>${e.managerId}`);
    expect(lines).toEqual(['nord-ic>lead']);
    for (const id of ['central-pm', 'central-ev', 'fr']) {
      expect(r.classified.get(id)!.possibleManager).toEqual({ id: 'lead', confidence: 0.3, reason: 'most senior captured' });
    }
    expect(r.classified.get('nord-ic')!.possibleManager).toBeUndefined();
    expect(r.edges.every((e) => !e.managerId || e.confidence >= ORG_MIN_EDGE_CONFIDENCE)).toBe(true);
  });
});
