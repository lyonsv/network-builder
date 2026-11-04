import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapColumns, normalizeDate, parsePeopleCsv, personId } from '../src/io/csv';

const fixture = readFileSync(path.join(__dirname, 'fixtures/linkedin-connections.csv'), 'utf8');

describe('parsePeopleCsv (LinkedIn export)', () => {
  const r = parsePeopleCsv(fixture);

  it('detects header after Notes preamble', () => {
    expect(r.headerRow).toBe(3);
    expect(r.columnMap).toEqual({
      firstName: 'First Name',
      lastName: 'Last Name',
      url: 'URL',
      email: 'Email Address',
      company: 'Company',
      title: 'Position',
      connectedOn: 'Connected On',
    });
  });

  it('parses people, dedupes, skips blanks', () => {
    expect(r.people.map((p) => p.fullName)).toEqual(['Jane Doe', 'John Smith', 'Ada Lovelace', 'Grace Hopper']);
    expect(r.skipped).toBe(1); // duplicate Jane (trailing slash URL)
  });

  it('handles quoted commas and dates', () => {
    const john = r.people[1]!;
    expect(john.company).toBe('Widgets, Inc.');
    expect(john.connectedOn).toBe('2021-03-15');
    expect(r.people[0]!.connectedOn).toBe('2026-11-04');
    expect(r.people[3]!.connectedOn).toBe('2019-09-10');
  });

  it('has stable ids', () => {
    expect(r.people[0]!.id).toBe(personId('https://www.linkedin.com/in/janedoe/', 'x', 'y'));
    expect(r.people[0]!.id).toMatch(/^[0-9a-f]{12}$/);
    expect(parsePeopleCsv(fixture).people.map((p) => p.id)).toEqual(r.people.map((p) => p.id));
    // no URL -> name|company fallback
    expect(r.people[2]!.id).toBe(personId('', 'Ada Lovelace', 'Analytical Engines'));
  });
});

describe('header variants', () => {
  it('handles Name,Title,LinkedIn,Connection Date with BOM', () => {
    const text = '﻿Name,Title,LinkedIn,Connection Date\nMary Ann Smith,VP Eng,https://linkedin.com/in/mas,2024-02-03\n';
    const r = parsePeopleCsv(text);
    expect(r.headerRow).toBe(0);
    expect(r.columnMap).toMatchObject({ fullName: 'Name', title: 'Title', url: 'LinkedIn', connectedOn: 'Connection Date' });
    const p = r.people[0]!;
    expect(p.firstName).toBe('Mary');
    expect(p.lastName).toBe('Ann Smith');
    expect(p.connectedOn).toBe('2024-02-03');
  });

  it('puts unmapped columns in extra', () => {
    const r = parsePeopleCsv('Name,URL,Notes\nBob,https://x.com/bob,met at conf\n');
    expect(r.people[0]!.extra).toEqual({ Notes: 'met at conf' });
  });

  it('mapColumns falls back to a linkedin url/profile/link header', () => {
    expect(mapColumns(['Full Name', 'LinkedIn Profile Link']).url).toBe('LinkedIn Profile Link');
    expect(mapColumns(['Name', 'LinkedIn Link']).url).toBe('LinkedIn Link');
  });

  it('does not map a non-URL linkedin column (e.g. headline) as the URL', () => {
    const m = mapColumns(['Name', 'LinkedIn Headline', 'Company']);
    expect(m.url).toBeUndefined();
  });
});

describe('normalizeDate', () => {
  it('is timezone independent', () => {
    const prev = process.env.TZ;
    try {
      for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
        process.env.TZ = tz;
        expect(normalizeDate('2024')).toBe('2024');
        expect(normalizeDate('Mon, 15 Jan 2024 02:00:00 GMT')).toBe('2024-01-15');
        expect(normalizeDate('04 Nov 2026')).toBe('2026-11-04');
      }
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it.each([
    ['04 Nov 2026', '2026-11-04'],
    ['2026-11-04', '2026-11-04'],
    ['11/04/2026', '2026-11-04'],
    ['1 September 2023', '2023-09-01'],
    ['', ''],
    ['not a date', 'not a date'],
    // partial dates are kept raw instead of shifting to the previous day in western timezones
    ['2024', '2024'],
    ['2024-01', '2024-01'],
    // impossible days are rejected rather than normalised
    ['2024-02-31', '2024-02-31'],
    ['31/02/2024', '31/02/2024'],
    // explicit zone: calendar date as written
    ['Mon, 15 Jan 2024 02:00:00 GMT', '2024-01-15'],
    ['2024-01-15T23:30:00Z', '2024-01-15'],
  ])('%s -> %s', (input, out) => {
    expect(normalizeDate(input)).toBe(out);
  });
});
