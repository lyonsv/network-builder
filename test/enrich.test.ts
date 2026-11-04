import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EnrichedFields, Person, ProfileCache } from '../src/types';

// runClaude is mocked: these tests never call the real Claude Code CLI.
const runClaude = vi.fn();
vi.mock('../src/llm/claude', async (orig) => ({
  ...(await orig<typeof import('../src/llm/claude')>()),
  runClaude: (...a: unknown[]) => runClaude(...a),
}));

const { buildEnrichPrompt, enrichProfiles, normalizeProfile } = await import('../src/llm/enrich');
const { buildRankPrompt } = await import('../src/llm/rank');
const { computeProfileKey, openProfileCache } = await import('../src/io/cache');
const { createCostTracker } = await import('../src/llm/costs');

const mk = (id: string, title: string, company = ''): Person & EnrichedFields => ({
  id, rowIndex: 1, fullName: `Name ${id}`, firstName: 'N', lastName: id, title, company, url: '', email: '', connectedOn: '', extra: {},
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'nb-enrich-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('profile enrichment', () => {
  it('prompt lists every enum value and uses local ids', () => {
    const prompt = buildEnrichPrompt([mk('a', 'Partner at Acme Ventures'), mk('b', 'Angel | Writer')]);
    for (const v of ['founder/owner', 'head of', 'senior ic', 'people/recruiting', 'open to work', 'exited founder']) expect(prompt).toContain(v);
    expect(prompt).toContain('{"id":"p0","name":"Name a","title":"Partner at Acme Ventures","company":""}');
    expect(prompt).toContain('"title":"Angel | Writer"'); // headline pipes kept: they separate segments
  });

  it('normalizes invalid enums, drops unknown tags, dedupes, and falls back to the CSV company', () => {
    const p = normalizeProfile(
      { company: '', role: ' VP  Sales ', seniority: 'Overlord', function: 'SALES', industry: 'SaaS', tags: ['vc', 'VC', 'wizard'], region: 1 },
      mk('a', 'VP Sales', 'Acme'),
    );
    expect(p).toEqual({ company: 'Acme', role: 'VP Sales', seniority: 'unknown', function: 'sales', industry: 'saas', tags: ['vc'], region: '' });
  });

  it('profile cache keys change with title/company/model; shared cache round-trips', async () => {
    const k = computeProfileKey('id1', 'CEO', 'Acme', 'haiku');
    expect(computeProfileKey('id1', 'CEO at New', 'Acme', 'haiku')).not.toBe(k);
    expect(computeProfileKey('id1', 'CEO', 'Other', 'haiku')).not.toBe(k);
    expect(computeProfileKey('id1', 'CEO', 'Acme', 'sonnet')).not.toBe(k);
    const cache = await openProfileCache(dir);
    const prof = normalizeProfile({ seniority: 'c-suite', function: 'general management', tags: ['executive'] }, mk('id1', 'CEO'));
    await cache.set(k, prof);
    expect(await (await openProfileCache(dir)).get(k)).toEqual(prof);
    expect(await cache.get('0000000000000000')).toBeUndefined();
    await expect(cache.get('../escape')).rejects.toThrow(/unsafe/);
  });

  it('enriches in batches, retries missing ids once, caches only successes, and uses the cache next time', async () => {
    const cache: ProfileCache & { store: Map<string, unknown> } = (() => {
      const store = new Map<string, unknown>();
      return { store, dir: '', get: async (k: string) => store.get(k) as any, set: async (k: string, v: unknown) => void store.set(k, v) };
    })();
    const people = [mk('a', 'Partner at Fund'), mk('b', 'Founder & CEO at X'), mk('c', '???')];
    runClaude.mockReset();
    // batch call answers a + an invalid id; retry for b,c answers b only; c stays unprofiled
    runClaude
      .mockResolvedValueOnce({
        data: { results: [{ id: 'p0', company: 'Fund', role: 'Partner', seniority: 'partner', function: 'investing', industry: 'venture capital', tags: ['investor', 'vc'], region: '' }, { id: 'p9', seniority: 'vp' }] },
        costUsd: 0.01, durationMs: 1, rawResult: '',
      })
      .mockResolvedValueOnce({
        data: { results: [{ id: 'p0', company: 'X', role: 'Founder & CEO', seniority: 'founder/owner', function: 'general management', industry: '', tags: ['founder', 'executive'], region: '' }] },
        costUsd: 0.005, durationMs: 1, rawResult: '',
      });
    const costs = createCostTracker();
    const done: boolean[] = [];
    const out = await enrichProfiles(people, {
      batchSize: 10, concurrency: 2, model: 'haiku', cache, costs, hooks: { onBatchDone: (i) => done.push(i.fromCache) },
    });
    expect(runClaude).toHaveBeenCalledTimes(2);
    expect(runClaude.mock.calls[0]![0]).toMatchObject({ model: 'haiku', tools: [] });
    expect(out.map((p) => p.profile?.seniority)).toEqual(['partner', 'founder/owner', undefined]);
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(cache.store.size).toBe(2);
    expect(costs.byStage().enrich).toBeCloseTo(0.015);
    expect(done).toEqual([false]);

    // second run: a,b from cache, only c is sent
    runClaude.mockReset();
    runClaude.mockResolvedValue({ data: { results: [] }, costUsd: 0.001, durationMs: 1, rawResult: '' });
    const again = await enrichProfiles(people, { batchSize: 10, concurrency: 2, model: 'haiku', cache, costs: createCostTracker() });
    expect(runClaude.mock.calls[0]![0].prompt).toContain('{"id":"p0","name":"Name c"');
    expect(runClaude.mock.calls[0]![0].prompt).not.toContain('Name a');
    expect(again[0]!.profile?.company).toBe('Fund');
  });

  it('a failed batch leaves people unprofiled instead of rejecting', async () => {
    runClaude.mockReset();
    runClaude.mockRejectedValue(new Error('overloaded'));
    const errors: string[] = [];
    const store = new Map<string, any>();
    const out = await enrichProfiles([mk('a', 'CEO')], {
      batchSize: 10, concurrency: 1, model: 'haiku', costs: createCostTracker(),
      cache: { dir: '', get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) },
      hooks: { onBatchError: (_i, e) => errors.push(e.message) },
    });
    expect(out[0]!.profile).toBeUndefined();
    expect(errors).toEqual(['overloaded']);
    expect(store.size).toBe(0);
  });

  it('rank prompt includes parsed profiles when present', () => {
    const withProfile = { ...mk('a', 'Partner at Fund'), profile: normalizeProfile({ company: 'Fund', seniority: 'partner', function: 'investing', tags: ['vc'] }, mk('a', '')) };
    const prompt = buildRankPrompt('angels', [withProfile, mk('b', 'Baker')]);
    expect(prompt).toContain('parsed profile (seniority; function; tags; industry)');
    expect(prompt).toContain('p0 | Name a | Partner at Fund | Fund | partner; investing; tags: vc');
    expect(prompt).toContain('p1 | Name b | Baker | (no company) | (no profile)');
    expect(buildRankPrompt('angels', [mk('b', 'Baker')])).not.toContain('parsed profile');
  });
});
