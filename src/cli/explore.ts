import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import Table from 'cli-table3';
import pc from 'picocolors';
import { dbProfileCache, openStore, withLedger, type Store } from '../db';
import { readPeopleCsv } from '../io/csv';
import { checkClaudeAvailable } from '../llm/claude';
import { createCostTracker } from '../llm/costs';
import { DEFAULT_DOSSIER_PATH, ensureDossierTemplate } from '../llm/dossier';
import { enrichProfiles } from '../llm/enrich';
import { LENS_RERANK_USD_PER_100, LENS_USD_PER_1000, estimateLensUsd, scoreLens } from '../llm/lens';
import {
  DEFAULTS,
  DEFAULT_CACHE_DIR,
  DEFAULT_DB_PATH,
  DEFAULT_OUT_DIR,
  expandHome,
  type CostTracker,
  type EnrichedFields,
  type ExplorerEvent,
  type ExplorerPerson,
  type Lens,
  type Person,
} from '../types';
import { startExplorerServer, type DossierFn, type ScoreFn } from '../web/explorer-server';
import { stablePortFor } from '../web/http-common';
import { acquireLock, installShutdown } from '../web/lock';
import { openInBrowser } from '../web/open';
import { logImport } from './db';
import { isInteractive } from './interactive';
import { runSetup } from './setup';
import { banner, colorScore, formatUsd } from './ui';

export interface ExploreFlags {
  input?: string;
  prompt?: string;
  db?: string;
  outDir?: string;
  cacheDir?: string;
  /** dossier prompt template (default <data dir>/dossier.md) */
  dossier?: string;
  researchModel?: string;
  /** parallel deep dossiers (default 2) */
  concurrency?: number;
  /** parallel light profiles (default 3) */
  lightConcurrency?: number;
  rerankTop?: number;
  dryRun?: boolean;
  /** commander --no-serve → false */
  serve?: boolean;
  /** commander --no-open → false */
  open?: boolean;
  port?: number;
  /**
   * Write {url, pid, reused} JSON here once the explorer is reachable (also when another explorer already runs on this
   * database). Used by the desktop app to find the page.
   */
  readyFile?: string;
  /** test hooks */
  dossierFn?: DossierFn;
  scoreFn?: ScoreFn;
}

async function writeReadyFile(file: string, info: { url: string; pid: number | null; reused: boolean }): Promise<void> {
  const { writeFile, rename } = await import('node:fs/promises');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(info), { mode: 0o600 });
  await rename(tmp, file);
}

const tildify = (f: string): string => {
  const home = os.homedir();
  return f.startsWith(home) ? `~${f.slice(home.length)}` : f;
};
const resolvePath = (f: string | undefined, fallback: string) => (f ? path.resolve(expandHome(f)) : fallback);
const truncate = (s: string, n: number) => {
  const c = (s ?? '').replace(/\s+/g, ' ').trim();
  return c.length > n ? `${c.slice(0, n - 1)}…` : c;
};

/** lens scores for the top people of a lens, as a terminal table */
export function lensTable(people: ExplorerPerson[], lens: Lens, limit = 15): string {
  const rows = people
    .filter((x) => x.scores[lens.id])
    .sort((a, b) => b.scores[lens.id]!.score - a.scores[lens.id]!.score)
    .slice(0, limit);
  const t = new Table({
    head: ['score', 'basis', 'name', 'title', 'why'].map((h) => pc.bold(h)),
    style: { head: [], border: ['grey'] },
    colWidths: [7, 10, 24, 40, 60],
    wordWrap: false,
  });
  for (const x of rows) {
    const s = x.scores[lens.id]!;
    t.push([colorScore(s.score), pc.dim(s.basis), truncate(x.fullName, 22), truncate(x.profile?.role || x.title, 38), truncate(s.reason, 58)]);
  }
  return t.toString();
}

const findLens = (store: Store, goal: string): Lens | undefined => {
  const g = goal.trim().toLowerCase();
  return store.listLenses().find((l) => l.goal.trim().toLowerCase() === g);
};

/**
 * The v6 entry point: optionally import a CSV (+ cheap headline profiles), optionally create/refresh a lens,
 * then open the network explorer on the database until Ctrl-C. Returns the process exit code.
 */
export async function runExplore(flags: ExploreFlags): Promise<number> {
  const startedAt = Date.now();
  banner();
  p.intro(pc.inverse(' network-builder · explorer '));

  const dbPath = resolvePath(flags.db, DEFAULT_DB_PATH);
  const outDir = resolvePath(flags.outDir, DEFAULT_OUT_DIR);
  const cacheDir = resolvePath(flags.cacheDir, DEFAULT_CACHE_DIR);
  const dossierPath = resolvePath(flags.dossier, DEFAULT_DOSSIER_PATH);
  const researchModel = flags.researchModel ?? DEFAULTS.researchModel;
  let goal = flags.prompt?.replace(/\s+/g, ' ').trim() || undefined;
  // NB_FORCE_SERVE=1: serve without a TTY (the desktop app runs the CLI as a child process)
  const serveMode = flags.serve !== false && (isInteractive() || process.env.NB_FORCE_SERVE === '1');

  let inputPath = flags.input ? path.resolve(expandHome(flags.input)) : undefined;

  // ---- dry run: parse + plan only (no DB writes, no model calls) ----
  if (flags.dryRun) {
    const lines: string[] = [`${pc.dim('database  ')}${tildify(dbPath)}`];
    if (inputPath) {
      try {
        const { result } = await readPeopleCsv(inputPath);
        lines.push(`${pc.dim('import    ')}${result.people.length} people from ${tildify(inputPath)} ${pc.dim('(+ headline profiles for new/changed titles, cached)')}`);
      } catch (e) {
        p.log.error(`Could not read ${tildify(inputPath)}: ${(e as Error).message}`);
        return 1;
      }
    }
    if (goal) lines.push(`${pc.dim('lens      ')}“${goal}” ${pc.dim(`≈ ${formatUsd(LENS_USD_PER_1000)} per 1,000 people + ${formatUsd(LENS_RERANK_USD_PER_100)} per 100 re-checked (top ${flags.rerankTop ?? 150})`)}`);
    lines.push(`${pc.dim('then      ')}${serveMode ? 'open the explorer in your browser' : 'exit (--no-serve / not a TTY)'}`);
    p.note(lines.join('\n'), 'Dry run');
    p.outro('Nothing was called and nothing was written.');
    return 0;
  }

  // ---- database ----
  let store: Store;
  try {
    const opened = await openStore(dbPath, { cacheDir, outDir });
    store = opened.store;
    if (opened.imported) logImport(opened.imported, dbPath);
  } catch (e) {
    p.log.error(`Could not open the database ${tildify(dbPath)}: ${(e as Error).message}`);
    p.outro(pc.red('Aborted'));
    return 1;
  }

  const costs: CostTracker = withLedger(createCostTracker(), store);
  const controller = new AbortController();
  // Ctrl-C before the server is up: stop model calls (results so far are already in the DB).
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
    console.log(`\n${pc.yellow('■')} Stopping… ${pc.dim('(everything finished so far is saved; Ctrl-C again to force quit)')}`);
  };
  process.on('SIGINT', onSigint);

  try {
    let existing = store.stats().people;
    if (!inputPath && existing === 0) {
      if (!isInteractive()) {
        p.log.error('Nothing imported yet. Import your LinkedIn connections first:\n  network-builder import ~/Downloads/Connections.csv');
        p.outro(pc.red('Aborted'));
        return 1;
      }
      const setup = await runSetup(tildify(path.dirname(dbPath)));
      if (!setup) return 0;
      inputPath = setup.inputPath;
      goal = goal ?? setup.goal;
    }

    // Claude Code is only needed for model work (profiles, lenses, dossiers); browsing works without it.
    const needsModel = Boolean(inputPath || goal);
    const claude = await checkClaudeAvailable();
    if (!claude.ok) {
      const msg = `Claude Code CLI not available (${claude.error ?? 'unknown'}). Install it and log in with \`claude\`.`;
      if (needsModel) p.log.warn(`${msg} Skipping profiles/lens scoring; the explorer still opens.`);
      else p.log.warn(`${msg} Browsing works; profiles and lenses won't run.`);
    } else {
      p.log.info(`Claude Code ${pc.dim(claude.version ?? '')} ${pc.dim('· using your Claude login (no API key)')}`);
    }

    // ---- 1. import CSV ----
    if (inputPath) {
      const s = p.spinner();
      s.start(`Reading ${tildify(inputPath)}`);
      let csvPeople: Person[];
      try {
        const { result } = await readPeopleCsv(inputPath);
        csvPeople = result.people;
        s.stop(`Read ${pc.bold(String(csvPeople.length))} people${result.skipped ? pc.dim(` · skipped ${result.skipped} rows`) : ''}`);
        for (const w of result.warnings.slice(0, 3)) p.log.warn(w);
      } catch (e) {
        s.error('Could not read CSV');
        p.log.error((e as Error).message);
        p.outro(pc.red('Aborted'));
        return 1;
      }
      if (!csvPeople.length) {
        p.log.error('No people found in that CSV. Expected columns like Name/First Name, Position/Title, URL, Connected On.');
        p.outro(pc.red('Aborted'));
        return 1;
      }
      store.upsertPeople(csvPeople, inputPath);
      const after = store.stats().people;
      p.log.success(`Imported into ${tildify(dbPath)} · ${pc.green(`+${Math.max(0, after - existing)} new`)} · ${after} people in your network`);
      existing = after;

      // cheap goal-free headline profiles for new/changed titles (cached per person+title)
      if (claude.ok) {
        const before = costs.byStage().enrich;
        const s2 = p.spinner();
        s2.start(`Profiling titles with ${DEFAULTS.enrichModel}`);
        let done = 0;
        const enriched = await enrichProfiles<Person & EnrichedFields>(csvPeople, {
          batchSize: DEFAULTS.enrichBatchSize,
          concurrency: DEFAULTS.enrichConcurrency,
          model: DEFAULTS.enrichModel,
          cache: dbProfileCache(store, DEFAULTS.enrichModel),
          costs,
          signal: controller.signal,
          hooks: {
            onBatchDone: (info) => {
              done++;
              s2.message(`Profiling titles · batch ${done}/${info.totalBatches}${info.fromCache ? ' (cached)' : ''} · ${formatUsd(costs.byStage().enrich - before)}`);
            },
          },
        });
        const profiled = enriched.filter((x) => x.profile).length;
        s2.stop(
          `Profiled ${profiled}/${enriched.length} · ${pc.yellow(formatUsd(costs.byStage().enrich - before))}` +
            (profiled < enriched.length ? pc.dim(` · ${enriched.length - profiled} failed (retried next import)`) : ''),
        );
      }
    }

    // ---- 2. lens from the command line ----
    let selectedLens: Lens | undefined;
    if (goal && claude.ok) {
      const scoreFn = flags.scoreFn ?? scoreLens;
      const lens =
        findLens(store, goal) ??
        store.createLens({
          goal,
          rankModel: 'haiku',
          rerankModel: (flags.rerankTop ?? 150) > 0 ? String(researchModel) : '',
          rerankTop: flags.rerankTop ?? 150,
        });
      selectedLens = lens;
      const all = store.listExplorerPeople();
      const todo = new Set(store.staleOrUnscored(lens.id));
      if (!todo.size) {
        p.log.info(`Lens “${lens.goal}” is up to date (${lens.scored} scored).`);
      } else {
        const est = estimateLensUsd(todo.size, lens.rerankModel ? lens.rerankTop : 0);
        if (!store.acquireLensLock(lens.id)) {
          p.log.error(`“${lens.goal}” is being scored by another network-builder process — try again when it finishes.`);
          return 1;
        }
        const lockBeat = setInterval(() => store.touchLensLock(lens.id), 30_000);
        lockBeat.unref?.();
        p.log.step(
          `${pc.magenta('Scoring')} “${lens.goal}” · ${todo.size} people ${pc.dim(`(≈ ${formatUsd(est)}; ${lens.rerankTop ? `top ${lens.rerankTop} re-checked with ${lens.rerankModel}` : 'no rerank'})`)}`,
        );
        const before = costs.byStage().lens;
        const s3 = p.spinner();
        s3.start('Scoring');
        try {
          await scoreFn({
            lens,
            people: all.filter((x) => todo.has(x.id)),
            allPeople: all,
            store,
            costs,
            signal: controller.signal,
            onProgress: ({ phase, done, total }) => s3.message(`${phase === 'rerank' ? 'Re-checking top candidates' : 'Scoring'} · ${done}/${total} · ${formatUsd(costs.byStage().lens - before)}`),
          });
        } finally {
          clearInterval(lockBeat);
          store.releaseLensLock(lens.id);
        }
        s3.stop(`Scored “${lens.goal}” · ${pc.yellow(formatUsd(costs.byStage().lens - before))}`);
      }
      console.log(lensTable(store.listExplorerPeople(), store.getLens(lens.id) ?? lens));
    } else if (goal) {
      selectedLens = findLens(store, goal);
    }

    process.off('SIGINT', onSigint);

    // ---- 3a. no server ----
    if (!serveMode) {
      p.outro(`${pc.green('Done.')} Open the explorer any time: ${pc.cyan('network-builder')}`);
      return 0;
    }

    // ---- 3b. explorer until Ctrl-C ----
    const shutdown = installShutdown();
    const lockPath = `${dbPath}.explorer.lock`;
    const lock = await acquireLock(lockPath).catch((e: Error) => {
      shutdown.dispose();
      throw e;
    });
    if (!lock.ok) {
      shutdown.dispose();
      const url = store.getMeta('explorer_url');
      p.log.warn(
        `The explorer is already running${lock.pid ? ` (pid ${lock.pid})` : ''}.` +
          (url ? `\nOpen it: ${pc.cyan(url)}${selectedLens ? pc.dim(`  (reload to see “${selectedLens.goal}”)`) : ''}` : ''),
      );
      if (url && flags.open !== false) openInBrowser(selectedLens ? `${url}&lens=${encodeURIComponent(selectedLens.id)}` : url);
      if (url && flags.readyFile) await writeReadyFile(flags.readyFile, { url, pid: lock.pid ?? null, reused: true });
      p.outro('Using the running explorer.');
      return 0;
    }

    let server: Awaited<ReturnType<typeof startExplorerServer>>;
    try {
      const template = await ensureDossierTemplate(dossierPath);
      if (template.created) p.log.info(`Created the dossier template ${pc.cyan(tildify(template.path))} ${pc.dim('(what profiles capture — edit freely)')}`);
      server = await startExplorerServer({
        store,
        dbPath,
        outDir,
        template: template.content,
        researchModel: String(researchModel),
        port: flags.port,
        preferredPort: stablePortFor(dbPath),
        concurrency: { light: flags.lightConcurrency ?? 3, deep: flags.concurrency ?? 2 },
        costs,
        rerankTop: flags.rerankTop,
        dossierFn: flags.dossierFn,
        scoreFn: flags.scoreFn,
        onEvent: (e) => logEvent(e, store),
      });
    } catch (e) {
      await lock.release();
      shutdown.dispose();
      p.log.error(`Could not start the explorer: ${(e as Error).message}`);
      p.outro(pc.red('Aborted'));
      return 1;
    }
    store.setMeta('explorer_url', server.url);
    if (flags.readyFile) await writeReadyFile(flags.readyFile, { url: server.url, pid: process.pid, reused: false });
    const openUrl = selectedLens ? `${server.url}&lens=${encodeURIComponent(selectedLens.id)}` : server.url;

    const snap = await server.snapshot().catch(() => '');
    if (!shutdown.isRequested()) {
      const st = server.state();
      const dossiers = st.people.filter((x) => x.dossier?.status === 'ok').length;
      p.note(
        [
          `${pc.dim('open      ')}${pc.cyan(pc.underline(openUrl))}`,
          `${pc.dim('network   ')}${st.people.length} people · ${st.people.filter((x) => x.profile).length} profiled · ${dossiers} with web profiles · ${st.lenses.length} lens${st.lenses.length === 1 ? '' : 'es'}`,
          `${pc.dim('snapshot  ')}${snap ? tildify(snap) : pc.dim('(explorer.html template missing)')}`,
          '',
          pc.dim('Select people → “Build light profiles” (≈ $0.01–0.02 each) or “Deep profile”. Create lenses for any goal.'),
          pc.dim('Everything saves to the database as it happens. Press Ctrl-C here when you are done.'),
        ].join('\n'),
        'Network explorer',
      );
      if (flags.open !== false && !openInBrowser(openUrl)) p.log.warn('Could not open a browser — open the URL above manually.');
    }

    const sig = await shutdown.requested;
    console.log(`\n${pc.yellow('■')} Stopping (${sig})… ${pc.dim('(cancelling queued work, writing a snapshot; Ctrl-C again to force quit)')}`);
    let final = { snapshot: '' };
    try {
      final = await server.close();
    } finally {
      await lock.release();
      shutdown.dispose();
      try {
        if (store.getMeta('explorer_url') === server.url) store.setMeta('explorer_url', '');
      } catch {
        /* ignore */
      }
    }
    const c = server.state().costs;
    p.note(
      [
        `${pc.dim('snapshot  ')}${final.snapshot ? tildify(final.snapshot) : pc.dim('(none)')}`,
        `${pc.dim('spent     ')}${pc.yellow(`${formatUsd(costs.total())}`)} this session ${pc.dim(`· all-time ${formatUsd(c.total)} (profiles ${formatUsd(c.enrich)} · web ${formatUsd(c.dossier)} · lenses ${formatUsd(c.lens)})`)}`,
        `${pc.dim('elapsed   ')}${Math.round((Date.now() - startedAt) / 1000)}s`,
      ].join('\n'),
      'Saved',
    );
    p.outro(`Reopen any time: ${pc.cyan('network-builder')}`);
    return 0;
  } catch (err) {
    if (controller.signal.aborted || (err as Error)?.name === 'AbortError') {
      p.log.warn(`Interrupted. Spent ${formatUsd(costs.total())}; everything finished is saved in ${tildify(dbPath)}.`);
      p.outro(pc.yellow('Rerun the same command to continue.'));
      return 130;
    }
    p.log.error((err as Error)?.stack ?? String(err));
    p.outro(pc.red('Failed'));
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    store.close();
  }
}

/** one terminal line per meaningful explorer event */
function logEvent(e: ExplorerEvent, store: Store): void {
  switch (e.type) {
    case 'person': {
      const d = e.person.dossier;
      const name = pc.bold(e.person.fullName || e.person.id);
      if (e.error) console.log(`  ${pc.red('✗')} ${name}${pc.dim(':')} ${pc.red(e.error.slice(0, 100))}`);
      else if (d?.status === 'ok')
        console.log(`  ${pc.green('✓')} ${name} ${pc.dim(`· ${d.depth} profile · ${d.dossier?.confidence ?? ''} · ${formatUsd(d.costUsd)} · total ${formatUsd(e.costs.total)}`)}`);
      break;
    }
    case 'notice':
      console.log(`  ${e.level === 'error' ? pc.red('!') : e.level === 'warn' ? pc.yellow('!') : pc.blue('i')} ${e.message}`);
      break;
    case 'lens':
      console.log(`  ${pc.magenta('◆')} lens “${e.lens.goal}” scored ${e.scores?.length ?? 0} ${pc.dim(`· total ${formatUsd(e.costs.total)}`)}`);
      break;
    default:
      void store;
      break;
  }
}
