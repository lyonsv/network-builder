import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readReportFile } from '../src/io/output';
import type { ExplorerState, ReportMeta, ResearchedPerson } from '../src/types';
import { embedJson, renderExplorerHtml } from '../src/web/template';

const TEMPLATE =
  '<!doctype html><title>__NB_TITLE__</title><script id="nb-data" type="application/json">__NB_DATA__</script><h1>__NB_TITLE__</h1>';

let dir: string;
let prevTemplate: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'nb-report-test-'));
  await writeFile(path.join(dir, 'tpl.html'), TEMPLATE);
  prevTemplate = process.env.NB_EXPLORER_TEMPLATE;
  process.env.NB_EXPLORER_TEMPLATE = path.join(dir, 'tpl.html');
});
afterAll(async () => {
  if (prevTemplate === undefined) delete process.env.NB_EXPLORER_TEMPLATE;
  else process.env.NB_EXPLORER_TEMPLATE = prevTemplate;
  await rm(dir, { recursive: true, force: true });
});

const person: ResearchedPerson = {
  id: 'abc123', rowIndex: 1, fullName: 'Jane </script><script>alert(1)</script> $& Doe', firstName: 'Jane', lastName: 'Doe',
  title: 'Partner\u2028x', company: '', url: 'https://linkedin.com/in/jd', email: '', connectedOn: '2026-11-04',
  extra: {}, score: 90, fitReason: 'VC', rank: 1, ranked: true,
};

const meta = (outDir: string, stem = 'run1'): ReportMeta => ({
  version: 1, prompt: 'angel <investors> & "friends"', inputPath: '/x.csv', createdAt: '', updatedAt: '',
  totalPeople: 1, rankModel: 'haiku', researchModel: 'sonnet', signalsPath: '/s.md', cacheDir: '/c', outDir, stem,
  estUsdPerResearch: 0.15,
});

const state = (): ExplorerState => ({
  version: 6, generatedAt: '', people: [{ ...person, scores: {} }], lenses: [], lists: [], api: null,
  queue: { queued: [], running: [], pausedUntil: null, lensJob: null, seq: 0 },
  costs: { enrich: 0, dossier: 0, lens: 0, research: 0, total: 0, incomplete: false },
  estimates: { lightUsd: 0.015, deepUsd: 0.13, lensUsdPer1000: 0.08, lensRerankUsdPer100: 0.5 }, dbPath: '/x.db',
});

describe('renderExplorerHtml', () => {
  it('embeds JSON that cannot break out of the script tag and round-trips', () => {
    const html = renderExplorerHtml(state(), TEMPLATE);
    expect(html).not.toContain('</script><script>alert');
    expect(html).not.toContain('\u2028');
    const m = html.match(/<script id="nb-data" type="application\/json">(.*?)<\/script>/s);
    expect(m).toBeTruthy();
    const parsed = JSON.parse(m![1]!) as ExplorerState;
    expect(parsed.people[0]!.fullName).toBe(person.fullName);
    expect(parsed.people[0]!.title).toBe(person.title);
  });
  it('fills the title', () => {
    const html = renderExplorerHtml(state(), TEMPLATE);
    expect(html).toContain('<title>network-builder · explorer · 1 people</title>');
    expect(html).not.toContain('__NB_TITLE__');
  });
  it('embedJson escapes < and line separators', () => {
    expect(embedJson({ a: '</script>\u2028\u2029' })).toBe('{"a":"\\u003c/script>\\u2028\\u2029"}');
  });
});

describe('readReportFile (legacy import of old report JSONs)', () => {
  it('reads {meta, people, lists}', async () => {
    const f = path.join(dir, 'v1.json');
    await writeFile(f, JSON.stringify({ meta: meta(dir), people: [person], lists: [{ id: 'l', name: 'L', ids: ['abc123'], createdAt: '', updatedAt: '' }] }));
    const back = await readReportFile(f);
    expect(back.meta?.prompt).toBe('angel <investors> & "friends"');
    expect(back.people).toHaveLength(1);
    expect(back.lists[0]!.id).toBe('l');
  });

  it('accepts legacy bare arrays with meta: null', async () => {
    const f = path.join(dir, 'legacy.json');
    await writeFile(f, JSON.stringify([person]));
    const r = await readReportFile(f);
    expect(r.meta).toBeNull();
    expect(r.people[0]!.id).toBe('abc123');
  });

  it('rejects non-reports', async () => {
    const f = path.join(dir, 'junk.json');
    await writeFile(f, '{"hello":1}');
    await expect(readReportFile(f)).rejects.toThrow(/not a network-builder report/);
  });
});
