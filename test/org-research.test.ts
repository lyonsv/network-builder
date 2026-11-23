import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_FACT_KINDS, SUBFUNCTIONS } from '../src/accounts/types';

// runClaude is mocked: these tests never call the real Claude Code CLI. All companies and people are fictional.
const runClaude = vi.fn();
vi.mock('../src/llm/claude', async (orig) => ({
  ...(await orig<typeof import('../src/llm/claude')>()),
  runClaude: (...a: unknown[]) => runClaude(...a),
}));

const { buildArgs, ClaudeError } = await import('../src/llm/claude');
const {
  buildOrgResearchPrompt, normalizeOrgResearch, runOrgResearchPass, webPersonConfidence, isDach, evidenceUrlOk, estimateOrgResearchUsd,
  classifyOrgRateLimited, isOwnDomain, ORG_RESEARCH_PASS_IDS, ORG_RESEARCH_PASSES, ORG_RESEARCH_USD_ESTIMATE,
} = await import('../src/llm/org-research');
const { ORG_RESEARCH_SCHEMA } = await import('../src/llm/schemas');

const account = { name: 'Ledgerly', aliases: ['Ledgerly Group'], domain: 'ledgerly.example', linkedinUrl: 'https://www.linkedin.com/company/ledgerly' };
const known = { people: [{ name: 'Riley Moss', title: 'VP Marketing' }, { name: 'Jonas Müller-Brandt', title: 'Head of Brand' }], entities: [], countries: [] };
const person = (over: Record<string, unknown> = {}) => ({
  name: 'Riley Moss', title: 'VP Marketing', entity: 'Ledgerly Services GmbH', country: 'de', subfunction: 'leadership',
  evidenceUrl: 'https://www.ledgerly.example/about/leadership', quote: 'Riley Moss, VP Marketing', date: '2026-05', ...over,
});
const fact = (over: Record<string, unknown> = {}) => ({
  kind: 'team', text: 'A central brand team serves all countries.', entity: '', country: '', subject: '', manager: '',
  evidenceUrl: 'https://press.ledgerly.example/2026/brand', quote: 'our central brand team', confidence: 0.95, ...over,
});
const head = (over: Record<string, unknown> = {}) => ({
  label: 'employees', scope: 'company', count: 1200, evidenceUrl: 'https://www.ledgerly.example/about', quote: 'more than 1,200 employees', ...over,
});
const ok = (data: unknown, costUsd = 0.12) => ({ data, costUsd, durationMs: 1, rawResult: '' });

beforeEach(() => runClaude.mockReset());

describe('normalizeOrgResearch (evidence rule)', () => {
  it('keeps people / facts / headcounts with an http(s) evidence URL and a quote; drops the rest', () => {
    const d = normalizeOrgResearch({
      people: [
        person(),
        person({ name: 'Ava Lindqvist', evidenceUrl: '' }),
        person({ name: 'Ben Ortiz', quote: '  ' }),
        person({ name: 'Dev Rao', evidenceUrl: 'https://de.linkedin.com/in/devrao' }),
        person({ name: 'Mia Chen', evidenceUrl: 'ftp://ledgerly.example/x' }),
        person({ name: 'Pressestelle Ledgerly' }),
        person({ name: 'Riley Moss', title: 'duplicate' }),
        person({ name: 'Noor Haddad', subfunction: 'sales', country: 'Germany', date: 'last year' }),
      ],
      facts: [
        fact(),
        fact({ evidenceUrl: 'https://www.linkedin.com/company/ledgerly' }),
        fact({ quote: '' }),
        fact({ kind: 'bogus', subject: 'Riley Moss', manager: 'Ava Lindqvist', confidence: 7 }),
        fact({ kind: 'reporting', subject: 'Dr. Riley Moss', manager: 'Ava Lindqvist' }),
      ],
      headcounts: [head(), head({ evidenceUrl: 'https://lnkd.in/abc' }), head({ count: 0 }), head({ scope: 'query' }), head({ quote: '' })],
      searchesRun: 4,
      rateLimited: false,
    });
    expect(d.people.map((p) => p.name)).toEqual(['Riley Moss', 'Noor Haddad']);
    expect(d.people[0]).toMatchObject({ country: 'DE', entity: 'Ledgerly Services GmbH', subfunction: 'leadership', date: '2026-05' });
    expect(d.people[1]).toMatchObject({ subfunction: '', country: '', date: '' });
    expect(d.facts).toHaveLength(3);
    expect(d.facts[1]).toMatchObject({ kind: 'other', subject: '', manager: '', confidence: 0.9 }); // unknown kind → other; conf capped
    expect(d.facts[2]).toMatchObject({ kind: 'reporting', subject: 'Riley Moss', manager: 'Ava Lindqvist' });
    expect(d.headcounts).toEqual([head()]);
    // people: no url, no quote, linkedin, ftp, "Pressestelle Ledgerly" (not a person); facts: 2; headcounts: 4
    expect(d.dropped).toBe(5 + 2 + 4);
    for (const x of [...d.people, ...d.facts, ...d.headcounts]) {
      expect(x.evidenceUrl).toMatch(/^https?:\/\//);
      expect(x.evidenceUrl).not.toMatch(/linkedin\.com|lnkd\.in/);
      expect(x.quote.length).toBeGreaterThan(0);
    }
  });

  it('evidenceUrlOk, rate-limit classification and garbage input', () => {
    expect(evidenceUrlOk('https://www.ledgerly.example/x')).toBeTruthy();
    expect(evidenceUrlOk('https://linkedin.com/in/x')).toBe('');
    expect(evidenceUrlOk('javascript:alert(1)')).toBe('');
    expect(evidenceUrlOk(42)).toBe('');
    expect(normalizeOrgResearch(null)).toMatchObject({ people: [], facts: [], headcounts: [], searchesRun: 0, rateLimited: false });
    const empty = normalizeOrgResearch({ people: 'x', facts: [null, 3], rateLimited: true, searchesRun: 2 });
    expect(classifyOrgRateLimited(empty)).toBe(true);
    expect(classifyOrgRateLimited(normalizeOrgResearch({ people: [person()], rateLimited: true, searchesRun: 2 }))).toBe(false); // partial info is info
    expect(classifyOrgRateLimited(normalizeOrgResearch({ people: [person()], rateLimited: true, searchesRun: 0 }))).toBe(true);
    expect(classifyOrgRateLimited(normalizeOrgResearch({ rateLimited: false }))).toBe(false);
  });

  it('schema enums match the shared vocabulary', () => {
    const props = (ORG_RESEARCH_SCHEMA as any).properties;
    expect(props.people.items.properties.subfunction.enum).toEqual(['', ...SUBFUNCTIONS]);
    expect(props.facts.items.properties.kind.enum).toEqual([...ORG_FACT_KINDS]);
    expect(props.headcounts.items.properties.scope.enum).toEqual(['company', 'function']);
  });
});

describe('org research prompt', () => {
  it('forbids linkedin.com, explains site:, lists known people, carries the evidence rule and the pass focus', () => {
    const p = buildOrgResearchPrompt(account, 'jobs', known, '2026-11-23');
    expect(p).toMatch(/do not search or cite linkedin\.com/i);
    expect(p).toContain('ignores "site:"');
    expect(p).toContain('- Riley Moss — VP Marketing');
    expect(p).toContain('- Jonas Müller-Brandt — Head of Brand');
    expect(p).toContain('EVIDENCE RULE');
    expect(p).toContain('berichtet an'); // jobs focus
    expect(p).toContain('at most 5 WebSearch calls');
    expect(p).toContain('context only');
    expect(p).not.toMatch(/search in GERMAN/); // .example domain, no DACH hints
  });

  it('searches in German for DACH accounts (domain, legal form, entities, countries, locations)', () => {
    const dach = (a: object, k: object = {}) => buildOrgResearchPrompt({ ...account, ...a }, 'seed', { ...known, ...k }, '2026-11-23');
    expect(dach({ domain: 'ledgerly.de' })).toContain('search in GERMAN');
    expect(dach({ domain: 'ledgerly.de' })).toContain('Ledgerly Unternehmenskommunikation');
    expect(dach({ name: 'Ledgerly AG' })).toContain('search in GERMAN');
    expect(dach({}, { entities: ['Ledgerly Services GmbH'] })).toContain('search in GERMAN');
    expect(dach({}, { countries: ['AT'] })).toContain('search in GERMAN');
    expect(isDach(account, { entities: [], countries: [], locations: ['Munich, Bavaria, Germany'] })).toBe(true);
    expect(isDach(account, { entities: [], countries: ['US'], locations: ['Austin, Texas'] })).toBe(false);
  });

  it('caps the known-people list', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ name: `Person ${i} Example`, title: 'Marketing Manager' }));
    const p = buildOrgResearchPrompt(account, 'seed', { people: many, entities: [], countries: [] }, '2026-11-23');
    expect(p).toContain('(120, first 80 shown)');
    expect(p).not.toContain('Person 80 Example');
  });
});

describe('runOrgResearchPass', () => {
  it('seed pass: Sonnet with WebSearch + WebFetch only, strict MCP config, no --bare', async () => {
    runClaude.mockResolvedValueOnce(ok({ people: [person()], facts: [], headcounts: [], searchesRun: 3, rateLimited: false }));
    const r = await runOrgResearchPass({ account, pass: 'seed', known });
    expect(r).toMatchObject({ status: 'ok', pass: 'seed', model: 'sonnet', costUsd: 0.12 });
    expect(r.data!.people).toHaveLength(1);
    const call = runClaude.mock.calls[0]![0];
    expect(call).toMatchObject({ model: 'sonnet', tools: ['WebSearch', 'WebFetch'], retries: 1 });
    expect(call.mcpTools).toBeUndefined();
    const args = buildArgs(call);
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--allowedTools'))).toEqual(['--allowedTools', 'WebSearch', 'WebFetch', '--tools', 'WebSearch,WebFetch']);
    expect(args).not.toContain('--bare');
    expect(args.join(' ')).not.toMatch(/mcp__/);
  });

  it('other passes default to Haiku; a model override wins', async () => {
    runClaude.mockResolvedValue(ok({ people: [], facts: [], headcounts: [], searchesRun: 2, rateLimited: false }, 0.03));
    expect((await runOrgResearchPass({ account, pass: 'press', known })).model).toBe('haiku');
    expect((await runOrgResearchPass({ account, pass: 'events', known, model: 'sonnet' })).model).toBe('sonnet');
  });

  it('rate limits (model-reported or CLI) → rate_limited with the spend; other failures → error; abort rethrows', async () => {
    runClaude.mockResolvedValueOnce(ok({ people: [], facts: [], headcounts: [], searchesRun: 1, rateLimited: true }, 0.02));
    expect(await runOrgResearchPass({ account, pass: 'press', known })).toMatchObject({ status: 'rate_limited', costUsd: 0.02 });
    runClaude.mockRejectedValueOnce(new ClaudeError('claude error: API Error: 429 Too Many Requests', { costUsd: 0.01 }));
    expect(await runOrgResearchPass({ account, pass: 'press', known })).toMatchObject({ status: 'rate_limited', costUsd: 0.01 });
    runClaude.mockRejectedValueOnce(new ClaudeError('claude returned no parseable JSON', { costUsd: 0.05, costIncomplete: true }));
    expect(await runOrgResearchPass({ account, pass: 'jobs', known })).toMatchObject({ status: 'error', costUsd: 0.05, costIncomplete: true });
    const abort = Object.assign(new ClaudeError('Aborted', { costUsd: 0.07 }), { name: 'AbortError' });
    runClaude.mockRejectedValueOnce(abort);
    await expect(runOrgResearchPass({ account, pass: 'jobs', known })).rejects.toBe(abort);
  });
});

describe('confidence + estimates', () => {
  it('webPersonConfidence: company site 0.9, press 0.6, third-party or > 24 months 0.4', () => {
    const today = '2026-11-23';
    expect(webPersonConfidence({ evidenceUrl: 'https://www.ledgerly.example/team', date: '' }, account, 'seed', today)).toBe(0.9);
    expect(webPersonConfidence({ evidenceUrl: 'https://www.ledgerly.example/impressum', date: '' }, account, 'press', today)).toBe(0.9);
    expect(webPersonConfidence({ evidenceUrl: 'https://careers.ledgerly.example/job/1', date: '2026-10' }, account, 'jobs', today)).toBe(0.9);
    expect(webPersonConfidence({ evidenceUrl: 'https://news.example/ledgerly-hires', date: '2026-01-10' }, account, 'press', today)).toBe(0.6);
    expect(webPersonConfidence({ evidenceUrl: 'https://directory.example/ledgerly', date: '' }, account, 'seed', today)).toBe(0.4);
    expect(webPersonConfidence({ evidenceUrl: 'https://conf.example/speakers', date: '' }, account, 'events', today)).toBe(0.4);
    expect(webPersonConfidence({ evidenceUrl: 'https://www.ledgerly.example/team', date: '2024-06' }, account, 'seed', today)).toBe(0.4);
    expect(webPersonConfidence({ evidenceUrl: 'https://notledgerly.example/x', date: '' }, account, 'seed', today)).toBe(0.4);
  });

  it('per-pass estimates add up to the whole-run range', () => {
    expect(estimateOrgResearchUsd(ORG_RESEARCH_PASS_IDS)).toEqual(ORG_RESEARCH_USD_ESTIMATE);
    expect(estimateOrgResearchUsd(['press'])).toEqual(ORG_RESEARCH_PASSES.press.usd);
    expect(ORG_RESEARCH_PASSES.seed.model).toBe('sonnet');
    expect(ORG_RESEARCH_USD_ESTIMATE).toEqual({ min: 0.3, max: 1.4 });
    expect(ORG_RESEARCH_PASSES.seed.usd).toEqual({ min: 0.1, max: 0.6 });
    for (const p of ['press', 'jobs', 'events', 'headcount'] as const) expect(ORG_RESEARCH_PASSES[p].usd).toEqual({ min: 0.05, max: 0.2 });
  });
});

describe('review fixes', () => {
  it('person names: whole-word team/mailbox filter, every honorific stripped', () => {
    const names = (ns: string[]) =>
      normalizeOrgResearch({ people: ns.map((name) => person({ name })) }).people.map((p) => p.name);
    expect(names(['Lena Presser', 'Tom Pressler', 'Ada Presley', 'Kai Teamann', 'Mia Marketingova'])).toEqual(
      ['Lena Presser', 'Tom Pressler', 'Ada Presley', 'Kai Teamann', 'Mia Marketingova'],
    );
    expect(names(['Pressestelle Ledgerly', 'Ledgerly Pressebüro', 'Marketing Team', 'Team Kommunikation', 'Info Ledgerly', 'Unternehmenskommunikation Ledgerly'])).toEqual([]);
    expect(names(['Dr. Prof. Jonas Müller-Brandt'])).toEqual(['Jonas Müller-Brandt']);
    expect(names(['Frau Dr. Ava Lindqvist'])).toEqual(['Ava Lindqvist']);
    const f = normalizeOrgResearch({ facts: [fact({ kind: 'reporting', subject: 'Lena Presser', manager: 'Prof. Dr. Ava Lindqvist' })] }).facts[0]!;
    expect(f).toMatchObject({ subject: 'Lena Presser', manager: 'Ava Lindqvist' });
  });

  it('a person seen twice keeps the company-site evidence', () => {
    const raw = { people: [person({ evidenceUrl: 'https://news.example/riley', quote: 'article' }), person({ quote: 'own site' })] };
    expect(normalizeOrgResearch(raw, 'ledgerly.example').people).toEqual([expect.objectContaining({ evidenceUrl: person().evidenceUrl, quote: 'own site' })]);
    expect(normalizeOrgResearch(raw).people[0]!.quote).toBe('article'); // no domain known: first one kept
    expect(isOwnDomain('https://shop.ledgerly.example/x', 'www.ledgerly.example')).toBe(true);
    expect(isOwnDomain('https://ledgerly.example.evil.test/x', 'ledgerly.example')).toBe(false);
  });

  it('seed and press prompts carry the leadership checklist and a minimum number of searches; prefer the own site', () => {
    const seed = buildOrgResearchPrompt(account, 'seed', known, '2026-11-23');
    for (const w of ['BELOW the C-level', 'Leiter(in) Marketing', 'Head of Brand', 'Unternehmenskommunikation', 'Head of Digital', 'CRM', 'Country or regional'])
      expect(seed).toContain(w);
    expect(seed).toContain('Run at least 5 DISTINCT searches');
    expect(seed).toContain("use the company's own page as evidenceUrl");
    const press = buildOrgResearchPrompt(account, 'press', known, '2026-11-23');
    expect(press).toContain('Leiter(in) Marketing');
    expect(press).toContain('Run at least 3 DISTINCT searches');
    expect(buildOrgResearchPrompt(account, 'headcount', known, '2026-11-23')).not.toContain('checklist of roles');
  });
});
