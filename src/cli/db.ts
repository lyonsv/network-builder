import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import Table from 'cli-table3';
import pc from 'picocolors';
import { importLegacy, openStore, withLedger, type Store } from '../db';
import { checkClaudeAvailable } from '../llm/claude';
import { createCostTracker } from '../llm/costs';
import { estimateLensUsd, scoreLens } from '../llm/lens';
import { lensTable } from './explore';
import { ahoyPaths, explorerExportFilename, toAhoyFiles, toExplorerCsv } from '../io/explorer-export';
import type { ExportPreset } from '../io/export';
import { ensureDir, writeFileAtomic } from '../io/fs-utils';
import { DEFAULT_CACHE_DIR, DEFAULT_DB_PATH, DEFAULT_OUT_DIR, expandHome, type ExplorerPerson, type Lens } from '../types';
import { formatUsd } from './ui';

const tildify = (f: string): string => {
  const home = os.homedir();
  return f.startsWith(home) ? `~${f.slice(home.length)}` : f;
};

export interface DbFlags {
  db?: string;
  cacheDir?: string;
  outDir?: string;
}

const resolve = (f: string | undefined, fallback: string) => (f ? path.resolve(expandHome(f)) : fallback);

async function withStore<T>(flags: DbFlags, fn: (store: Store, dbPath: string) => Promise<T> | T): Promise<T> {
  const dbPath = resolve(flags.db, DEFAULT_DB_PATH);
  const { store, imported } = await openStore(dbPath, {
    cacheDir: resolve(flags.cacheDir, DEFAULT_CACHE_DIR),
    outDir: resolve(flags.outDir, DEFAULT_OUT_DIR),
  });
  if (imported) logImport(imported, dbPath);
  try {
    return await fn(store, dbPath);
  } finally {
    store.close();
  }
}

const day = (iso: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

/** One-line summary of the import of pre-SQLite caches/reports (first open, or `db --import-legacy`). */
export function logImport(
  r: { reports: number; people: number; runs: number; rankings: number; research: number; profiles: number; lists: number },
  dbPath: string,
  opts: { rerun?: boolean } = {},
): void {
  const total = r.people + r.rankings + r.research + r.profiles + r.lists + r.runs;
  if (!total) {
    p.log.info(
      opts.rerun
        ? `Legacy import into ${tildify(dbPath)}: nothing new (scanned ${r.reports} reports).`
        : `Created ${tildify(dbPath)} (no earlier data to import).`,
    );
    return;
  }
  p.log.info(
    `${opts.rerun ? 'Imported into' : 'Created'} ${tildify(dbPath)}${opts.rerun ? ':' : ' and imported earlier data:'} ${r.people} new people, ` +
      `${r.rankings} rankings (${r.runs} runs), ${r.research} research results, ${r.profiles} profiles, ${r.lists} lists ` +
      `from ${r.reports} reports. Old files were left in place.`,
  );
}

/** lens by exact id, then case-insensitive goal */
function findLens(store: Store, idOrGoal: string): Lens | undefined {
  const all = store.listLenses();
  const q = idOrGoal.trim().toLowerCase();
  return all.find((l) => l.id === idOrGoal) ?? all.find((l) => l.goal.trim().toLowerCase() === q);
}

/** `network-builder lists` */
export async function runLists(flags: DbFlags): Promise<number> {
  return withStore(flags, (store) => {
    const lists = store.listLists();
    if (!lists.length) {
      console.log(pc.dim('No saved lists yet. Build one in the explorer (select people → Save as list).'));
      return 0;
    }
    const lenses = new Map(store.listLenses().map((l) => [l.id, l] as const));
    const t = new Table({ head: ['id', 'name', 'people', 'lens', 'updated'].map((h) => pc.bold(h)), style: { head: [], border: ['grey'] } });
    for (const l of lists) {
      const lensId = store.getMeta(`list_lens:${l.id}`);
      const lens = lensId ? lenses.get(lensId)?.goal : l.prompt;
      t.push([pc.dim(l.id), pc.bold(l.name), String(l.ids.length), (lens ?? '').slice(0, 40), day(l.updatedAt)]);
    }
    console.log(t.toString());
    console.log(pc.dim('Export one: network-builder export --list "<name or id>" [--preset crm|full|ahoy] [--lens "<lens id or goal>"]'));
    return 0;
  });
}

export interface ExportFlags extends DbFlags {
  list?: string;
  preset?: string;
  output?: string;
  /** lens id or goal for the Fit Score / Fit Reason columns (default: the lens the list was saved under) */
  lens?: string;
}

/** `network-builder export --list <name|id> [--preset crm|full|ahoy] [--lens <id|goal>] [-o file]` */
export async function runExport(flags: ExportFlags): Promise<number> {
  if (!flags.list) {
    console.error(pc.red('--list <name or id> is required. See saved lists with: network-builder lists'));
    return 1;
  }
  if (flags.preset && flags.preset !== 'crm' && flags.preset !== 'full' && flags.preset !== 'ahoy') {
    console.error(pc.red('--preset must be "crm", "full" or "ahoy"'));
    return 1;
  }
  const preset: ExportPreset = flags.preset === 'full' ? 'full' : flags.preset === 'ahoy' ? 'ahoy' : 'crm';
  return withStore(flags, async (store) => {
    const list = store.findList(flags.list!);
    if (!list) {
      console.error(pc.red(`No list named or with id "${flags.list}". Saved lists: network-builder lists`));
      return 1;
    }
    let lens: Lens | undefined;
    if (flags.lens) {
      lens = findLens(store, flags.lens);
      if (!lens) {
        console.error(pc.red(`No lens "${flags.lens}". See lenses with: network-builder lens list`));
        return 1;
      }
    } else {
      const saved = store.getMeta(`list_lens:${list.id}`);
      lens = (saved && store.getLens(saved)) || (list.prompt ? findLens(store, list.prompt) : undefined);
    }
    const people = list.ids.map((id) => store.getExplorerPerson(id)).filter((x): x is ExplorerPerson => Boolean(x));
    if (!people.length) {
      console.error(pc.red(`List "${list.name}" has no people known to the database.`));
      return 1;
    }
    const out = flags.output
      ? path.resolve(expandHome(flags.output))
      : path.join(resolve(flags.outDir, DEFAULT_OUT_DIR), explorerExportFilename(list.name, people.length));
    await ensureDir(path.dirname(out));
    let written = [out];
    if (preset === 'ahoy') {
      const files = toAhoyFiles(people, lens);
      const ap = ahoyPaths(out);
      await writeFileAtomic(ap.companies, files.companies);
      await writeFileAtomic(ap.contacts, files.contacts);
      written = [ap.companies, ap.contacts];
      if (files.counts.notes) {
        await writeFileAtomic(ap.notes, files.notes);
        written.push(ap.notes);
      }
    } else await writeFileAtomic(out, toExplorerCsv(people, preset, lens, store.listLenses()));
    store.recordExport({ listId: list.id, name: list.name, preset, path: written[0]!, count: people.length });
    const missing = list.ids.length - people.length;
    console.log(
      `${pc.green('✓')} Exported ${pc.bold(String(people.length))} people from ${pc.bold(list.name)} (${preset}${lens ? `, lens “${lens.goal}”` : ''}) → ${written.map((w) => pc.cyan(tildify(w))).join(', ')}` +
        (missing ? pc.yellow(` · ${missing} unknown ids skipped`) : ''),
    );
    return 0;
  });
}

export interface DbCmdFlags extends DbFlags {
  importLegacy?: boolean;
}

function dossierCounts(store: Store): { light: number; deep: number; legacy: number } {
  try {
    const rows = store.db
      .prepare("SELECT depth, MAX(COALESCE(legacy, 0)) AS legacy, COUNT(DISTINCT person_id) AS n FROM dossiers WHERE status = 'ok' GROUP BY depth")
      .all() as { depth: string; legacy: number; n: number }[];
    const legacy = Number(
      (store.db.prepare("SELECT COUNT(DISTINCT person_id) AS n FROM dossiers WHERE status = 'ok' AND legacy = 1").get() as { n: number } | undefined)?.n ?? 0,
    );
    return {
      light: Number(rows.find((r) => r.depth === 'light')?.n ?? 0),
      deep: Number(rows.find((r) => r.depth === 'deep')?.n ?? 0),
      legacy,
    };
  } catch {
    return { light: 0, deep: 0, legacy: 0 };
  }
}

/** `network-builder db` — what the store holds and what it has cost. */
export async function runDb(flags: DbCmdFlags): Promise<number> {
  return withStore(flags, async (store, dbPath) => {
    if (flags.importLegacy) {
      const r = await importLegacy(store, {
        cacheDir: resolve(flags.cacheDir, DEFAULT_CACHE_DIR),
        outDir: resolve(flags.outDir, DEFAULT_OUT_DIR),
      });
      logImport(r, dbPath, { rerun: true });
    }
    const s = store.stats();
    const d = dossierCounts(store);
    const lenses = store.listLenses();
    let c: { enrich: number; dossier: number; lens: number; research: number; total: number };
    try {
      c = store.explorerCosts();
    } catch {
      c = { enrich: s.spend.enrich, dossier: s.spend.dossier, lens: s.spend.lens + s.spend.rank, research: s.spend.research, total: 0 };
      c.total = c.enrich + c.dossier + c.lens + c.research;
    }
    p.note(
      [
        `${pc.dim('path        ')}${tildify(s.path)}`,
        `${pc.dim('people      ')}${pc.bold(String(s.people))} ${pc.dim(`· ${s.profiledPeople} with headline profiles`)}`,
        `${pc.dim('web profiles')} ${pc.bold(String(d.light + d.deep))} ${pc.dim(`· ${d.light} light · ${d.deep} deep${d.legacy ? ` (${d.legacy} converted from older research)` : ''}`)}`,
        `${pc.dim('lenses      ')}${lenses.length}`,
        `${pc.dim('lists       ')}${s.lists} ${pc.dim(`· ${s.exports} exports`)}`,
        `${pc.dim('spend       ')}${pc.yellow(formatUsd(c.total))} ${pc.dim(
          `(headline profiles ${formatUsd(c.enrich)} · web profiles ${formatUsd(c.dossier)} · lenses ${formatUsd(c.lens)} · older research ${formatUsd(c.research)})`,
        )}`,
      ].join('\n'),
      'network-builder database',
    );
    if (lenses.length) console.log(lensesTable(lenses));
    return 0;
  });
}

function lensesTable(lenses: Lens[]): string {
  const t = new Table({ head: ['id', 'goal', 'scored', 'stale', 'updated'].map((h) => pc.bold(h)), style: { head: [], border: ['grey'] } });
  for (const l of lenses) t.push([pc.dim(l.id), l.goal.slice(0, 50), String(l.scored), l.stale ? pc.yellow(String(l.stale)) : '0', day(l.updatedAt)]);
  return t.toString();
}

/** `network-builder lens list` */
export async function runLensList(flags: DbFlags): Promise<number> {
  return withStore(flags, (store) => {
    const lenses = store.listLenses();
    if (!lenses.length) {
      console.log(pc.dim('No lenses yet. Create one in the explorer, or: network-builder -p "potential angel investors"'));
      return 0;
    }
    console.log(lensesTable(lenses));
    return 0;
  });
}

/** `network-builder lens rm <id|goal>` */
export async function runLensRm(idOrGoal: string, flags: DbFlags): Promise<number> {
  return withStore(flags, (store) => {
    const lens = findLens(store, idOrGoal);
    if (!lens) {
      console.error(pc.red(`No lens "${idOrGoal}". See: network-builder lens list`));
      return 1;
    }
    store.deleteLens(lens.id);
    console.log(`${pc.green('✓')} Deleted lens “${lens.goal}” (${lens.id}) and its scores.`);
    return 0;
  });
}

export interface LensRescoreFlags extends DbFlags {
  yes?: boolean;
  /** only stale/unscored people instead of everyone */
  stale?: boolean;
  /** new rerank band size, saved on the lens */
  rerankTop?: number;
  /** test hook */
  scoreFn?: typeof scoreLens;
}

/** `network-builder lens rescore <id|goal> [--stale] [-y]` — re-score a lens with the current rules. */
export async function runLensRescore(idOrGoal: string, flags: LensRescoreFlags): Promise<number> {
  return withStore(flags, async (store) => {
    let lens = findLens(store, idOrGoal);
    if (!lens) {
      console.error(pc.red(`No lens "${idOrGoal}". See: network-builder lens list`));
      return 1;
    }
    if (flags.rerankTop !== undefined) {
      if (!Number.isFinite(flags.rerankTop) || flags.rerankTop < 0) {
        console.error(pc.red('--rerank-top must be a number ≥ 0'));
        return 1;
      }
      store.setLensRerankTop(lens.id, flags.rerankTop);
      lens = store.getLens(lens.id) ?? lens;
    }
    const all = store.listExplorerPeople();
    const ids = new Set(flags.stale ? store.staleOrUnscored(lens.id) : all.map((x) => x.id));
    if (!ids.size) {
      console.log(`Lens “${lens.goal}” has nothing stale — use without --stale to re-score everyone.`);
      return 0;
    }
    const est = estimateLensUsd(ids.size, lens.rerankModel ? lens.rerankTop : 0);
    const what = `${ids.size.toLocaleString()} people for “${lens.goal}”` +
      (lens.rerankTop && lens.rerankModel ? ` (top ${lens.rerankTop} re-checked with ${lens.rerankModel})` : '');
    if (!flags.yes) {
      if (!process.stdin.isTTY) {
        console.error(pc.red(`Would re-score ${what}, ≈ ${formatUsd(est)}. Pass --yes to confirm.`));
        return 1;
      }
      const ok = await p.confirm({ message: `Re-score ${what}? ≈ ${formatUsd(est)} (rough)` });
      if (p.isCancel(ok) || !ok) return 1;
    }
    if (!flags.scoreFn) {
      const claude = await checkClaudeAvailable();
      if (!claude.ok) {
        console.error(pc.red(`Claude Code CLI not available: ${claude.error ?? 'unknown error'}`));
        return 1;
      }
    }
    if (!store.acquireLensLock(lens.id)) {
      console.error(pc.red(`“${lens.goal}” is being scored by another network-builder process (e.g. the open explorer) — try again when it finishes.`));
      return 1;
    }
    const lockBeat = setInterval(() => store.touchLensLock(lens.id), 30_000);
    lockBeat.unref?.();
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once('SIGINT', onSigint);
    const costs = withLedger(createCostTracker(), store);
    const s = p.spinner();
    s.start(`Re-scoring ${what}`);
    try {
      await (flags.scoreFn ?? scoreLens)({
        lens,
        people: all.filter((x) => ids.has(x.id)),
        allPeople: all,
        store,
        costs,
        signal: controller.signal,
        onProgress: ({ phase, done, total }) =>
          s.message(`${phase === 'rerank' ? 'Re-checking top candidates' : 'Scoring'} · ${done}/${total} · ${formatUsd(costs.byStage().lens)}`),
      });
      s.stop(`Re-scored “${lens.goal}” · ${pc.yellow(formatUsd(costs.byStage().lens))}`);
    } catch (e) {
      s.stop(pc.red(controller.signal.aborted ? 'Stopped — scores finished so far are saved.' : `Failed: ${(e as Error).message}`));
      return controller.signal.aborted ? 130 : 1;
    } finally {
      process.off('SIGINT', onSigint);
      clearInterval(lockBeat);
      store.releaseLensLock(lens.id);
    }
    console.log(lensTable(store.listExplorerPeople(), store.getLens(lens.id) ?? lens));
    return 0;
  });
}
