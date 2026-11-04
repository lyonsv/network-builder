import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeResearchKey, computeRunKey, openRunCache } from '../src/io/cache';
import type { ResearchRecord } from '../src/types';

const rec = (id: string, status: 'ok' | 'error' = 'ok'): ResearchRecord => ({
  id, status, costUsd: 0.3, durationMs: 1, model: 'opus', signalsHash: 'sig', finishedAt: '',
  ...(status === 'error' ? { error: 'boom' } : {}),
});

describe('cache keys', () => {
  it('research key depends on person, prompt, signals and model — not on the CSV', () => {
    const k = computeResearchKey('abc123', 'angels', 'sig1', 'opus');
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(computeResearchKey('abc123', 'angels', 'sig1', 'opus')).toBe(k);
    expect(computeResearchKey('abc124', 'angels', 'sig1', 'opus')).not.toBe(k);
    expect(computeResearchKey('abc123', 'hires', 'sig1', 'opus')).not.toBe(k);
    expect(computeResearchKey('abc123', 'angels', 'sig2', 'opus')).not.toBe(k);
    expect(computeResearchKey('abc123', 'angels', 'sig1', 'sonnet')).not.toBe(k);
  });

  it('run key changes with CSV, prompt and rank model', () => {
    const k = computeRunKey('csv', 'p', 'haiku');
    expect(computeRunKey('csv2', 'p', 'haiku')).not.toBe(k);
    expect(computeRunKey('csv', 'p2', 'haiku')).not.toBe(k);
    expect(computeRunKey('csv', 'p', 'sonnet')).not.toBe(k);
  });
});

describe('openRunCache', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'nb-cache-test-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('research is shared across runs and only ok records hit', async () => {
    const a = await openRunCache(root, 'runaaaaaaaaaaaaa');
    await a.setResearch('k1', rec('p1'));
    await a.setResearch('k2', rec('p2', 'error'));
    const b = await openRunCache(root, 'runbbbbbbbbbbbbb');
    expect((await b.getResearch('k1'))?.id).toBe('p1');
    expect(await b.getResearch('k2')).toBeUndefined();
    expect(await b.getResearch('missing')).toBeUndefined();
  });

  it('fresh wipes only the run ranks and ignores (but keeps) shared research', async () => {
    const a = await openRunCache(root, 'runaaaaaaaaaaaaa');
    await a.setRanks([{ id: 'p1', score: 80, reason: 'r' }]);
    await a.setResearch('k1', rec('p1'));

    const fresh = await openRunCache(root, 'runaaaaaaaaaaaaa', { fresh: true });
    expect(fresh.getRank('p1')).toBeUndefined();
    expect(await fresh.getResearch('k1')).toBeUndefined();
    expect(await readdir(path.join(root, 'research'))).toContain('k1.json');

    const again = await openRunCache(root, 'runaaaaaaaaaaaaa');
    expect((await again.getResearch('k1'))?.id).toBe('p1');
  });

  it('rejects unsafe keys', async () => {
    const a = await openRunCache(root, 'runaaaaaaaaaaaaa');
    await expect(a.getResearch('../evil')).rejects.toThrow(/unsafe/);
  });
});
