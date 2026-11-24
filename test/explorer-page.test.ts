import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateLensUsd } from '../src/llm/lens';

// Pure helpers from the explorer page's inline script (src/web/explorer.html), pulled out by brace matching
// like test/export.test.ts does: money formatting, the lens estimate the confirm dialog shows, reason display.

const html = readFileSync(path.join(__dirname, '../src/web/explorer.html'), 'utf8');

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

type Est = Record<string, unknown>;
type LensLike = { rerankModel: string; rerankTop: number } | null;
function page(EST: Est) {
  const fns = ['usd', 'onPlan', 'perLight', 'perDeep', 'lensTop', 'lensCost', 'lensRange', 'lensTime', 'reasonText', 'parseQuery'].map((n) => extractFunction(html, n));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('EST', `${fns.join('\n')}\nreturn { usd, onPlan, perLight, perDeep, lensTop, lensCost, lensRange, lensTime, reasonText, parseQuery };`)(EST) as {
    usd: (n: number) => string;
    onPlan: (n: number) => string;
    perLight: () => number;
    perDeep: () => number;
    lensTop: (l: LensLike) => number;
    lensCost: (n: number, l: LensLike) => number;
    lensRange: (n: number, l?: LensLike) => string;
    lensTime: (n: number, l?: LensLike) => string;
    reasonText: (r: string) => string;
    parseQuery: (q: string) => string[];
  };
}

const BASE = { lensUsdPer1000: 0.3, lensRerankUsdPer100: 0.5, lightUsd: 0.015, deepUsd: 0.17 };

describe('explorer page: costs', () => {
  it('one money format: 2 decimals, "< $0.01" below a cent', () => {
    const p = page(BASE);
    expect(p.usd(0.82)).toBe('$0.82');
    expect(p.usd(0.0035)).toBe('< $0.01');
    expect(p.usd(0)).toBe('$0.00');
    expect(p.usd(2.725)).toMatch(/^\$2\.7[23]$/);
    expect(p.onPlan(0.24)).toBe('≈ $0.24 on your Claude plan');
  });

  it('per-person web-profile prices are the same everywhere (rounded up to the cent)', () => {
    const p = page(BASE);
    expect(p.perLight()).toBe(0.02);
    expect(p.perDeep()).toBe(0.17);
  });

  it("a new lens uses the server's real rerank band, matching the CLI estimate", () => {
    const p20 = page({ ...BASE, lensRerankTop: 20, lensRerankModel: 'sonnet' });
    expect(p20.lensTop(null)).toBe(20);
    expect(p20.lensCost(245, null)).toBeCloseTo(estimateLensUsd(245, 20), 6);
    expect(p20.lensRange(245)).toBe('≈ $0.09–$0.17');
    // the review's case: the old page always assumed 150 → ≈ $0.82
    const p150 = page({ ...BASE, lensRerankTop: 150, lensRerankModel: 'sonnet' });
    expect(p150.lensCost(245, null)).toBeCloseTo(estimateLensUsd(245, 150), 6);
    // no re-check model on the server → no rerank cost
    expect(page({ ...BASE, lensRerankTop: 150, lensRerankModel: '' }).lensTop(null)).toBe(0);
    // older servers that don't send the field: 150
    expect(page(BASE).lensTop(null)).toBe(150);
  });

  it('an existing lens keeps its own band; no rerank model → none', () => {
    const p = page({ ...BASE, lensRerankTop: 150 });
    expect(p.lensTop({ rerankModel: 'sonnet', rerankTop: 20 })).toBe(20);
    expect(p.lensTop({ rerankModel: '', rerankTop: 150 })).toBe(0);
    expect(p.lensCost(1000, { rerankModel: '', rerankTop: 150 })).toBeCloseTo(0.3, 6);
  });

  it('gives a rough time', () => {
    const p = page({ ...BASE, lensRerankTop: 20, lensRerankModel: 'sonnet' });
    expect(p.lensTime(245)).toBe('about a minute');
    expect(p.lensTime(5000, { rerankModel: 'sonnet', rerankTop: 150 })).toMatch(/^about \d+ minutes$/);
  });
});

describe('explorer page: display helpers', () => {
  it('drops the model evidence token from reasons (display only)', () => {
    const p = page(BASE);
    expect(p.reasonText('[headline] CMO at Liffey Labs, Dublin.')).toBe('CMO at Liffey Labs, Dublin.');
    expect(p.reasonText('[deep] Partner at Northwind Ventures')).toBe('Partner at Northwind Ventures');
    expect(p.reasonText('No token here [headline]')).toBe('No token here [headline]');
  });

  it('counts query words (the lens offer triggers on 3+)', () => {
    const p = page(BASE);
    expect(p.parseQuery('marketing leaders in Ireland')).toHaveLength(4);
    expect(p.parseQuery('"head of marketing" dublin')).toEqual(['head of marketing', 'dublin']);
  });
});
