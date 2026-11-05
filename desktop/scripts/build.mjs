// Bundles (1) the Electron main process → dist/main.js and (2) the whole network-builder CLI + explorer server
// (dependencies included) → dist-server/bin.mjs, plus the explorer page next to it.
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..');

await rm(path.join(root, 'dist'), { recursive: true, force: true });
await rm(path.join(root, 'dist-server'), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: { main: 'src/main.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'info',
});

await build({
  absWorkingDir: repo,
  entryPoints: { bin: 'src/bin.ts' },
  outdir: path.join(root, 'dist-server'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // CJS dependencies inside an ESM bundle still call require()
  banner: { js: "import { createRequire as __nbCreateRequire } from 'node:module'; const require = __nbCreateRequire(import.meta.url);" },
  sourcemap: 'linked',
  logLevel: 'info',
});
await mkdir(path.join(root, 'dist-server'), { recursive: true });
await copyFile(path.join(repo, 'src/web/explorer.html'), path.join(root, 'dist-server/explorer.html'));
console.log('desktop build: dist/main.js + dist-server/bin.mjs');
