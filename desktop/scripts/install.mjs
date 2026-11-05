// Copies the built app to /Applications and (unless --no-dock) pins it to the Dock. macOS only.
//   node scripts/install.mjs [--no-dock] [--open]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'Network Builder.app';
const releaseDir = path.join(root, 'release');
const built = existsSync(releaseDir)
  ? readdirSync(releaseDir).map((d) => path.join(releaseDir, d, NAME)).find((p) => existsSync(p))
  : undefined;
if (!built) {
  console.error('No built app found — run `pnpm build` in desktop/ first.');
  process.exit(1);
}
const dest = path.join('/Applications', NAME);

// quit a running copy (it stops its server gracefully) and wait for it to exit before replacing it
const running = () => {
  try { execFileSync('pgrep', ['-f', 'Network Builder.app/Contents/MacOS/Network Builder$']); return true; } catch { return false; }
};
if (running()) {
  try { execFileSync('osascript', ['-e', 'tell application "Network Builder" to quit']); } catch { /* ignore */ }
  for (let i = 0; i < 60 && running(); i++) execFileSync('sleep', ['0.5']);
}
rmSync(dest, { recursive: true, force: true });
cpSync(built, dest, { recursive: true, verbatimSymlinks: true });
// built locally, so no quarantine flag — but clear it in case the folder came from a download
try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', dest]); } catch { /* none */ }
console.log(`Installed ${dest}`);

if (!process.argv.includes('--no-dock')) {
  const dock = execFileSync('defaults', ['read', 'com.apple.dock', 'persistent-apps'], { encoding: 'utf8' });
  if (dock.includes('Network%20Builder.app') || dock.includes('Network Builder.app')) {
    console.log('Already in the Dock');
  } else {
    const tile = `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://${encodeURI(dest)}/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>`;
    execFileSync('defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', tile]);
    execFileSync('killall', ['Dock']);
    console.log('Added to the Dock');
  }
}
if (process.argv.includes('--open')) execFileSync('open', [dest]);
