// Regenerates build/icon.png + build/icon.icns from build/icon.svg (macOS: headless Chrome, sips, iconutil).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b = (f) => path.join(root, 'build', f);
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(chrome, ['--headless=new', '--hide-scrollbars', '--default-background-color=00000000', '--window-size=1024,1024',
  `--screenshot=${b('icon.png')}`, `file://${b('icon.svg')}`], { stdio: 'ignore' });
const set = b('icon.iconset');
rmSync(set, { recursive: true, force: true });
mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', String(s), String(s), b('icon.png'), '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
  execFileSync('sips', ['-z', String(s * 2), String(s * 2), b('icon.png'), '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', b('icon.icns')]);
rmSync(set, { recursive: true, force: true });
console.log('build/icon.png + build/icon.icns');
