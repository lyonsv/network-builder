import type { JobFunction, Profile, Seniority } from '../types';
import { canonicalCompanyUrl, normalizeCompany } from './capture';
import type { Account, Department, OrgNoise, Seniority as OrgSeniority, Subfunction, Tier } from './types';

/**
 * Deterministic org-chart placement from a job title (no AI). Good enough to group a buying committee; anything it
 * gets wrong is fixed by hand in the explorer (overrides are stored per account member).
 */

const VP = /\b(s?vp|evp|avp|vice[\s-]+president)\b/i;
const EXEC =
  /\b(chief\b|ceo|cfo|cto|coo|cmo|cro|cpo|ciso|cio|cdo|chro|cco|clo|president|co-?founder|founder|owner|managing director|general manager|executive director|managing partner|partner)\b/i;
const BOARD = /\b(board member|board of directors|non[\s-]?executive|chair(man|woman|person)?\b|advis[oe]r|trustee)/i;
const DIRECTOR = /\b(director|head of|head,|\bhead\b|global head)\b/i;
// "manager(in)" without a leading \b: DE compounds such as "Kommunikationsmanagerin", "Eventmanagerin"
const MANAGER = /\b(mgr|team lead|tech lead|lead|supervisor)\b|manager(in)?\b/i;
// German titles (JS \b is ASCII-only, so compounds like "Marketingleiter" match without a leading \b)
const DE_EXEC = /\bgesch[äa]ftsf[üu]hrer(in)?\b|\bgesch[äa]ftsf[üu]hrung\b|\bvorstand\b/i;
const DE_TEAM_LEAD = /(teamleiter(in)?|teamleitung|gruppenleiter(in)?|\bteamlead)\b/i;
// also compounds: "Marketingleiter", "Marketingleitung" (not "Begleiter", "Anleitung", "Weiterleitung")
const DE_DIRECTOR = /(?<!beg|an|weiter)(leiter(in)?|leitung)\b/i;
/** "Leitung" names the function's head ("Marketingleitung", "Leitung Marketing" = Head of Marketing) */
const DE_HEAD = /(?<!beg|an|weiter|team|gruppen|projekt)leitung\b/i;
const DE_IC = /(referent(in)?|spezialist(in)?|sachbearbeiter(in)?)\b/i;
const JUNIOR = /\b(junior|jr\.?)(?=[\s,]|$)/i;
const TRAINEE = /\b(werkstudent(in)?|working student|praktikant(in)?|trainee|azubi|auszubildende[r]?|intern|internship|apprentice)\b/i;

const NON_EXEC = /\bnon[\s-]?executive\b/i;
const OWN_EXEC = /\b(chief|ceo|cfo|cto|coo|cmo|cro|cpo|co-?founder|founder|owner|president)\b/i;
/** "Partner Marketing Manager" / "Product Owner" are not partners or owners of the company */
const NOT_OWNERSHIP =
  /\bpartner(s|ships?)?[\s-]+(marketing|manager|management|account|sales|success|development|programs?|enablement|ecosystem|alliances?|relations|operations|channel)\b|\b(product|process|brand|service|content)[\s-]+owner\b/gi;
/**
 * Support roles attached to an exec: "Assistant to the CMO", "Executive Assistant to …", "Assistenz der
 * Geschäftsführung", "Referent(in) der / für (die) Geschäftsführung", "Office Manager(in) der GF". They support the
 * exec, they aren't one. When the title also names its own role ("Marketing Managerin & Referentin der
 * Geschäftsführung") the support clause is dropped and that role wins; alone, the bare support word stays (an IC).
 */
const ASSIST_TO = /\b((?:executive\s+|personal\s+)?assist(?:ant|antin|enz))\s+(?:to|of|for|der|des|für|fuer)\b.*$/i;
/** Referent(in) / Office Manager(in) are support roles only FOR the exec ("Referentin für Marketing" is a specialist) */
const REF_TO =
  /\b(referent(?:in)?|office[\s-]?manager(?:in)?)\s+(?:to|of|for|der|des|für|fuer)\s+(?:(?:die|den|the)\s+)?(?:gesch[äa]ftsf[üu]hrung|gesch[äa]ftsleitung|unternehmensleitung|gf|vorstands?|ceo|managing\s+director|md|(?:executive\s+)?board)\b.*$/i;
const stripAssistant = (t: string): string => {
  const m = ASSIST_TO.exec(t) ?? REF_TO.exec(t);
  if (!m) return t;
  const before = t.slice(0, m.index).replace(/(?:\s*(?:[&|,/+·•–-]|\bund\b|\band\b))+\s*$/i, '').trim();
  return before || m[1]!;
};
const neutral = (t: string) => stripAssistant(t).replace(NOT_OWNERSHIP, (m) => m.replace(/partner|owner/gi, 'x'));
/** "lead" in "Lead Generation Specialist" is the marketing term, not a seniority word (tier / seniority only) */
const LEAD_TERM = /\blead[\s-]+(gen(eration)?|management|nurturing|scoring|routing|qualification)\b/gi;
const noLeadTerm = (t: string) => t.replace(LEAD_TERM, (m) => m.replace(/lead/i, 'x'));

/** board/advisory roles, unless the title also carries an operating exec role ("Founder & Board member") */
const isBoardOnly = (t: string) => (NON_EXEC.test(t) || BOARD.test(t)) && !OWN_EXEC.test(t.replace(VP, ''));

export function tierFromTitle(title: string): Tier {
  const t = noLeadTerm(neutral((title || '').trim()));
  if (!t) return 'unknown';
  if (NON_EXEC.test(t) && !OWN_EXEC.test(t)) return 'board';
  if (VP.test(t)) return 'vp';
  if (EXEC.test(t) || DE_EXEC.test(t)) return 'exec';
  if (DIRECTOR.test(t)) return 'director';
  if (DE_TEAM_LEAD.test(t)) return 'manager'; // before DE_DIRECTOR: "Teamleiter" contains "leiter"
  if (DE_DIRECTOR.test(t)) return 'director';
  if (BOARD.test(t)) return 'board';
  // "Werkstudent Marketing Manager" / "Junior Marketing Manager" are not people managers
  if (TRAINEE.test(t) || DE_IC.test(t) || JUNIOR.test(t)) return 'ic';
  if (MANAGER.test(t)) return 'manager';
  return 'ic';
}

/** HR / employer-branding "marketing" is recruiting, not the marketing org */
const HR_MARKETING =
  /\b(hr|human resources|people|talent|recruit(ing|ment)?|employer)[\s-]+(marketing|brand(ing)?)\b|\bemployer[\s-]+brand(ing)?\b|personalmarketing|arbeitgebermarke/i;
/** marketing titles that also contain words of other departments ("Marketing Technology Lead", "Partner Marketing") */
const MARKETING_HYBRID = [
  /\b(partner|channel|alliances?|field|revenue|growth|performance|product|portfolio|brand|content|events?|digital|social|regional|trade|vendor)[\s-]+marketing\b/i,
  /\bmarketing[\s-]+(technology|tech|ops|operations|automation|analyst|analytics|data|engineer|manager|lead|director|specialist|coordinator)\b/i,
  /\b(marcom|mops|abm|pmm|demand[\s-]+gen(eration)?|lead[\s-]+gen(eration)?|event[\s-]+manager(in)?|social media)\b/i,
  // (?<!tele): "Telekommunikation" is telecoms, not comms
  /(marketing|(?<!tele)kommunikation|pressesprecher(in)?|pressereferent(in)?|\bpresse\b|\bpresse-|[öo]ffentlichkeitsarbeit|produktmarketing|markenf[üu]hrung|veranstaltung|kampagnen|eventmanager(in)?)/i,
];

const DEPT_RULES: [Department, RegExp][] = [
  ['marketing', /\bproduct marketing\b/i],
  ['executive', /\b(ceo|chief executive|president|co-?founder|founder|owner|managing director|general manager|coo|chief operating|executive director)\b/i],
  ['executive', DE_EXEC],
  ['people', HR_MARKETING],
  ...MARKETING_HYBRID.map((re): [Department, RegExp] => ['marketing', re]),
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
  const t = neutral(raw.replace(VP, 'VP')); // "Vice President, Sales" is a sales title, not the company president
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


// ---------- v9: marketing org map (EN + DE title rules; no AI) ----------

const SENIOR = /\b(senior|sr\.?)(?=[\s,]|$)/i;
const SVP = /\b(svp|evp|senior vice[\s-]+president|executive vice[\s-]+president)\b/i;
const DE_SENIOR_DIRECTOR = /(bereichsleiter(in)?|hauptabteilungsleiter(in)?|bereichsleitung)\b/i;
const DIRECTOR_WORD = /\bdirector\b|\bdirektor(in)?\b/i;
const HEAD = /\b(head of|head,|head\b|global head)/i;
const LEAD = /\b(team lead|tech lead|teamlead|lead)\b/i;
const MANAGER_WORD = /\b(mgr|supervisor)\b|manager(in)?\b/i;
const SENIOR_IC = /\b(senior|sr\.?|principal|staff)(?=[\s,]|$)/i;

/** fine seniority ladder from a title (EN + DE); tier-consistent via SENIORITY_TIER */
export function seniorityFromTitle(title: string): OrgSeniority {
  const raw = (title || '').trim();
  if (!raw) return 'unknown';
  const tier = tierFromTitle(raw);
  if (tier === 'board' || tier === 'unknown') return 'unknown';
  const t = noLeadTerm(neutral(raw));
  if (tier === 'exec') return 'c-level';
  if (tier === 'vp') return SVP.test(t) ? 'svp' : 'vp';
  if (tier === 'director') {
    if (DE_SENIOR_DIRECTOR.test(t)) return 'senior-director';
    if (DIRECTOR_WORD.test(t)) return SENIOR.test(t) ? 'senior-director' : 'director';
    if (HEAD.test(t) || DE_HEAD.test(t)) return 'head';
    return 'director'; // Leiter(in) / Abteilungsleiter
  }
  if (TRAINEE.test(t)) return 'intern';
  if (tier === 'manager') {
    if (DE_TEAM_LEAD.test(t) && !/\bteamlead\b/i.test(t)) return 'manager'; // Teamleiter(in) / Gruppenleiter(in)
    if (MANAGER_WORD.test(t)) return SENIOR.test(t) ? 'senior-manager' : 'manager';
    if (LEAD.test(t)) return 'lead';
    return 'manager';
  }
  if (JUNIOR.test(t)) return 'junior';
  if (SENIOR_IC.test(t)) return 'senior-ic';
  return 'ic';
}

const SUBFUNCTION_RULES: [Subfunction, RegExp][] = [
  ['product-marketing', /\b(product|portfolio|solutions?)[\s-]+marketing\b|\bpmm\b|produktmarketing|\bgo[\s-]to[\s-]market\b/i],
  ['partner-marketing', /\b(partner|channel|alliances?|trade|ecosystem)[\s-]*marketing\b|partnermarketing/i],
  ['marketing-ops', /\bmarketing[\s-]+(technology|tech|ops|operations|automation|analyst|analytics|data|engineer|systems|intelligence|insights)\b|\b(mops|martech|marketing automation)\b/i],
  ['events', /\bevents?\b|eventmanag|veranstaltung|\bmesse(n)?\b|trade[\s-]?shows?|\bkongress/i],
  ['comms-pr', /\b(communications?|comms|pr|public relations|press|media relations|corporate affairs|spokes(person|man|woman)|marcom)\b|(?<!tele)kommunikation|pressesprecher|pressereferent|\bpresse|[öo]ffentlichkeitsarbeit/i],
  ['demand-gen', /\b(demand[\s-]+gen(eration)?|growth|performance marketing|campaigns?|abm|account[\s-]based|lead[\s-]+gen(eration)?|acquisition|lifecycle|revenue marketing|integrated marketing)\b|kampagnen|leadgenerierung/i],
  ['field-marketing', /\b(field|regional|country|local|area)[\s-]+marketing\b|\bfield marketer\b/i],
  ['digital-social', /\b(digital|online|social( media)?|seo|sea|sem|web(site)?|e-?commerce|paid (social|media|search)|influencer|community)\b|onlinemarketing|onlineredakt/i],
  ['content', /\b(content|copywriter|copywriting|editor(ial)?|storytelling|redakteur(in)?|redaktion|texter(in)?)\b/i],
  ['brand', /\b(brand(ing)?|creative|kreativ|marke)\b|markenf[üu]hrung|markenmanag/i],
];
const LEADERSHIP_SENIORITY = new Set<OrgSeniority>(['c-level', 'svp', 'vp', 'senior-director', 'director', 'head']);

/** marketing sub-function from a title; 'other' for non-marketing titles and generic marketing roles below leadership */
export function subfunctionFromTitle(title: string): Subfunction {
  const t = stripAssistant((title || '').trim());
  if (!t) return 'other';
  const dept = departmentFromTitle(t);
  const marketingExec = dept === 'executive' && /marketing|\bcmo\b/i.test(t);
  if (dept !== 'marketing' && !marketingExec) return 'other';
  if (/\b(cmo|chief marketing)\b/i.test(t) || marketingExec) return 'leadership';
  for (const [sf, re] of SUBFUNCTION_RULES) if (re.test(t)) return sf;
  return LEADERSHIP_SENIORITY.has(seniorityFromTitle(t)) ? 'leadership' : 'other';
}

const SALES_HYBRID = /\b(sales|vertrieb)\s*(&|and|und|\/|\+)\s*marketing\b|\bmarketing\s*(&|and|und|\/|\+)\s*(sales|vertrieb)\b/i;
const FUNDED = /\b(funded by|sponsored by|vendor[\s-]funded|vendor[\s-]sponsored|mdf[\s-]funded|partner[\s-]funded|co-?funded by)\b/i;
/**
 * "… marketing … for|@|– <Vendor> Inc|Corp|GmbH|AG|Ltd|…": only with a company suffix, so "for New Business",
 * "for IBM Partners" or "for DACH" never count (Haiku judges those).
 */
const VENDOR_CO =
  /\b([Mm]arketing|[Pp]ortfolio|MARKETING)\b[^|]*?\s(?:for|@|[–-])\s*([A-Z][\w.&-]*(?:\s+[A-Z][\w.&-]*){0,2})\s+(Inc|Corp|Corporation|GmbH|AG|Ltd|LLC|SE|plc|BV|B\.V|SA|S\.A)\.?(?=[\s,;)|]|$)/;
/** "… Marketing Manager HP Inc." — the title ENDS with a company carrying a legal suffix */
const VENDOR_TAIL =
  /\b(?:[Mm]arketing|[Pp]ortfolio|MARKETING)\b.*\s([A-Z][\w.&-]*(?:\s+[A-Z][\w.&-]*){0,2})\s+(?:Inc|Corp|Corporation|GmbH|AG|Ltd|LLC|SE|plc|BV|B\.V|SA|S\.A)\.?\s*$/;
const normCo = (s: string) => s.toLowerCase().replace(/\b(inc|corp|corporation|gmbh|ltd|llc|ag|se|plc)\b\.?/g, '').replace(/[^a-z0-9]/g, '');

/**
 * Why a title may not belong in the marketing org ('' = no sign). Conservative: only flags explicit patterns.
 * `not-marketing` and `stale` are left to the AI pass / the user; `other-employer` comes from `isOtherEmployer`.
 * Vendor-funded roles are not noise (see `vendorFundedFromTitle`).
 */
export function noiseFromTitle(title: string): OrgNoise | '' {
  const t = (title || '').trim();
  if (!t) return '';
  if (HR_MARKETING.test(t)) return 'hr-marketing';
  if (SALES_HYBRID.test(t)) return 'sales-hybrid';
  return '';
}

/**
 * Tag (not noise): a marketer whose role is funded by / dedicated to a vendor — an explicit "funded by / sponsored by /
 * vendor-funded" phrase, or "… marketing … for|@|– <Vendor> Inc|Corp|GmbH|…" when the person's company is known and
 * is not that vendor. When the vendor IS their employer the title says nothing special (they are `other-employer`).
 */
export function vendorFundedFromTitle(title: string, company = ''): boolean {
  const t = (title || '').trim();
  if (!t) return false;
  if (FUNDED.test(t)) return true;
  const co = normCo(company);
  if (!co) return false;
  const m = VENDOR_CO.exec(t);
  const tail = m ? null : VENDOR_TAIL.exec(t);
  const vendor = m ? normCo(m[2]!) : tail ? normCo(tail[1]!) : '';
  return Boolean(vendor && vendor !== co && !co.includes(vendor) && !vendor.includes(co));
}

/** company text that names no employer (or a deliberately vague one): never treated as another employer */
const NO_EMPLOYER =
  /^(self[\s-]?employed|freelance[r]?|freiberuf\w*|selbs(t|tst)(ä|ae)ndig\w*|independent|stealth|confidential|various|n\/?a|none|-)(\b.*)?$/i;

/** generic words that say nothing about WHICH company it is ("Ledgerly Group" ≈ "Ledgerly Services GmbH") */
const GENERIC_CO =
  /\b(group|gruppe|groupe|grupo|holding|holdings|international|intl|global|worldwide|se|ag|gmbh|mbh|kg|kgaa|inc|ltd|llc|plc|corp|co|company|the|and)\b/g;
/** normalised company name without legal / generic words */
export const companyCore = (s: string): string => normalizeCompany(s).replace(GENERIC_CO, ' ').replace(/\s+/g, ' ').trim();

const slugText = (url: string): string => {
  const slug = /linkedin\.com\/(?:company|showcase|school)\/([^/?#\s]+)/i.exec(url || '')?.[1] ?? '';
  try {
    return decodeURIComponent(slug).replace(/[-_]+/g, ' ');
  } catch {
    return slug.replace(/[-_]+/g, ' ');
  }
};

/**
 * Do two company cores name the same employer? Lenient on purpose (only a clear mismatch may flag other-employer):
 * equal (ignoring spaces); a 2-letter name as the whole first word ("hp" ~ "hp deutschland"); a ≥ 3-char name as whole
 * words of the other ("ledgerly" ~ "ledgerly services"); or a shared prefix of ≥ 5 chars ("ledgerlypay", "ledgerlyag").
 */
export function sameEmployer(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ca = a.replace(/ /g, '');
  const cb = b.replace(/ /g, '');
  if (ca === cb) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 2) return long.split(' ')[0] === short;
  if (short.length >= 3 && ` ${long} `.includes(` ${short} `)) return true;
  let i = 0;
  while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
  return i >= 5;
}

/**
 * What the account is called (as `companyCore`s): name, aliases, domain stem ("ledgerly.com" → "ledgerly"), LinkedIn
 * slug, the entities set on members, and the LinkedIn company pages already captured onto this account (list walks).
 */
export function employerNames(
  account: Pick<Account, 'name' | 'aliases' | 'domain' | 'linkedinUrl'>,
  entities: string[] = [],
  companyPages: string[] = [],
): string[] {
  const domainStem = (account.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[./]/)[0] ?? '';
  const raw = [account.name, ...(account.aliases ?? []), domainStem, slugText(account.linkedinUrl || ''), ...entities, ...companyPages.map(slugText)];
  return [...new Set(raw.map(companyCore).filter(Boolean))];
}

/**
 * True only when the person's current company is CLEARLY not the account or one of its entities (e.g. they are
 * employed by the vendor whose marketing they do). Conservative: a missing / vague company, an account with nothing to
 * compare with, or any `sameEmployer` match (on the company text or its /company/ slug) is not other-employer.
 * `companyUrl` equal to the account's LinkedIn page, or to a company page captured onto the account, counts as the account.
 * Pass only a company from a captured profile's current experience — never one guessed from a headline.
 */
export function isOtherEmployer(
  company: string,
  account: Pick<Account, 'name' | 'aliases' | 'domain' | 'linkedinUrl'>,
  entities: string[] = [],
  companyUrl = '',
  companyPages: string[] = [],
): boolean {
  const text = (company || '').replace(/\s+/g, ' ').trim();
  const co = companyCore(text);
  if (!co || NO_EMPLOYER.test(text)) return false;
  const cu = canonicalCompanyUrl(companyUrl);
  if (cu && [account.linkedinUrl || '', ...companyPages].some((u) => canonicalCompanyUrl(u) === cu)) return false;
  const names = employerNames(account, entities, companyPages);
  if (!names.length) return false;
  const mine = [co, companyCore(slugText(companyUrl))].filter(Boolean);
  return !names.some((n) => mine.some((m) => sameEmployer(n, m)));
}
