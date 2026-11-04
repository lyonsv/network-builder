import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPLORER_CRM_COLUMNS,
  EXPLORER_FULL_COLUMNS,
  explorerCrmRow,
  explorerExportFilename,
  explorerFullHeader,
  explorerFullRow,
  toExplorerCsv,
} from '../src/io/explorer-export';
import type { DossierRecord, ExplorerPerson, Lens } from '../src/types';

// The browser download in src/web/explorer.html and the server/CLI export (src/io/explorer-export.ts) must
// produce identical files. We pull the page's helper functions out of its inline script and compare.

const html = readFileSync(path.join(__dirname, '../src/web/explorer.html'), 'utf8');

/** Pull `function name(...) {...}` out of the inline script by brace matching (the helpers use simple strings). */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`explorer.html: function ${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`explorer.html: unbalanced function ${name}`);
}

type UiLens = { id: string; goal: string };
const crmMarker = /\/\*NB_CRM_COLUMNS\*\/(\[[\s\S]*?\])\/\*END\*\//.exec(html);
const fullCols = /var FULL_COLUMNS = (\[[\s\S]*?\]);/.exec(html);
const fns = ['prof', 'tagsOf', 'companyOf', 'dos', 'careerText', 'recentText', 'bullets', 'crmRow', 'fullHeader', 'fullRow', 'slug', 'csvCell', 'exportFilename'].map(
  (n) => extractFunction(html, n),
);
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const ui = new Function(
  `var CRM_COLUMNS = ${crmMarker?.[1] ?? '[]'}; var FULL_COLUMNS = ${fullCols?.[1] ?? '[]'};\n${fns.join('\n')}\n` +
    `function buildCsv(rows, preset, lens, lenses) {
       var cols = preset === 'crm' ? CRM_COLUMNS : fullHeader(lenses);
       var lines = [cols.map(csvCell).join(',')];
       rows.forEach(function (p) { lines.push((preset === 'crm' ? crmRow(p, lens) : fullRow(p, lenses)).map(csvCell).join(',')); });
       return '\\ufeff' + lines.join('\\r\\n') + '\\r\\n';
     }
     return { CRM_COLUMNS, FULL_COLUMNS, crmRow, fullHeader, fullRow, slug, csvCell, exportFilename, buildCsv };`,
)() as {
  CRM_COLUMNS: string[];
  FULL_COLUMNS: string[];
  crmRow: (p: ExplorerPerson, lens: UiLens | null) => unknown[];
  fullHeader: (lenses: UiLens[]) => string[];
  fullRow: (p: ExplorerPerson, lenses: UiLens[]) => unknown[];
  slug: (s: string, max?: number) => string;
  csvCell: (v: unknown) => string;
  exportFilename: (name: string, n: number, date?: Date) => string;
  buildCsv: (rows: ExplorerPerson[], preset: 'crm' | 'full', lens: UiLens | null, lenses: UiLens[]) => string;
};

// The buildCsv mirror above must match the page's real buildCsv body (guards against the test drifting).
it('test mirror of buildCsv matches the page', () => {
  const real = extractFunction(html, 'buildCsv');
  expect(real).toContain("preset === 'crm' ? CRM_COLUMNS : fullHeader(lenses)");
  expect(real).toContain("'\\ufeff' + lines.join('\\r\\n') + '\\r\\n'");
});

const lens: Lens = { id: 'angels', goal: 'potential angel investors', createdAt: '', updatedAt: '', rankModel: 'haiku', rerankModel: 'sonnet', rerankTop: 150, scored: 3, stale: 0, threshold: 70, pinnedIn: [], pinnedOut: [] };
const lens2: Lens = { ...lens, id: 'mkt', goal: 'heads of marketing' };
const lenses = [lens, lens2];

const base: ExplorerPerson = {
  id: 'a', rowIndex: 1, fullName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', title: 'VP Sales, EMEA at Acme',
  company: '', url: 'https://www.linkedin.com/in/ada/', email: '', connectedOn: '2024-01-02', extra: {}, scores: {},
};
const dossier = (over: Partial<DossierRecord> = {}): DossierRecord => ({
  personId: 'x', depth: 'light', status: 'ok', model: 'haiku', costUsd: 0.01, durationMs: 1, createdAt: '2026-11-04T10:00:00.000Z',
  dossier: {
    identityConfirmed: true, confidence: 'medium', oneLiner: '=Former VP at Globex', currentRole: 'Chair', currentCompany: 'Harbor Group',
    location: 'Dublin, Ireland', career: [{ role: 'VP EMEA', company: 'Globex', period: '2011–2016', current: false }, { role: 'Chair', company: 'Harbor', period: '', current: true }],
    education: ['State University'], investingSummary: 'Angel in fintech', investments: ['Ledgerly', 'Brightwire'], boards: ['Oakfield Foods'], expertise: ['scaling'],
    notable: ['Ran a big-tech country office'], publicPresence: ['Podcast "X"'],
    recentActivity: [
      { date: '2026-09-12', kind: 'podcast', title: 'Scaling in Europe', summary: '=Argues European scale-ups need more growth capital', url: 'https://pod.example/ep1' },
      { date: '2026-03', kind: 'post', title: 'On boards', summary: 'Boards should meet founders monthly', url: '' },
    ],
    recentThemes: ['growth capital', 'board governance'], sources: [{ title: 'CB Insights', url: 'https://cbinsights.com/x' }, { title: '', url: 'https://y.z' }],
  },
  ...over,
});
const sample: ExplorerPerson[] = [
  base,
  { ...base, id: 'b', email: 'a@b.c', profile: { company: 'Acme', role: 'VP Sales', seniority: 'vp', function: 'sales', industry: 'saas', tags: ['executive', 'operator'], region: 'EMEA' }, scores: { angels: { score: 40, reason: 'operator', basis: 'headline', stale: false } } },
  { ...base, id: 'c', title: '-dash title', profile: { company: '', role: '', seniority: 'unknown', function: 'other', industry: '', tags: [], region: '' } },
  { ...base, id: 'd', dossier: dossier(), profile: { company: 'Harbor', role: 'Board Chair', seniority: 'advisor/board', function: 'general management', industry: '', tags: ['board member'], region: '' }, scores: { angels: { score: 88, reason: '@ angel investments', basis: 'dossier-light', stale: true }, mkt: { score: 5, reason: 'no', basis: 'dossier-light', stale: false } } },
  { ...base, id: 'e', dossier: dossier({ depth: 'deep', legacy: true, dossier: { ...dossier().dossier!, investments: [], career: [] } }) },
  { ...base, id: 'f', dossier: dossier({ status: 'error', dossier: undefined, error: 'boom' }) },
  { ...base, id: 'g', url: 'https://www.linkedin.com/in/Ünïcode', fullName: '林俐莹 "quoted"', firstName: '林', lastName: '俐莹' },
];

describe('explorer.html export parity with the server', () => {
  it('CRM columns match', () => {
    expect(crmMarker, 'NB_CRM_COLUMNS marker missing from explorer.html').toBeTruthy();
    expect(ui.CRM_COLUMNS).toEqual([...EXPLORER_CRM_COLUMNS]);
  });

  it('full columns match (base + per-lens)', () => {
    expect(ui.FULL_COLUMNS).toEqual([...EXPLORER_FULL_COLUMNS]);
    expect(ui.fullHeader(lenses)).toEqual(explorerFullHeader(lenses));
  });

  it('CRM values match for every person, with and without a lens', () => {
    for (const l of [null, lens, lens2]) {
      for (const p of sample) expect(ui.crmRow(p, l), `${p.id}/${l?.id}`).toEqual(explorerCrmRow(p, l));
    }
  });

  it('full values match for every person', () => {
    for (const p of sample) expect(ui.fullRow(p, lenses), p.id).toEqual(explorerFullRow(p, lenses));
  });

  it('whole CSVs are byte-identical (both presets)', () => {
    expect(ui.buildCsv(sample, 'crm', lens, lenses)).toBe(toExplorerCsv(sample, 'crm', lens, lenses));
    expect(ui.buildCsv(sample, 'crm', null, lenses)).toBe(toExplorerCsv(sample, 'crm', null, lenses));
    expect(ui.buildCsv(sample, 'full', lens, lenses)).toBe(toExplorerCsv(sample, 'full', lens, lenses));
  });

  it('CSV is BOM-prefixed and formula-safe', () => {
    const csv = toExplorerCsv(sample, 'crm', lens, lenses);
    expect(csv.startsWith('﻿"First Name"')).toBe(true);
    expect(csv).toContain(`"'=Former VP at Globex"`);
    expect(csv).toContain(`"'@ angel investments"`);
    expect(csv).toContain(`"'-dash title"`);
  });

  it('export filenames are identical', () => {
    const d = new Date(2026, 10, 4, 9, 5, 7);
    for (const name of ['Irish Angels (warm)', 'x'.repeat(200), '投资人', '', 'Ünïcödé — list!']) {
      expect(ui.exportFilename(name, 3, d), name).toBe(explorerExportFilename(name, 3, d));
    }
    expect(explorerExportFilename('Irish Angels (warm)', 42, d)).toBe('2026-11-04_090507_irish-angels-warm_42.csv');
  });
});

// ---- Ahoy CRM import bundle ----
import { AHOY_COMPANY_COLUMNS, AHOY_CONTACT_COLUMNS, AHOY_NOTE_COLUMNS, ahoyName, toAhoyFiles } from '../src/io/explorer-export';

const marker = (name: string) => new RegExp(`/\\*${name}\\*/(\\[[\\s\\S]*?\\])/\\*END\\*/`).exec(html)?.[1] ?? '[]';
const ahoyUi = new Function(
  `var AHOY_COMPANY_COLUMNS = ${marker('NB_AHOY_COMPANY')}; var AHOY_CONTACT_COLUMNS = ${marker('NB_AHOY_CONTACT')};` +
    `var AHOY_NOTE_COLUMNS = ${marker('NB_AHOY_NOTE')};\n` +
    ['prof', 'companyOf', 'dos', 'csvCell', 'ahoyName', 'ahoyLocation', 'ahoyCompany', 'ahoyNote', 'ahoyNoteTitle', 'ahoyFiles'].map((n) => extractFunction(html, n)).join('\n') +
    '\nreturn { AHOY_COMPANY_COLUMNS, AHOY_CONTACT_COLUMNS, AHOY_NOTE_COLUMNS, ahoyName, ahoyFiles };',
)() as {
  AHOY_COMPANY_COLUMNS: string[];
  AHOY_CONTACT_COLUMNS: string[];
  AHOY_NOTE_COLUMNS: string[];
  ahoyName: (p: Partial<ExplorerPerson>) => [string, string];
  ahoyFiles: (rows: ExplorerPerson[], lens: UiLens | null) => ReturnType<typeof toAhoyFiles>;
};

describe('Ahoy export', () => {
  const ahoySample: ExplorerPerson[] = [
    ...sample,
    { ...base, id: 'h', fullName: '🌎🌍Sam Example, MBA', profile: { company: 'acme', role: 'Founder', seniority: 'founder/owner', function: 'general management', industry: 'fintech', tags: [], region: '' } },
    { ...base, id: 'i', fullName: 'Dr. Jo Q. Public (née Smith) PhD', company: 'Northwind Ventures; Chair of a founders network' },
    { ...base, id: 'j', dossier: dossier({ dossier: { ...dossier().dossier!, location: 'Reported as Bern, Switzerland (unverified); London' } }) },
    { ...base, id: 'k', dossier: dossier({ dossier: { ...dossier().dossier!, location: 'Unclear (sources list Berlin and SF)' } }) },
  ];

  it('columns use the Ahoy schema labels and match the page', () => {
    expect(ahoyUi.AHOY_COMPANY_COLUMNS).toEqual([...AHOY_COMPANY_COLUMNS]);
    expect(ahoyUi.AHOY_CONTACT_COLUMNS).toEqual([...AHOY_CONTACT_COLUMNS]);
    expect(ahoyUi.AHOY_NOTE_COLUMNS).toEqual([...AHOY_NOTE_COLUMNS]);
    expect(AHOY_CONTACT_COLUMNS).not.toContain('Summary'); // notes go in their own file
    // labels from Ahoy's get_crm_schema (ahoy_company / ahoy_contact / ahoy_note)
    expect(AHOY_COMPANY_COLUMNS[0]).toBe('Company Name');
    expect(AHOY_NOTE_COLUMNS.slice(-2)).toEqual(['Title', 'Content']);
  });

  it('page and server produce byte-identical files', () => {
    for (const l of [null, lens]) expect(ahoyUi.ahoyFiles(ahoySample, l)).toEqual(toAhoyFiles(ahoySample, l));
  });

  it('splits and cleans names', () => {
    const cases: [string, [string, string]][] = [
      ['Ada Lovelace', ['Ada', 'Lovelace']],
      ['🌎🌍Sam Example, MBA', ['Sam', 'Example']],
      ['Dr. Jo Q. Public (née Smith) PhD', ['Jo Q.', 'Public']],
      ['Michelle Example M.D.', ['Michelle', 'Example']],
      ['Cher', ['Cher', '']],
    ];
    for (const [full, want] of cases) {
      expect(ahoyName({ fullName: full }), full).toEqual(want);
      expect(ahoyUi.ahoyName({ fullName: full }), full).toEqual(want);
    }
  });

  it('one row per company (case-insensitive), contacts reference it exactly, notes kept separate', () => {
    const f = toAhoyFiles(ahoySample, lens);
    const companyRows = f.companies.trim().split('\r\n').slice(1);
    expect(companyRows.filter((r) => r.toLowerCase().startsWith('"acme"'))).toHaveLength(1);
    expect(f.companies).toContain('"Northwind Ventures"');
    expect(f.companies).not.toContain('Chair of a founders network');
    // the first-seen spelling wins and every contact uses it
    const acme = companyRows.find((r) => r.toLowerCase().startsWith('"acme"'))!.split(',')[0];
    const acmeContacts = f.contacts.split('\r\n').filter((l) => /,"acme",/i.test(l));
    expect(acmeContacts.length).toBeGreaterThan(1);
    for (const line of acmeContacts) expect(line).toContain(`,${acme},`);
    expect(f.notes).toContain('**Fit for ""potential angel investors"": 88/100**');
    expect(f.notes).toContain('"network-builder: potential angel investors"');
    expect(f.counts.contacts).toBe(ahoySample.length);
    expect(f.contacts).toContain('"Bern, Switzerland"');
    expect(f.contacts).not.toContain('Unclear');
  });
});

describe('Ahoy zip download', () => {
  const zipUi = new Function(
    'var CRC_TABLE = null;\n' + ['crc32', 'zipFiles'].map((n) => extractFunction(html, n)).join('\n') + '\nreturn { crc32, zipFiles };',
  )() as { crc32: (b: Uint8Array) => number; zipFiles: (f: { name: string; text: string }[]) => Uint8Array };

  it('crc32 matches the standard check value', () => {
    expect(zipUi.crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('builds a valid zip that unzip can test and extract byte-for-byte', async () => {
    const { mkdtempSync, writeFileSync, readFileSync: rf, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const os = await import('node:os');
    const files = toAhoyFiles(sample, lens);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nb-zip-'));
    try {
      const zip = path.join(dir, 'x_ahoy.zip');
      writeFileSync(zip, zipUi.zipFiles([
        { name: 'x_ahoy-companies.csv', text: files.companies },
        { name: 'x_ahoy-contacts.csv', text: files.contacts },
        { name: 'x_ahoy-notes.csv', text: files.notes },
      ]));
      execFileSync('unzip', ['-tq', zip]);
      execFileSync('unzip', ['-q', zip, '-d', path.join(dir, 'out')]);
      expect(rf(path.join(dir, 'out', 'x_ahoy-contacts.csv'), 'utf8')).toBe(files.contacts);
      expect(rf(path.join(dir, 'out', 'x_ahoy-notes.csv'), 'utf8')).toBe(files.notes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
