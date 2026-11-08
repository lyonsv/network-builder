import type { JobFunction, Profile, Seniority } from '../types';
import type { Department, Tier } from './types';

/**
 * Deterministic org-chart placement from a job title (no AI). Good enough to group a buying committee; anything it
 * gets wrong is fixed by hand in the explorer (overrides are stored per account member).
 */

const VP = /\b(s?vp|evp|avp|vice[\s-]+president)\b/i;
const EXEC =
  /\b(chief\b|ceo|cfo|cto|coo|cmo|cro|cpo|ciso|cio|cdo|chro|cco|clo|president|co-?founder|founder|owner|managing director|general manager|executive director|managing partner|partner)\b/i;
const BOARD = /\b(board member|board of directors|non[\s-]?executive|chair(man|woman|person)?\b|advis[oe]r|trustee)/i;
const DIRECTOR = /\b(director|head of|head,|\bhead\b|global head)\b/i;
const MANAGER = /\b(manager|mgr|team lead|tech lead|lead\b|supervisor)\b/i;

const NON_EXEC = /\bnon[\s-]?executive\b/i;
const OWN_EXEC = /\b(chief|ceo|cfo|cto|coo|cmo|cro|cpo|co-?founder|founder|owner|president)\b/i;
/** board/advisory roles, unless the title also carries an operating exec role ("Founder & Board member") */
const isBoardOnly = (t: string) => (NON_EXEC.test(t) || BOARD.test(t)) && !OWN_EXEC.test(t.replace(VP, ''));

export function tierFromTitle(title: string): Tier {
  const t = (title || '').trim();
  if (!t) return 'unknown';
  if (NON_EXEC.test(t) && !OWN_EXEC.test(t)) return 'board';
  if (VP.test(t)) return 'vp';
  if (EXEC.test(t)) return 'exec';
  if (DIRECTOR.test(t)) return 'director';
  if (BOARD.test(t)) return 'board';
  if (MANAGER.test(t)) return 'manager';
  return 'ic';
}

const DEPT_RULES: [Department, RegExp][] = [
  ['marketing', /\bproduct marketing\b/i],
  ['executive', /\b(ceo|chief executive|president|co-?founder|founder|owner|managing director|general manager|coo|chief operating|executive director)\b/i],
  ['it-security', /\b(security|ciso|infosec|cyber|\bit\b|information technology|cio|chief information|systems administrator|sysadmin|it ops)\b/i],
  ['data-ai', /\b(data|analytics|machine learning|\bml\b|\bai\b|artificial intelligence|scientist|business intelligence|\bbi\b|cdo|chief data)\b/i],
  ['engineering', /\b(engineer|engineering|developer|software|devops|sre|cto|chief technology|architect|platform|infrastructure|technical|technology|r&d)\b/i],
  ['product', /\b(product|cpo|chief product)\b/i],
  ['design', /\b(design|designer|ux|ui|user experience|ux research(er)?)\b/i],
  ['customer', /\b(customer|client services|support|success|onboarding|implementation|professional services)\b/i],
  ['sales', /\b(sales|account executive|business development|bdr|sdr|cro|chief revenue|revenue|partnerships?|alliances|commercial|account manager|channel)\b/i],
  ['marketing', /\b(marketing|cmo|brand|growth|content|communications|comms|\bpr\b|public relations|demand gen|creative|social media|seo|events)\b/i],
  ['finance', /\b(finance|financial|cfo|accounting|accountant|controller|treasury|fp&a|procurement|purchasing|sourcing|vendor|payroll|tax)\b/i],
  ['people', /\b(hr|human resources|people|talent|recruit(er|ing|ment)?|chro|learning and development|l&d)\b/i],
  ['legal', /\b(legal|counsel|compliance|attorney|lawyer|solicitor|clo|privacy|regulatory|risk)\b/i],
  ['operations', /\b(operations|ops\b|supply chain|logistics|facilities|strategy|strategic|transformation|chief of staff|program(me)? manag|project manag|business operations)\b/i],
];

export function departmentFromTitle(title: string): Department {
  const raw = (title || '').trim();
  if (!raw) return 'other';
  if (isBoardOnly(raw)) return 'board';
  const t = raw.replace(VP, 'VP'); // "Vice President, Sales" is a sales title, not the company president
  for (const [dept, re] of DEPT_RULES) if (re.test(t)) return dept;
  return 'other';
}

const SENIORITY_TIER: Record<Seniority, Tier> = {
  'founder/owner': 'exec', 'c-suite': 'exec', partner: 'exec', vp: 'vp', director: 'director', 'head of': 'director',
  manager: 'manager', 'senior ic': 'ic', ic: 'ic', 'advisor/board': 'board', student: 'ic', unknown: 'unknown',
};
const FUNCTION_DEPT: Record<JobFunction, Department> = {
  investing: 'finance', 'general management': 'executive', sales: 'sales', marketing: 'marketing', engineering: 'engineering',
  product: 'product', design: 'design', 'data/ai': 'data-ai', operations: 'operations', finance: 'finance',
  'people/recruiting': 'people', legal: 'legal', consulting: 'other', 'customer success': 'customer', 'media/creative': 'marketing',
  'education/research': 'other', healthcare: 'other', 'public sector': 'other', other: 'other',
};

/** Title first; fall back to the AI headline profile (connections) when the title says nothing useful. */
export function classify(title: string, profile?: Profile): { department: Department; tier: Tier } {
  let department = departmentFromTitle(title);
  let tier = tierFromTitle(title);
  if (profile) {
    if (department === 'other') department = FUNCTION_DEPT[profile.function] ?? 'other';
    if (tier === 'unknown' || (tier === 'ic' && profile.seniority && SENIORITY_TIER[profile.seniority] !== 'ic' && SENIORITY_TIER[profile.seniority] !== 'unknown')) {
      tier = SENIORITY_TIER[profile.seniority] ?? tier;
    }
  }
  if (tier === 'board' && department === 'other') department = 'board';
  return { department, tier };
}
