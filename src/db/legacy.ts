import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { computeProfileKey, computeResearchKey } from '../io/cache';
import { readReportFile } from '../io/output';
import { DEFAULTS, type Profile, type RankResult, type ResearchRecord, type RunMeta } from '../types';
import type { Store } from './store';

export const LEGACY_IMPORT_FLAG = 'legacy_import_v1';
const SAFE_KEY = /^[a-zA-Z0-9_-]+$/;

export interface LegacyImportResult {
  reports: number;
  people: number;
  runs: number;
  rankings: number;
  research: number;
  profiles: number;
  lists: number;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function legacyResearchCost(store: Store, rec: ResearchRecord): void {
  store.addCost('research', Number(rec.costUsd) || 0, null, 'legacy research');
}

const isOk = (r: ResearchRecord | undefined): r is ResearchRecord => Boolean(r && r.status === 'ok' && r.report && r.id);

/**
 * One-way, idempotent import of the pre-SQLite file caches and report JSONs into the store. Old files are
 * only read, never modified or deleted. Safe to run repeatedly: existing rows are never overwritten.
 */
export async function importLegacy(store: Store, dirs: { cacheDir: string; outDir: string }): Promise<LegacyImportResult> {
  const res: LegacyImportResult = { reports: 0, people: 0, runs: 0, rankings: 0, research: 0, profiles: 0, lists: 0 };
  const prompts = new Set<string>();
  const before = store.stats();

  // 1. Report JSONs (outputs/*.json): people, profiles, research, lists, spend.
  const outputs = (await listDir(dirs.outDir)).filter((n) => n.endsWith('.json')).sort();
  for (const name of outputs) {
    const file = path.join(dirs.outDir, name);
    let rep: Awaited<ReturnType<typeof readReportFile>>;
    try {
      if (!(await stat(file)).isFile()) continue;
      rep = await readReportFile(file);
    } catch {
      continue; // not a report
    }
    res.reports++;
    const meta = rep.meta;
    if (meta?.prompt) prompts.add(meta.prompt);
    let mtime = new Date().toISOString();
    try {
      mtime = (await stat(file)).mtime.toISOString();
    } catch {
      /* keep now */
    }
    store.upsertPeople(rep.people, meta?.inputPath || file, meta?.createdAt || mtime);

    for (const p of rep.people) {
      if (p.profile) {
        const key = computeProfileKey(p.id, p.title, p.company, DEFAULTS.enrichModel);
        if (!store.getProfile(key)) store.setProfile(key, p.profile, p.id, DEFAULTS.enrichModel);
        else store.linkProfile(key, p.id);
      }
      if (meta && isOk(p.research)) {
        const key = computeResearchKey(p.id, meta.prompt, p.research.signalsHash ?? '', p.research.model);
        if (store.insertResearch(key, p.research, meta.prompt)) legacyResearchCost(store, p.research);
      }
    }
    // Reports written after the store existed (meta.dbPath) already live in the store: importing their list
    // snapshots again would resurrect deleted lists, and their spend was recorded live in the ledger.
    const predatesStore = !meta?.dbPath && !meta?.runKey;
    const listFlag = `lists_adopted:${meta?.stem ?? name}`;
    if (predatesStore && !store.getMeta(listFlag)) {
      for (const l of rep.lists) {
        if (!store.hasList(l.id)) {
          store.upsertList(l, meta?.prompt ?? null);
          res.lists++;
        }
      }
      store.setMeta(listFlag, new Date().toISOString());
    }
    // Profiling/ranking spend recorded in the report (cumulative per report), once per report. Research spend is
    // taken from the imported research rows instead (exact per call, and not double-counted across reports).
    if (predatesStore && meta?.costs) {
      const flag = `legacy_costs:${name}`;
      if (!store.getMeta(flag)) {
        store.addCost('enrich', meta.costs.enrich ?? 0, null, `legacy ${name}`);
        store.addCost('rank', meta.costs.rank ?? 0, null, `legacy ${name}`);
        store.setMeta(flag, new Date().toISOString());
      }
    }
  }

  // 2. Per-run caches (<cacheDir>/<runKey>/meta.json + ranks.json): runs + rankings.
  for (const dir of await listDir(dirs.cacheDir)) {
    if (dir === 'research' || dir === 'profiles' || !SAFE_KEY.test(dir)) continue;
    const meta = await readJson<RunMeta>(path.join(dirs.cacheDir, dir, 'meta.json'));
    const ranks = await readJson<Record<string, RankResult>>(path.join(dirs.cacheDir, dir, 'ranks.json'));
    if (!meta && !ranks) continue;
    if (meta?.prompt) prompts.add(meta.prompt);
    const runKey = meta?.runKey || dir;
    if (!store.getRun(runKey)) {
      const t = meta?.updatedAt || new Date().toISOString();
      store.upsertRun({
        runKey,
        prompt: meta?.prompt ?? '',
        inputPath: meta?.inputPath ?? '',
        rankModel: meta?.rankModel ?? '',
        researchModel: meta?.researchModel ?? '',
        totalPeople: meta?.totalPeople ?? Object.keys(ranks ?? {}).length,
        createdAt: meta?.createdAt || t,
        updatedAt: t,
      });
      res.runs++;
    }
    if (ranks && store.getRankings(runKey).size === 0) {
      const results = Object.values(ranks).filter((r) => r && typeof r.id === 'string');
      if (results.length) store.setRankings(runKey, results);
    }
  }

  // 3. Shared research cache (<cacheDir>/research/<key>.json). The goal isn't stored in the file, so it's
  //    recovered by matching the key against every goal seen in reports/runs.
  const researchDir = path.join(dirs.cacheDir, 'research');
  for (const name of await listDir(researchDir)) {
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -5);
    if (!SAFE_KEY.test(key) || store.hasResearchKey(key)) continue;
    const rec = await readJson<ResearchRecord>(path.join(researchDir, name));
    if (!isOk(rec)) continue;
    const prompt = [...prompts].find((pr) => computeResearchKey(rec.id, pr, rec.signalsHash ?? '', rec.model) === key) ?? '';
    if (store.insertResearch(key, rec, prompt)) legacyResearchCost(store, rec);
  }

  // 4. Shared profile cache (<cacheDir>/profiles/<key>.json), linked to people by recomputing keys.
  const profileDir = path.join(dirs.cacheDir, 'profiles');
  const profileNames = (await listDir(profileDir)).filter((n) => n.endsWith('.json'));
  if (profileNames.length) {
    const owner = new Map<string, string>();
    const rows = store.db.prepare('SELECT id, title, company FROM people').all() as { id: string; title: string; company: string }[];
    for (const r of rows) owner.set(computeProfileKey(r.id, r.title, r.company, DEFAULTS.enrichModel), r.id);
    for (const name of profileNames) {
      const key = name.slice(0, -5);
      if (!SAFE_KEY.test(key)) continue;
      if (store.getProfile(key)) {
        const pid = owner.get(key);
        if (pid) store.linkProfile(key, pid);
        continue;
      }
      const profile = await readJson<Profile>(path.join(profileDir, name));
      if (profile) store.setProfile(key, profile, owner.get(key), DEFAULTS.enrichModel);
    }
  }

  const after = store.stats();
  res.people = after.people - before.people;
  res.rankings = after.rankings - before.rankings;
  res.research = after.researchRows - before.researchRows;
  res.profiles = after.profiles - before.profiles;
  store.setMeta(LEGACY_IMPORT_FLAG, new Date().toISOString());
  return res;
}
