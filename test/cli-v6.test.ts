import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runExport, runLensList, runLensRescore, runLensRm } from '../src/cli/db';
import { runExplore } from '../src/cli/explore';
import { inputHash } from '../src/db/hash';
import { Store } from '../src/db/store';
import { EXPLORER_FULL_COLUMNS, explorerExportFilename, toExplorerCsv } from '../src/io/explorer-export';
import type { Person } from '../src/types';

const mk = (id: string, name: string, title: string): Person => ({
  id, rowIndex: 0, fullName: name, firstName: name.split(' ')[0]!, lastName: name.split(' ')[1] ?? '', title, company: '',
  url: `https://www.linkedin.com/in/${id}/`, email: '', connectedOn: '2021-02-03', extra: {},
});

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nb-cli-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function seed(): { dbPath: string; lensId: string } {
  const dbPath = path.join(dir, 'network.db');
  const store = Store.open(dbPath);
  store.setMeta('legacy_import_v1', 'test'); // nothing to import
  store.upsertPeople([mk('aaa', 'Ann Angel', '=Angel Investor'), mk('bbb', 'Bob Builder', 'Recruiter')], 't.csv');
  const lens = store.createLens({ goal: 'angels', rankModel: 'haiku', rerankModel: '', rerankTop: 0 });
  const people = store.listExplorerPeople();
  store.setLensScores(
    people.map((p) => ({
      lensId: lens.id, personId: p.id, score: p.id === 'aaa' ? 88 : 12, reason: `r-${p.id}`, basis: 'headline' as const,
      model: 'haiku', inputHash: inputHash(p), scoredAt: new Date().toISOString(),
    })),
  );
  const now = new Date().toISOString();
  store.upsertList({ id: 'angels', name: 'Angels', ids: ['aaa', 'bbb', 'gone'], createdAt: now, updatedAt: now }, lens.goal);
  store.setMeta('list_lens:angels', lens.id);
  store.close();
  return { dbPath, lensId: lens.id };
}

describe('export --list (v6 explorer rows)', () => {
  it('uses the lens the list was saved under, skips unknown ids, BOM + formula-safe', async () => {
    const { dbPath } = seed();
    const out = path.join(dir, 'out.csv');
    expect(await runExport({ db: dbPath, outDir: dir, list: 'angels', output: out })).toBe(0);
    const csv = readFileSync(out, 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, ann, bob] = csv.slice(1).trim().split('\r\n');
    expect(header).toContain('"Fit Score"');
    expect(ann).toContain('88');
    expect(ann).toContain(`"'=Angel Investor"`);
    expect(bob).toContain('12');
  });

  it('--lens overrides; full preset has the explorer columns; unknown list/lens → 1', async () => {
    const { dbPath } = seed();
    const out = path.join(dir, 'full.csv');
    expect(await runExport({ db: dbPath, outDir: dir, list: 'Angels', preset: 'full', lens: 'angels', output: out })).toBe(0);
    const header = readFileSync(out, 'utf8').slice(1).split('\r\n')[0]!;
    const cols = header.split(',').map((h) => h.replace(/"/g, ''));
    expect(cols.slice(0, EXPLORER_FULL_COLUMNS.length)).toEqual([...EXPLORER_FULL_COLUMNS]);
    expect(cols.slice(EXPLORER_FULL_COLUMNS.length).every((c) => /_(score|reason)$/.test(c))).toBe(true);
    expect(await runExport({ db: dbPath, outDir: dir, list: 'nope' })).toBe(1);
    expect(await runExport({ db: dbPath, outDir: dir, list: 'angels', lens: 'nope' })).toBe(1);
    expect(await runExport({ db: dbPath, outDir: dir, list: 'angels', preset: 'xml' })).toBe(1);
  });
});

describe('lens subcommands', () => {
  it('lists and removes lenses by id or goal', async () => {
    const { dbPath } = seed();
    expect(await runLensList({ db: dbPath })).toBe(0);
    expect(await runLensRm('nope', { db: dbPath })).toBe(1);
    expect(await runLensRm('ANGELS', { db: dbPath })).toBe(0);
    const store = Store.open(dbPath);
    expect(store.listLenses()).toEqual([]);
    store.close();
  });
});

describe('explorer export helpers', () => {
  it('names files with a timestamp and slug', () => {
    expect(explorerExportFilename('Angels – Ireland!', 3, new Date(2026, 10, 4, 9, 5, 7))).toBe('2026-11-04_090507_angels-ireland_3.csv');
  });
  it('blank lens columns without a lens', () => {
    const csv = toExplorerCsv([{ ...mk('x', 'X Y', 'CEO'), scores: {} }], 'crm');
    expect(csv.slice(1).split('\n')[1]).toContain('"X"');
  });
});

describe('runExplore --dry-run', () => {
  it('makes no calls and writes nothing', async () => {
    const dbPath = path.join(dir, 'never.db');
    expect(await runExplore({ db: dbPath, dryRun: true, prompt: 'angels', serve: false })).toBe(0);
    expect(() => readFileSync(dbPath)).toThrow();
  });
});

describe('lens rescore', () => {
  it('re-scores everyone (or only stale) with the current rules; needs --yes when not a TTY', async () => {
    const { dbPath, lensId } = seed();
    const seen: string[][] = [];
    const scoreFn = (async (o: any) => {
      seen.push(o.people.map((p: any) => p.id).sort());
      const scores = o.people.map((p: any) => ({
        lensId: o.lens.id, personId: p.id, score: 50, reason: 'rescored', basis: 'headline', model: 'haiku',
        inputHash: inputHash(p), scoredAt: new Date().toISOString(),
      }));
      o.store.setLensScores(scores);
      return scores;
    }) as any;
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      expect(await runLensRescore('angels', { db: dbPath, scoreFn })).toBe(1); // no --yes, no TTY
      expect(seen).toEqual([]);
      expect(await runLensRescore('angels', { db: dbPath, scoreFn, stale: true, yes: true })).toBe(0); // nothing stale
      expect(seen).toEqual([]);
      expect(await runLensRescore(lensId, { db: dbPath, scoreFn, yes: true })).toBe(0);
      expect(seen).toEqual([['aaa', 'bbb']]);
      expect(await runLensRescore('nope', { db: dbPath, scoreFn, yes: true })).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
    const store = Store.open(dbPath);
    expect(store.listExplorerPeople().find((p) => p.id === 'aaa')!.scores[lensId]!.reason).toBe('rescored');
    store.close();
  });
});
