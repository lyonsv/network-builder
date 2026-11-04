import { createHash } from 'node:crypto';
import type { DossierRecord, Profile } from '../types';

/** Profile with keys in a fixed order (tags sorted) so the hash never depends on JSON key order. */
function stableProfile(p: Profile | undefined): string {
  if (!p) return '';
  return JSON.stringify([
    p.company ?? '', p.role ?? '', p.seniority ?? '', p.function ?? '', p.industry ?? '',
    [...(p.tags ?? [])].map(String).sort(), p.region ?? '',
  ]);
}

/** Identity of a dossier version: depth + creation time + model (a new dossier always changes this). */
export function dossierIdentity(d: DossierRecord | undefined): string {
  if (!d || d.status !== 'ok') return '';
  return `${d.depth}:${d.createdAt}:${d.model}`;
}

/**
 * Hash of everything a lens score is computed from: headline (title), company, the parsed profile and the best
 * dossier. When it changes, the person's scores in every lens are stale. Stable across processes.
 */
export function inputHash(p: { title: string; company: string; profile?: Profile; dossier?: DossierRecord }): string {
  const parts = [(p.title ?? '').trim(), (p.company ?? '').trim(), stableProfile(p.profile), dossierIdentity(p.dossier)];
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}
