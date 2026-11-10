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

// ---------- full-list pages (/details/<kind>/) ----------

const DETAIL_HEADINGS: Record<string, RegExp> = {
  experience: /^experience$/i,
  education: /^education$/i,
  skills: /^skills$/i,
  certifications: /^licen[cs]es? (&|and) certifications$|^certifications$/i,
  languages: /^languages$/i,
  'volunteering-experiences': /^volunteer(ing)?( experience)?$/i,
  honors: /^hono(u)?rs (&|and) awards$/i,
};
export const DETAIL_LABELS: Record<string, string> = {
  skills: 'Skills', certifications: 'Licenses & certifications', languages: 'Languages',
  'volunteering-experiences': 'Volunteering', honors: 'Honors & awards',
};
const NOISE = /^(show all.*|see more|…\s*see more|see less|show more|show less|…\s*more|back|load more|show more results|nothing to see for now.*)$/i;

/** the list part of a details page's text: after its heading, before the sidebar / footer; screen-reader repeats dropped */
export function detailLines(kind: string, text: string): string[] {
  const raw = (text || '').split('\n').map((l) => clean(l)).filter(Boolean);
  const head = DETAIL_HEADINGS[kind];
  // no heading = not that list (an empty section, an error or a sign-in page): read nothing rather than noise
  const at = head ? raw.findIndex((l) => head.test(l)) : -1;
  if (at < 0) return [];
  const start = at + 1;
  const out: string[] = [];
  for (let i = start; i < raw.length; i++) {
    const l = raw[i]!;
    const key = l.toLowerCase();
    if (STOP_HEADINGS.has(key) || /^linkedin corporation ©/i.test(l) || (key === 'about' && /^accessibility$/i.test(raw[i + 1] ?? ''))) break;
    if (NOISE.test(l) || l === out[out.length - 1]) continue;
    out.push(l);
  }
  return out.slice(0, 1500);
}

const EMPLOYMENT_IN_LINE = (l: string) => l.split(' · ').length > 1 && EMPLOYMENT.test(l.split(' · ').pop()!.trim());
const looksLikeProse = (l: string) => l.length > 100 || /[.!?:]$/.test(l) || /^(skills|grade|activities)\b/i.test(l);

/**
 * Experience from a details page's text. Handles single roles ("Title / Company · Full-time / dates / location /
 * description") and grouped companies ("Company / Full-time · 6 yrs / location / Role / dates / … / Role / dates …").
 */
export function parseExperienceText(lines: string[]): ExperienceEntry[] {
  const L = lines;
  const isRange = (l: string) => DATE_RANGE.test(l) || (SINGLE_DATE.test(l) && l.length < 40);
  type Role = { title: string; company: string; employmentType?: string; start: number; date: number; groupLoc?: string };
  const roles: Role[] = [];
  const groupStarts: number[] = [];
  let group: { company: string; at: number; loc?: string } | null = null;
  let prevDate = -1;
  for (let i = 0; i < L.length; i++) {
    if (DURATION_ONLY.test(L[i]!) && i > 0 && !isRange(L[i]!)) {
      // grouped company header: the line before is the company; an optional location follows
      const loc = L[i + 1] && looksLikeLocation(L[i + 1]!) && !isRange(L[i + 1]!) ? L[i + 1] : undefined;
      group = { company: splitCompanyLine(L[i - 1]!).company || L[i - 1]!, at: i - 1, loc };
      groupStarts.push(i - 1);
      continue;
    }
    if (!isRange(L[i]!)) continue;
    let j = i - 1;
    let employmentType: string | undefined;
    if (j > prevDate && EMPLOYMENT.test(L[j]!)) {
      employmentType = L[j];
      j--;
    }
    if (j <= prevDate || j < 0) continue; // a date with no header (e.g. a second date line): ignore
    let title: string;
    let company: string;
    let start: number;
    if (EMPLOYMENT_IN_LINE(L[j]!) && j - 1 > prevDate) {
      const c = splitCompanyLine(L[j]!);
      company = c.company;
      employmentType = c.employmentType;
      title = L[j - 1]!;
      start = j - 1;
      group = null;
    } else if (group && j > group.at + 1) {
      title = L[j]!;
      company = group.company;
      start = j;
    } else if (j - 1 > prevDate && !looksLikeProse(L[j - 1]!) && !(group && j - 1 <= group.at + 1)) {
      title = L[j - 1]!;
      company = splitCompanyLine(L[j]!).company || L[j]!;
      start = j - 1;
      group = null;
    } else {
      title = L[j]!;
      company = group?.company ?? '';
      start = j;
    }
    roles.push({ title, company, employmentType, start, date: i, groupLoc: group?.loc });
    prevDate = i;
  }
  const bounds = [...roles.map((r) => r.start), ...groupStarts].sort((a, b) => a - b);
  return roles.slice(0, MAX_ITEMS).map((r) => {
    const next = bounds.find((b) => b > r.date) ?? L.length;
    let rest = L.slice(r.date + 1, next);
    let location: string | undefined;
    if (rest[0] && looksLikeLocation(rest[0])) {
      location = rest[0];
      rest = rest.slice(1);
    }
    location ??= r.groupLoc;
    const description = rest.join('\n').trim();
    const dates = L[r.date]!;
    return {
      title: r.title,
      company: r.company,
      ...(r.employmentType ? { employmentType: r.employmentType } : {}),
      dates,
      current: /present/i.test(dates),
      ...(location ? { location } : {}),
      ...(description ? { description: description.slice(0, MAX_LINE) } : {}),
    };
  });
}

/** Education from a details page's text: "School / Degree, field / 2005 - 2009 / Grade… / Activities…" */
export function parseEducationText(lines: string[]): EducationEntry[] {
  const L = lines;
  const isYears = (l: string) => DATE_RANGE.test(l) || /^\d{4}$/.test(l);
  const heads: { school: string; degree: string; start: number; date: number }[] = [];
  let prev = -1;
  for (let i = 0; i < L.length; i++) {
    if (!isYears(L[i]!) || i - 1 <= prev) continue;
    const two = i - 2 > prev && !looksLikeProse(L[i - 2]!) && !looksLikeProse(L[i - 1]!);
    heads.push(two ? { school: L[i - 2]!, degree: L[i - 1]!, start: i - 2, date: i } : { school: L[i - 1]!, degree: '', start: i - 1, date: i });
    prev = i;
  }
  if (!heads.length) return L.length ? [{ school: L[0]!, detail: L.slice(1, 4).join(' · ') }] : [];
  return heads.slice(0, MAX_ITEMS).map((h, k) => {
    const end = heads[k + 1]?.start ?? L.length;
    const extra = L.slice(h.date + 1, end);
    return { school: h.school, detail: [h.degree, L[h.date], ...extra].filter(Boolean).join(' · ').slice(0, MAX_LINE) };
  });
}

/** skills / languages / certifications …: unique lines minus endorsement counters and role cross-references */
function listLines(kind: string, lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (kind === 'skills' && (/endorse/i.test(l) || /^\d+ experiences? (at|across)/i.test(l) || /^(all|industry knowledge|tools & technologies|interpersonal skills|other skills)$/i.test(l) || /skill assessment/i.test(l))) continue;
    if (/^\d+ experiences? (at|across)/i.test(l)) continue;
    const k = l.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out.slice(0, 300);
}

/** "VP Finance at Ledgerly | Ex-Globex" → { title: 'VP Finance', company: 'Ledgerly' } */
export function splitHeadline(headline: string): { title: string; company: string } {
  const first = (headline || '').split(/\s[|•·]\s/)[0]!.trim();
  const m = /^(.*?)\s+(?:at|@)\s+(.+)$/i.exec(first);
  return m ? { title: m[1]!.trim(), company: m[2]!.trim() } : { title: first, company: '' };
}

export class CaptureError extends Error {}

/** badges LinkedIn shows beside the name ("LIVE", "1st", pronouns, …) — never a headline */
const BADGE = /^(live|·.*|(1st|2nd|3rd\+?)|\(?(he|she|they)\/\w+\)?|verified|premium|open to work|hiring|creator|top voice)$/i;

/** headline + location from the visible text after the name (first lines of the profile) */
function topFromText(raw: string, fullName: string): { headline: string; location: string } {
  const lines = raw.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const i = lines.indexOf(fullName);
  if (i < 0) return { headline: '', location: '' };
  const rest = lines.slice(i + 1, i + 12).filter((l) => l.length >= 3 && !BADGE.test(l));
  const loc = rest[1] && rest[1] !== 'Contact info' && !/followers|connections/i.test(rest[1]) && rest[1].length < 90 ? rest[1] : '';
  return { headline: (rest[0] ?? '').slice(0, 500), location: loc };
}

export function parseCapture(p: CapturePayload): CapturedProfile {
  if (!p || typeof p !== 'object') throw new CaptureError('missing profile');
  const url = canonicalProfileUrl(String(p.url ?? ''));
  if (!url) throw new CaptureError('not a LinkedIn profile URL (expected linkedin.com/in/…)');
  const fullName = clean(p.fullName, 200);
  if (!fullName) throw new CaptureError('could not read the person’s name from the page — scroll to the top of the profile and try again');
  const rawText = clean(p.rawText, MAX_RAW_TEXT);
  const top = topFromText(rawText, fullName);
  let headline = clean(p.headline, 500);
  if ((!headline || BADGE.test(headline)) && top.headline) headline = top.headline;
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

  // full lists from /details/<kind>/ beat the profile page's summary whenever they found more
  const detailsText: Record<string, string> = {};
  const detailOther: Record<string, string[]> = {};
  const details = p.details && typeof p.details === 'object' ? p.details : {};
  for (const kind of Object.keys(DETAIL_HEADINGS)) {
    const d = (details as Record<string, { text?: unknown; items?: unknown }>)[kind];
    if (!d || typeof d !== 'object') continue;
    const lines = detailLines(kind, clean(d.text, 30_000));
    if (lines.length) detailsText[kind] = lines.join('\n');
    const its = Array.isArray(d.items) ? (d.items as Item[]).filter((x) => x && Array.isArray(x.lines)) : [];
    if (kind === 'experience') {
      const fromItems = parseExperience(its);
      const fromText = parseExperienceText(lines);
      const dated = (xs: ExperienceEntry[]) => xs.filter((e) => e.dates).length;
      const best = dated(fromItems) >= dated(fromText) ? fromItems : fromText;
      if (dated(best) > dated(experience) || (dated(best) === dated(experience) && best.length > experience.length)) experience = best;
    } else if (kind === 'education') {
      const fromItems = parseEducation(its);
      const best = fromItems.length >= 1 && fromItems.some((e) => /\d{4}/.test(e.detail)) ? fromItems : parseEducationText(lines);
      if (best.length >= education.length) education = best;
    } else {
      const ls = its.length ? its.map((it) => it.lines.map((l) => clean(l)).filter(Boolean)[0] ?? '').filter(Boolean) : lines;
      const xs = listLines(kind, ls.length ? ls : lines);
      if (xs.length) detailOther[DETAIL_LABELS[kind]!] = xs;
    }
  }
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
  // the full lists replace the profile page's short versions of the same section
  for (const [label, v] of Object.entries(detailOther)) {
    for (const k of Object.keys(other)) if (k.toLowerCase().slice(0, 5) === label.toLowerCase().slice(0, 5)) delete other[k];
    other[label] = v;
  }

  const cur = experience.find((e) => e.current) ?? experience[0];
  const fromHeadline = splitHeadline(headline);
  const company = clean(p.currentCompany, 200) || cur?.company || fromHeadline.company;
  const title = cur && (!company || !cur.company || normalizeCompany(cur.company) === normalizeCompany(company)) ? cur.title : fromHeadline.title;
  return {
    url,
    fullName,
    headline,
    location: clean(p.location, 200) || top.location,
    title: title || fromHeadline.title,
    company,
    companyUrl: cur?.companyUrl ?? '',
    about,
    experience,
    education,
    other,
    rawText,
    ...(Object.keys(detailsText).length ? { detailsText } : {}),
  };
}
