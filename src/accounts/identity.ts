import { personId } from '../io/csv';
import { canonicalProfileUrl } from './capture';

/**
 * Person identity for accounts (pure, no DB). LinkedIn shows the same person under a vanity URL
 * (`/in/riley-moss`) or, in lists and searches, an opaque member URN (`/in/ACoAAB…`); names come with accents,
 * German transliterations, titles and pronouns. These helpers decide when two rows are the same person.
 */

const URN = /^ACo[A-Za-z0-9_-]{8,}$/;

export interface ProfileRef {
  /** lower-cased https://www.linkedin.com/in/<slug> — what the id is derived from */
  canonical: string;
  /** the URL to navigate to: original case for URNs (they are case-sensitive), else the canonical URL */
  url: string;
  /** personId(canonical) — the contacts/people id */
  id: string;
  /** the slug as it appears in `url` */
  slug: string;
  kind: 'vanity' | 'urn';
}

export function profileRef(url: string): ProfileRef | null {
  const canonical = canonicalProfileUrl(url);
  if (!canonical) return null;
  let slug = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(url)![1]!;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* keep as-is */
  }
  const kind = URN.test(slug) ? 'urn' : 'vanity';
  const navSlug = kind === 'urn' ? slug : slug.toLowerCase();
  return { canonical, url: `https://www.linkedin.com/in/${navSlug}`, id: personId(canonical, '', ''), slug: navSlug, kind };
}

/** two profile URLs that are both vanity (or both URN) but differ belong to different people */
export function profileUrlsConflict(a: string, b: string): boolean {
  const x = a ? profileRef(a) : null;
  const y = b ? profileRef(b) : null;
  return Boolean(x && y && x.kind === y.kind && x.id !== y.id);
}

const HONORIFICS = /\b(dr|prof|mba|phd)\b\.?/g;
const PRONOUNS = /\(?\b(she|he|they)\s*\/\s*(her|him|them|hers|his|theirs)(\s*\/\s*\w+)?\b\)?/gi;

/** "Dr. Jonas Müller-Brandt (he/him) 🚀" → "jonas muller brandt" — for matching only, never for display */
export function normalizePersonName(s: string): string {
  return (s || '')
    .replace(PRONOUNS, ' ')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ') // emoji, hyphens, punctuation
    .replace(HONORIFICS, ' ')
    .replace(/[.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameName(a: string, b: string): boolean {
  const x = normalizePersonName(a);
  return x !== '' && x === normalizePersonName(b);
}

const STOPWORDS = new Set([
  'at', 'of', 'the', 'and', 'for', 'in', 'a', 'an', 'to', 'on', 'with', 'de', 'der', 'die', 'das', 'und', 'fur', 'im', 'bei',
  'von', 'senior', 'sr', 'jr', 'junior',
]);
/**
 * Title phrases → one canonical token, so "CMO" ≈ "Chief Marketing Officer" and "Leiterin Unternehmenskommunikation" ≈
 * "Head of Corporate Communications" (applied to the normalised, umlaut-folded title; longest phrases first).
 */
const TITLE_PHRASES: [RegExp, string][] = [
  [/\bchief executive officer\b/g, 'ceo'], [/\bchief marketing officer\b/g, 'cmo'],
  [/\bchief communications? officer\b/g, 'cco'], [/\bchief digital officer\b/g, 'cdo'],
  [/\bchief revenue officer\b/g, 'cro'], [/\bchief operating officer\b/g, 'coo'],
  [/\bchief financial officer\b/g, 'cfo'], [/\bchief technology officer\b/g, 'cto'],
  [/\bsenior vice president\b/g, 'svp'], [/\bexecutive vice president\b/g, 'evp'], [/\bvice president\b/g, 'vp'],
  [/\bpublic relations\b/g, 'pr'], [/\bmanaging director\b/g, 'md'],
  [/\bunternehmenskommunikation\b/g, 'corporate communications'], [/\bkommunikation\b/g, 'communications'],
  [/\bcorporate communication\b/g, 'corporate communications'],
  [/\b(leiterin|leiter|leitung)\b/g, 'head'], [/\bgeschaftsfuhrer(in)?\b/g, 'md'], [/\bmarke\b/g, 'brand'],
];
const titleTokens = (t: string): Set<string> => {
  let s = normalizePersonName(t);
  for (const [re, to] of TITLE_PHRASES) s = s.replace(re, to);
  return new Set(s.split(' ').filter((w) => w && !STOPWORDS.has(w)));
};

/** either title blank, or the smaller title's tokens overlap the other's by ≥ 50% (stopwords ignored) */
export function titlesCompatible(a: string, b: string): boolean {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (!A.size || !B.size) return true;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size) >= 0.5;
}
