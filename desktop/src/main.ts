/**
 * Network Builder desktop shell (macOS). Runs the network-builder explorer server as an Electron utility process and
 * shows the explorer page in a native window. All data stays where the CLI keeps it (~/.network-builder or
 * $NETWORK_BUILDER_HOME); AI work goes through the user's Claude Code CLI, found via their login-shell PATH because
 * Dock-launched apps get a minimal PATH.
 *
 * Environment (tests / development):
 *   NB_DESKTOP_SERVER   path to the server bundle (default: packaged resources/server/bin.mjs or ../dist-server/bin.mjs)
 *   NB_DESKTOP_SMOKE=1  start, load the explorer, print "NB_SMOKE_OK <url>" to stdout and quit
 *   NETWORK_BUILDER_HOME  data folder (passed through to the server)
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, Menu, app, dialog, nativeTheme, shell, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess } from 'electron';

const APP_NAME = 'Network Builder';
const SMOKE = process.env.NB_DESKTOP_SMOKE === '1';
app.setName(APP_NAME);

let win: BrowserWindow | null = null;
let server: UtilityProcess | null = null;
let explorerUrl = '';
let quitting = false;

// ---------------------------------------------------------------- paths

function serverEntry(): string {
  if (process.env.NB_DESKTOP_SERVER) return path.resolve(process.env.NB_DESKTOP_SERVER);
  return app.isPackaged ? path.join(process.resourcesPath, 'server', 'bin.mjs') : path.join(__dirname, '..', 'dist-server', 'bin.mjs');
}

/** Same rule as the CLI's resolveDataHome(): env, else whichever folder holds network.db, else ~/.network-builder. */
function dataHome(): string {
  const env = process.env.NETWORK_BUILDER_HOME?.trim();
  if (env) return path.resolve(env.replace(/^~(?=$|\/)/, os.homedir()));
  const home = path.join(os.homedir(), '.network-builder');
  const legacy = path.join(os.homedir(), 'git', 'reports', 'network-builder');
  if (existsSync(path.join(home, 'network.db'))) return home;
  if (existsSync(path.join(legacy, 'network.db'))) return legacy;
  return home;
}
const hasDatabase = () => existsSync(path.join(dataHome(), 'network.db'));

const logFile = () => {
  const dir = path.join(app.getPath('userData'), 'logs');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'server.log');
};
function log(line: string): void {
  try {
    appendFileSync(logFile(), `${new Date().toISOString()} ${line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')}\n`);
  } catch {
    /* logging is best effort */
  }
}

/** The user's login-shell PATH (Dock-launched apps only get /usr/bin:/bin:…, which misses `claude` and `node`). */
function loginShellPath(): string {
  try {
    const shellBin = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shellBin, ['-ilc', 'printf "__NB_PATH__%s__NB_END__" "$PATH"'], { encoding: 'utf8', timeout: 10_000 });
    const m = /__NB_PATH__([\s\S]*?)__NB_END__/.exec(out);
    return m?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}
let cachedPath: string | null = null;
function childEnv(): NodeJS.ProcessEnv {
  if (cachedPath === null) {
    const extra = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
    cachedPath = [loginShellPath(), process.env.PATH ?? '', ...extra].filter(Boolean).join(':');
  }
  return { ...process.env, PATH: cachedPath, NB_FORCE_SERVE: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
}

// ---------------------------------------------------------------- the explorer server (utility process)

/** Start `network-builder [args…]` and resolve with the explorer URL once it is reachable. */
function startServer(args: string[]): Promise<string> {
  const ready = path.join(app.getPath('temp'), `network-builder-ready-${process.pid}-${Date.now()}.json`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const tail: string[] = [];
    const remember = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        log(line);
        tail.push(line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
        if (tail.length > 12) tail.shift();
      }
    };
    const child = utilityProcess.fork(serverEntry(), [...args, '--no-open', '--ready-file', ready], {
      env: childEnv(),
      stdio: 'pipe',
      serviceName: 'Network Builder server',
    });
    server = child;
    child.stdout?.on('data', remember);
    child.stderr?.on('data', remember);
    const timer = setInterval(() => {
      if (settled || !existsSync(ready)) return;
      try {
        const info = JSON.parse(readFileSync(ready, 'utf8')) as { url?: string; reused?: boolean };
        rmSync(ready, { force: true });
        if (!info.url) return;
        settled = true;
        clearInterval(timer);
        log(`explorer ready at ${info.url}${info.reused ? ' (an explorer was already running on this database)' : ''}`);
        resolve(info.url);
      } catch {
        /* half-written: try again */
      }
    }, 150);
    child.on('exit', (code) => {
      log(`server exited (${code})`);
      if (server === child) server = null;
      if (!settled) {
        settled = true;
        clearInterval(timer);
        reject(new Error(tail.join('\n') || `the explorer server exited (${code})`));
      } else if (!quitting && code !== 0 && win && !win.isDestroyed()) {
        void dialog
          .showMessageBox(win, {
            type: 'warning',
            message: 'The Network Builder server stopped.',
            detail: tail.slice(-6).join('\n'),
            buttons: ['Restart', 'Quit'],
          })
          .then((r) => (r.response === 0 ? boot() : app.quit()));
      }
    });
  });
}

function stopServer(): Promise<void> {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once('exit', done);
    child.kill(); // SIGTERM: the CLI finishes in-flight work, writes a snapshot and releases its lock
    setTimeout(done, 8000);
  });
}

// ---------------------------------------------------------------- window

const page = (title: string, body: string) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>:root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d1f;--mu:#6e6e73}@media(prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f5f5f7;--mu:#a1a1a6}}
body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif}
.box{max-width:520px;text-align:center;padding:24px}.logo{width:56px;height:56px;border-radius:14px;margin:0 auto 16px;display:grid;place-items:center;
background:linear-gradient(135deg,#6366f1,#ec4899);color:#fff;font-weight:700;font-size:22px}p{color:var(--mu)}pre{text-align:left;white-space:pre-wrap;font-size:12px;color:var(--mu)}
.spin{width:22px;height:22px;border:3px solid #6366f155;border-top-color:#6366f1;border-radius:50%;margin:18px auto 0;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(1turn)}}</style>
<div class="box"><div class="logo">nb</div>${body}</div>`);

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    show: !SMOKE,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161618' : '#fafafa',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  const isExplorer = (u: string) => explorerUrl !== '' && new URL(u).origin === new URL(explorerUrl).origin;
  // links to LinkedIn, Ahoy proposals, sources… open in the default browser
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isExplorer(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('data:')) return;
    if (!isExplorer(url)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });
  return w;
}

async function boot(): Promise<void> {
  if (!win || win.isDestroyed()) win = createWindow();
  let args: string[] = [];
  let busy = 'Starting your network explorer…';
  if (!hasDatabase() && !SMOKE) {
    await win.loadURL(page('Welcome', '<h2>Welcome to Network Builder</h2><p>Pick the CSV of your LinkedIn connections to get started.</p>'));
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose your LinkedIn connections CSV',
      message: 'Export it with the Chrome extension (github.com/lyonsv/chrome-linkedin-connections-exporter) or from LinkedIn → Settings → Data privacy → Get a copy of your data → Connections.',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      defaultPath: app.getPath('downloads'),
    });
    if (r.canceled || !r.filePaths[0]) {
      await win.loadURL(page('Welcome', '<h2>No connections yet</h2><p>Use <b>File → Import Connections CSV…</b> when you have your export.</p>'));
      return;
    }
    args = ['import', r.filePaths[0]];
    busy = 'Importing your connections and reading their headlines with Claude — this takes a minute or two for a few thousand people…';
  }
  await win.loadURL(page('Starting', `<h2>Network Builder</h2><p>${busy}</p><div class="spin"></div>`));
  try {
    explorerUrl = await startServer(args);
    await win.loadURL(explorerUrl);
    if (SMOKE) {
      process.stdout.write(`NB_SMOKE_OK ${explorerUrl}\n`);
      setTimeout(() => app.quit(), 300);
    }
  } catch (e) {
    const msg = String((e as Error).message || e).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
    if (SMOKE) {
      process.stdout.write(`NB_SMOKE_FAIL ${msg}\n`);
      app.exit(1);
      return;
    }
    await win.loadURL(page('Could not start', `<h2>Couldn't start the explorer</h2><pre>${msg}</pre><p>Log: ${logFile()}</p>`));
  }
}

async function importCsv(): Promise<void> {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    title: 'Import a connections or leads CSV',
    properties: ['openFile'],
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    defaultPath: app.getPath('downloads'),
  });
  if (r.canceled || !r.filePaths[0]) return;
  if (!explorerUrl) return void boot();
  // the running server picks up the new people itself (it watches the database for other processes' changes)
  const child = utilityProcess.fork(serverEntry(), ['import', r.filePaths[0], '--no-serve'], { env: { ...childEnv(), NB_FORCE_SERVE: '' }, stdio: 'pipe' });
  child.stdout?.on('data', (b: Buffer) => log(`[import] ${b.toString('utf8').trim()}`));
  child.stderr?.on('data', (b: Buffer) => log(`[import] ${b.toString('utf8').trim()}`));
  child.on('exit', (code) => {
    void dialog.showMessageBox(win!, {
      type: code === 0 ? 'info' : 'error',
      message: code === 0 ? 'Import finished' : 'Import failed',
      detail: code === 0 ? 'New people and updated titles are in your explorer now.' : `See the log: ${logFile()}`,
    });
  });
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Import Connections CSV…', accelerator: 'CmdOrCtrl+O', click: () => void importCsv() },
        { type: 'separator' },
        { label: 'Open in Browser', click: () => explorerUrl && void shell.openExternal(explorerUrl) },
        { label: 'Show Data Folder', click: () => void shell.openPath(dataHome()) },
        { label: 'Show Exports Folder', click: () => void shell.openPath(path.join(dataHome(), 'outputs')) },
        { label: 'Show Server Log', click: () => shell.showItemInFolder(logFile()) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(app.isPackaged ? [] : ([{ role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Network Builder on GitHub', click: () => void shell.openExternal('https://github.com/lyonsv/network-builder') },
        { label: 'Use It from Claude Code (MCP)', click: () => void shell.openExternal('https://github.com/lyonsv/network-builder/blob/main/docs/MCP.md') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(() => {
    buildMenu();
    void boot();
  });
  // macOS: closing the window keeps the app (and server) running; clicking the Dock icon brings it back
  app.on('window-all-closed', () => {
    if (SMOKE) app.quit();
  });
  app.on('activate', () => {
    if (win) return win.show();
    win = createWindow();
    void (explorerUrl ? win.loadURL(explorerUrl) : boot());
  });
  app.on('before-quit', (e) => {
    if (quitting || !server) return;
    e.preventDefault();
    quitting = true;
    void stopServer().then(() => app.quit());
  });
}
