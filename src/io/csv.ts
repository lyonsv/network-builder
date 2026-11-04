import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import type { CanonicalField, ColumnMap, ParseResult, Person } from '../types';

const SYNONYMS: Record<CanonicalField, string[]> = {
  fullName: ['name', 'full name', 'fullname', 'contact name', 'person'],
  firstName: ['first name', 'firstname', 'first', 'given name'],
  lastName: ['last name', 'lastname', 'last', 'surname', 'family name'],
  title: ['position', 'title', 'job title', 'role', 'headline', 'occupation'],
  company: ['company', 'organization', 'organisation', 'employer', 'company name'],
  url: ['url', 'linkedin', 'linkedin url', 'profile url', 'profile', 'linkedin profile', 'linkedin profile url'],
  email: ['email', 'email address', 'e mail'],
  connectedOn: ['connected on', 'connection date', 'connected', 'date connected', 'connected at', 'date'],
};

const FIELD_ORDER: CanonicalField[] = [
  'firstName', 'lastName', 'fullName', 'title', 'company', 'url', 'email', 'connectedOn',
];

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function mapColumns(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  const used = new Set<number>();
  const normed = headers.map((h) => normHeader(h ?? ''));
  for (const field of FIELD_ORDER) {
    for (const syn of SYNONYMS[field]) {
      const idx = normed.findIndex((h, i) => !used.has(i) && h === syn);
      if (idx >= 0) {
        map[field] = headers[idx];
        used.add(idx);
        break;
      }
    }
  }
  // Fallback: an unclaimed header like "LinkedIn Profile Link" is the URL — but not "LinkedIn Headline".
  if (!map.url) {
    const idx = normed.findIndex((h, i) => {
      if (used.has(i)) return false;
      const words = h.split(' ');
      return words.includes('linkedin') && words.some((w) => w === 'url' || w === 'profile' || w === 'link');
    });
    if (idx >= 0) map.url = headers[idx];
  }
  return map;
}

export function detectHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, 20);
  for (let i = 0; i < limit; i++) {
    const m = mapColumns(rows[i] ?? []);
    const n = Object.keys(m).length;
    if (n >= 2 && (m.fullName || m.firstName || m.url)) return i;
  }
  return 0;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function ymd(y: number, m: number, d: number): string | undefined {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1)) return undefined;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) return undefined;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function normalizeDate(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!) ?? s;
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase().slice(0, 3)];
    if (mon) return ymd(+m[3]!, mon, +m[1]!) ?? s;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return ymd(+m[3]!, +m[1]!, +m[2]!) ?? s;
  // Bare "2024" / "2024-01": keep as-is rather than inventing a day (Date.parse reads them as UTC midnight).
  if (/^\d{4}(?:[-/]\d{1,2})?$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    // Explicit zone (Z / GMT / UTC / ±hh:mm): take the calendar date as written, i.e. in UTC.
    if (/(?:\dZ|\b(?:GMT|UTC)(?:[+-]\d{2}:?\d{2})?|:\d{2}(?:\.\d+)?\s*[+-]\d{2}:?\d{2})$/i.test(s)) {
      return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) ?? s;
    }
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()) ?? s;
  }
  return s;
}

function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

export function personId(url: string, fullName: string, company: string): string {
  const key = url.trim() ? normalizeUrl(url) : `${fullName.trim().toLowerCase()}|${company.trim().toLowerCase()}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

export function parsePeopleCsv(text: string): ParseResult {
  const clean = text.replace(/^﻿/, '');
  const rows = parse(clean, {
    relax_column_count: true,
    skip_empty_lines: false,
    relax_quotes: true,
  }) as string[][];
  const warnings: string[] = [];
  const headerRow = detectHeaderRow(rows);
  const headers = (rows[headerRow] ?? []).map((h) => (h ?? '').trim());
  const columnMap = mapColumns(headers);

  if (!columnMap.fullName && !columnMap.firstName && !columnMap.url) {
    warnings.push(`Could not find a name or URL column in headers: ${headers.join(', ')}`);
  }
  if (!columnMap.title) warnings.push('No title/position column found.');
  if (!columnMap.connectedOn) warnings.push('No connection date column found.');

  const idx: Partial<Record<CanonicalField, number>> = {};
  for (const [field, header] of Object.entries(columnMap) as [CanonicalField, string][]) {
    idx[field] = headers.indexOf(header);
  }
  const mappedIdx = new Set(Object.values(idx));

  const people: Person[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let rowIndex = 0;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const get = (f: CanonicalField) => {
      const i = idx[f];
      return i === undefined || i < 0 ? '' : (row[i] ?? '').trim();
    };
    if (row.every((c) => !(c ?? '').trim())) continue; // blank line, not counted
    rowIndex++;

    let firstName = get('firstName');
    let lastName = get('lastName');
    let fullName = get('fullName') || `${firstName} ${lastName}`.trim();
    if (!firstName && !lastName && fullName) {
      const sp = fullName.indexOf(' ');
      firstName = sp < 0 ? fullName : fullName.slice(0, sp);
      lastName = sp < 0 ? '' : fullName.slice(sp + 1).trim();
    }
    const url = get('url');
    if (!fullName && !url) {
      skipped++;
      continue;
    }
    const company = get('company');
    const id = personId(url, fullName, company);
    if (seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);

    const extra: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (!mappedIdx.has(i) && h) extra[h] = (row[i] ?? '').trim();
    });

    people.push({
      id,
      rowIndex,
      fullName,
      firstName,
      lastName,
      title: get('title'),
      company,
      url,
      email: get('email'),
      connectedOn: normalizeDate(get('connectedOn')),
      extra,
    });
  }

  return { people, headerRow, columnMap, skipped, warnings };
}

export async function readPeopleCsv(filePath: string): Promise<{ text: string; result: ParseResult }> {
  const text = await readFile(filePath, 'utf8');
  return { text, result: parsePeopleCsv(text) };
}
