import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many have run, so each migration
 * runs exactly once per database. Append new migrations; never edit an applied one.
 */
export const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE people (
    id           TEXT PRIMARY KEY,
    full_name    TEXT NOT NULL DEFAULT '',
    first_name   TEXT NOT NULL DEFAULT '',
    last_name    TEXT NOT NULL DEFAULT '',
    title        TEXT NOT NULL DEFAULT '',
    company      TEXT NOT NULL DEFAULT '',
    url          TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '',
    connected_on TEXT NOT NULL DEFAULT '',
    extra_json   TEXT NOT NULL DEFAULT '{}',
    first_seen   TEXT NOT NULL,
    last_seen    TEXT NOT NULL,
    last_source  TEXT NOT NULL DEFAULT ''
  );

  -- goal-independent title parse; key = computeProfileKey(person, title, company, model)
  CREATE TABLE profiles (
    key          TEXT PRIMARY KEY,
    person_id    TEXT,
    model        TEXT NOT NULL DEFAULT '',
    profile_json TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX profiles_person ON profiles(person_id);

  CREATE TABLE runs (
    run_key        TEXT PRIMARY KEY,
    prompt         TEXT NOT NULL DEFAULT '',
    input_path     TEXT NOT NULL DEFAULT '',
    rank_model     TEXT NOT NULL DEFAULT '',
    research_model TEXT NOT NULL DEFAULT '',
    total_people   INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE rankings (
    run_key   TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
    person_id TEXT NOT NULL,
    score     INTEGER NOT NULL,
    reason    TEXT NOT NULL DEFAULT '',
    ranked    INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (run_key, person_id)
  );
  CREATE INDEX rankings_person ON rankings(person_id);

  -- every research attempt that was kept (ok results; errors are not cached), newest wins per key
  CREATE TABLE research (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id    TEXT NOT NULL,
    key          TEXT NOT NULL,
    prompt       TEXT NOT NULL DEFAULT '',
    signals_hash TEXT NOT NULL DEFAULT '',
    model        TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL,
    record_json  TEXT NOT NULL,
    error        TEXT,
    cost_usd     REAL NOT NULL DEFAULT 0,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    UNIQUE (key, created_at)
  );
  CREATE INDEX research_person ON research(person_id, created_at);
  CREATE INDEX research_key ON research(key);

  CREATE TABLE lists (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    prompt     TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE list_members (
    list_id   TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL,
    position  INTEGER NOT NULL,
    PRIMARY KEY (list_id, person_id)
  );

  CREATE TABLE exports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id    TEXT,
    name       TEXT NOT NULL,
    preset     TEXT NOT NULL,
    path       TEXT NOT NULL,
    count      INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE cost_ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    stage      TEXT NOT NULL,
    usd        REAL NOT NULL,
    run_key    TEXT,
    note       TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // 2: v6 network explorer — goal-free dossiers, lenses and per-lens scores
  `
  CREATE TABLE dossiers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id   TEXT NOT NULL,
    depth       TEXT NOT NULL,
    status      TEXT NOT NULL,
    model       TEXT NOT NULL DEFAULT '',
    record_json TEXT NOT NULL,
    error       TEXT,
    cost_usd    REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    legacy      INTEGER NOT NULL DEFAULT 0,
    -- set for rows converted from older data (e.g. 'research:<id>') so the conversion is idempotent
    source_key  TEXT UNIQUE
  );
  CREATE INDEX dossiers_person ON dossiers(person_id, created_at);

  CREATE TABLE lenses (
    id           TEXT PRIMARY KEY,
    goal         TEXT NOT NULL,
    rank_model   TEXT NOT NULL DEFAULT '',
    rerank_model TEXT NOT NULL DEFAULT '',
    rerank_top   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE lens_scores (
    lens_id    TEXT NOT NULL REFERENCES lenses(id) ON DELETE CASCADE,
    person_id  TEXT NOT NULL,
    score      INTEGER NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    basis      TEXT NOT NULL DEFAULT 'headline',
    model      TEXT NOT NULL DEFAULT '',
    input_hash TEXT NOT NULL DEFAULT '',
    scored_at  TEXT NOT NULL,
    PRIMARY KEY (lens_id, person_id)
  );
  CREATE INDEX lens_scores_person ON lens_scores(person_id);
  `,
  // 4: lens membership — a score threshold plus manual pins (in/out) that override it
  `
  ALTER TABLE lenses ADD COLUMN threshold INTEGER NOT NULL DEFAULT 70;
  CREATE TABLE lens_pins (
    lens_id   TEXT NOT NULL REFERENCES lenses(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL,
    state     TEXT NOT NULL CHECK (state IN ('in', 'out')),
    pinned_at TEXT NOT NULL,
    PRIMARY KEY (lens_id, person_id)
  );
  `,
  // 5: Ahoy CRM reconciliation per person (CrmMatch JSON)
  `
  CREATE TABLE crm_matches (
    person_id   TEXT PRIMARY KEY,
    record_json TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

const readVersion = (db: DatabaseSync) =>
  Number((db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0);

/**
 * Apply pending migrations. Each step takes the write lock up front (BEGIN IMMEDIATE, waits via busy_timeout)
 * and re-reads the version inside the transaction, so several processes opening a brand-new database at once
 * apply each migration exactly once.
 */
export function migrate(db: DatabaseSync): void {
  for (;;) {
    let version = readVersion(db);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `network.db schema v${version} is newer than this network-builder (v${SCHEMA_VERSION}). Update the CLI.`,
      );
    }
    if (version === SCHEMA_VERSION) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      version = readVersion(db); // another process may have migrated while we waited for the lock
      if (version < SCHEMA_VERSION) {
        db.exec(MIGRATIONS[version]!);
        db.exec(`PRAGMA user_version = ${version + 1}`);
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* no transaction open */
      }
      throw e;
    }
  }
}
