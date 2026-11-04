import { readFile } from 'node:fs/promises';
import type { OutputFilenameOptions, ReportFile, ReportMeta, ResearchedPerson, SavedList } from '../types';

export const OUTPUT_COLUMNS = [
  'rank', 'fit_score', 'research_score', 'full_name', 'first_name', 'last_name', 'title', 'company',
  'role', 'seniority', 'function', 'industry', 'tags', 'region', 'linkedin_url', 'email', 'connected_on', 'fit_reason', 'researched', 'identity_confirmed',
  'confidence', 'current_role', 'location', 'summary', 'signals', 'fit_assessment',
  'recommended_approach', 'talking_points', 'red_flags', 'sources', 'research_cost_usd',
  'research_error',
] as const;

export function slugify(input: string, maxLen = 50, fallback = 'run'): string {
  let s = (input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/-+$/, '');
  return s || fallback;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function buildOutputFilename(opts: OutputFilenameOptions): string {
  const d = opts.date;
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}_${slugify(opts.prompt)}_ranked-${opts.total}.csv`;
}

/**
 * Spreadsheet apps treat cells starting with = + - @ (or tab/CR) as formulas. Prefix those with a
 * single quote so names/titles/model text can't become formulas (CSV injection).
 */
export function safeCell(v: string | number): string | number {
  return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

const bullets = (items: string[]) => items.map((t) => `• ${t}`).join('\n');

export function toOutputRow(p: ResearchedPerson): Record<string, string | number> {
  const rec = p.research;
  const r = rec?.status === 'ok' ? rec.report : undefined;
  const pr = p.profile;
  const row: Record<string, string | number> = {
    rank: p.rank > 0 ? p.rank : '',
    fit_score: p.score,
    research_score: r ? r.researchScore : '',
    full_name: p.fullName,
    first_name: p.firstName,
    last_name: p.lastName,
    title: p.title,
    company: pr?.company || p.company,
    role: pr?.role ?? '',
    seniority: pr?.seniority ?? '',
    function: pr?.function ?? '',
    industry: pr?.industry ?? '',
    tags: pr?.tags.join('; ') ?? '',
    region: pr?.region ?? '',
    linkedin_url: p.url,
    email: p.email,
    connected_on: p.connectedOn,
    fit_reason: p.fitReason,
    researched: rec ? (rec.status === 'ok' ? 'yes' : 'error') : 'no',
    identity_confirmed: r ? (r.identityConfirmed ? 'yes' : 'no') : '',
    confidence: r?.confidence ?? '',
    current_role: r?.currentRole ?? '',
    location: r?.location ?? '',
    summary: r?.summary ?? '',
    signals: r ? r.signals.map((s) => `${s.signal} [${s.strength}]: ${s.finding}`).join('\n') : '',
    fit_assessment: r?.fitAssessment ?? '',
    recommended_approach: r?.recommendedApproach ?? '',
    talking_points: r ? bullets(r.talkingPoints) : '',
    red_flags: r ? bullets(r.redFlags) : '',
    sources: r ? r.sources.map((s) => `${s.title} — ${s.url}`).join('\n') : '',
    research_cost_usd: rec ? Number(rec.costUsd.toFixed(4)) : '',
    research_error: rec?.status === 'error' ? (rec.error ?? 'unknown error') : '',
  };
  for (const k of Object.keys(row)) row[k] = safeCell(row[k]!);
  return row;
}

/** UTF-8 BOM so Excel (esp. on macOS) reads accented/CJK/emoji names correctly. */
export const CSV_BOM = '\ufeff';

/**
 * Read a JSON sidecar. New files are ReportFile {meta, people}; files from before the interactive report
 * were a bare ResearchedPerson[] and come back with meta: null.
 */
export async function readReportFile(
  file: string,
): Promise<{ meta: ReportMeta | null; people: ResearchedPerson[]; lists: SavedList[] }> {
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (Array.isArray(raw)) return { meta: null, people: raw as ResearchedPerson[], lists: [] };
  if (raw && typeof raw === 'object' && Array.isArray((raw as ReportFile).people)) {
    const r = raw as ReportFile;
    const meta = r.meta && typeof r.meta === 'object' && typeof r.meta.prompt === 'string' ? r.meta : null;
    const lists = Array.isArray(r.lists) ? r.lists.filter((l) => l && typeof l.id === 'string' && Array.isArray(l.ids)) : [];
    return { meta, people: r.people, lists };
  }
  throw new Error(`${file} is not a network-builder report (expected {meta, people} or an array of people)`);
}
