import { describe, expect, it } from 'vitest';
import { buildOutputFilename, OUTPUT_COLUMNS, slugify, toOutputRow } from '../src/io/output';
import type { ResearchedPerson } from '../src/types';

describe('slugify', () => {
  it('basic', () => expect(slugify('Make a list of potential Angel Investors!')).toBe('make-a-list-of-potential-angel-investors'));
  it('accents & emoji', () => expect(slugify('Café 🚀 founders — Zürich')).toBe('cafe-founders-zurich'));
  it('empty', () => {
    expect(slugify('')).toBe('run');
    expect(slugify('🚀🚀')).toBe('run');
  });
  it('long prompt is truncated without trailing dash', () => {
    const s = slugify('investor '.repeat(25));
    expect(s.length).toBeLessThanOrEqual(50);
    expect(s.endsWith('-')).toBe(false);
  });
});

describe('buildOutputFilename', () => {
  const date = new Date(2026, 10, 4, 9, 5, 7);
  it('date, seconds, slug and total', () => {
    expect(buildOutputFilename({ prompt: 'angel investors', date, total: 1234 }))
      .toBe('2026-11-04_090507_angel-investors_ranked-1234.csv');
  });
});

describe('toOutputRow', () => {
  const base: ResearchedPerson = {
    id: 'abc', rowIndex: 1, fullName: 'Jane Doe', firstName: 'Jane', lastName: 'Doe',
    title: 'Partner', company: 'Acme', url: 'https://linkedin.com/in/jd', email: '',
    connectedOn: '2026-11-04', extra: {}, score: 92, fitReason: 'VC partner', rank: 1, ranked: true,
  };

  it('unresearched rows have empty research columns', () => {
    const row = toOutputRow(base);
    expect(Object.keys(row)).toEqual([...OUTPUT_COLUMNS]);
    expect(row.researched).toBe('no');
    expect(row.summary).toBe('');
  });

  it('flattens research', () => {
    const row = toOutputRow({
      ...base,
      research: {
        id: 'abc', status: 'ok', costUsd: 0.31234, durationMs: 1, model: 'opus', signalsHash: 'h', finishedAt: '',
        report: {
          identityConfirmed: true, summary: 'S', currentRole: 'Partner', location: 'Dublin',
          signals: [{ signal: 'Identity', finding: 'Found', strength: 'strong' }, { signal: 'Wealth', finding: 'n/a', strength: 'none' }],
          fitAssessment: 'F', recommendedApproach: 'R', talkingPoints: ['a', 'b'], redFlags: [],
          sources: [{ title: 'Site', url: 'https://x' }], confidence: 'high', researchScore: 88,
        },
      },
    });
    expect(row.signals).toBe('Identity [strong]: Found\nWealth [none]: n/a');
    expect(row.talking_points).toBe('• a\n• b');
    expect(row.red_flags).toBe('');
    expect(row.sources).toBe('Site — https://x');
    expect(row.research_score).toBe(88);
    expect(row.identity_confirmed).toBe('yes');
    expect(row.research_cost_usd).toBe(0.3123);
  });

  it('error rows', () => {
    const row = toOutputRow({ ...base, research: { id: 'abc', status: 'error', error: 'boom', costUsd: 0.1, durationMs: 1, model: 'opus', signalsHash: 'h', finishedAt: '' } });
    expect(row.researched).toBe('error');
    expect(row.research_error).toBe('boom');
  });

  it('neutralises spreadsheet formula injection', () => {
    const row = toOutputRow({ ...base, fullName: '=HYPERLINK("http://evil","x")', title: '+1 CEO', company: '-Acme', fitReason: '@SUM(A1)' });
    expect(row.full_name).toBe('\'=HYPERLINK("http://evil","x")');
    expect(row.title).toBe("'+1 CEO");
    expect(row.company).toBe("'-Acme");
    expect(row.fit_reason).toBe("'@SUM(A1)");
    expect(row.fit_score).toBe(92); // numbers untouched
  });
});
