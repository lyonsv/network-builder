import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Profile, ProfileCache, RankResult, ResearchRecord, RunCache, RunMeta } from '../types';
import { ensureDir, writeFileAtomic } from './fs-utils';

export function computeRunKey(inputText: string, prompt: string, rankModel: string): string {
  return createHash('sha1').update(`${inputText}\0${prompt}\0${rankModel}`).digest('hex').slice(0, 16);
}

/**
 * Key for the shared research cache. Research depends on the person, the goal, the signals and the
 * model — not on the rest of the CSV — so a re-exported CSV with new connections reuses old research.
 */
export function computeResearchKey(personId: string, prompt: string, signalsHash: string, model: string): string {
  return createHash('sha1').update(`${personId}\0${prompt}\0${signalsHash}\0${model}`).digest('hex').slice(0, 16);
}

/**
 * Key for the shared profile cache. A profile is parsed only from the person's own title/company, so it is
 * independent of the goal and reused by every run; a changed title (new job) re-enriches.
 */
export function computeProfileKey(personId: string, title: string, company: string, model: string): string {
  return createHash('sha1').update(`${personId}\0${title}\0${company}\0${model}`).digest('hex').slice(0, 16);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export async function openRunCache(
  cacheRoot: string,
  runKey: string,
  opts?: { fresh?: boolean },
): Promise<RunCache> {
  const dir = path.join(cacheRoot, runKey);
  const fresh = Boolean(opts?.fresh);
  // --fresh only wipes this run's ranks; shared research files are kept but not read this run.
  if (fresh) await rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
  const researchDir = path.join(cacheRoot, 'research');
  await ensureDir(researchDir);

  const ranksFile = path.join(dir, 'ranks.json');
  const ranks = new Map<string, RankResult>(
    Object.entries((await readJson<Record<string, RankResult>>(ranksFile)) ?? {}),
  );
  let chain: Promise<void> = Promise.resolve();

  const researchFile = (key: string) => {
    if (!SAFE_ID.test(key)) throw new Error(`unsafe cache key: ${key}`);
    return path.join(researchDir, `${key}.json`);
  };

  return {
    dir,
    runKey,
    getRank: (id) => ranks.get(id),
    setRanks(results) {
      for (const r of results) ranks.set(r.id, r);
      const next = chain.then(() =>
        writeFileAtomic(ranksFile, JSON.stringify(Object.fromEntries(ranks), null, 2)),
      );
      chain = next.catch(() => {});
      return next;
    },
    async getResearch(key) {
      if (fresh) return undefined;
      const rec = await readJson<ResearchRecord>(researchFile(key));
      return rec && rec.status === 'ok' ? rec : undefined;
    },
    async setResearch(key, rec) {
      await writeFileAtomic(researchFile(key), JSON.stringify(rec, null, 2));
    },
    async writeMeta(meta: RunMeta) {
      const prev = await readJson<RunMeta>(path.join(dir, 'meta.json'));
      const merged: RunMeta = { ...meta, createdAt: prev?.createdAt ?? meta.createdAt };
      await writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(merged, null, 2));
    },
  };
}

/** Shared profile cache at <cacheRoot>/profiles/<key>.json (never wiped by --fresh: profiles don't depend on the goal). */
export async function openProfileCache(cacheRoot: string): Promise<ProfileCache> {
  const dir = path.join(cacheRoot, 'profiles');
  await ensureDir(dir);
  const file = (key: string) => {
    if (!SAFE_ID.test(key)) throw new Error(`unsafe cache key: ${key}`);
    return path.join(dir, `${key}.json`);
  };
  return {
    dir,
    async get(key) {
      return readJson<Profile>(file(key));
    },
    async set(key, profile) {
      await writeFileAtomic(file(key), JSON.stringify(profile));
    },
  };
}
