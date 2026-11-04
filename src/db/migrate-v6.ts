import { DEFAULTS, type CareerEntry, type Dossier, type DossierRecord, type LensScore, type ResearchRecord } from '../types';
import { inputHash } from './hash';
import type { Store } from './store';

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export interface V6MigrationResult {
  lensesCreated: number;
  scoresMigrated: number;
  dossiersConverted: number;
}

const RUN_FLAG = (runKey: string) => `v6_run_migrated:${runKey}`;

function firstSentence(s: string): string {
  const t = (s ?? '').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return (m?.[1] ?? t).trim();
}

/** "VP Sales at Acme" / "Partner, Northwind Ventures" → role + company (best effort) */
function splitRole(currentRole: string): { role: string; company: string } {
  const t = (currentRole ?? '').trim();
  const m = /^(.*?)\s+(?:at|@)\s+(.+)$/i.exec(t) ?? /^(.*?),\s+(.+)$/.exec(t);
  return m ? { role: m[1]!.trim(), company: m[2]!.trim() } : { role: t, company: '' };
}

/** Convert an older goal-specific research record into a goal-free (legacy) deep dossier. */
export function researchToDossier(rec: ResearchRecord, goal: string): DossierRecord | undefined {
  const r = rec.report;
  if (rec.status !== 'ok' || !r) return undefined;
  const { role, company } = splitRole(r.currentRole);
  const findings = (r.signals ?? []).filter((s) => s.strength !== 'none' && s.finding);
  const pick = (re: RegExp) => findings.filter((s) => re.test(s.signal)).map((s) => s.finding.trim());
  const investing = findings.filter((s) => /invest|angel|portfolio|fund/i.test(`${s.signal} ${s.finding}`)).map((s) => s.finding.trim());
  const career: CareerEntry[] = r.currentRole ? [{ role, company, period: '', current: true }] : [];
  const summaryRest = (r.summary ?? '').trim().slice(firstSentence(r.summary ?? '').length).trim();
  const dossier: Dossier = {
    identityConfirmed: Boolean(r.identityConfirmed),
    confidence: r.confidence ?? 'medium',
    oneLiner: firstSentence(r.summary ?? ''),
    currentRole: role || r.currentRole || '',
    currentCompany: company,
    location: r.location ?? '',
    career,
    education: [],
    investingSummary: investing.slice(0, 2).join(' '),
    investments: [],
    boards: [],
    expertise: [],
    notable: [summaryRest, ...pick(/capacity|seniority|background|identity|who is/i)].filter(Boolean),
    publicPresence: pick(/recent|activity|presence|media|podcast/i),
    recentActivity: [],
    recentThemes: [],
    sources: (r.sources ?? []).filter((s) => s && /^https?:\/\//i.test(s.url)),
  };
  return {
    personId: rec.id,
    depth: 'deep',
    status: 'ok',
    dossier,
    model: rec.model || '',
    costUsd: 0, // the spend is already in the ledger as legacy 'research'
    durationMs: Number(rec.durationMs) || 0,
    createdAt: rec.finishedAt || new Date().toISOString(),
    legacy: true,
    legacyNotes: {
      goal,
      fitAssessment: r.fitAssessment ?? '',
      recommendedApproach: r.recommendedApproach ?? '',
      talkingPoints: r.talkingPoints ?? [],
      redFlags: r.redFlags ?? [],
      researchScore: Number(r.researchScore) || 0,
    },
  };
}

/**
 * One-way, idempotent conversion of pre-v6 data:
 * - every ok `research` row → a legacy deep dossier (source_key 'research:<id>', so it is converted once);
 * - every `runs` row → the lens for its goal (one lens per distinct goal; newest run's scores win), each run once.
 *
 * Migrated scores are treated as NOT stale even though they were computed from the headline before profiles
 * existed: their input hash is computed from the person's current title/company/profile WITHOUT the converted
 * legacy dossier. People who already had legacy research therefore show as stale (their score never used it).
 */
export function migrateV6(store: Store): V6MigrationResult {
  const res: V6MigrationResult = { lensesCreated: 0, scoresMigrated: 0, dossiersConverted: 0 };
  const db = store.db;

  // 1. research → legacy deep dossiers
  const research = db.prepare("SELECT id, prompt, record_json FROM research WHERE status = 'ok' ORDER BY created_at").all() as Row[];
  for (const r of research) {
    let rec: ResearchRecord | undefined;
    try {
      rec = JSON.parse(str(r.record_json)) as ResearchRecord;
    } catch {
      continue;
    }
    const d = rec && researchToDossier(rec, str(r.prompt));
    if (!d) continue;
    const before = Number((db.prepare('SELECT COUNT(*) AS n FROM dossiers').get() as Row).n);
    store.addDossier(d, `research:${str(r.id)}`);
    const after = Number((db.prepare('SELECT COUNT(*) AS n FROM dossiers').get() as Row).n);
    res.dossiersConverted += after - before;
  }

  // 2. runs + rankings → lenses (newest run first so its scores win; INSERT-if-absent per person)
  const runs = db.prepare("SELECT run_key, prompt, rank_model, updated_at, created_at FROM runs ORDER BY updated_at DESC").all() as Row[];
  if (!runs.some((r) => !store.getMeta(RUN_FLAG(str(r.run_key))))) return res;

  // hash inputs WITHOUT dossiers (see doc comment)
  const profiles = new Map<string, Parameters<typeof inputHash>[0]['profile']>();
  for (const pr of db.prepare('SELECT person_id, profile_json FROM profiles WHERE person_id IS NOT NULL ORDER BY person_id, created_at DESC').all() as Row[]) {
    const id = str(pr.person_id);
    if (profiles.has(id)) continue;
    try {
      profiles.set(id, JSON.parse(str(pr.profile_json)));
    } catch {
      /* skip */
    }
  }
  const headlineHash = new Map<string, string>();
  for (const p of db.prepare('SELECT id, title, company FROM people').all() as Row[]) {
    const id = str(p.id);
    headlineHash.set(id, inputHash({ title: str(p.title), company: str(p.company), profile: profiles.get(id) }));
  }

  for (const run of runs) {
    const runKey = str(run.run_key);
    if (store.getMeta(RUN_FLAG(runKey))) continue;
    const goal = str(run.prompt).trim();
    if (!goal) {
      store.setMeta(RUN_FLAG(runKey), new Date().toISOString());
      continue;
    }
    let lens = store.findLensByGoal(goal);
    if (!lens) {
      lens = store.createLens(
        { goal, rankModel: str(run.rank_model) || DEFAULTS.rankModel, rerankModel: DEFAULTS.researchModel, rerankTop: 150 },
        str(run.created_at) || undefined,
      );
      res.lensesCreated++;
    }
    const existing = new Set(
      (db.prepare('SELECT person_id FROM lens_scores WHERE lens_id = ?').all(lens.id) as Row[]).map((x) => str(x.person_id)),
    );
    const scoredAt = str(run.updated_at) || new Date().toISOString();
    const scores: LensScore[] = [];
    for (const rk of db.prepare('SELECT person_id, score, reason FROM rankings WHERE run_key = ? AND ranked = 1').all(runKey) as Row[]) {
      const pid = str(rk.person_id);
      const hash = headlineHash.get(pid);
      if (hash === undefined || existing.has(pid)) continue;
      scores.push({
        lensId: lens.id, personId: pid, score: Number(rk.score), reason: str(rk.reason), basis: 'headline',
        model: str(run.rank_model) || DEFAULTS.rankModel, inputHash: hash, scoredAt,
      });
      existing.add(pid);
    }
    store.setLensScores(scores);
    // keep the lens's updated_at at the run's time rather than "now" (setLensScores bumps it)
    db.prepare('UPDATE lenses SET updated_at = ? WHERE id = ?').run(scoredAt, lens.id);
    res.scoresMigrated += scores.length;
    store.setMeta(RUN_FLAG(runKey), new Date().toISOString());
  }
  return res;
}
