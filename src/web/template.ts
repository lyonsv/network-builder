import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExplorerState } from '../types';

const DATA_TAG = '<script id="nb-data" type="application/json">__NB_DATA__</script>';

/**
 * Where explorer.html lives at runtime. In dev (tsx) this module is src/web/template.ts, so the template
 * sits next to it; in the bundle (dist/index.js) tsup copies it to dist/explorer.html. NB_EXPLORER_TEMPLATE
 * overrides both (used by tests and for hacking on the UI).
 */
export function templateCandidates(name = 'explorer.html', envVar = 'NB_EXPLORER_TEMPLATE'): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out: string[] = [];
  const override = process.env[envVar];
  if (override) out.push(path.resolve(override));
  out.push(path.join(here, name), path.join(here, '..', 'web', name), path.join(here, 'web', name));
  return out;
}

function loadNamed(name: string, envVar: string): string {
  const candidates = templateCandidates(name, envVar);
  const found = candidates.find((f) => existsSync(f));
  if (!found) throw new Error(`${name} template not found (looked in: ${candidates.join(', ')})`);
  // Read every time: it's small, and this keeps the override / live UI edits working without a restart.
  return readFileSync(found, 'utf8');
}

/** The v6 network explorer page (src/web/explorer.html; dist/explorer.html). NB_EXPLORER_TEMPLATE overrides. */
export function loadExplorerTemplate(): string {
  return loadNamed('explorer.html', 'NB_EXPLORER_TEMPLATE');
}

/** JSON that is safe inside a <script> element: no `</script>`, `<!--`, or JS-breaking line separators. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function explorerTitle(state: Pick<ExplorerState, 'people'>): string {
  return `network-builder · explorer · ${state.people.length.toLocaleString('en-US')} people`;
}

export function renderExplorerHtml(state: ExplorerState, template: string = loadExplorerTemplate()): string {
  return fill(template, embedJson(state), escapeHtml(explorerTitle(state)));
}

function fill(template: string, data: string, title: string): string {
  // Title first (so user data containing "__NB_TITLE__" is never touched), then data with function
  // replacers so `$&`, `$1` etc. inside the data are never interpreted.
  const titled = template.split('__NB_TITLE__').join(title);
  return titled.includes(DATA_TAG)
    ? titled.replace(DATA_TAG, () => DATA_TAG.replace('__NB_DATA__', () => data))
    : titled.replace('__NB_DATA__', () => data);
}
