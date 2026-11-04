import { importLegacy, LEGACY_IMPORT_FLAG, type LegacyImportResult } from './legacy';
import { migrateV6, type V6MigrationResult } from './migrate-v6';
import { Store } from './store';

export { Store, dbProfileCache, dbRunCache, withLedger } from './store';
export type { DbStats, ListRecord } from './store';
export { importLegacy, LEGACY_IMPORT_FLAG } from './legacy';
export { migrateV6, researchToDossier } from './migrate-v6';
export type { V6MigrationResult } from './migrate-v6';
export { inputHash } from './hash';

/**
 * Open (creating/migrating) the store. The first time a database is opened, the pre-SQLite file caches and
 * report JSONs are imported once (read-only; old files are kept).
 */
export async function openStore(
  dbPath: string,
  legacy?: { cacheDir: string; outDir: string },
): Promise<{ store: Store; imported?: LegacyImportResult; migratedV6?: V6MigrationResult }> {
  const store = Store.open(dbPath);
  let imported: LegacyImportResult | undefined;
  if (legacy && !store.getMeta(LEGACY_IMPORT_FLAG)) imported = await importLegacy(store, legacy);
  // v6: research → legacy dossiers, runs → lenses. Idempotent and cheap when there's nothing new.
  const migratedV6 = migrateV6(store);
  const changed = migratedV6.lensesCreated + migratedV6.scoresMigrated + migratedV6.dossiersConverted > 0;
  return { store, ...(imported ? { imported } : {}), ...(changed ? { migratedV6 } : {}) };
}
