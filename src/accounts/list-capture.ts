import { splitHeadline } from './capture';
import { profileRef } from './identity';
import type { ListPageKind } from './types';

/**
 * Parse what the Chrome extension read off a LinkedIn people LIST (a company's People tab or a people search): one
 * entry per result card (its visible text lines + the card's /in/ link), the header ("1,234 associated members") and
 * the "What they do" insight module. Pure, no DB: all interpretation happens here so it can be tested and fixed
 * without reinstalling the extension.
 */

/** one result card as the extension sends it */
export interface ListCardPayload {
  /** position in the walk (0-based, unique per run) */
  idx: number;
  /** the card's visible text, one entry per line, in page order */
  lines: string[];
  /** the card's first linkedin.com/in/… link ('' when there is none) */
  href?: string;
}

export interface ParsedListCard {
  fullName: string;
  /** navigable profile URL (URN case kept) or '' */
  url: string;
  headline: string;
  title: string;
  company: string;
  location: string;
  /** '1st' | '2nd' | '3rd+' | '' */
  degree: string;
  /** "LinkedIn Member" (outside your network) or no profile link: keep only headline/location, never a contact */
  anonymous: boolean;
}

const clean = (s: unknown, max = 500): string =>
  typeof s === 'string' ? s.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';

const ANON_NAME = /^(linkedin[ -]?(member|mitglied)|mitglied von linkedin)$/i;
const DEGREE = /^[·•\s]*(1st|2nd|3rd\+?|1\.|2\.|3\.\+?)(\s+degree connection|\s+connection)?$/i;
const TRAILING_DEGREE = /\s*[·•]\s*(1st|2nd|3rd\+?)(\s+degree connection)?\s*$/i;
/** UI chrome on a card, never data */
const NOISE = [
  /^[·•]$/,
  /^(connect|follow|following|message|pending|save|send|more|vernetzen|folgen|nachricht)$/i,
  /^view .+['’]s? profile$/i,
  /^(\d+\s+)?(other\s+)?mutual connections?$/i,
  /mutual connection|gemeinsame kontakte?|gemeinsamer kontakt/i,
  /^[\d.,\s]+[KkMm]?\+?\s*(followers|follower|abonnenten)$/i,
  /^(status is .*|verified|premium|open to work|hiring|creator|top voice|influencer|1st degree connection|2nd degree connection|3rd degree connection)$/i,
  /^(provides services|bietet dienstleistungen an)/i,
];
const PRONOUNS = /\s*\(\s*(she|he|they|sie|er|ihr|xe|ze)\s*\/\s*\w+(\s*\/\s*\w+)?\s*\)/gi;
/** LinkedIn badge text glued to the name line ("Flavio … is hiring", "… Premium", "… • 2nd"), EN + DE; end of line only */
const NAME_BADGE =
  /\s*(?:[·•|,–-]\s*)?(?:is hiring|stellt (?:gerade )?ein|sucht mitarbeiter(?:innen)?|premium|verified|verifiziert|open to work|offen für (?:neue )?(?:jobs|stellen)|top voice|creator|(?:1st|2nd|3rd\+?|1\.|2\.|3\.\+?)(?:\s+degree connection)?|\d+\.?\s*grades?)\s*$/i;
const EMOJI_ALL = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;
/** a card's name line → just the name: pronouns, emoji and trailing badges ("is hiring", "Premium", "• 2nd", …) dropped */
export function cleanPersonName(raw: string): string {
  let s = raw.replace(PRONOUNS, ' ').replace(EMOJI_ALL, ' ').replace(/\s+/g, ' ').trim();
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(NAME_BADGE, '').replace(/[\s·•|,–-]+$/, '').trim();
  }
  return s;
}
/** LinkedIn's match summary under a card: "Current: … at Y" is the person's current role; "Past: …" never is */
const SUMMARY = /^(current|past|aktuell|früher|frueher|summary|zusammenfassung):\s*/i;
const PAST = /^(past|früher|frueher):/i;

const DEGREE_NORM: Record<string, string> = { '1.': '1st', '2.': '2nd', '3.': '3rd+', '3.+': '3rd+', '3rd': '3rd+' };

/** "Head of Brand at Ledgerly" / "… bei …" / "… @Ledgerly" → title / company (raw company, see cleanCompany) */
function split(headline: string): { title: string; company: string } {
  const first = (headline.split(/\s[|•·]\s/)[0] ?? '').trim();
  const at = /^(.*?)\s+(?:at\s+|@\s*|bei\s+)(\S.*)$/i.exec(first);
  if (at && at[1]!.trim()) return { title: at[1]!.trim(), company: at[2]!.trim() };
  return splitHeadline(headline);
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u;
/**
 * A company as people type it into headlines → just the company. Cut at " - ", " | ", " · ", " • ", ", ", " @",
 * " (" and the first emoji; truncated text ("…und das...") is dropped. `hint` is what was cut off (a team/entity hint).
 */
export function cleanCompany(raw: string): { company: string; hint: string } {
  let c = clean(raw, 500);
  let hint = '';
  const cut = (i: number, skip = 0) => {
    if (i < 0) return;
    hint = clean(c.slice(i + skip) + (hint ? ` ${hint}` : ''), 300);
    c = c.slice(0, i).trim();
  };
  const e = c.search(EMOJI);
  if (e >= 0) c = c.slice(0, e).trim();
  const sep = /\s+[-–—|·•]\s+|,\s+|\s+@|\s+\(/.exec(c);
  if (sep) cut(sep.index, sep[0].length);
  hint = hint.replace(/^[@(\s]+|[)\s]+$/g, '');
  if (/(\.\.\.|…)$/.test(c)) return { company: '', hint: '' };
  if (/(\.\.\.|…)$/.test(hint)) hint = hint.replace(/\s*\S*(\.\.\.|…)$/, '').trim();
  return { company: c.replace(/[\s,;:]+$/, ''), hint };
}

/** the URL filters a people search on the current employer (LinkedIn's `currentCompany=["4242424"]`) */
export function filtersOnCurrentCompany(pageUrl: unknown): boolean {
  try {
    const v = new URL(String(pageUrl ?? '')).searchParams.get('currentCompany') ?? '';
    return /\d/.test(v);
  } catch {
    return false;
  }
}

/** search params that define a people list's result set (everything else is UI state: page, origin, spelling, …) */
export const LIST_FILTER_PARAMS = [
  'keywords', 'currentCompany', 'pastCompany', 'company', 'geoUrn', 'network', 'title', 'industry', 'schoolFilter', 'school',
  'profileLanguage', 'serviceCategory', 'firstName', 'lastName', 'connectionOf', 'followerOf', 'facetCurrentFunction',
  'facetGeoRegion', 'facetNetwork', 'facetIndustry', 'facetSchool', 'facetCurrentCompany', 'facetPastCompany',
  'functionFacet', 'seniorityFacet', 'yearsAtCompanyFacet',
] as const;

/** the list's result-set filters as [key, value] pairs, in allow-list order (page, origin, … left out) */
export function listFilters(pageUrl: unknown): [string, string][] {
  let q: URLSearchParams;
  try {
    q = new URL(String(pageUrl ?? '')).searchParams;
  } catch {
    return [];
  }
  const out: [string, string][] = [];
  for (const k of LIST_FILTER_PARAMS) for (const v of q.getAll(k)) if (v.trim()) out.push([k, v.trim()]);
  return out;
}

const looksLikeLocation = (l: string): boolean =>
  l.length <= 90 && !/\s(at|@|bei)\s/i.test(l) && !/[|•]/.test(l) && !SUMMARY.test(l) && !/\d{3,}/.test(l);

export interface ParseListCardInput {
  lines?: unknown;
  href?: unknown;
  pageKind?: ListPageKind;
  /** the list page's URL: a `currentCompany` filter means everyone listed works at `accountName` */
  pageUrl?: unknown;
  /** the account the run belongs to: the company fallback on a currentCompany-filtered search */
  accountName?: string;
}

export function parseListCard(card: ParseListCardInput): ParsedListCard {
  const raw = Array.isArray(card.lines) ? card.lines.map((l) => clean(l)).filter(Boolean) : [];
  let degree = '';
  const lines: string[] = [];
  let current = '';
  for (const l0 of raw) {
    let l = l0;
    const td = TRAILING_DEGREE.exec(l);
    if (td) {
      degree ||= td[1]!;
      l = l.slice(0, td.index).trim();
    }
    const d = DEGREE.exec(l);
    if (d) {
      degree ||= d[1]!;
      continue;
    }
    if (!l || NOISE.some((re) => re.test(l))) continue;
    if (SUMMARY.test(l)) {
      // a "Past:" line names a former employer: never the person's company or title
      if (!PAST.test(l)) current ||= l.replace(SUMMARY, '');
      continue;
    }
    if (l === lines[lines.length - 1]) continue; // a screen-reader copy right after the visible one
    lines.push(l);
  }
  degree = DEGREE_NORM[degree.toLowerCase()] ?? degree.toLowerCase();

  const ref = typeof card.href === 'string' && card.href ? profileRef(card.href) : null;
  const name = cleanPersonName(lines[0] ?? '');
  const anonymous = !ref || !name || ANON_NAME.test(name);
  const headline = clean(lines[1] ?? '', 500);
  const location = lines[2] && looksLikeLocation(lines[2]) ? clean(lines[2], 200) : '';
  // company: "Current: … at Y" → headline "… at/bei/@ Y" → the account, when the search filters on its current company
  let { title, company } = split(headline);
  company = cleanCompany(company).company;
  if (current) {
    const s = split(current);
    const sc = cleanCompany(s.company).company;
    if (sc) ({ title, company } = { title: s.title || title, company: sc });
  }
  if (!company && card.accountName && filtersOnCurrentCompany(card.pageUrl)) company = clean(card.accountName, 200);
  return {
    fullName: anonymous ? '' : clean(name, 200),
    url: anonymous ? '' : ref!.url,
    headline,
    title: clean(title, 300),
    company: clean(company, 200),
    location,
    degree,
    anonymous,
  };
}

// ---------- header + insight modules ----------

const NUM = String.raw`(\d{1,3}(?:[,.   ]\d{3})+|\d+(?:[.,]\d+)?)\s*([KkMm](?![a-zä]))?\+?`;
const HEADER = new RegExp(
  NUM + String.raw`\s+(?:associated\s+|zugehörige\s+|verbundene\s+)?(members|results|employees|mitglieder|ergebnisse|beschäftigte|mitarbeitende|mitarbeiter)\b`,
  'i',
);

/** "1,234" / "1.234" / "1 234" (narrow no-break space) / "1.2K" → integer, or null */
export function parseCount(n: string, suffix?: string): number | null {
  const s = n.trim();
  let v: number;
  if (suffix) v = Math.round(parseFloat(s.replace(',', '.')) * (/m/i.test(suffix) ? 1_000_000 : 1000));
  else if (/^\d{1,3}(?:[,.   ]\d{3})+$/.test(s)) v = Number(s.replace(/[,.   ]/g, ''));
  else if (/^\d+$/.test(s)) v = Number(s);
  else return null;
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** "1,234 associated members" / "About 2,300 results" / "1.234 Mitglieder" / "Etwa 2.300 Ergebnisse" → number */
export function parsePeopleHeader(text: unknown): number | null {
  const t = typeof text === 'string' ? text.slice(0, 2000) : '';
  const m = HEADER.exec(t);
  return m ? parseCount(m[1]!, m[2]) : null;
}

const FACET_START = /^(what they do|was sie machen|was sie tun|tätigkeitsbereiche?)$/i;
const FACET_END = /^(where they live|where they studied|what they studied|what they(?:'|’)re skilled at|how you(?:'|’)re connected|wo sie (leben|wohnen)|wo sie studiert haben|was sie studiert haben|worin sie kompetent sind|wie sie mit ihnen vernetzt sind)$/i;
const FACET_NOISE = /^(\+?\s*add|hinzufügen|show (more|less)|mehr anzeigen|weniger anzeigen|next|previous|weiter|zurück|search employees.*|mitarbeiter suchen.*)$/i;

/**
 * The "What they do" module's visible text → [{label, count}] (in page order, labels unique). Counts and labels may
 * be on one line ("412 Marketing", "Marketing 412", "Marketing (412)") or alternate lines.
 */
export function parseFunctionFacets(text: unknown): { label: string; count: number }[] {
  const all = (typeof text === 'string' ? text.slice(0, 20_000) : '').split('\n').map((l) => clean(l, 200)).filter(Boolean);
  const start = all.findIndex((l) => FACET_START.test(l));
  let lines = start >= 0 ? all.slice(start + 1) : all;
  const end = lines.findIndex((l) => FACET_END.test(l));
  if (end >= 0) lines = lines.slice(0, end);
  lines = lines.filter((l) => !FACET_NOISE.test(l));
  const out: { label: string; count: number }[] = [];
  const seen = new Set<string>();
  const push = (label: string, count: number | null) => {
    const l = label.replace(/[·•:]+$/, '').trim();
    if (!l || count === null || /^\d/.test(l) || l.length > 80) return;
    const k = l.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ label: l, count });
  };
  const N = String.raw`(\d{1,3}(?:[,.   ]\d{3})+|\d+)`;
  const lead = new RegExp(`^${N}\\s+(.+)$`);
  const trail = new RegExp(`^(.+?)\\s+\\(?${N}\\)?$`);
  const bare = new RegExp(`^${N}$`);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = bare.exec(l))) {
      // "412" then "Marketing" (or "Marketing" then "412", handled below)
      const next = lines[i + 1];
      if (next && !bare.test(next)) {
        push(next, parseCount(m[1]!));
        i++;
      }
    } else if ((m = lead.exec(l))) push(m[2]!, parseCount(m[1]!));
    else if ((m = trail.exec(l))) push(m[1]!, parseCount(m[2]!));
    else {
      const next = lines[i + 1];
      const b = next ? bare.exec(next) : null;
      if (b) {
        push(l, parseCount(b[1]!));
        i++;
      }
    }
  }
  return out.slice(0, 50);
}
