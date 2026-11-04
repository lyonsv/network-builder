import { copyFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // bin.ts checks the Node version, then dynamically imports the app (a separate chunk), so an old Node never
  // reaches the node:sqlite import
  splitting: true,
  // keep `node:` prefixes: node:sqlite only exists with the prefix (there is no bare `sqlite` builtin)
  removeNodeProtocol: false,
  esbuildOptions(o) {
    o.chunkNames = 'app-[hash]';
  },
  // The page templates are standalone HTML files loaded at runtime from next to the bundle.
  async onSuccess() {
    for (const name of ['explorer.html']) {
      try {
        await copyFile(`src/web/${name}`, `dist/${name}`);
      } catch (e) {
        console.warn(`[tsup] warning: could not copy src/web/${name} → dist/${name} (${(e as Error).message})`);
      }
    }
  },
});
