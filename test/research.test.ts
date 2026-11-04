import { describe, expect, it, vi } from 'vitest';
import type { RankedPerson, ResearchRecord, RunCache } from '../src/types';

// runClaude is mocked: these tests never call the real Claude Code CLI.
const runClaude = vi.fn();
vi.mock('../src/llm/claude', async (orig) => ({
  ...(await orig<typeof import('../src/llm/claude')>()),
  runClaude: (...a: unknown[]) => runClaude(...a),
}));

const { researchPeople } = await import('../src/llm/research');
const { createCostTracker } = await import('../src/llm/costs');

const person: RankedPerson = {
  id: 'abc', rowIndex: 1, fullName: 'Ada', firstName: 'Ada', lastName: '', title: 'Angel investor', company: '',
  url: '', email: '', connectedOn: '', extra: {}, score: 90, fitReason: 'r', rank: 1, ranked: true,
};

function memCache(): RunCache & { store: Map<string, ResearchRecord> } {
  const store = new Map<string, ResearchRecord>();
  return {
    store, dir: '', runKey: '', getRank: () => undefined, setRanks: async () => {}, writeMeta: async () => {},
    getResearch: async (k) => {
      const r = store.get(k);
      return r?.status === 'ok' ? r : undefined;
    },
    setResearch: async (k, rec) => {
      store.set(k, rec);
    },
  };
}

const opts = (cache: RunCache) => ({
  prompt: 'angels', signalsMarkdown: '## 1. Who', concurrency: 1, model: 'sonnet', cache, costs: createCostTracker(),
});

describe('researchPeople caching', () => {
  it('caches ok results but never caches errors (so a failure cannot overwrite a good result)', async () => {
    const cache = memCache();
    runClaude.mockResolvedValueOnce({
      data: { identityConfirmed: true, summary: 's', currentRole: '', location: '', signals: [], fitAssessment: '',
        recommendedApproach: '', talkingPoints: [], redFlags: [], sources: [], confidence: 'high', researchScore: 80 },
      costUsd: 0.1, durationMs: 1, rawResult: '',
    });
    const [ok] = await researchPeople([person], opts(cache));
    expect(ok!.research?.status).toBe('ok');
    expect(cache.store.size).toBe(1);
    const good = [...cache.store.values()][0];

    // a forced re-run (cache read bypassed) that fails must leave the cached ok record untouched
    runClaude.mockRejectedValueOnce(new Error('boom'));
    const bypass: RunCache = { ...cache, getResearch: async () => undefined };
    const [failed] = await researchPeople([person], opts(bypass));
    expect(failed!.research?.status).toBe('error');
    expect([...cache.store.values()][0]).toEqual(good);
  });
});
