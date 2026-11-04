import type { ExplorerPerson, Lens } from '../types';
import type { ExportPreset } from './export';
import { CSV_BOM, slugify } from './output';

/**
 * v6 explorer exports (server `POST /api/export`, CLI `export --list`). This is a line-for-line mirror of the
 * browser download in src/web/explorer.html (crmRow / fullHeader / fullRow / csvCell / buildCsv) so a list
 * saved to outputs and the same list downloaded from the page are byte-identical. test/export.test.ts extracts
 * the page's functions and compares values + whole CSVs — change both sides together.
 */
export const EXPLORER_CRM_COLUMNS = [
  'First Name', 'Last Name', 'Email', 'Job Title', 'Company', 'LinkedIn URL', 'Seniority', 'Function', 'Industry',
  'Tags', 'Location', 'Connected On', 'Summary', 'Current Role', 'Career', 'Investments', 'Boards', 'Recent Themes', 'Profile Depth',
  'Profile Confidence', 'Lens', 'Fit Score', 'Fit Reason',
] as const;

/** Full preset base columns; `<lensId>_score` + `<lensId>_reason` are appended per lens (in lenses order). */
export const EXPLORER_FULL_COLUMNS = [
  'full_name', 'first_name', 'last_name', 'title', 'company', 'role', 'seniority', 'function',
  'industry', 'tags', 'region', 'linkedin_url', 'email', 'connected_on', 'profile_depth', 'profile_date',
  'identity_confirmed', 'confidence', 'one_liner', 'current_role', 'current_company', 'location', 'career',
  'education', 'investing_summary', 'investments', 'boards', 'expertise', 'notable', 'public_presence', 'recent_themes', 'recent_activity', 'sources',
] as const;

type Cell = string | number;
type LensRef = Pick<Lens, 'id' | 'goal'>;

const dos = (p: ExplorerPerson) => (p.dossier?.status === 'ok' && p.dossier.dossier ? p.dossier.dossier : null);
const arr = <T>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
const companyOf = (p: ExplorerPerson) => p.profile?.company || p.company || '';
const bullets = (xs: string[] | undefined) => arr(xs).filter(Boolean).map((x) => `• ${x}`).join('\n');

/** `• 2026-09 podcast: Title — what they said (url)`, newline-joined (same as the page's recentText). */
function recentText(d: ReturnType<typeof dos>): string {
  if (!d) return '';
  return arr(d.recentActivity)
    .filter(Boolean)
    .map(
      (r) =>
        '• ' + [r.date, r.kind].filter(Boolean).join(' ') + ': ' + (r.title || '') +
        (r.summary ? ` — ${r.summary}` : '') + (r.url ? ` (${r.url})` : ''),
    )
    .join('\n');
}

function careerText(d: ReturnType<typeof dos>): string {
  if (!d) return '';
  return arr(d.career)
    .filter(Boolean)
    .map((c) => '• ' + [c.role, c.company].filter(Boolean).join(', ') + (c.period ? ` (${c.period})` : ''))
    .join('\n');
}

export function explorerCrmRow(p: ExplorerPerson, lens?: LensRef | null): Cell[] {
  const pr = p.profile;
  const d = dos(p);
  const sc = lens ? p.scores?.[lens.id] : undefined;
  return [
    p.firstName || '', p.lastName || '', p.email || '', pr?.role || p.title || '', companyOf(p), p.url || '',
    pr?.seniority && pr.seniority !== 'unknown' ? pr.seniority : '',
    pr?.function && pr.function !== 'other' && (pr.function as string) !== 'unknown' ? pr.function : '',
    pr?.industry || '', arr(pr?.tags).join('; '), (d && d.location) || pr?.region || '', p.connectedOn || '',
    d ? d.oneLiner || '' : '',
    d ? [d.currentRole, d.currentCompany].filter(Boolean).join(', ') : '',
    careerText(d),
    d ? arr(d.investments).join('; ') || d.investingSummary || '' : '',
    d ? arr(d.boards).join('; ') : '',
    d ? arr(d.recentThemes).join('; ') : '',
    d ? (p.dossier!.depth || '') + (p.dossier!.legacy ? ' (legacy)' : '') : '',
    d ? d.confidence || '' : '',
    sc ? lens!.goal || '' : '', sc ? sc.score : '', sc ? sc.reason || '' : '',
  ];
}

export function explorerFullHeader(lenses: LensRef[] = []): string[] {
  const cols: string[] = [...EXPLORER_FULL_COLUMNS];
  for (const l of lenses) cols.push(`${l.id}_score`, `${l.id}_reason`);
  return cols;
}

export function explorerFullRow(p: ExplorerPerson, lenses: LensRef[] = []): Cell[] {
  const pr = p.profile;
  const d = dos(p);
  const rec = d ? p.dossier! : null;
  const row: Cell[] = [
    p.fullName || '', p.firstName || '', p.lastName || '', p.title || '', companyOf(p),
    pr?.role || '', pr?.seniority || '', pr?.function || '', pr?.industry || '', arr(pr?.tags).join('; '), pr?.region || '',
    p.url || '', p.email || '', p.connectedOn || '',
    rec ? (rec.depth || '') + (rec.legacy ? ' (legacy)' : '') : '', rec ? rec.createdAt || '' : '',
    d ? (d.identityConfirmed ? 'yes' : 'no') : '', d ? d.confidence || '' : '',
    d ? d.oneLiner || '' : '', d ? d.currentRole || '' : '', d ? d.currentCompany || '' : '', d ? d.location || '' : '',
    careerText(d),
    d ? arr(d.education).join('; ') : '',
    d ? d.investingSummary || '' : '',
    d ? arr(d.investments).join('; ') : '',
    d ? arr(d.boards).join('; ') : '',
    d ? arr(d.expertise).join('; ') : '',
    d ? bullets(d.notable) : '', d ? bullets(d.publicPresence) : '',
    d ? arr(d.recentThemes).join('; ') : '', recentText(d),
    d ? arr(d.sources).map((s) => `${s.title || ''} — ${s.url || ''}`).join('\n') : '',
  ];
  for (const l of lenses) {
    const sc = p.scores?.[l.id];
    row.push(sc ? sc.score : '', sc ? sc.reason || '' : '');
  }
  return row;
}

/** Same as the page's csvCell: every cell quoted, formula-guarded. */
export function csvCell(v: Cell | null | undefined): string {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * UTF-8 BOM + CRLF rows, identical to the page's buildCsv. `lens` drives the CRM fit columns;
 * `lenses` (all lenses, in listLenses() order) drives the full preset's per-lens columns.
 */
export function toExplorerCsv(
  people: ExplorerPerson[],
  preset: ExportPreset,
  lens?: LensRef | null,
  lenses: LensRef[] = [],
): string {
  if (preset === 'ahoy') throw new Error('toExplorerCsv: the ahoy preset is several files — use toAhoyFiles');
  const cols = preset === 'crm' ? [...EXPLORER_CRM_COLUMNS] : explorerFullHeader(lenses);
  const lines = [cols.map(csvCell).join(',')];
  for (const p of people) {
    lines.push((preset === 'crm' ? explorerCrmRow(p, lens) : explorerFullRow(p, lenses)).map(csvCell).join(','));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

// ---- Ahoy CRM import bundle (mirror of ahoyName / ahoyCompany / ahoyNote / ahoyFiles in explorer.html) ----
/** Headers use the Ahoy CRM schema labels; one file per entity type, notes kept out of contact "Summary". */
export const AHOY_COMPANY_COLUMNS = ['Company Name', 'Domain', 'Industry'] as const;
export const AHOY_CONTACT_COLUMNS = ['First Name', 'Last Name', 'Email', 'Job Title', 'Company', 'LinkedIn URL', 'Headline', 'Location'] as const;
export const AHOY_NOTE_COLUMNS = ['First Name', 'Last Name', 'Email', 'LinkedIn URL', 'Company', 'Title', 'Content'] as const;

/** "🌍 Dr. Jane Q. Example, MBA, CFA" → ["Jane Q.", "Example"]: drop emoji, honorifics, credentials and (née …). */
export function ahoyName(p: Partial<Pick<ExplorerPerson, 'fullName' | 'firstName' | 'lastName'>>): [string, string] {
  let full = String(p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ') || '');
  full = full.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ').replace(/\([^)]*\)/g, ' ');
  full = full.split(',')[0]!;
  full = full.replace(/\b(Dr|Mr|Mrs|Ms|Prof)\.?\s+/gi, ' ').replace(/\s+(M\.?D\.?|Ph\.?D\.?|MBA|CFA|CPA|PE|Esq\.?|Jr\.?|Sr\.?)$/i, '');
  const parts = full.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!parts.length) return ['', ''];
  if (parts.length === 1) return [parts[0]!, ''];
  return [parts.slice(0, -1).join(' '), parts[parts.length - 1]!];
}

/** plain "City, Country": first of several, no "(notes)", blank when the research was unsure */
export function ahoyLocation(p: ExplorerPerson): string {
  const d = dos(p);
  const loc = String((d && d.location) || p.profile?.region || '').replace(/\s*\([^)]*\)?/g, '').split(';')[0]!.trim();
  if (/^(unclear|unknown|not (found|stated|confirmed|known)|n\/a)/i.test(loc)) return '';
  return loc.replace(/^(reported as|likely|probably|possibly)\s+/i, '').trim();
}

/** company name as it will appear in the Companies CSV (first part of "A; B", trimmed) */
export function ahoyCompany(p: ExplorerPerson): string {
  const d = dos(p);
  const c = companyOf(p) || (d && d.currentCompany) || '';
  return String(c).split(/\s*[;|]\s*/)[0]!.replace(/\s+/g, ' ').trim();
}

/** Ahoy note Content (markdown): fit, who they are, investments, boards, themes. '' when there's nothing to say. */
export function ahoyNote(p: ExplorerPerson, lens?: LensRef | null): string {
  const d = dos(p);
  const sc = lens && p.scores ? p.scores[lens.id] : null;
  const out: string[] = [];
  if (sc) out.push(`**Fit for "${lens!.goal}": ${sc.score}/100** — ${sc.reason || ''}`);
  if (d && d.oneLiner) out.push(d.oneLiner);
  if (d && arr(d.investments).length) out.push('- **Investments:** ' + arr(d.investments).filter(Boolean).join('; '));
  if (d && arr(d.boards).length) out.push('- **Boards:** ' + arr(d.boards).filter(Boolean).join('; '));
  if (d && arr(d.recentThemes).length) out.push('- **Talking about:** ' + arr(d.recentThemes).filter(Boolean).join('; '));
  if (!out.length) return '';
  if (p.connectedOn) out.push('- **Connected on LinkedIn:** ' + p.connectedOn);
  return out.join('\n\n');
}

/** Ahoy note Title */
export const ahoyNoteTitle = (lens?: LensRef | null): string => (lens ? `network-builder: ${lens.goal}` : 'network-builder profile');

export interface AhoyFiles {
  companies: string;
  contacts: string;
  notes: string;
  counts: { companies: number; contacts: number; notes: number };
}

/** Companies / Contacts / Notes CSVs for Ahoy's import flow (BOM + CRLF, same cell quoting as the other presets). */
export function toAhoyFiles(people: ExplorerPerson[], lens?: LensRef | null): AhoyFiles {
  const csv = (cols: readonly string[], data: Cell[][]) =>
    CSV_BOM + [cols.map(csvCell).join(','), ...data.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
  const companies: Cell[][] = [];
  const seen = new Map<string, string>();
  const contacts: Cell[][] = [];
  const notes: Cell[][] = [];
  for (const p of people) {
    const nm = ahoyName(p);
    const co = ahoyCompany(p);
    const pr = p.profile;
    const key = co.toLowerCase();
    if (co && !seen.has(key)) {
      seen.set(key, co);
      companies.push([co, '', pr?.industry || '']);
    }
    const coName = co ? seen.get(key)! : '';
    contacts.push([nm[0], nm[1], p.email || '', pr?.role || p.title || '', coName, p.url || '', p.title || '', ahoyLocation(p)]);
    const note = ahoyNote(p, lens);
    if (note) notes.push([nm[0], nm[1], p.email || '', p.url || '', coName, ahoyNoteTitle(lens), note]);
  }
  return {
    companies: csv(AHOY_COMPANY_COLUMNS, companies),
    contacts: csv(AHOY_CONTACT_COLUMNS, contacts),
    notes: csv(AHOY_NOTE_COLUMNS, notes),
    counts: { companies: companies.length, contacts: contacts.length, notes: notes.length },
  };
}

/** Write the Ahoy bundle next to `base` (a .csv path): `<base>_ahoy-companies.csv`, `_ahoy-contacts.csv`, `_ahoy-notes.csv`. */
export function ahoyPaths(base: string): { companies: string; contacts: string; notes: string } {
  const stem = base.replace(/\.csv$/i, '');
  return { companies: `${stem}_ahoy-companies.csv`, contacts: `${stem}_ahoy-contacts.csv`, notes: `${stem}_ahoy-notes.csv` };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** `<YYYY-MM-DD_HHmmss>_<slug(name, 40)>_<N>.csv` — same as the page's exportFilename. */
export function explorerExportFilename(name: string, count: number, date = new Date()): string {
  return `${stamp(date)}_${slugify(name, 40, 'list')}_${count}.csv`;
}

/** `<YYYY-MM-DD>_network-explorer.html` — the read-only snapshot (one per day, overwritten). */
export function snapshotFilename(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_network-explorer.html`;
}
