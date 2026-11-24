/**
 * `network-builder setup`: everything after the CLI itself is installed. Interactive on a terminal (a guided wizard),
 * `--agent` for Claude Code (does the automatic steps, prints what the human still has to do), `--status [--json]`.
 * Safe to run again: every step checks first and skips what's done.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as p from '@clack/prompts';
import { execa } from 'execa';
import pc from 'picocolors';
import { readPeopleCsv } from '../io/csv';
import {
  ahoyConnected,
  APP_NAME,
  CONNECTIONS_URL,
  CONNECTORS_URL,
  EXPORTER_REPO,
  LINKEDIN_EXPORT_URL,
  REPO,
  appVersion,
  checklist,
  chromeHasExtension,
  chromeInstalled,
  claudeRun,
  collectState,
  findClaude,
  isAppleSilicon,
  packageRoot,
  packageVersion,
  paths,
  peopleCount,
  skipped,
  tildify,
  type ChecklistItem,
  type SetupState,
} from './checks';

export interface SetupFlags {
  agent?: boolean;
  status?: boolean;
  json?: boolean;
  /** --agent: wait up to N minutes for a connections export to land in Downloads, then import it */
  watchDownloads?: number;
}

export const FIRST_PROMPT = 'Give me a quick tour of my network with the network-builder skill, then suggest three useful things I can do with it.';
export const EXAMPLE_PROMPTS = [
  'Find the marketing leaders in my network based in Ireland and build an Ahoy pipeline of the target companies and people to reach out to.',
  'Who in my network could introduce me to someone at <company>?',
  'Which of my connections are angel investors?',
];
const HEADLINE_USD_PER_PERSON = 0.0002;
/** how to run this command from a shell that may not have ~/.local/bin on PATH yet */
const CMD = process.env.NB_LAUNCHER ? tildify(process.env.NB_LAUNCHER) : 'network-builder';

const home = os.homedir();
let interactive = true;
const say = (s = '') => console.log(s);
const ok = (s: string) => (interactive ? p.log.success(s) : say(`✓ ${s}`));
const warn = (s: string) => (interactive ? p.log.warn(s) : say(`! ${s}`));
const info = (s: string) => (interactive ? p.log.info(s) : say(`  ${s}`));
const step = (s: string) => (interactive ? p.log.step(pc.bold(s)) : say(`\n== ${s}`));

function bail<T>(v: T | symbol): T {
  if (p.isCancel(v)) {
    p.cancel('Stopped. Run `network-builder setup` any time to pick up where you left off.');
    process.exit(130);
  }
  return v as T;
}
const confirm = async (message: string, initialValue = true): Promise<boolean> =>
  interactive ? bail<boolean>(await p.confirm({ message, initialValue })) : initialValue;

const copy = (s: string) => {
  try {
    execFileSync('pbcopy', [], { input: s });
  } catch {
    /* no clipboard */
  }
};
const openUrl = (url: string, chrome = false) => {
  if (skipped('open')) return;
  try {
    execFileSync('open', chrome ? ['-a', 'Google Chrome', url] : [url], { stdio: 'ignore' });
  } catch {
    try {
      execFileSync('open', [url], { stdio: 'ignore' });
    } catch {
      /* nothing to open with */
    }
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** clean a path typed or dragged into Terminal: quotes, backslash escapes, ~ */
export function cleanTypedPath(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1);
  else s = s.replace(/\\(.)/g, '$1');
  if (s === '~' || s.startsWith('~/')) s = path.join(home, s.slice(1));
  return s;
}

/** wait for Enter on a terminal; resolves true when pressed. Returns a cancel function too. */
function onEnter(): { pressed: () => boolean; stop: () => void } {
  let hit = false;
  if (!interactive || !process.stdin.isTTY) return { pressed: () => false, stop: () => {} };
  const handler = (d: Buffer) => {
    if (d.includes(13) || d.includes(10)) hit = true;
    if (d.includes(3)) {
      process.stdin.setRawMode?.(false);
      process.exit(130);
    }
  };
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', handler);
  return {
    pressed: () => hit,
    stop: () => {
      process.stdin.off('data', handler);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    },
  };
}

async function download(url: string, file: string, label?: string): Promise<boolean> {
  if (url.startsWith('file://')) {
    try {
      cpSync(new URL(url), file);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) return false;
    const total = Number(res.headers.get('content-length') ?? 0);
    let got = 0;
    let lastPct = -1;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    if (label && total) {
      body.on('data', (c: Buffer) => {
        got += c.length;
        const pct = Math.floor((got / total) * 10) * 10;
        if (pct !== lastPct && interactive) {
          lastPct = pct;
          process.stdout.write(`\r${pc.dim(`│  ${label} ${pct}%`)}`);
        }
      });
    }
    await pipeline(body, createWriteStream(file));
    if (label && total && interactive) process.stdout.write('\r\x1b[2K');
    return true;
  } catch {
    return false;
  }
}

const assetBase = () => process.env.NB_ASSET_BASE || `https://github.com/${REPO}/releases/download/v${packageVersion()}`;

// ----------------------------------------------------------------------------------------------------- steps

async function stepClaude(s: SetupState): Promise<void> {
  if (skipped('claude')) return;
  step('Claude Code');
  if (!s.claude.installed) {
    if (!interactive) return warn('Claude Code is not installed.');
    info('network-builder uses Claude Code for its AI, on your own Claude plan (Pro or Max). No API key needed.');
    if (!(await confirm('Install Claude Code now?'))) return warn('Skipped. Install it later: curl -fsSL https://claude.ai/install.sh | bash');
    await execa('/bin/bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], { stdio: 'inherit', reject: false });
    s.claude.installed = Boolean(await findClaude());
    if (!s.claude.installed) return warn('Claude Code did not install. See https://docs.claude.com/en/docs/claude-code/setup');
    s.claude.loggedIn = undefined;
  }
  if (s.claude.loggedIn === false || s.claude.loggedIn === undefined) {
    const auth = await claudeRun(['auth', 'status']);
    s.claude.loggedIn = /"loggedIn":\s*true/.test(auth.out) || (auth.ok && !/"loggedIn":\s*false/.test(auth.out));
  }
  if (s.claude.loggedIn) return ok(`Claude Code ${s.claude.version ?? ''} · logged in`.trim());
  if (!interactive) return warn('Claude Code is not logged in. The person needs to run `claude auth login` in Terminal.');
  info('Log in with your Claude account. A browser window opens.');
  const bin = (await findClaude())!;
  await execa(bin, ['auth', 'login'], { stdio: 'inherit', reject: false });
  const after = await claudeRun(['auth', 'status']);
  s.claude.loggedIn = /"loggedIn":\s*true/.test(after.out) || (after.ok && !/"loggedIn":\s*false/.test(after.out));
  if (s.claude.loggedIn) ok('Logged in');
  else warn('Still not logged in. Run `claude auth login`, then `network-builder setup` again.');
}

async function stepConnectClaude(s: SetupState): Promise<void> {
  step('Connect to Claude Code');
  const { launcher, skillsDir } = paths();
  if (!skipped('mcp') && s.claude.installed) {
    if (s.mcp.current) ok('Claude Code can read your network (MCP server "network-builder")');
    else {
      await claudeRun(['mcp', 'remove', '-s', 'user', 'network-builder']);
      const r = await claudeRun(['mcp', 'add', '-s', 'user', 'network-builder', '--', ...launcher, 'mcp']);
      s.mcp.current = r.ok;
      if (r.ok) ok('Claude Code can read your network now (MCP server "network-builder", every project)');
      else warn(`Couldn't connect it: ${r.out.split('\n')[0]}\n  Try: claude mcp add -s user network-builder -- ${launcher.join(' ')} mcp`);
    }
  }
  if (!skipped('skill')) {
    if (s.skill.current) ok('Claude Code skill is up to date');
    else {
      const dest = path.join(skillsDir, 'network-builder');
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(skillsDir, { recursive: true });
      cpSync(path.join(packageRoot(), 'skills', 'network-builder'), dest, { recursive: true });
      s.skill.current = true;
      ok(`Installed the Claude Code skill (${tildify(dest)})`);
    }
  }
}

async function stepApp(s: SetupState): Promise<void> {
  if (skipped('app')) return;
  step('Desktop app');
  if (!isAppleSilicon()) return warn('The desktop app needs an Apple silicon Mac. On this Mac, run `network-builder` to open the same app in your browser.');
  const want = packageVersion();
  let { appsDir } = paths();
  let dest = path.join(appsDir, APP_NAME);
  if (s.app.installed && s.app.version === want) {
    ok(`Network Builder ${want} is in ${tildify(appsDir)}`);
  } else {
    try {
      mkdirSync(appsDir, { recursive: true });
      execFileSync('test', ['-w', appsDir]);
    } catch {
      appsDir = path.join(home, 'Applications');
      mkdirSync(appsDir, { recursive: true });
      dest = path.join(appsDir, APP_NAME);
    }
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'nb-app-'));
    try {
      const zip = path.join(tmp, 'app.zip');
      const spin = interactive ? p.spinner() : undefined;
      spin?.start(`Downloading Network Builder ${want} (about 120 MB)`);
      if (!interactive) say(`  Downloading Network Builder ${want} (about 120 MB)…`);
      const got = await download(`${assetBase()}/Network-Builder-mac-arm64.zip`, zip);
      if (!got) {
        spin?.error('Download failed');
        return warn("Couldn't download the desktop app. Everything else works; run `network-builder setup` again later, or use `network-builder` to open it in your browser.");
      }
      execFileSync('ditto', ['-x', '-k', zip, path.join(tmp, 'x')]);
      const fresh = path.join(tmp, 'x', APP_NAME);
      if (!existsSync(fresh)) throw new Error('the download had no app in it');
      // quit a running copy of THIS app (by its path, so nothing else is touched), then swap it in
      const exe = `${dest}/Contents/MacOS/Network Builder`;
      try {
        execFileSync('pkill', ['-TERM', '-f', exe], { stdio: 'ignore' });
        for (let i = 0; i < 40; i++) {
          execFileSync('pgrep', ['-f', exe], { stdio: 'ignore' });
          await sleep(250);
        }
      } catch {
        /* not running (pgrep exits 1) */
      }
      const staged = `${dest}.new`;
      rmSync(staged, { recursive: true, force: true });
      execFileSync('ditto', [fresh, staged]);
      const old = `${dest}.old`;
      rmSync(old, { recursive: true, force: true });
      if (existsSync(dest)) renameSync(dest, old);
      renameSync(staged, dest);
      rmSync(old, { recursive: true, force: true });
      try {
        execFileSync('xattr', ['-dr', 'com.apple.quarantine', dest], { stdio: 'ignore' });
      } catch {
        /* none */
      }
      s.app = { ...s.app, installed: true, version: appVersion(dest) ?? want, path: dest };
      spin?.stop(`Installed Network Builder ${want} in ${tildify(appsDir)}`);
      if (!interactive) ok(`Installed Network Builder ${want} in ${tildify(appsDir)}`);
    } catch (e) {
      warn(`Couldn't install the desktop app (${(e as Error).message}). Run \`network-builder setup\` again.`);
      return;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (skipped('dock')) return;
  try {
    const dock = execFileSync('defaults', ['read', 'com.apple.dock', 'persistent-apps'], { encoding: 'utf8' });
    if (dock.includes('Network%20Builder.app') || dock.includes('Network Builder.app')) return;
    const url = `file://${encodeURI(dest)}/`;
    const tile = `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${url}</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>`;
    execFileSync('defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', tile]);
    execFileSync('killall', ['Dock'], { stdio: 'ignore' });
    ok('Added it to your Dock');
  } catch {
    /* Dock is optional */
  }
}

async function refreshExtensions(): Promise<void> {
  const { exporterDir, captureDir, extDir } = paths();
  mkdirSync(extDir, { recursive: true });
  const src = path.join(packageRoot(), 'extension');
  if (existsSync(path.join(src, 'manifest.json'))) {
    rmSync(captureDir, { recursive: true, force: true });
    cpSync(src, captureDir, { recursive: true });
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nb-ext-'));
  try {
    const tgz = path.join(tmp, 'x.tgz');
    if (await download(`https://codeload.github.com/${EXPORTER_REPO}/tar.gz/refs/heads/main`, tgz)) {
      mkdirSync(path.join(tmp, 'x'));
      execFileSync('tar', ['-xzf', tgz, '-C', path.join(tmp, 'x'), '--strip-components', '1']);
      if (existsSync(path.join(tmp, 'x', 'manifest.json'))) {
        // replace the contents in place: Chrome keeps pointing at this folder
        mkdirSync(exporterDir, { recursive: true });
        for (const f of readdirSync(exporterDir)) rmSync(path.join(exporterDir, f), { recursive: true, force: true });
        cpSync(path.join(tmp, 'x'), exporterDir, { recursive: true });
      }
    }
  } catch {
    /* keep what's there */
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Walk the person through Load unpacked for one folder and notice when Chrome has it. */
async function loadUnpacked(dir: string, name: string): Promise<boolean> {
  if (chromeHasExtension(dir)) {
    ok(`${name} is in Chrome`);
    return true;
  }
  copy(dir);
  openUrl('chrome://extensions', true);
  p.note(
    [
      `Chrome just opened its ${pc.bold('Extensions')} page.`,
      '',
      `1. Turn on ${pc.bold('Developer mode')} (the switch at the top right).`,
      `   ${pc.dim("It only lets you add an extension from a folder on your Mac. Nothing else changes.")}`,
      `2. Click ${pc.bold('Load unpacked')}.`,
      `3. Press ${pc.bold('⌘ Shift G')}, then ${pc.bold('⌘ V')} to paste the folder (already copied), then ${pc.bold('Enter')} and ${pc.bold('Select')}.`,
      '',
      pc.dim(`Folder: ${tildify(dir)}`),
      pc.dim("Page didn't open? Type chrome://extensions in Chrome's address bar."),
    ].join('\n'),
    `Add "${name}" to Chrome`,
  );
  const spin = p.spinner();
  spin.start('Waiting for Chrome to load it (press Enter to skip)');
  const key = onEnter();
  try {
    for (let i = 0; i < 900; i++) {
      if (chromeHasExtension(dir)) {
        spin.stop(`${name} is in Chrome`);
        return true;
      }
      if (key.pressed()) break;
      await sleep(1000);
    }
  } finally {
    key.stop();
  }
  spin.stop(pc.yellow(`Not seeing ${name} yet. You can add it later from ${tildify(dir)}`));
  return false;
}

async function stepExtensions(s: SetupState): Promise<void> {
  if (skipped('extensions')) return;
  step('Chrome');
  await refreshExtensions();
  const { exporterDir, captureDir } = paths();
  s.chrome.exporter = chromeHasExtension(exporterDir);
  s.chrome.capture = chromeHasExtension(captureDir);
  if (!interactive) return ok(`Extensions ready in ${tildify(path.dirname(exporterDir))}`);
  if (!chromeInstalled()) return warn('Google Chrome is not installed. You can still import LinkedIn\'s own export (next step), or install Chrome from https://www.google.com/chrome/ and run setup again.');
  if (s.chrome.exporter) ok('LinkedIn Connections Exporter is in Chrome');
  if (s.chrome.capture) ok('Network Builder for LinkedIn (profile capture) is in Chrome');
}

/** newest likely connections file in Downloads (export CSV, LinkedIn's Connections.csv, or LinkedIn's data-export zip) */
export function latestExport(since = 0, dir = path.join(home, 'Downloads')): string | undefined {
  let best: { f: string; m: number } | undefined;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const n of names) {
    if (!/^(linkedin-connections-.*\.csv|Connections.*\.csv|Basic_LinkedInDataExport.*\.zip|Complete_LinkedInDataExport.*\.zip)$/i.test(n)) continue;
    if (/\.(crdownload|download)$/i.test(n)) continue;
    const f = path.join(dir, n);
    const m = statSync(f).mtimeMs;
    if (m > since && (!best || m > best.m)) best = { f, m };
  }
  return best?.f;
}

/** a LinkedIn data-export zip → its Connections.csv, extracted into the data folder */
function csvFromExport(file: string): string {
  if (!/\.zip$/i.test(file)) return file;
  const out = path.join(paths().dataDir, 'imports');
  mkdirSync(out, { recursive: true });
  const target = path.join(out, `Connections-${new Date().toISOString().slice(0, 10)}.csv`);
  const listing = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n');
  const entry = listing.find((l) => /(^|\/)Connections\.csv$/i.test(l.trim()));
  if (!entry) throw new Error(`no Connections.csv inside ${path.basename(file)}`);
  const csv = execFileSync('unzip', ['-p', file, entry.trim()]);
  writeFileSync(target, csv);
  return target;
}

async function runImport(file: string): Promise<boolean> {
  let csv: string;
  try {
    csv = csvFromExport(file);
  } catch (e) {
    warn(`Couldn't read ${path.basename(file)}: ${(e as Error).message}`);
    return false;
  }
  let n = 0;
  try {
    n = (await readPeopleCsv(csv)).result.people.length;
  } catch (e) {
    warn(`Couldn't read ${path.basename(csv)}: ${(e as Error).message}`);
    return false;
  }
  const usd = Math.max(0.01, n * HEADLINE_USD_PER_PERSON);
  info(`${n.toLocaleString('en')} connections. Claude reads each headline (role, seniority, industry): about $${usd.toFixed(2)} of your Claude plan, ${n > 1500 ? 'a few minutes' : 'a minute or two'}.`);
  if (interactive && !(await confirm('Import them now?'))) return false;
  const { launcher } = paths();
  const r = await execa(launcher[0]!, [...launcher.slice(1), 'import', csv, '--no-serve'], { stdio: 'inherit', reject: false });
  if (r.exitCode !== 0) {
    warn(`The import stopped. Run it again (finished work is kept): network-builder import "${csv}" --no-serve`);
    return false;
  }
  return true;
}

async function waitForExport(since: number, minutes: number, allowTyping: boolean): Promise<string | undefined> {
  const spin = interactive ? p.spinner() : undefined;
  spin?.start(`Watching your Downloads folder for the file${allowTyping ? ' (press Enter to choose a file instead)' : ''}`);
  if (!interactive) say(`  Watching ~/Downloads for a connections export (up to ${minutes} min)…`);
  const key = allowTyping ? onEnter() : undefined;
  try {
    const until = Date.now() + minutes * 60_000;
    while (Date.now() < until) {
      const f = latestExport(since);
      if (f) {
        await sleep(2000); // let the download finish writing
        spin?.stop(`Found ${path.basename(f)}`);
        if (!interactive) ok(`Found ${path.basename(f)}`);
        return f;
      }
      if (key?.pressed()) break;
      await sleep(1500);
    }
  } finally {
    key?.stop();
  }
  spin?.stop(pc.dim('Stopped watching'));
  return undefined;
}

async function askForFile(): Promise<string | undefined> {
  for (;;) {
    const v = bail(await p.text({ message: 'Drag the CSV (or LinkedIn zip) into this window, or paste its path. Leave empty to skip.' }));
    if (!String(v ?? '').trim()) return undefined;
    const f = cleanTypedPath(String(v));
    if (existsSync(f)) return f;
    warn(`No file at ${f}`);
  }
}

async function stepConnections(s: SetupState, watchMinutes?: number): Promise<void> {
  step('Your LinkedIn connections');
  if (s.people > 0) {
    ok(`${s.people.toLocaleString('en')} connections in your network`);
    if (!interactive) return;
    if (!(await confirm('Import a newer export too? (adds new connections, refreshes job titles)', false))) return;
  }
  const started = Date.now();
  if (!interactive) {
    if (!watchMinutes) return;
    const f = latestExport(started - 3 * 86_400_000) ?? (await waitForExport(started - 5000, watchMinutes, false));
    if (f && (await runImport(f))) s.people = await peopleCount();
    return;
  }

  const recent = latestExport(started - 3 * 86_400_000);
  if (recent && (await confirm(`Found ${path.basename(recent)} in Downloads. Import it?`))) {
    if (await runImport(recent)) s.people = await peopleCount();
    return;
  }
  const how = bail(
    await p.select({
      message: 'How do you want to get your connections?',
      options: [
        { value: 'exporter', label: 'Chrome extension', hint: 'recommended · about a minute per 500 connections' },
        { value: 'linkedin', label: "LinkedIn's own export", hint: 'no extension · LinkedIn emails it, from 10 minutes to a day' },
        { value: 'file', label: 'I already have the file' },
        { value: 'skip', label: 'Skip for now' },
      ],
    }),
  );
  let file: string | undefined;
  if (how === 'skip') return warn('Skipped. Run `network-builder setup` when you have your connections.');
  if (how === 'file') file = await askForFile();
  if (how === 'linkedin') {
    openUrl(LINKEDIN_EXPORT_URL);
    p.note(
      [
        'LinkedIn just opened "Get a copy of your data".',
        `1. Choose ${pc.bold('Want something in particular?')} and tick ${pc.bold('Connections')}.`,
        `2. Click ${pc.bold('Request archive')} (LinkedIn may ask for your password).`,
        '3. When the email arrives, download the file. I\'ll spot it in Downloads,',
        `   or run ${pc.cyan('network-builder setup')} again then.`,
      ].join('\n'),
      "LinkedIn's export",
    );
    file = await waitForExport(started - 5000, 30, true);
    if (!file) file = await askForFile();
  }
  if (how === 'exporter') {
    if (!chromeInstalled()) {
      warn("Chrome isn't installed. Use LinkedIn's own export instead, or install Chrome and run setup again.");
      return;
    }
    const { exporterDir } = paths();
    info('This extension reads your Connections page and saves a CSV. It runs only when you click it and sends nothing anywhere.');
    s.chrome.exporter = await loadUnpacked(exporterDir, 'LinkedIn Connections Exporter');
    openUrl(CONNECTIONS_URL, true);
    p.note(
      [
        `LinkedIn's ${pc.bold('Connections')} page just opened (log in if asked).`,
        `1. Click the ${pc.bold('🧩 puzzle piece')} in Chrome's toolbar → ${pc.bold('LinkedIn Connections Exporter')} → ${pc.bold('Start export')}.`,
        `2. ${pc.bold('Keep that tab in front')} while it scrolls. It downloads a CSV when it's done.`,
        pc.dim('   Paused around 1,900? Choose "Pause 60s & retry". A LinkedIn security check? Stop and try tomorrow.'),
      ].join('\n'),
      'Export your connections',
    );
    file = await waitForExport(started - 5000, 60, true);
    if (!file) file = await askForFile();
  }
  if (file && (await runImport(file))) s.people = await peopleCount();
}

async function stepAhoy(s: SetupState): Promise<void> {
  if (skipped('claude') || !s.claude.installed) return;
  step('Ahoy CRM');
  if (s.ahoy.connected) return ok('Ahoy is connected to Claude Code');
  if (!interactive) return warn('Ahoy is not connected to Claude Code yet.');
  openUrl(CONNECTORS_URL);
  p.note(
    [
      `Claude's ${pc.bold('Connectors')} page just opened.`,
      `Find ${pc.bold('Ahoy')}, click ${pc.bold('Connect')} and sign in to Ahoy.`,
      pc.dim('Use the same Claude account you use in Claude Code. It can take a minute to show up.'),
    ].join('\n'),
    'Connect Ahoy',
  );
  for (;;) {
    const next = bail(
      await p.select({
        message: 'Connected?',
        options: [
          { value: 'check', label: 'Check again' },
          { value: 'link', label: 'Ahoy gave me an MCP link instead' },
          { value: 'skip', label: 'Skip for now' },
        ],
      }),
    );
    if (next === 'skip') return warn('Skipped. Connect it any time; Claude Code picks it up when it restarts.');
    if (next === 'link') {
      const link = String(bail(await p.text({ message: 'Paste the link (https://api.ahoy.ai/…/mcp/)' })) ?? '').trim();
      if (/^https:\/\//.test(link)) {
        await claudeRun(['mcp', 'remove', '-s', 'user', 'ahoy']);
        const r = await claudeRun(['mcp', 'add', '-s', 'user', '--transport', 'http', 'ahoy', link]);
        if (r.ok) {
          ok('Added. One more step in Claude Code: type /mcp, choose ahoy, then Authenticate.');
          return;
        }
        warn(`That didn't work: ${r.out.split('\n')[0]}`);
      }
      continue;
    }
    const spin = p.spinner();
    spin.start('Checking');
    s.ahoy.connected = await ahoyConnected();
    if (s.ahoy.connected) return spin.stop('Ahoy is connected to Claude Code');
    spin.stop(pc.yellow('Not connected yet'));
  }
}

/**
 * A folder to start Claude Code in for network work: not the home folder (Claude Code warns about trusting all of it).
 * Its CLAUDE.md points Claude at the network-builder skill.
 */
export function claudeWorkspace(): string {
  const dir = path.join(paths().dataDir, 'claude');
  mkdirSync(dir, { recursive: true });
  const md = path.join(dir, 'CLAUDE.md');
  if (!existsSync(md)) {
    writeFileSync(
      md,
      '# My network\n\nThis folder is for working with my LinkedIn network. Use the network-builder skill and its tools\n' +
        '(network_*), and the Ahoy connector for my CRM. Ask before anything that costs money or writes to Ahoy.\n',
    );
  }
  return dir;
}

// ----------------------------------------------------------------------------------------------------- output

function renderChecklist(items: ChecklistItem[]): string {
  return items
    .map((i) => {
      const mark = i.done ? pc.green('✓') : i.optional ? pc.dim('○') : pc.yellow('○');
      const label = i.done ? i.label : i.optional ? pc.dim(i.label) : i.label;
      return `${mark} ${label}${!i.done && i.todo ? `\n    ${pc.dim(i.todo)}` : ''}`;
    })
    .join('\n');
}

async function printStatus(json: boolean): Promise<number> {
  const s = await collectState();
  const items = checklist(s);
  const complete = items.every((i) => i.done || i.optional);
  if (json) {
    say(JSON.stringify({ version: s.version, complete, items, state: s }, null, 2));
  } else {
    say(`${pc.bold(`network-builder ${s.version}`)} ${pc.dim(`· data in ${tildify(s.dataDir)}`)}`);
    say(renderChecklist(items));
    if (!complete) say(pc.dim('\nRun `network-builder setup` to finish.'));
  }
  return complete ? 0 : 1;
}

export async function runSetup(flags: SetupFlags): Promise<number> {
  if (flags.status) return printStatus(Boolean(flags.json));
  if (process.platform !== 'darwin') {
    say('`network-builder setup` is for macOS. On Linux, run `network-builder` to import a CSV and open the explorer, and add the MCP server with: claude mcp add -s user network-builder -- network-builder mcp');
    return 1;
  }
  interactive = !flags.agent && Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (interactive) {
    p.intro(pc.inverse(' network-builder setup '));
    p.note(
      [
        `Your LinkedIn network → target lists → your ${pc.bold('Ahoy')} pipeline, with Claude.`,
        '',
        `• the ${pc.bold('Network Builder')} app in your Dock, and Claude Code connected to your network`,
        `• your ${pc.bold('LinkedIn connections')}, exported and imported`,
        `• a check that ${pc.bold('Ahoy')} is connected`,
        '',
        pc.dim(`About 10 minutes. Your network stays on this Mac (${tildify(paths().dataDir)}).`),
        pc.dim('AI runs on your own Claude plan. Safe to run again.'),
      ].join('\n'),
      'This sets up everything',
    );
  } else {
    say(`network-builder ${packageVersion()} setup (agent mode)`);
  }

  const s = await collectState({ ahoy: false });
  await stepClaude(s);
  await stepConnectClaude(s);
  await stepApp(s);
  await stepExtensions(s);
  await stepConnections(s, flags.watchDownloads);
  if (s.claude.installed && !skipped('claude')) {
    if (!interactive) s.ahoy.connected = await ahoyConnected();
    else {
      const spin = p.spinner();
      spin.start('Checking your Claude Code connections');
      s.ahoy.connected = await ahoyConnected();
      spin.stop(s.ahoy.connected ? 'Ahoy is connected' : 'Ahoy is not connected yet');
    }
  }
  await stepAhoy(s);

  const items = checklist(s);
  const pending = items.filter((i) => !i.done && !i.optional);
  if (!interactive) {
    say(`\n${renderChecklist(items)}`);
    say('\nNEXT STEPS FOR THE HUMAN (walk them through one at a time):');
    for (const i of pending) say(`- ${i.todo}`);
    if (!s.chrome.exporter && s.people === 0) {
      say(`- To add the exporter: copy the folder path to the clipboard (printf '%s' "${s.chrome.exporterDir}" | pbcopy), open chrome://extensions, then they turn on Developer mode → Load unpacked → ⌘⇧G → ⌘V → Enter → Select.`);
    }
    if (s.people === 0) say(`- When they have started the export, run: ${CMD} setup --agent --watch-downloads 30   (waits for the file in Downloads and imports it)`);
    say('- Then they restart Claude Code (type /exit, then `claude --continue`) so it loads network-builder.');
    say(`\nCheck any time: ${CMD} setup --status`);
    return 0;
  }

  p.note(renderChecklist(items), pending.length ? `Almost there: ${pending.length} to go` : 'All set');
  p.note(
    [
      `Open ${pc.bold('Claude Code')} on your network (in Terminal: ${pc.cyan('network-builder claude')}) and ask:`,
      ...EXAMPLE_PROMPTS.map((x) => pc.cyan(`  "${x}"`)),
      '',
      `Browse and curate in the ${pc.bold('Network Builder')} app in your Dock.`,
      pc.dim('Check your setup any time: network-builder setup --status'),
    ].join('\n'),
    'What next',
  );
  if (s.app.installed && s.people > 0 && (await confirm('Open the Network Builder app now?'))) {
    try {
      execFileSync('open', [s.app.path]);
    } catch {
      /* ignore */
    }
  }
  const claude = await findClaude();
  if (claude && s.claude.loggedIn && s.people > 0 && (await confirm('Start Claude Code now with a tour of your network?'))) {
    p.outro('Starting Claude Code…');
    await new Promise<void>((resolve) => spawn(claude, [FIRST_PROMPT], { stdio: 'inherit', cwd: claudeWorkspace() }).on('exit', () => resolve()));
    return 0;
  }
  p.outro(pending.length ? 'Run `network-builder setup` again any time to finish.' : 'Enjoy!');
  return 0;
}

/** `network-builder uninstall`: remove what setup added. Keeps your network data unless --delete-data. */
export async function runUninstall(flags: { deleteData?: boolean; yes?: boolean }): Promise<number> {
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !flags.yes;
  const p0 = paths();
  const appPaths = [path.join(p0.appsDir, APP_NAME), path.join(home, 'Applications', APP_NAME)].filter((x) => existsSync(x));
  const wrapper = process.env.NB_LAUNCHER;
  const lines = [
    'the Claude Code connection "network-builder" and the network-builder skill',
    ...appPaths.map((a) => `${tildify(a)} and its Dock icon`),
    wrapper ? `the ${tildify(wrapper)} command and its PATH line in ~/.zshrc` : '',
    `the app runtime in ${tildify(path.join(p0.dataDir, 'runtime'))} and ${tildify(path.join(p0.dataDir, 'app'))}`,
    flags.deleteData ? pc.red(`ALL your network data in ${tildify(p0.dataDir)}`) : `(your network data in ${tildify(p0.dataDir)} is kept; add --delete-data to remove it)`,
  ].filter(Boolean);
  if (interactive) {
    p.note(lines.map((l) => `• ${l}`).join('\n'), 'This removes');
    if (!(await confirm('Uninstall network-builder?', false))) return 0;
  } else say(`Removing:\n${lines.map((l) => `- ${l}`).join('\n')}`);
  if (!skipped('mcp')) await claudeRun(['mcp', 'remove', '-s', 'user', 'network-builder']);
  rmSync(path.join(p0.skillsDir, 'network-builder'), { recursive: true, force: true });
  for (const a of appPaths) {
    try {
      execFileSync('pkill', ['-TERM', '-f', `${a}/Contents/MacOS/Network Builder`], { stdio: 'ignore' });
    } catch {
      /* not running */
    }
    rmSync(a, { recursive: true, force: true });
  }
  try {
    if (skipped('dock')) throw new Error('skip');
    const dock = execFileSync('defaults', ['read', 'com.apple.dock', 'persistent-apps'], { encoding: 'utf8' });
    if (dock.includes('Network%20Builder.app')) {
      // rewrite the Dock list without our tile
      const script = `ObjC.import('Foundation');var d=$.NSUserDefaults.alloc.initWithSuiteName('com.apple.dock');var a=ObjC.deepUnwrap(d.objectForKey('persistent-apps'))||[];var k=a.filter(function(t){try{return String(t['tile-data']['file-data']['_CFURLString']).indexOf('Network%20Builder.app')<0}catch(e){return true}});d.setObjectForKey($(k),'persistent-apps');d.synchronize;`;
      execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { stdio: 'ignore' });
      execFileSync('killall', ['Dock'], { stdio: 'ignore' });
    }
  } catch {
    /* drag it off by hand */
  }
  for (const rc of skipped('rc') ? [] : [path.join(home, '.zshrc'), path.join(home, '.bash_profile')]) {
    try {
      const txt = (await import('node:fs')).readFileSync(rc, 'utf8');
      const cleaned = txt.replace(/\n# added by network-builder\nexport PATH="[^"\n]*"\n/g, '\n');
      if (cleaned !== txt) writeFileSync(rc, cleaned);
    } catch {
      /* no rc file */
    }
  }
  if (wrapper) rmSync(wrapper, { force: true });
  rmSync(path.join(p0.dataDir, 'runtime'), { recursive: true, force: true });
  rmSync(path.join(p0.dataDir, 'app'), { recursive: true, force: true });
  if (flags.deleteData) rmSync(p0.dataDir, { recursive: true, force: true });
  const done = 'Uninstalled. Remove the Chrome extensions in chrome://extensions if you added them.';
  if (interactive) p.outro(done);
  else say(done);
  return 0;
}
