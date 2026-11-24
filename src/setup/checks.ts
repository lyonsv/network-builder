/**
 * Setup checks shared by `network-builder setup` (interactive wizard), `setup --agent` (Claude Code) and
 * `setup --status [--json]`, so every route sees the same state. All checks are read-only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { DEFAULT_DB_PATH, REPORTS_ROOT } from '../types';

export const REPO = 'lyonsv/network-builder';
export const EXPORTER_REPO = 'lyonsv/chrome-linkedin-connections-exporter';
export const APP_NAME = 'Network Builder.app';
export const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
export const LINKEDIN_EXPORT_URL = 'https://www.linkedin.com/mypreferences/d/download-my-data';
export const CONNECTORS_URL = 'https://claude.ai/settings/connectors';

const home = os.homedir();
export const tildify = (f: string): string => (f.startsWith(home) ? `~${f.slice(home.length)}` : f);

/** steps skipped via NB_SKIP="mcp app dock skill extensions claude open" (tests, unusual setups) */
export const skipped = (step: string): boolean => ` ${process.env.NB_SKIP ?? ''} `.includes(` ${step} `);

/** the package root (holds package.json, skills/, extension/), from dist/ or src/setup/ */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const pj = path.join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name === 'network-builder') return dir;
      } catch {
        /* keep looking */
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error('network-builder package root not found');
}

export function packageVersion(): string {
  try {
    return String((JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export interface Paths {
  dataDir: string;
  dbPath: string;
  extDir: string;
  exporterDir: string;
  captureDir: string;
  appsDir: string;
  skillsDir: string;
  /** the command Claude Code should run for the MCP server (the installer's launcher when there is one) */
  launcher: string[];
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const extDir = path.join(REPORTS_ROOT, 'extensions');
  let appsDir = env.NB_APPS_DIR || '/Applications';
  // standard (non-admin) users can't write /Applications; the app then lives in ~/Applications
  if (!env.NB_APPS_DIR && !existsSync(path.join(appsDir, APP_NAME)) && existsSync(path.join(home, 'Applications', APP_NAME))) {
    appsDir = path.join(home, 'Applications');
  }
  const launcher = env.NB_LAUNCHER && existsSync(env.NB_LAUNCHER)
    ? [env.NB_LAUNCHER]
    : [process.execPath, process.argv[1] ?? path.join(packageRoot(), 'dist', 'bin.js')];
  return {
    dataDir: REPORTS_ROOT,
    dbPath: DEFAULT_DB_PATH,
    extDir,
    exporterDir: path.join(extDir, 'linkedin-connections-exporter'),
    captureDir: path.join(extDir, 'network-builder'),
    appsDir,
    skillsDir: env.NB_SKILLS_DIR || path.join(home, '.claude', 'skills'),
    launcher,
  };
}

/** Apple silicon, even when this process runs under Rosetta */
export function isAppleSilicon(): boolean {
  if (process.arch === 'arm64') return true;
  try {
    return execFileSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------- Claude Code

export async function findClaude(): Promise<string | undefined> {
  const candidates = [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  try {
    const r = await execa('/bin/sh', ['-c', 'command -v claude'], { reject: false });
    if (r.exitCode === 0 && String(r.stdout).trim()) return String(r.stdout).trim();
  } catch {
    /* fall through */
  }
  return candidates.find((c) => existsSync(c));
}

export async function claudeRun(args: string[], timeout = 60_000): Promise<{ ok: boolean; out: string }> {
  const bin = await findClaude();
  if (!bin) return { ok: false, out: 'claude not found' };
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const r = await execa(bin, args, { reject: false, timeout, env });
  return { ok: r.exitCode === 0, out: `${String(r.stdout ?? '')}\n${String(r.stderr ?? '')}`.trim() };
}

// -------------------------------------------------------------------------------------------------------- Chrome

export function chromeInstalled(): boolean {
  return ['/Applications/Google Chrome.app', path.join(home, 'Applications', 'Google Chrome.app')].some((p) => existsSync(p));
}

/** is an unpacked extension loaded from this folder, in any Chrome profile? */
export function chromeHasExtension(dir: string): boolean {
  const root = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  let profiles: string[] = [];
  try {
    profiles = readdirSync(root);
  } catch {
    return false;
  }
  const needle = JSON.stringify(dir); // paths are stored JSON-escaped
  for (const prof of profiles) {
    for (const f of ['Secure Preferences', 'Preferences']) {
      try {
        if (readFileSync(path.join(root, prof, f), 'utf8').includes(needle)) return true;
      } catch {
        /* not a profile */
      }
    }
  }
  return false;
}

// --------------------------------------------------------------------------------------------------------- state

export interface SetupState {
  version: string;
  node: { ok: boolean; version: string };
  claude: { installed: boolean; version?: string; loggedIn?: boolean };
  mcp: { registered: boolean; current: boolean };
  ahoy: { connected: boolean };
  skill: { installed: boolean; current: boolean; path: string };
  app: { supported: boolean; installed: boolean; version?: string; path: string };
  chrome: { installed: boolean; exporter: boolean; capture: boolean; exporterDir: string; captureDir: string };
  people: number;
  dataDir: string;
}

export function appVersion(appPath: string): string | undefined {
  try {
    return execFileSync('defaults', ['read', path.join(appPath, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

export async function peopleCount(dbPath = DEFAULT_DB_PATH): Promise<number> {
  if (!existsSync(dbPath)) return 0;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return Number((db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n?: number } | undefined)?.n ?? 0);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

export async function ahoyConnected(): Promise<boolean> {
  const r = await claudeRun(['mcp', 'list'], 90_000);
  return r.out.split('\n').some((l) => /ahoy/i.test(l) && /connected/i.test(l) && !/fail|needs auth/i.test(l));
}

export async function collectState(opts: { ahoy?: boolean } = {}): Promise<SetupState> {
  const p = paths();
  const version = packageVersion();
  const claudeBin = await findClaude();
  let claudeVersion: string | undefined;
  let loggedIn: boolean | undefined;
  let mcpOut = '';
  if (claudeBin) {
    claudeVersion = (await claudeRun(['--version'])).out.split('\n')[0];
    const auth = await claudeRun(['auth', 'status']);
    try {
      loggedIn = Boolean((JSON.parse(auth.out.split('\n').find((l) => l.trim().startsWith('{')) ?? '{}') as { loggedIn?: boolean }).loggedIn);
    } catch {
      loggedIn = auth.ok;
    }
    const mcp = await claudeRun(['mcp', 'get', 'network-builder']);
    mcpOut = mcp.ok ? mcp.out : '';
  }
  const skillPath = path.join(p.skillsDir, 'network-builder', 'SKILL.md');
  let skillCurrent = false;
  try {
    skillCurrent = readFileSync(skillPath, 'utf8') === readFileSync(path.join(packageRoot(), 'skills', 'network-builder', 'SKILL.md'), 'utf8');
  } catch {
    /* missing */
  }
  const appPath = path.join(p.appsDir, APP_NAME);
  const appInstalled = existsSync(appPath);
  return {
    version,
    node: { ok: true, version: process.versions.node },
    claude: { installed: Boolean(claudeBin), version: claudeVersion, loggedIn },
    mcp: { registered: Boolean(mcpOut), current: Boolean(mcpOut) && mcpOut.includes(p.launcher[p.launcher.length - 1]!) },
    ahoy: { connected: opts.ahoy === false || !claudeBin ? false : await ahoyConnected() },
    skill: { installed: existsSync(skillPath), current: skillCurrent, path: skillPath },
    app: { supported: isAppleSilicon(), installed: appInstalled, version: appInstalled ? appVersion(appPath) : undefined, path: appPath },
    chrome: {
      installed: chromeInstalled(),
      exporter: chromeHasExtension(p.exporterDir),
      capture: chromeHasExtension(p.captureDir),
      exporterDir: p.exporterDir,
      captureDir: p.captureDir,
    },
    people: await peopleCount(p.dbPath),
    dataDir: p.dataDir,
  };
}

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  optional?: boolean;
  /** what to do when it isn't done, in plain words */
  todo?: string;
}

/** The setup checklist, in order. The same list ends the wizard, fills `--status` and drives `--agent`'s next steps. */
export function checklist(s: SetupState): ChecklistItem[] {
  const items: ChecklistItem[] = [
    {
      id: 'claude',
      label: s.claude.installed ? `Claude Code${s.claude.loggedIn === false ? ' (not logged in)' : ''}` : 'Claude Code',
      done: s.claude.installed && s.claude.loggedIn !== false,
      todo: s.claude.installed ? 'Log in to Claude Code: run `claude auth login` in Terminal.' : 'Install Claude Code: run `curl -fsSL https://claude.ai/install.sh | bash`.',
    },
    {
      id: 'mcp',
      label: 'Claude Code can read your network',
      done: s.mcp.current,
      todo: 'Run `network-builder setup` again to connect it.',
    },
    {
      id: 'skill',
      label: 'Claude Code skill',
      done: s.skill.current,
      todo: 'Run `network-builder setup` again to install it.',
    },
    {
      id: 'app',
      label: s.app.supported ? `Desktop app${s.app.version ? ` ${s.app.version}` : ''}` : 'Desktop app (Apple silicon only; run `network-builder` instead)',
      done: !s.app.supported || (s.app.installed && s.app.version === s.version),
      optional: !s.app.supported,
      todo: 'Run `network-builder setup` again to install it.',
    },
    {
      id: 'people',
      label: s.people ? `${s.people.toLocaleString('en')} connections imported` : 'Your LinkedIn connections imported',
      done: s.people > 0,
      todo: s.chrome.exporter
        ? `Export them: open ${CONNECTIONS_URL}, click the exporter → Start export, then \`network-builder setup\` imports the file.`
        : 'Add the connections exporter to Chrome and export them: run `network-builder setup`.',
    },
    {
      id: 'ahoy',
      label: 'Ahoy connected to Claude Code',
      done: s.ahoy.connected,
      todo: `Connect it: ${CONNECTORS_URL} → Ahoy → Connect (same Claude account), then restart Claude Code.`,
    },
    {
      id: 'capture',
      label: 'Profile capture extension (optional)',
      done: s.chrome.capture,
      optional: true,
      todo: `For mapping target companies later: Load unpacked ${tildify(s.chrome.captureDir)} in chrome://extensions.`,
    },
  ];
  return items;
}
