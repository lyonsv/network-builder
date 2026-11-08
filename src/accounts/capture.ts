import type { CapturePayload, CapturedProfile, EducationEntry, ExperienceEntry } from './types';

/**
 * Turn what the Chrome extension read off a LinkedIn profile page into a CapturedProfile. The extension sends each
 * section's list items as text lines (LinkedIn's own visible strings, de-duplicated) plus the page text; all
 * interpretation happens here so it can be tested and fixed without reinstalling the extension.
 */

export const MAX_RAW_TEXT = 60_000;
const MAX_LINE = 4000;
const MAX_ITEMS = 80;

const clean = (s: unknown, max = MAX_LINE): string =>
  typeof s === 'string' ? s.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '';

/** https://www.linkedin.com/in/<slug> (lower-case, no query/trailing slash) or '' if not a profile URL */
export function canonicalProfileUrl(url: string): string {
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(url || '');
  if (!m) return '';
  let slug = m[1]!;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* keep as-is */
  }
  return `https://www.linkedin.com/in/${slug.toLowerCase()}`;
}

/** https://www.linkedin.com/company/<slug> or '' */
export function canonicalCompanyUrl(url: string): string {
  const m = /linkedin\.com\/(company|school|showcase)\/([^/?#\s]+)/i.exec(url || '');
  return m ? `https://www.linkedin.com/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` : '';
}

const LEGAL_SUFFIX = /\b(inc|incorporated|ltd|limited|llc|llp|plc|gmbh|ag|sa|sas|bv|nv|oy|ab|as|corp|corporation|co|company|pty|srl|spa|ug|dac|uc)\b\.?/g;
/** "Ledgerly, Inc." → "ledgerly" — for matching company names, never for display */
export function normalizeCompany(name: string): string {
  return (name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** does a free-text company / headline mention this (normalised) account name as whole words? */
export function mentionsCompany(text: string, normName: string): boolean {
  if (!normName) return false;
  const t = normalizeCompany(text);
  if (!t) return false;
  if (t === normName) return true;
  if (normName.length < 3) return false;
  return ` ${t} `.includes(` ${normName} `);
}

// "Jan 2020 - Present · 4 yrs 10 mos", "2018 – 2021", "Mar 2024 - Present"
const DATE_RANGE = /^((?:[A-Za-z]{3,9}\.? )?\d{4}|Present)\s*[-–—]\s*(Present|(?:[A-Za-z]{3,9}\.? )?\d{4})(?:\s*·\s*.+)?$/i;
const SINGLE_DATE = /^(?:[A-Za-z]{3,9}\.? )?\d{4}(?:\s*·\s*.+)?$/;
const DURATION_ONLY = /^(?:(?:full|part)[- ]time\s*·\s*)?(\d+ yrs?|\d+ mos?|less than a year)(\s+\d+ mos?)?$/i;
const EMPLOYMENT = /^(full[- ]time|part[- ]time|self[- ]employed|freelance|contract|internship|apprenticeship|seasonal|permanent)$/i;
const isDate = (l: string) => DATE_RANGE.test(l) || SINGLE_DATE.test(l);
const looksLikeLocation = (l: string) =>
  l.length <= 90 && !/[.!?]$/.test(l) && (/\b(remote|hybrid|on-site|onsite)\b/i.test(l) || /^[^·]+,[^·]+/.test(l) || /·\s*(remote|hybrid|on-site)/i.test(l));

function splitCompanyLine(line: string): { company: string; employmentType?: string } {
  const parts = line.split(' · ').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && EMPLOYMENT.test(parts[parts.length - 1]!)) {
    return { company: parts.slice(0, -1).join(' · '), employmentType: parts[parts.length - 1] };
  }
  if (EMPLOYMENT.test(parts[0] ?? '')) return { company: '', employmentType: parts[0] };
  return { company: parts.join(' · ') };
}

function parseRole(lines: string[], groupCompany?: string, companyUrl?: string): ExperienceEntry | null {
  const L = lines.map((l) => clean(l)).filter(Boolean);
  if (!L.length) return null;
  const title = L[0]!;
  const d = L.findIndex((l, i) => i > 0 && isDate(l));
  let company = groupCompany ?? '';
  let employmentType: string | undefined;
  const between = d > 0 ? L.slice(1, d) : L.slice(1, 2);
  for (const l of between) {
    const s = splitCompanyLine(l);
    if (!company && s.company) company = s.company;
    if (s.employmentType) employmentType = s.employmentType;
  }
  const dates = d > 0 ? L[d]! : '';
  let rest = d > 0 ? L.slice(d + 1) : L.slice(2);
  let location: string | undefined;
  if (rest[0] && looksLikeLocation(rest[0])) {
    location = rest[0];
    rest = rest.slice(1);
  }
  const description = rest.filter((l) => !/^…?\s*see more$/i.test(l)).join('\n').trim();
  return {
    title,
    company,
    ...(companyUrl ? { companyUrl } : {}),
    ...(employmentType ? { employmentType } : {}),
    dates,
    current: /present/i.test(dates),
    ...(location ? { location } : {}),
    ...(description ? { description: description.slice(0, MAX_LINE) } : {}),
  };
}

type Item = { lines: string[]; sub?: string[][]; companyUrl?: string };

export function parseExperience(items: Item[]): ExperienceEntry[] {
  const out: ExperienceEntry[] = [];
  for (const it of items.slice(0, MAX_ITEMS)) {
    const lines = (it.lines ?? []).map((l) => clean(l)).filter(Boolean);
    const companyUrl = canonicalCompanyUrl(it.companyUrl ?? '') || undefined;
    const sub = (it.sub ?? []).filter((s) => Array.isArray(s) && s.some((l) => clean(l)));
    // several roles at one company: [Company, "Full-time · 5 yrs", location?] + one sub-list per role
    if (sub.length && lines.length && !lines.slice(0, 3).some((l) => DATE_RANGE.test(l))) {
      const company = splitCompanyLine(lines[0]!).company || lines[0]!;
      for (const s of sub) {
        const r = parseRole(s, company, companyUrl);
        if (r) out.push(r);
      }
      continue;
    }
    if (lines.length >= 2 && DURATION_ONLY.test(lines[1]!) && !sub.length) {
      // a grouped company whose roles the page didn't render as a nested list
      continue;
    }
    // a single role: LinkedIn puts its description / skills in a nested list — read them as the role's text
    const r = parseRole([...lines, ...sub.flat()], undefined, companyUrl);
    if (r) out.push(r);
  }
  return out;
}

export function parseEducation(items: Item[]): EducationEntry[] {
  return items
    .slice(0, MAX_ITEMS)
    .map((it) => (it.lines ?? []).map((l) => clean(l)).filter(Boolean))
    .filter((l) => l.length)
    .map((l) => ({ school: l[0]!, detail: l.slice(1).join(' · ').slice(0, MAX_LINE) }));
}

const SECTION_HEADINGS: Record<string, string> = {
  about: 'about', experience: 'experience', education: 'education', 'licenses & certifications': 'certifications',
  'volunteer experience': 'volunteering', volunteering: 'volunteering', skills: 'skills', 'honors & awards': 'honors',
  languages: 'languages', projects: 'projects', publications: 'publications', courses: 'courses', organizations: 'organizations',
  patents: 'patents', recommendations: 'recommendations', interests: 'interests', activity: 'activity', featured: 'featured',
};
const STOP_HEADINGS = new Set(['people also viewed', 'people you may know', 'you might like', 'more profiles for you', 'explore premium profiles']);

/**
 * Fallback when the structured sections are missing (LinkedIn markup changed): split the visible page text on
 * section headings ("Experience", "Education", …). Coarse, but it keeps the context usable.
 */
export function sectionsFromText(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur = '';
  let prev = '';
  for (const line0 of (raw || '').split('\n')) {
    const line = clean(line0);
    if (!line || line === prev) continue; // LinkedIn repeats strings for screen readers
    prev = line;
    const key = line.toLowerCase();
    if (STOP_HEADINGS.has(key)) {
      cur = '';
      continue;
    }
    if (SECTION_HEADINGS[key]) {
      cur = SECTION_HEADINGS[key]!;
      out[cur] ??= [];
      continue;
    }
    if (cur && !/^(show all|see more|…see more|show more)/i.test(line)) out[cur]!.push(line);
  }
  return out;
}

/** group flat lines into items at each date line's preceding title — used only by the raw-text fallback */
function itemsFromFlatLines(lines: string[]): Item[] {
  const items: Item[] = [];
  let cur: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const nextIsDateSoon = lines.slice(i + 1, i + 4).some((l) => DATE_RANGE.test(l));
    const curHasDate = cur.some((l) => DATE_RANGE.test(l));
    if (curHasDate && nextIsDateSoon && !DATE_RANGE.test(lines[i]!)) {
      items.push({ lines: cur });
      cur = [];
    }
    cur.push(lines[i]!);
  }
  if (cur.length) items.push({ lines: cur });
  return items;
}

/** "VP Finance at Ledgerly | Ex-Globex" → { title: 'VP Finance', company: 'Ledgerly' } */
export function splitHeadline(headline: string): { title: string; company: string } {
  const first = (headline || '').split(/\s[|•·]\s/)[0]!.trim();
  const m = /^(.*?)\s+(?:at|@)\s+(.+)$/i.exec(first);
  return m ? { title: m[1]!.trim(), company: m[2]!.trim() } : { title: first, company: '' };
}

export class CaptureError extends Error {}

export function parseCapture(p: CapturePayload): CapturedProfile {
  if (!p || typeof p !== 'object') throw new CaptureError('missing profile');
  const url = canonicalProfileUrl(String(p.url ?? ''));
  if (!url) throw new CaptureError('not a LinkedIn profile URL (expected linkedin.com/in/…)');
  const fullName = clean(p.fullName, 200);
  if (!fullName) throw new CaptureError('could not read the person’s name from the page — scroll to the top of the profile and try again');
  const headline = clean(p.headline, 500);
  const rawText = clean(p.rawText, MAX_RAW_TEXT);
  const sections = p.sections && typeof p.sections === 'object' ? p.sections : {};
  const items = (k: string): Item[] => {
    const s = (sections as Record<string, unknown>)[k] as { items?: unknown } | undefined;
    return Array.isArray(s?.items) ? (s!.items as Item[]).filter((x) => x && Array.isArray(x.lines)) : [];
  };

  const fallback = sectionsFromText(rawText);
  let experience = parseExperience(items('experience'));
  if (!experience.length && fallback.experience?.length) experience = parseExperience(itemsFromFlatLines(fallback.experience));
  let education = parseEducation(items('education'));
  if (!education.length && fallback.education?.length) education = [{ school: fallback.education[0]!, detail: fallback.education.slice(1, 4).join(' · ') }];
  let about = clean(p.about, 8000);
  if (!about && fallback.about?.length) about = fallback.about.join('\n').slice(0, 8000);

  const other: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sections)) {
    if (k === 'experience' || k === 'education' || k === 'about') continue;
    const lines = items(k).map((it) => it.lines.map((l) => clean(l)).filter(Boolean).join(' · ')).filter(Boolean);
    if (lines.length) other[clean((v as { heading?: string })?.heading, 80) || k] = lines.slice(0, MAX_ITEMS);
  }
  for (const [k, v] of Object.entries(fallback)) {
    if (k === 'experience' || k === 'education' || k === 'about' || !v.length) continue;
    if (!Object.keys(other).some((h) => h.toLowerCase().startsWith(k.slice(0, 5)))) other[k] = v.slice(0, MAX_ITEMS);
  }

  const cur = experience.find((e) => e.current) ?? experience[0];
  const fromHeadline = splitHeadline(headline);
  const company = clean(p.currentCompany, 200) || cur?.company || fromHeadline.company;
  const title = cur && (!company || !cur.company || normalizeCompany(cur.company) === normalizeCompany(company)) ? cur.title : fromHeadline.title;
  return {
    url,
    fullName,
    headline,
    location: clean(p.location, 200),
    title: title || fromHeadline.title,
    company,
    companyUrl: cur?.companyUrl ?? '',
    about,
    experience,
    education,
    other,
    rawText,
  };
}
