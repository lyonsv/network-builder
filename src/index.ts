import { Command, InvalidArgumentError } from 'commander';
import { runDb, runExport, runLensList, runLensRescore, runLensRm, runLists, type DbCmdFlags, type DbFlags, type ExportFlags, type LensRescoreFlags } from './cli/db';
import { runExplore, type ExploreFlags } from './cli/explore';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { DEFAULTS, DEFAULT_DB_PATH, DEFAULT_OUT_DIR, REPORTS_ROOT } from './types';
import { DEFAULT_DOSSIER_PATH } from './llm/dossier';

/** package version (dist/*.js and src/*.ts both sit one level below package.json) */
const VERSION = (() => {
  try {
    return String((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();
const home = os.homedir();
const tildify = (f: string) => (f.startsWith(home) ? `~${f.slice(home.length)}` : f);

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Must be a whole number ≥ 1.');
  return n;
}
function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('Must be a whole number ≥ 0.');
  return n;
}

const program = new Command();

const explorerOptions = (cmd: Command) =>
  cmd
    .option('--db <path>', `SQLite database (default ${tildify(DEFAULT_DB_PATH)})`)
    .option('-o, --out-dir <path>', `where exports and snapshots go (default ${tildify(DEFAULT_OUT_DIR)})`)
    .option('--cache-dir <path>', 'legacy file cache from early versions, imported into the database once')
    .option('--dossier <path>', `what web profiles capture (default ${tildify(DEFAULT_DOSSIER_PATH)})`)
    .option('--research-model <model>', `model for deep profiles and lens re-checks (default ${DEFAULTS.researchModel})`)
    .option('-c, --concurrency <n>', 'parallel deep profiles (default 2)', positiveInt)
    .option('--light-concurrency <n>', 'parallel light profiles (default 3)', positiveInt)
    .option('--rerank-top <n>', 'new lenses: re-check the top N with the research model (0 = off; default 150)', nonNegativeInt)
    .option('--no-open', "don't open the browser automatically (the URL is printed)")
    .option('--port <n>', 'explorer port (default: a stable port for this database, else random)', positiveInt)
    .option('--ready-file <path>', 'write {url, pid, reused} JSON here once the explorer is up (used by the desktop app)');

explorerOptions(
  program
    .name('network-builder')
    .enablePositionalOptions()
    .version(VERSION)
    .description(
      'Explore your LinkedIn network: import connections, build goal-free web profiles for the people you pick, and score\n' +
        'everyone against any goal ("lenses": angel investors, heads of marketing, …). Opens a local explorer in your browser.\n' +
        'All model calls go through your local Claude Code CLI login, so no API key is needed.\n' +
        `Your data lives in ${tildify(REPORTS_ROOT)} (set NETWORK_BUILDER_HOME to move it).`,
    )
    .option('-i, --input <path>', 'import a connections CSV (LinkedIn export or any CSV with name/title/url/date columns)')
    .option('-p, --prompt <goal>', 'create (or refresh) a lens for this goal, e.g. "potential angel investors"'),
)
  .option('--dry-run', 'show what would happen; make no model calls and write nothing')
  .option('--no-serve', "do the import/scoring, then exit without opening the explorer (default when not a TTY)")
  .action(async (opts: ExploreFlags) => {
    process.exitCode = await runExplore(opts);
  });

/**
 * `network-builder --db X lists` puts --db on the ROOT command (positional options keep root and subcommand
 * options apart), so subcommands fall back to root-level --db / --out-dir / --cache-dir.
 */
const withRoot = <T extends { db?: string; outDir?: string; cacheDir?: string }>(opts: T): T => {
  const root = program.opts<{ db?: string; outDir?: string; cacheDir?: string }>();
  return {
    ...opts,
    db: opts.db ?? root.db,
    outDir: opts.outDir ?? root.outDir,
    ...('cacheDir' in opts || root.cacheDir ? { cacheDir: opts.cacheDir ?? root.cacheDir } : {}),
  };
};

explorerOptions(
  program
    .command('serve')
    .description('open the network explorer (same as running with no arguments)')
    .argument('[report]', 'ignored: older per-goal report files are now imported into the database'),
).action(async (report: string | undefined, opts: ExploreFlags) => {
  if (report) console.log(`Note: “${report}” ignored — reports are imported into the database; opening the explorer.`);
  process.exitCode = await runExplore(withRoot(opts));
});

explorerOptions(
  program
    .command('import')
    .description('add people from a CSV (LinkedIn connections export or any lead list); repeat imports merge, then the explorer opens')
    .argument('<csv>', 'path to the CSV file')
    .option('-p, --prompt <goal>', 'also create (or refresh) a lens for this goal')
    .option('--no-serve', "import (and score), then exit without opening the explorer"),
).action(async (csv: string, opts: ExploreFlags) => {
  process.exitCode = await runExplore(withRoot({ ...opts, input: csv }));
});

const dbOptions = (cmd: Command) =>
  cmd
    .option('--db <path>', `SQLite database (default ${tildify(DEFAULT_DB_PATH)})`)
    .option('-O, --out-dir <path>', `outputs folder (default ${tildify(DEFAULT_OUT_DIR)})`)
    .option('--cache-dir <path>', 'legacy file cache from early versions, imported once');

dbOptions(program.command('lists').description('show saved lists (built in the explorer) with their sizes')).action(
  async (opts: DbFlags) => {
    process.exitCode = await runLists(withRoot(opts));
  },
);

dbOptions(
  program
    .command('export')
    .description('write a saved list to CSV for your CRM or 1-1 outreach (default: outputs/<date>_<list>_<N>.csv)')
    .requiredOption('-l, --list <name|id>', 'saved list name or id (see `network-builder lists`)')
    .option('--preset <preset>', 'crm (HubSpot/Salesforce-friendly columns), full (every column) or ahoy (Ahoy CRM import: companies + contacts + notes CSVs)', 'crm')
    .option('--lens <id|goal>', 'lens for the Fit Score / Fit Reason columns (default: the lens the list was saved under)')
    .option('-o, --output <file>', 'output CSV path'),
).action(async (opts: ExportFlags) => {
  process.exitCode = await runExport(withRoot(opts));
});

dbOptions(
  program
    .command('db')
    .description('database stats: people, profiles, web profiles, lenses, lists, spend')
    .option('--import-legacy', 're-run the (idempotent) import of old cache files and report JSONs'),
).action(async (opts: DbCmdFlags) => {
  process.exitCode = await runDb(withRoot(opts));
});

const lens = program.command('lens').description('manage lenses (goals scored across your whole network)');
dbOptions(lens.command('list').description('show lenses with scored/stale counts')).action(async (opts: DbFlags) => {
  process.exitCode = await runLensList(withRoot(opts));
});
dbOptions(
  lens
    .command('rescore')
    .description('re-score a lens with the current scoring rules (everyone, or only stale people with --stale)')
    .argument('<id|goal>', 'lens id or goal')
    .option('--stale', 'only people whose info changed since they were scored')
    .option('--goal <text>', 'reword the lens first (same id; pins and threshold kept; re-scores everyone)')
    .option('--rerank-top <n>', 'change how many top people the rerank model re-checks (saved on the lens)', (v: string) => Number.parseInt(v, 10))
    .option('-y, --yes', 'skip the cost confirmation'),
).action(async (idOrGoal: string, opts: LensRescoreFlags) => {
  process.exitCode = await runLensRescore(idOrGoal, withRoot(opts));
});
dbOptions(lens.command('rm').description('delete a lens and its scores').argument('<id|goal>', 'lens id or goal')).action(
  async (idOrGoal: string, opts: DbFlags) => {
    process.exitCode = await runLensRm(idOrGoal, withRoot(opts));
  },
);

program
  .command('mcp')
  .description('run an MCP server (stdio) so Claude Code and other MCP clients can search and curate your network')
  .option('--db <path>', `SQLite database (default ${tildify(DEFAULT_DB_PATH)})`)
  .option('-o, --out-dir <path>', `where exports go (default ${tildify(DEFAULT_OUT_DIR)})`)
  .action(async (opts: { db?: string; outDir?: string }) => {
    const { runMcpServer } = await import('./mcp/server');
    await runMcpServer(withRoot(opts));
  });

// `pnpm start -- …` / `pnpm dev -- …` pass a literal "--" through; drop it so options still parse.
const argv = process.argv[2] === '--' ? [...process.argv.slice(0, 2), ...process.argv.slice(3)] : process.argv;

// Inside the desktop app the CLI runs as an Electron utility process, which stays alive after its work is done (the
// parent port keeps it open). Exit explicitly so the app sees the exit code (e.g. "database is newer than this app")
// instead of waiting forever on its loading screen.
const inElectronUtility = 'parentPort' in process && (process as { parentPort?: unknown }).parentPort != null;

program
  .parseAsync(argv)
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (inElectronUtility) process.exit(process.exitCode ?? 0);
  });
