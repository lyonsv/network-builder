# Interactive report contract (UI <-> server)

Types live in `src/types.ts` (ReportMeta, ReportFile, ReportState, QueueState, CostSnapshot, ServerEvent).

## Template
- `src/web/report.html` — ONE vanilla HTML file, inline `<style>` and `<script>`, no external requests (no CDN, no fonts).
- Data placeholder, exactly: `<script id="nb-data" type="application/json">__NB_DATA__</script>`
  Server/writer replaces `__NB_DATA__` with `JSON.stringify(state)` where `<` is escaped as `<` (and U+2028/2029 escaped).
- Page title placeholder: `__NB_TITLE__` (inside <title>, already HTML-escaped by the writer).
- At build, tsup copies it to `dist/report.html`. Runtime loader looks next to the running module
  (`dirname(fileURLToPath(import.meta.url))/report.html`), falling back to `../web/report.html` and `./web/report.html`.

## Modes
- `state.api === null` → static snapshot (opened from disk). Everything works (search/filter/sort/detail/CSV download)
  except research buttons, which are disabled with a hint: `network-builder serve "<paths.json>"`.
- `state.api.token` set → live. Page is served from `http://127.0.0.1:<port>/?t=<token>`; same origin.

## HTTP API (all JSON; every /api request must send header `X-NB-Token: <token>`; SSE passes `?t=<token>`)
- `GET  /api/state` → ReportState (fresh)
- `POST /api/research` body `{ ids: string[], force?: boolean }` → `{ queued: string[], skipped: string[] }`
   Skips already-researched-ok (unless force), already queued/running, and unranked/unknown ids.
- `POST /api/cancel` body `{ ids?: string[] }` → `{ cancelled: string[] }` (queued only; omit ids = all queued)
- `POST /api/save` → `{ paths }` (rewrites csv/json/html now; server also autosaves after each `done`, debounced 1s)
- `GET  /api/events?t=<token>` → SSE stream of ServerEvent; event name = type. Sends `hello` on connect.
  Heartbeat comment `: ping` every 15s. UI reconnects with backoff and refetches /api/state on reconnect.
- Server binds 127.0.0.1 only, random free port. Rejects requests with wrong token (401) or a foreign
  `Origin` header (403). Body limit 1MB.

## Research semantics
- Research uses the existing `researchPeople([person], opts)` + shared research cache (cache hit → instant done, $0).
- Server runs its own queue with concurrency = cfg.researchConcurrency. FIFO. A `done` event carries the full
  updated ResearchedPerson (status ok OR error in person.research).
- Estimated cost shown in UI = count × meta.estUsdPerResearch (rough).

## UI requirements
- Header: prompt, counts (total / researched / queued / running), live cost, save status, links to CSV/JSON paths (text).
- Table columns: select checkbox, Rank, Fit, Research score, Name (links to LinkedIn URL), Title (+company if any),
  Connected, Why (fit reason, truncated w/ tooltip), Status (not researched / queued / running / ✓ conf / ✗ error),
  Action button (Research / Re-run / Cancel).
- Search: free text over name, title, company, fitReason, and research summary/currentRole/location.
- Filters: min fit score (range + number), status (all / not researched / researched / queued+running / errors),
  confidence (any/high/medium/low), identity confirmed, connected-on date range, "ranked only" hides ranking failures.
- Sort: click any header (asc/desc toggle, indicator); default rank asc.
- Selection: per-row checkbox, header checkbox = select all *filtered* rows, shift-click range select,
  "Select top N" quick action; sticky action bar showing "N selected · ≈ $X" with buttons
  [Research selected] [Cancel queued] [Clear]. Confirm dialog before bulk research > 10 people showing est cost.
- Row click (not on controls) expands a detail panel: summary, current role, location, identity confirmed, confidence,
  research score, signals (with strength chips), fit assessment, recommended approach, talking points, red flags,
  sources (links, target=_blank rel=noopener), cost, error text.
- Performance: 2,000+ rows — render with pagination (50/100/250/all), filtering debounced ~150ms.
- Download CSV button (client-side, current filtered rows or all) in addition to the server-saved CSV.
- Persist UI prefs (filters/sort/page size) in localStorage, wrapped in try/catch.
- Clean, modern, light+dark (prefers-color-scheme), keyboard accessible, no frameworks.

## Revisions (review round 2)
- `QueueState.seq`: monotonically increasing per server session. `POST /api/research` and `POST /api/cancel` responses also
  include `queue: QueueState`. Clients apply queue snapshots only if `seq >= lastSeq` (hello and /api/state are authoritative).
  The UI never mutates queue state optimistically.
- `ResearchRecord.fromCache`: set on records reused from the shared research cache in this session; UI shows "cached, $0"
  (costUsd keeps the original cost).
- The UI keeps `view` as a list of ids and always reads the current person via `byId` (no stale copies after `done`).
- Default port: `stablePortFor(stem)` in 47000–47999 (same origin → same localStorage prefs when reopening a report),
  falling back to a random free port if busy. `--port` is exact.
- Single server per report: `<outDir>/<stem>.lock` holds the pid; a live holder makes a second `serve` refuse to start;
  a dead holder's lock is replaced.
- Shutdown: SIGINT / SIGTERM / SIGHUP all trigger cancel → abort → final save → final box (exit 0); a second signal force-quits.

## Revisions (v3)
- Research is only ever started by the human in this report; the CLI has no auto-research mode
  (`--no-ui`, `-n/--top`, `-y/--yes`, `--skip-research` removed; `--no-serve` writes files and exits).
- Only `status: 'ok'` research is written to the shared cache. A failed (forced) re-run keeps the person's previous
  ok result; the `done` event then carries `error: string` and the UI toasts "Re-run failed — kept the previous result".
- `ReportMeta.costs = { rank, research }` is the cumulative spend on this report, rewritten on every save; `serve`
  seeds its cost tracker from it, so `costs` in state/events is cumulative across sessions.
- Autosave is debounced (1s) but never postponed more than 10s.
- Saved CSV starts with a UTF-8 BOM.
- Search covers name, title, company, URL and research text; fit reasons only when "include fit reasons" is ticked
  (persisted in prefs as `searchReasons`).

## Revisions (v4): profile enrichment + CRM lists

### Enrichment (backend)
- New stage between CSV parse and ranking: `enrichProfiles(people, opts)` in `src/llm/enrich.ts` — Haiku, NO tools,
  batched (default 100/call, concurrency 4), JSON schema output → `Profile` (types.ts) per person.
- Cache: shared, goal-independent: `<cacheRoot>/profiles/<key>.json`, key = sha1(personId + '\0' + title + '\0' + company + '\0' + model).slice(0,16).
  Missing/failed people get no profile (never cached); a rerun retries them.
- Enrichment always runs for everyone (it's cheap, ~$0.10–0.30 per 2,000); costs tracked under stage 'enrich'
  (extend CostStage + CostTracker + CostSnapshot with `enrich`; meta.costs.enrich cumulative).
- The ranking prompt includes the parsed profile (company/seniority/function/tags) per person when available.
- `serve` backfills: if any person lacks `profile`, run enrichment for them on startup (cached, so usually $0),
  with a terminal progress line; UI receives updated people via GET /api/state (send a `saved` event after).
- Output CSV gains columns after `company`: `role, seniority, function, industry, tags, region` (tags joined "; ").
  `company` column = profile.company || person.company.

### Lists (server)
- `ReportFile.lists?: SavedList[]` persisted in the JSON sidecar (and embedded in the HTML state).
- `GET /api/lists` → `{ lists }`; `PUT /api/lists/:id` body `{ name, ids }` → upsert (id = slug of name if new; server validates ids exist,
  dedupes, keeps order) → `{ list, lists }`; `DELETE /api/lists/:id` → `{ lists }`. Broadcast SSE `lists` event after changes. Autosave.
- `POST /api/export` body `{ name: string, ids: string[], preset: 'crm' | 'full' }` → writes
  `<outDir>/<stem>__<slug(name)>_<N>.csv` (UTF-8 BOM, formula-safe) and returns `{ path, count }`.
  Server and UI share the same column presets (define in `src/io/export.ts`; UI duplicates the column list in JS — keep in sync, add a test that
  parses the column names out of report.html and compares).
- CRM preset columns (HubSpot/Salesforce-friendly header names, in order):
  `First Name, Last Name, Email, Job Title, Company, LinkedIn URL, Seniority, Function, Industry, Tags, Region, Connected On, Fit Score, Fit Reason, Research Summary, Recommended Approach, Research Score, Confidence`
- Full preset = the main output CSV columns.

### UI (report.html)
- New columns: Company (from profile), Seniority, Function, Tags (chips). Keep table readable: allow hiding columns via a "Columns" menu (persisted).
- New filters: Seniority (multi), Function (multi), Tags (multi, any-of), Industry (text contains), Company (text contains). Multi-selects as compact chip dropdowns.
  Search also covers role/company/industry/tags.
- Selection is the working list for BOTH research and export. Persist the working selection in localStorage per stem.
- Easy list-building controls:
  - Selection bar actions: **Select N filtered** · **Deselect filtered** (selection only, never a lens) · **Invert within filtered** · **Clear**; with a lens active, **✕ Remove N from lens** / **＋ Add N to lens** for the selected people (via `scopeToShown`), plus **Lenses ▾** for every lens.
  - View toggle: **All · Selected · Not selected** (works together with filters).
  - Row checkbox; shift-click range; keyboard: ↑/↓ (or j/k) move focus between rows, **x** or Space toggles selection, Enter expands.
  - In "Selected" view, each row shows a quick **✕ remove** button.
- Saved lists (live mode): dropdown "Lists" → load into selection (replace or add), save current selection as new list / overwrite, rename, delete.
  Static mode: lists shown read-only (can load into selection + export via browser download).
- **Export CSV** button in the selection bar → small dialog: list name (prefilled from the loaded list or "Selection <date>"), preset (CRM / Full),
  count; [Download] (browser, always) and [Save to outputs] (live only, calls /api/export, shows the saved path).
- Research button stays in the selection bar ("Research N" with ≈ cost, confirm > 10) — human-triggered only.

## Revisions (v5): SQLite store

- One database: `<data dir>/network.db` (`DEFAULT_DB_PATH`; `--db <path>` on the root command, `serve`,
  `lists`, `export`, `db`). Built-in `node:sqlite` (no npm dependency), WAL, foreign keys, 5s busy timeout.
  Schema in `src/db/schema.ts`, versioned with `PRAGMA user_version` (append migrations, never edit applied ones).
- Tables: `people` (accumulates across CSV imports; first_seen/last_seen/last_source; email/connected_on never blanked by a
  newer export), `profiles` (key = computeProfileKey, linked to person_id), `runs` + `rankings` (per run key),
  `research` (every kept result with its goal `prompt`, signals hash, model; full ResearchRecord in `record_json`;
  unique on (key, created_at)), `lists` (+ `prompt` = goal of the report it was built in) + `list_members` (ordered),
  `exports`, `cost_ledger` (every new spend by stage; `withLedger()` wraps the CostTracker), `meta`.
- The LLM stages keep their interfaces: `dbRunCache(store, runKey, { prompt, fresh })` implements RunCache (ranks per run;
  research exact-key hits; new `getPriorResearch(personId, excludeKey)`), `dbProfileCache(store)` implements ProfileCache
  (`set(key, profile, personId)`). `--fresh` deletes only this run's rankings and ignores exact research hits.
- Legacy: on first open, `importLegacy()` reads (never modifies/deletes) `<cacheDir>/<runKey>/{meta,ranks}.json`,
  `<cacheDir>/research/*.json` (goal recovered by matching keys against known prompts), `<cacheDir>/profiles/*.json`
  and `outputs/*.json` reports (people, profiles, research, lists; profiling/ranking spend from meta.costs, research spend
  from the imported rows). Flag `legacy_import_v1` in `meta`; `network-builder db --import-legacy` re-runs it (idempotent).
- Research reuse across goals: no exact (person+goal+signals+model) hit → the latest ok research for that person from any
  other goal is attached as `priorResearch` (types.ts). Ranking adds an "earlier web research" column (role; location;
  ≤200-char summary). Research prompts include the prior findings + sources and cut the search budget to ~4.
  The UI may show `priorResearch` as "earlier research (goal …)"; it is never counted as research for this goal.
- Lists are global: `/api/lists` reads/writes the store (lists in a report's JSON from before the store are adopted once).
  Updating a list from a report keeps members that report doesn't contain (appended after the report's own ids).
  `ReportState.lists`/the JSON snapshot still embed all lists for static mode. `/api/export` records into `exports`
  (optional body `listId`).
- ReportMeta gains `runKey` and `dbPath` (serve reopens the same database).
- CLI: `network-builder lists`, `network-builder export --list <name|id> [--preset crm|full] [-o file]` (rebuilds rows from the
  database: list goal's ranking + latest research, else most recent; default `outputs/<date>_<slug>_<N>.csv`),
  `network-builder db [--import-legacy]` (counts + spend by stage + runs).
- Profiling defaults changed: batches of 50 with a 5-minute timeout (100-person batches sometimes exceeded 3 minutes).

## Revisions (v5.1): integration fixes
- Lists with a store: the server re-reads lists from the store on every list GET/PUT/DELETE and on `/api/state`
  (no long-lived cache). `PUT /api/lists/:id` body may include `create: true` → always creates a new list with a
  server-assigned unique id (the UI uses this for "Save as new"); without it, an existing id is updated.
  Non-Latin names get ids `list`, `list-2`, …
- A report JSON's lists are adopted into the store only for reports written before the store existed
  (`adoptLists`, = no `meta.dbPath`), once per report (meta flag `lists_adopted:<stem>`). Legacy import follows
  the same rule and skips spend for reports with `meta.dbPath`/`meta.runKey`.
- `saved` SSE events may carry `reload: true` (people changed server-side, e.g. the background profile backfill
  in `serve`); clients refetch `/api/state`.
- `serve` starts the server first and backfills missing profiles in the background (skipped when the Claude CLI
  is unavailable; one pass per process).
- People upsert: a value is only replaced by a non-blank value from an observation at least as new
  (`serve` passes the report's `createdAt`).
- Browser and server exports are value-identical (tested): Function blank for `other`, Region falls back to the
  research location, export file slug = `slugify(name, 40, 'list')`, full-preset `rank` blank when unknown.
  `POST /api/export` gets `listId` when the selection equals the loaded list.
- Root-level `--db/--out-dir/--cache-dir` apply to subcommands. Migrations use `BEGIN IMMEDIATE`; Node ≥ 22.13.

## v6: Network explorer (supersedes the per-goal "report" model)

Why: research must be goal-free knowledge about the network, reusable for any list ("angel investors", "heads of marketing"...).
Headline-only ranking is misleading (self-labelled "Angel Investor" recruiter > VC partner; ex-execs with bland headlines missed).

### Concepts (types in src/types.ts, v6 section)
- **Person** (from CSV imports, accumulates) + **Profile** (cheap headline parse, all people, existing).
- **Dossier** (goal-free web knowledge). `light` = Haiku + WebSearch, ≤2 searches, snippets only, ~$0.01–0.02.
  `deep` = research model (default sonnet) + WebSearch/WebFetch, ≤6 searches, ~$0.10–0.15. Both human-triggered from the UI
  (single person or bulk selection), never automatic. Prompt template for what to capture lives in
  `<data dir>/dossier.md` (create default if missing; DO NOT delete/overwrite existing signals.md).
  Dossiers are versioned rows; the explorer shows the best (deep > light, newest).
- **Lens** = a goal scored across the whole network. Pass 1: Haiku over everyone in batches (inputs: headline, profile,
  dossier digest if any). Pass 2 (rerank): research model re-scores the top `rerankTop` (default 150) with full dossier info,
  batches of ~25. Score rubric emphasises CREDIBLE EVIDENCE over keywords: primary occupation, institutional roles
  (Partner/GP/Principal at a fund) > self-applied labels in a headline; a recruiter/consultant who adds "Angel Investor"
  scores moderate unless a dossier shows real investments; dossier evidence (named investments, boards, exec history) beats
  headline wording. Reason must cite the evidence and say what it's based on.
- Lens scores store `inputHash` (title + profile + best dossier id). When a person's inputs change (new dossier), their
  scores in every lens become **stale**; UI offers "Update N stale" per lens (re-scores only those people, Haiku + rerank if
  they're in the top band). Never auto-run.
- Creating a lens is human-triggered (UI "New lens" box, or CLI `-p "<goal>"`). Cost shown before confirming.

### Rate limiting (web search)
- Dossier queue runs with concurrency 1 (light) — configurable — and detects rate limiting: CLI error text OR a structured
  `rateLimited: true` flag the model must set when its searches fail/are refused. On rate limit: record nothing as done,
  requeue the person at the front, set `pausedUntil` (backoff 1m → 2m → 5m → 10m, reset after a success), emit `queue`.
- A person whose search found nothing is still `ok` with low confidence (that's information); only failures are retried.

### Migration (DB schema bump)
- New tables: `dossiers(id, person_id, depth, status, model, dossier_json, error, cost_usd, duration_ms, created_at, legacy)`,
  `lenses(id, goal, rank_model, rerank_model, rerank_top, created_at, updated_at)`,
  `lens_scores(lens_id, person_id, score, reason, basis, model, input_hash, scored_at, PK(lens_id, person_id))`.
- Existing `runs`+`rankings` → one lens per distinct prompt (scores basis 'headline', model haiku, inputHash computed so they
  are NOT stale unless inputs differ). Existing ok `research` rows → `dossiers` (depth 'deep', legacy=1) mapping
  summary→oneLiner(first sentence)/notable, currentRole, location, sources, signals text → notable/investingSummary best-effort.
  Keep old tables (read-only). Idempotent.

### CLI
- `network-builder` (no args): open the explorer on the DB (no CSV needed once imported).
- `network-builder -i <csv>`: import/upsert people + profile any new/changed titles (Haiku, cheap), then open the explorer.
- `-p "<goal>"`: create (or refresh stale of) that lens after import, then open the explorer with it selected.
- `--no-open`, `--port`, `--db`, `--no-serve` (do the work, write nothing else, exit). `serve` = alias of no-args explorer.
- `lists`, `export --list <name> [--lens <id>] [--preset crm|full]` (fit columns from the given lens; default: lens the list was
  built under if recorded, else none), `db` (stats incl. dossiers light/deep, lenses).
- `lens list` / `lens rm <id>` small helpers.
- Static snapshot: `POST /api/snapshot` (and on exit) writes `outputs/<date>_network-explorer.html` (api:null) — read-only view.

### HTTP API (token + origin rules unchanged)
- `GET /api/state` → ExplorerState
- `POST /api/dossiers` `{ ids, depth, force? }` → `{ queued, skipped, queue }` (skip people with an ok dossier of ≥ that depth unless force)
- `POST /api/dossiers/cancel` `{ ids? }` → `{ cancelled, queue }`
- `POST /api/lenses` `{ goal, rerankTop? }` → `{ lens }` then runs scoring in background (one lens job at a time; 409 if busy)
- `POST /api/lenses/:id/refresh` → re-score stale people; `DELETE /api/lenses/:id`
- `GET/PUT/DELETE /api/lists...` unchanged (lists global). `PUT` body may include `lensId` (recorded).
- `POST /api/export` `{ name, ids, preset, listId?, lensId? }` → `{ path, count }`
- `POST /api/snapshot` → `{ path }`
- SSE `/api/events?t=` → ExplorerEvent (event name = type).

### UI (explorer)
- Header: network size, profiled, dossiers (light/deep), spend, queue status (running/queued/paused until …), lens job progress.
- **Lens bar**: dropdown of lenses (+ "No lens"), "New lens" input with cost estimate, "Update N stale" button. With a lens
  selected the table shows Score (+ basis icon: headline / light / deep; stale marker) and Reason columns, sorted by score.
  Without a lens: sorted by name/connected date; pure exploration.
- Search covers name, title, profile fields, and dossier text (career companies/roles, investments, boards, expertise,
  notable, location, oneLiner). Quoted phrases supported. Filters as v4 + "Has dossier: none/light/deep", Location contains,
  "Past company contains" (career).
- Row detail: profile, dossier (career timeline, investments, boards, education, expertise, notable, presence, sources,
  confidence, depth, date), scores across ALL lenses (lens → score/reason), list memberships. Legacy research shown as
  dossier (legacy) — goal-specific fields (fit assessment/approach) shown under a collapsed "Legacy goal notes".
- Selection bar actions: Export CSV (CRM/full; with lens columns if a lens is active), Save as list, **Build light profiles
  (N) ≈ $**, **Deep profile (N) ≈ $** (confirm > 10), Cancel queued, Clear. Per-row: "Profile" (light) / "Deep" buttons.
- Everything else from v4 (lists, views All/Selected/Not selected, ✕ remove, keyboard, undo, column menu, prefs) stays.

### v6 module signatures (builders code against these; owner in brackets)

```ts
// [B1] src/db/store.ts — new Store methods (schema bump in src/db/schema.ts, migration in src/db/legacy.ts or src/db/migrate-v6.ts)
listExplorerPeople(): ExplorerPerson[];                 // profile + best dossier + scores for every lens (stale computed)
getExplorerPerson(id: string): ExplorerPerson | undefined;
addDossier(rec: DossierRecord): number;
bestDossier(personId: string): DossierRecord | undefined; // deep > light, newest; status ok only
listLenses(): Lens[];                                   // with scored/stale counts
getLens(id: string): Lens | undefined;
createLens(i: { goal: string; rankModel: string; rerankModel: string; rerankTop: number }): Lens; // id = unique slug
deleteLens(id: string): boolean;
setLensScores(scores: LensScore[]): void;
staleOrUnscored(lensId: string): string[];              // person ids needing (re)scoring
explorerCosts(): ExplorerCosts;                         // from cost_ledger (incomplete=false)

// [B1] src/db/hash.ts
export function inputHash(p: { title: string; company: string; profile?: Profile; dossier?: DossierRecord }): string;

// [B1] src/llm/dossier.ts
export const DEFAULT_DOSSIER_PATH: string;             // <data dir>/dossier.md
export const DEFAULT_DOSSIER_MD: string;
export function ensureDossierTemplate(path: string): Promise<{ path: string; content: string; created: boolean }>;
export function buildDossier(person: ExplorerPerson, opts: {
  depth: DossierDepth; model: string; template: string; signal?: AbortSignal; timeoutMs?: number;
}): Promise<DossierRecord>;                             // never rejects except AbortError; status 'rate_limited' when detected
export const DOSSIER_ESTIMATES: { lightUsd: number; deepUsd: number };

// [B1] src/llm/lens.ts
export function scoreLens(opts: {
  lens: Lens; people: ExplorerPerson[];                 // the people to (re)score
  allPeople?: ExplorerPerson[];                         // for choosing the rerank band (top N of the lens overall)
  store: Store; costs: CostTracker; signal?: AbortSignal;
  onProgress?(p: { phase: 'score' | 'rerank'; done: number; total: number }): void;
}): Promise<LensScore[]>;                               // persists via store.setLensScores as batches finish
export const LENS_USD_PER_1000: number;

// [B2] src/web/explorer-server.ts
export function startExplorerServer(opts: {
  store: Store; dbPath: string; outDir: string; template: string /* dossier template */;
  researchModel: string; port?: number; concurrency?: { light: number; deep: number };
  dossierFn?: typeof buildDossier; scoreFn?: typeof scoreLens;   // test stubs
}): Promise<{ url: string; port: number; token: string; close(): Promise<void> }>;
// [B2] src/cli/explore.ts — CLI flow; src/index.ts wiring; template loader for explorer.html; tsup copies explorer.html
// [B3] src/web/explorer.html — single-file vanilla UI; data placeholder `__NB_DATA__` (ExplorerState JSON), title `__NB_TITLE__`
```

### v6.1 integration notes
- Export: `src/io/explorer-export.ts` is a line-for-line mirror of explorer.html's `crmRow` / `fullHeader` / `fullRow` /
  `csvCell` / `buildCsv` / `exportFilename`. Every cell quoted, CRLF rows, UTF-8 BOM. Full preset appends
  `<lensId>_score`, `<lensId>_reason` for ALL lenses (listLenses order). Filenames `<YYYY-MM-DD_HHmmss>_<slug(name,40)>_<N>.csv`
  on both sides. test/export.test.ts extracts the page functions and asserts values + whole CSVs are identical.
- `POST /api/lenses/:id/refresh` body `{ all?: boolean }` — `all: true` re-scores everyone (UI "Re-score all ≈ $";
  CLI `network-builder lens rescore <id|goal> [--stale] [-y]`).
- `POST /api/lenses` with an existing goal → `{ lens, existing: true, scoring: <n stale> }`; the UI says so.
- report.html, its loader/renderer, `writeReport`, the old CRM/full mappers (src/io/export.ts → just `ExportPreset`) and
  src/db/export.ts were removed; `readReportFile` stays for the legacy import.

### v6.2 review fixes
- **Rate limits are bounded.** Each person gets at most 3 rate-limited attempts (`maxRateLimitedAttempts`), then an
  error dossier "rate-limited N× — retry later" is stored (not ok → can be re-queued by hand). Backoff escalates once per
  pause (1m → 2m → 5m → 10m); the next limit after the last step sets `queue.pausedManual = true` and nothing runs until
  `POST /api/dossiers/resume` (UI: "Resume" in the paused chip). Never auto-resumes indefinitely.
- **Rate-limit text heuristic** only applies when the model omitted `rateLimited` AND ran no searches AND the answer is
  empty; pattern narrowed to `rate limit | too many requests/searches | 429 | search quota/limit reached`.
- **Lens counts**: "Update N" = stale + unscored (same set the server refresh scores); label "(stale + new)" when any are new.
- **Estimates** include the rerank: `estimates.lensRerankUsdPer100`; cost = n/1000 × lensUsdPer1000 + min(rerankTop, n)/100 ×
  lensRerankUsdPer100 (`estimateLensUsd` in src/llm/lens.ts; measured rates rounded up: $0.30/1000, $0.50/100).
- **Rerank failure/abort** marks unfinished band members stale (input_hash cleared); pass-1 batch failures likewise.
- **Other processes' writes**: every API call and every heartbeat checks `PRAGMA data_version`; on change the server
  reloads and emits `lenses` + `{type:'reload'}` (UI refetches /api/state).
- **Lens lock** (`meta lens_job:<id>` = {pid, at}, 30s heartbeat, stale after 2 min or dead pid) is taken by the explorer,
  `-p` and `lens rescore`; a held lock → 409 / CLI error. Lens scores stream to the UI per batch (`scoreLens({ onScores })`).
- Aborted dossier calls' spend is recorded (or the tracker marked incomplete when unknown).

## v6.3 — lens membership

- `Lens` gains `threshold` (0–100, default 70), `pinnedIn: string[]`, `pinnedOut: string[]` (migration 4: `lenses.threshold`, `lens_pins`).
- Member of a lens = pinned in, or (score ≥ threshold and not pinned out). The UI pins only where the score alone disagrees.
- `PUT /api/lenses/:id` body `{ threshold?: number }` and/or `{ ids: string[], pin: 'in' | 'out' | null }` → `{ lens, lenses }`; emits `lenses`.
- Explorer: threshold input + "Show everyone / Only in lens / Only not in lens / Added/removed by hand" in the lens bar; ✓/+ toggle on each
  row's score and on every lens in the detail panel; "Add N to lens" / "Remove N from lens" for the selection (with Undo).
- `PUT /api/lenses/:id` also takes `{ goal, rescore?: true }`: rewords the lens in place (id, pins, threshold kept; all scores marked
  stale; `rescore` re-scores everyone; 409 while that lens or — with rescore — any lens is scoring, or if another lens has that goal).
  Explorer: "✎ Edit" in the lens bar. CLI: `lens rescore <id|goal> --goal "<new goal>"` (same checks; rewords once it holds the lens lock).

## v6.4 — lens workspace UX

- Lens strip under the lens bar: tabs In lens / Candidates / Removed / Everyone (counts respect the other filters; switching lens
  opens "In lens"), "Include score ≥" slider (applies live, saved after 600ms), context bulk button acting on everyone shown
  (Remove / Add / Restore these N; confirm above 25; Undo toast), "Export lens (N)" → export dialog with the members.
- Row column `lensact`: ✕ remove / ＋ add / ↺ restore; rows leave the tab with a fade; keyboard `r` / `a` on a focused row
  (focus moves to the next row). Score cell shows an "added" / "removed" chip for manual pins.
- Pin edits are optimistic and serialised; server/SSE lens updates are ignored while edits are in flight (last response wins).
- Results bar above the table: "N people in this lens · of total", one chip per active filter (× clears it), Clear all,
  selection count, Select / Deselect these.

## v6.5 — Ahoy CRM export preset

- Preset `ahoy` (page download, `POST /api/export`, `export --preset ahoy`): three files `<base>_ahoy-companies.csv`
  (Company Name, Domain, Industry — one row per company, case-insensitive), `<base>_ahoy-contacts.csv` (First Name, Last Name,
  Email, Job Title, Company, LinkedIn URL, Headline, Location — Company equals the companies file exactly) and
  `<base>_ahoy-notes.csv` (First Name, Last Name, Email, LinkedIn URL, Company, Title, Content — markdown fit score/reason, one-liner, investments, boards, themes; only people with something to say).
  Headers are Ahoy schema labels; no "Summary" column (notes are a separate file). Domain is blank: reconcile against the
  live CRM (search_crm / get_crm_object) before importing. `/api/export` returns `{ path, paths, count }`.
- Page `ahoyName / ahoyLocation / ahoyCompany / ahoyNote / ahoyFiles` mirror `src/io/explorer-export.ts`; parity tested.

## v7 — Ahoy CRM integration (through the user's Ahoy MCP connector in Claude Code)

- `claude -p` calls may now use MCP tools: `ClaudeCallOptions.mcpTools` → no `--strict-mcp-config`, `--disallowedTools`
  for every built-in, `--allowedTools` = exactly those MCP tools (`mcp__claude_ai_Ahoy__*`; override the prefix with
  `NB_AHOY_TOOL_PREFIX` for a `claude mcp add`-style server name).
- Migration 5: `crm_matches(person_id PK, record_json, updated_at)`; `ExplorerPerson.crm?: CrmMatch`
  (status in_crm|new|ambiguous|error, contact/company ids+names+domain, companyStatus in_crm|no_domain|new|none,
  linkedToCompany, candidates, reason, checkedAt, resolvedByHand, sent{proposalId,url,at,title}).
- `src/llm/ahoy.ts`: `checkAhoy` (read-only: search_crm / get_crm_object / get_associations; Haiku, 8 people per call,
  4 parallel), `planAhoySend` (deterministic: new companies once, new contacts + ahoy_contact_to_company, a note +
  ahoy_note_to_contact for everyone; ≤50 ops per proposal; skips unchecked/ambiguous/error/already sent),
  `sendAhoyProposal` (create_proposal ONLY, never execute_crm_operations; verifies the op count; no retries).
- API: `POST /api/ahoy/check {ids}`, `/api/ahoy/resolve {id, contactId|"new"}`, `/api/ahoy/plan {ids, lensId?}`,
  `/api/ahoy/send {ids, lensId?}`; one Ahoy job at a time (409); queue state `ahoyJob {kind, done, total}`;
  SSE `crm {updates:[{id, crm}], costs}`; cost stage `ahoy`.
- UI: Ahoy column (✓ Ahoy / New / Pick / Failed + ⚠ no-domain / not-linked + ↗ proposal), More filters → Ahoy CRM,
  selection bar "Ahoy ▾" (Check / Send…), detail-panel "Ahoy CRM" section with candidate picking and Re-check.

## v8 — Accounts (ABX) + Chrome extension

- Migration (array index 5, comment "6"): `accounts(id slug PK, name, domain, linkedin_url, aliases_json, status
  target|engaged|customer|paused, brief markdown, created_at, updated_at)`, `contacts(id = personId(canonical URL) PK —
  equal to people.id for connections, url, full_name, headline, title, company, location, profile_json CapturedProfile,
  captured_at, capture_count)`, `contact_captures(id, contact_id, profile_json, captured_at)` (history),
  `account_members(account_id FK cascade, person_id, department, tier, role, reports_to, notes, added_at, updated_at;
  PK account+person)`. `''` department/tier = automatic from the title (`src/accounts/classify.ts`).
- **Captured people never go in `people`.** Membership may reference a connection (`people.id`), a capture
  (`contacts.id`) or both (same id). Validation: role ∈ decision-maker|champion|influencer|user|gatekeeper|blocker|'',
  department/tier from `src/accounts/types.ts`, `reports_to` must be another member of the same account with no
  cycles; removing a member clears reporting lines that pointed at them.
- `ExplorerState.accounts?: AccountSummary[]` `{id, name, status, domain, memberIds, memberCount, captured,
  connections, roles: {role: n}, updatedAt}`. SSE `accounts {accounts, changed?, notice?}` after every account change
  (page reloads the open account; `notice` = a capture from the extension → toast with "Open").
- Page API (session token): `GET/POST /api/accounts`, `GET/PUT/DELETE /api/accounts/:id` (`GET` → AccountView
  `{account, members: AccountMember[], warmPaths, gaps}`; `PUT` body any of name, domain, linkedinUrl, aliases[],
  status, brief → `{view, accounts}`), `GET /api/accounts/:id/brief?detail=full|summary` → `{markdown}`
  (`src/accounts/brief.ts`, same as MCP `network_get_account`), `POST /api/accounts/:id/members {ids, role?}` →
  `{added, already, unknown, view, accounts}`, `PUT|DELETE /api/accounts/:id/members/:pid` (PUT body any of role,
  department, tier, reportsTo, notes). Validation errors are 400, unknown account 404.
- Pairing: `POST /api/ext/pair {rotate?}` → `{code: "nb1." + base64url(JSON {v:1, u:"http://127.0.0.1:<port>", t}),
  port, extensionDir, extension}`. The capture token lives in meta `ext_token` (survives restarts; `rotate` revokes it).
- Status: `state.extension = {paired, seenAt}`; every authorised `/ext/*` call records meta `ext_seen` (at most once a
  minute) and emits SSE `{type:'extension', extension, connected}` (`connected` = first contact, or first in 10 min).
  The header's 🧩 button shows not set up / waiting to pair / connected.
- Extension API `/ext/*`: header `X-NB-Capture: <token>` (never the page token); Origin absent or
  `chrome-extension://[a-p]{32}`; Host must be ours. `GET /ext/ping`, `GET /ext/accounts` (id, name, status,
  memberCount), `GET /ext/lookup?url&company&companyUrl` → `{id, isConnection, capturedAt, accounts:[{id,name,role}],
  suggested}`, `POST /ext/capture {profile: CapturePayload, accountId? | accountName?, role?, notes?}` →
  `{account, person, createdAccount, addedToAccount, isConnection, firstCapture, saved: {experience, education,
  sections, lists}}`; the server logs `saved` plus the extension's `detailsDiag` (statuses and sizes only). Account resolution: accountId → name
  or alias match → LinkedIn company URL / company name match → create. Notes append; re-capture refreshes the profile
  and keeps history. 401 = re-pair, 400 = bad capture (not retried by the extension).
- CapturePayload: `{url, fullName, headline, location, currentCompany, about, sections: {<anchor id>: {heading, items:
  [{lines, sub?, companyUrl?}]}}, rawText ≤ 60k, details?: {<kind>: {text ≤ 30k, items}}}`. `details` holds the
  person's full lists (`/in/<slug>/details/<kind>/` for experience, education, skills, certifications, languages,
  volunteering-experiences, honors), read when the panel opens: the background opens them in a minimized window and the
  content script in each tab answers `nb-read-list` once its text settles (LinkedIn won't render them in frames); the server prefers them
  over the profile page's summary (`detailLines` cuts to the list, `parseExperienceText` / `parseEducationText`) and
  keeps the cleaned text as `CapturedProfile.detailsText`. A page without its heading counts as empty. All interpretation is server-side (`parseCapture`): grouped
  roles, nested descriptions, employment type, dates/current, location, and a raw-text section fallback.
- UI: header switch People | Accounts (persisted in localStorage `nb.mode` / `nb.account`). Accounts view = account list
  + header fields + autosaving brief + buying committee & gaps + warm paths (＋ Add) + org chart (department columns →
  tier rows, cards with role, connection, ↳ manager) + person drawer (role, department, level, reports to, notes,
  captured profile, remove). Selection bar gains "Add to account ▾" (uses `scopeToShown`). Person detail shows
  "Accounts" chips. The "Chrome extension…" dialog shows the extension folder, the pairing code (copy) and Reset.

## v9 — Marketing org map

Phase 1 (data model only; no UI, no AI). Types in `src/accounts/types.ts` (v9 block), identity in
`src/accounts/identity.ts`, SQL in `src/db/accounts.ts`.

- Migration (array index 5, comment "7"; `SCHEMA_VERSION` 6): `contacts += kind ('full'|'light', default 'full'),
  sources_json (SourceRef[])`; `contact_aliases(alias_id PK, contact_id, url, added_at)`; `account_members += subfunction
  ('' = automatic), team, entity, country (ISO alpha-2 or ''), responsibilities, noise ('' auto | 'none' | NoiseFlag),
  sources_json, confidence REAL, reports_to_source ('' | user | inferred | web), reports_to_confidence REAL,
  reports_to_reason, inference_json (MemberInference, written by the Phase 2 job)`; existing non-empty `reports_to` →
  `reports_to_source = 'user'`. New tables, all `ON DELETE CASCADE` from `accounts`: `account_headcounts(id, account_id,
  taken_at, source linkedin-people|linkedin-search|web|user, scope company|function|query, label, count, url,
  evidence_url, quote, confidence, run_id)`, `account_list_runs(id uuid, account_id, page_kind people-tab|search, url,
  keywords, started_at, finished_at, rows_seen, named, anonymous, stop_reason end|cap|cancelled|checkpoint|rate-limit|
  login|stalled|error|counts-only|abandoned; migration 7 adds updated_at)`, `account_anon_rows(run_id → list_runs cascade, idx, headline, location; PK run+idx)`,
  `account_org_facts(id, account_id, kind team|entity|reporting|leadership|hiring|headcount|other, text, evidence_url
  (http(s), required), quote, confidence, found_at, run_id)`.
- Vocabulary: `SUBFUNCTIONS` (+ `SUBFUNCTION_LABELS`), `SENIORITIES` (+ `SENIORITY_TIER` → TIERS), `NOISE_FLAGS`,
  `SOURCE_KINDS`, `SourceRef {kind, at, url?, evidenceUrl?, quote?, runId?}` (deduped by kind + url + runId),
  `ReportsToSource`, `Confidence01` (0..1; stated in a source 0.9, same team + seniority gap 0.6, title only 0.3;
  `confidenceBadge`: high ≥ 0.75, medium ≥ 0.45, else low), `MemberInference`, `HeadcountSnapshot`, `ListRun`,
  `AnonRow`, `OrgFact`, `LightContactInput {fullName, url?, title?, headline?, company?, location?, source}`.
- `Contact += kind, sources` (a light contact has `captureCount` 0 and a minimal `CapturedProfile` with empty sections).
  `AccountMemberRow +=` the new columns (`inference?` parsed). `AccountMember +=` `kind ('full'|'light'|'connection')`,
  resolved `subfunction` (user → inference → `subfunctionFromTitle`, a stub returning 'other' until Phase 2),
  `autoSubfunction`, `seniority` (inference → `seniorityFromTitle`, coarse from the tier until Phase 2), `noise`
  (resolved; '' = clean, 'none' override → ''), `autoNoise` (false = set by hand, so `noise ''` + `autoNoise false` =
  the user said "not noise"), `team/entity/country/responsibilities` (user → inference), `sources`,
  `confidence`, `reportsToSource`, `reportsToConfidence`, `reportsToReason`, `inference?`.
- Identity (`identity.ts`, pure): `profileRef(url) → {canonical, url, id, slug, kind: vanity|urn} | null` (URN = slug
  `/^ACo[A-Za-z0-9_-]{8,}$/`, case-sensitive; `url` keeps a URN's case for navigation, `id = personId(lower-cased
  canonical)`); `normalizePersonName` (pronouns, emoji, punctuation, `Dr./Prof./MBA/PhD` dropped; ß→ss, accents
  stripped, ae/oe/ue → a/o/u; lower-case) + `sameName`; `titlesCompatible` (either blank, or ≥ 50% token overlap of
  the shorter title after stopwords); `profileUrlsConflict` (both vanity or both URN, different ids → different people).
- Repo: `resolveId` follows `contact_aliases` (used by `getContact`, `contacts`, `knownPerson`, `addMembers`,
  `idForProfileUrl` after the people lookup). `upsertLightContacts(accountId, inputs)` (one tx) → `{added, updated,
  merged, skipped: [{input, reason}], warnings: [{id, reason}]}`: (1) known URL (alias/connection) → that person, or
  for a no-URL row the same name-only id; (2) else exactly one member of the account with `sameName` +
  `titlesCompatible` and no URL conflict → reuse it (`merged`; a new URL becomes an alias); several → a new contact
  plus a `possible duplicate` warning; (3) else a new `light` contact (`id = profileRef.id`, or `personId('', name,
  accountId)` without a URL; title/company from `splitHeadline`). Existing contacts only get blanks filled; a
  connection matched by URL is filed as-is (no contact row). `added` = new on this account, `updated` = already there
  by URL/id. `saveContact(profile, source?)` sets `kind = 'full'` and merges sources. `mergeContacts(lightId, intoId)`
  (only from a light contact) → `{warnings}`: memberships move (both on an account → `into`'s non-empty values win;
  reporting line: `into`'s when its source is `user` (even if cleared), else a `user` line on the light row, else
  whichever has one; sources unioned), `reports_to` pointers follow, self-lines cleared, a loop is broken at a non-user
  edge (if every edge is the user's, the first is cleared and a warning returned), aliases written, light row deleted.
  `ingestCapture` folds exactly one same-name light member (no URL conflict, `titlesCompatible` titles) into the
  capture and records `SourceRef{kind:'extension-profile'}` on contact and member; same-name rows with conflicting
  titles (or several matches) are not merged and come back in `CaptureResult.warnings`.
- Reporting provenance: any `reportsTo` set via `updateMember`/`addMembers` (incl. clearing it) → `reports_to_source =
  'user'`, confidence 1, reason ''. `reportsToSource: 'auto'` (not combinable with `reportsTo`) hands it back to
  automatic: clears the line, source, confidence and reason. `updateMember` resolves aliases for the member id and
  `reportsTo`, so a merged light id still works. `confirmReportsTo` flips inferred|web → user. `applyInferredReportsTo(accountId, id,
  managerId, conf, reason, 'inferred'|'web')` → false when the line is the user's; same-account / self / cycle checks
  as manual edits. `removeMember` clears lines (and their provenance) that pointed at the removed person.
- Repo extras: `addHeadcount/headcounts`, `startListRun/updateListRun/getListRun/listRuns`, `addAnonRows` (idempotent by
  run+idx, returns new rows) / `anonRows`, `addOrgFacts` (skips exact kind+text+evidence_url duplicates) / `orgFacts`,
  `aliasesOf`, `addMemberSources`.
- Member validation (`MemberPatch`): `subfunction` ∈ SUBFUNCTIONS or '', `team` ≤ 120, `entity` ≤ 200, `country`
  two letters (upper-cased) or '', `responsibilities` ≤ 1000, `noise` '' | 'none' | NoiseFlag.
- `AccountSummary.captured` now counts only members with a full captured profile; new `light` counts members known
  only from a list row / added by hand.
- Page API (session token): `PUT /api/accounts/:id/members/:pid` also accepts `subfunction, team, entity, country,
  responsibilities, noise` (strings), `reportsToSource: 'auto'` (reset to automatic; anything else 400) and
  `confirmReportsTo: true` (400 when there is no line). New `POST
  /api/accounts/:id/contacts {contacts: LightContactInput-ish[] (1–500; fullName required ≤ 200; url, title, headline,
  company, location optional strings, length-capped), role?}` → `{added, updated, merged, skipped, warnings, view,
  accounts}`; the source is forced to `{kind:'manual'}`; `role` applies to newly added members only. 400 on bad input,
  404 unknown account, 401 without token. Light contacts live only in `contacts` — never in `people`, lenses, the
  People view, network search or exports.

### v9 Phase 2 — classifier fixes + Haiku org inference

- `src/accounts/classify.ts` (deterministic, EN + DE): department rules now put HR / employer-branding marketing
  ("HR Marketing", "Employer Branding", "Personalmarketing") → `people`, and marketing hybrids ("Partner Marketing",
  "Marketing Technology Lead", "Demand Generation", "Event Manager", DE `Marketing / Kommunikation /
  Unternehmenskommunikation / Pressesprecher(in) / Produktmarketing / Markenführung / Veranstaltung / Kampagnen`) →
  `marketing`, before IT / data / engineering / sales; "Geschäftsführer(in)" → `executive`. "Growth Engineer" stays
  engineering. "Partner Marketing Manager" / "Product Owner" are no longer read as firm partners / owners.
  `tierFromTitle` adds DE words: Geschäftsführer(in)/Vorstand → exec; Leiter(in)/Leitung/Abteilungs-/Bereichsleiter →
  director; Teamleiter(in)/Gruppenleiter(in)/Teamlead → manager; Referent(in)/Spezialist(in)/Sachbearbeiter(in),
  Werkstudent(in)/Praktikant(in)/Trainee/Azubi/Intern and "Junior …" → ic.
  New: `seniorityFromTitle` (fine ladder: svp vs vp, senior-director vs director vs head, senior-manager vs manager vs
  lead, senior-ic, junior, intern; Bereichsleiter → senior-director, Leiter(in) → director, Teamleiter(in) → manager;
  always consistent with `SENIORITY_TIER[tierFromTitle]`), `subfunctionFromTitle` ('other' for non-marketing titles;
  CMO and senior generic marketing heads → `leadership`), `noiseFromTitle(title)` → `hr-marketing`,
  `sales-hybrid` ("Sales & Marketing", "Marketing und Vertrieb") or '' (vendor-funded moved to a tag in Phase 2b).
  Also: "Telekommunikation" is not comms (`(?<!tele)kommunikation`); bare "event(s)" no longer makes a title marketing
  (only "Event Manager", "Event Marketing", "Eventmanager(in)"); "Presse-", "Öffentlichkeitsarbeit" → comms-pr;
  "manager(in)" matches inside DE compounds ("Kommunikationsmanagerin" → manager); "Assistant to the CMO" / "Assistenz
  der Geschäftsführung" are not exec; "lead" in "lead generation / lead gen / lead management …" is not a seniority word. `not-marketing` / `stale` come only from the AI or the user.
- View: `AccountMember.noise` = user override → inference (even '' = clean) → rules (see Phase 2b).
- `src/llm/org-infer.ts` (Haiku, `claude -p` with `tools: []` → `--strict-mcp-config --tools ''`; never MCP):
  `buildOrgClassifyPrompt(account, batch)` (people as `p0..pN`, **no names**: title, headline, location, company,
  entity hint, ≤ 600 chars of about + current role description) → per id `{subfunction, seniority, noise, team, entity,
  country, responsibilities (≤ 240, only from the given text), confidence, reason}` (`ORG_CLASSIFY_SCHEMA`);
  `buildOrgReportingPrompt(account, roster, todo)` over ≤ 400 rows (most senior kept; `{id, title, seniority,
  subfunction, entity?, country?, location?, reportsTo?}` where `reportsTo` marks a confirmed user/web line) → `{edges:
  [{id, managerId|null, confidence, reason}]}` (`ORG_REPORTING_SCHEMA`). `normalizeInference` (bad enums → other /
  unknown / '', country two letters or '', confidence clamped). `suggestManagersRuleBased(members, targets?)` (pure):
  most senior in the same (entity, sub-function) 0.6 (0.5 if one step apart) → most senior marketing person in the
  entity 0.45 → overall head 0.3; the manager is always strictly more senior. `cleanEdges` drops unknown ids, self
  lines, people not asked for, and loops (against confirmed lines; the more confident edge wins).
  `runOrgInference({account, members, ids?, model='haiku', batchSize=40, concurrency=2, signal, costs, onProgress})` →
  `{classified: Map<id, MemberInference>, edges: OrgEdge[] ({id, managerId|null, confidence, reason, source:
  'llm'|'rules'}), costUsd (incl. failed attempts), costIncomplete, failedBatches, reportingFallback}`; missing ids are
  retried once; a failed batch leaves those people's earlier inference; a failed reporting call (and people beyond the
  400-row roster) fall back to the rules. People with a noise flag (the user's, else this run's inference, else the
  title rule) are left out of the reporting step entirely: no manager, and nobody reports to them. The prompt prefers a
  manager in the same entity, then the same sub-function, then the same country, then the head of marketing.
  `onProgress` counts people throughout (classify: people done; reporting: 0 then all). Abort → AbortError carrying the
  spend so far. `ORG_INFER_USD_PER_100 = 0.06`, `ORG_INFER_MIN_USD = 0.005` (per run), `estimateOrgInferUsd(n) =
  max(0.005, n/100 × 0.06)` (0 for n = 0).
- Repo: `applyInference(accountId, [id, MemberInference][])` writes `inference_json` only → count.
  `replaceInferredReportsTo(accountId, ids, edges)` (one tx) clears those people's `inferred` lines, then applies edges
  as `inferred` via `applyInferredReportsTo`; `user` and `web` lines are never touched; invalid edges are skipped →
  `{applied, skipped}`.
- Costs: `CostStage += 'org'`; `ExplorerCosts.org?` (in `total`); `DbStats.spend.org`.
  `ExplorerState.estimates.orgInferUsdPer100`.
- Queue: `JobQueueState.orgJob?: {accountId, kind: 'infer'|'research', phase ('classify'|'reporting' for infer), done,
  total (people, start to finish), pausedUntil?, pausedManual?} | null` (SSE `queue` events while it runs).
- Page API (session token; paid — only ever started by these POSTs, nothing auto-runs, nothing in MCP):
  `POST /api/accounts/:id/org/infer {ids?: string[]}` (default: every member; ids must be on the account, aliases
  resolved) → `{started, estimateUsd, queue}`; one org job at a time (409); 404 unknown account; 400 bad / foreign ids or
  an empty account. On finish: inference stored, suggested lines replaced, cost added to the ledger as `org`, `accounts`
  event with notice "Classified N people; M reporting lines suggested". Errors → `notice` (error); spend still recorded.
  `POST /api/accounts/:id/org/cancel {}` → `{cancelled, queue}` (aborts this account's running job; its results are
  discarded, the spend is recorded). Server option `orgInferFn` (tests), `orgModel` (default haiku).

### v9 Phase 2b — vendor-funded is a tag; `other-employer` noise

User decision (2026-11-23): only people who work for the account (or one of its entities) are in the org; among them,
vendor-funded roles are part of the org.
- Vocabulary: `NOISE_FLAGS += 'other-employer'` (appended; `vendor-funded` stays in the list so stored values and
  `PUT …/members/:pid {noise: 'vendor-funded'}` remain valid). `OrgNoise = Exclude<NoiseFlag, 'vendor-funded'>`,
  `ORG_NOISE_FLAGS` = the flags that exclude someone from the org. `MemberInference.vendorFunded?: boolean`.
- `classify.ts`: `vendorFundedFromTitle(title, company?)` → boolean (the old vendor-funded patterns: an explicit
  "funded by / sponsored by / vendor-funded" phrase, or "… marketing … for|@|– <Vendor> Inc|Corp|GmbH|…" when a company
  is known and is not that vendor). `isOtherEmployer(company, account, entities?, companyUrl?, companyPages?)` → true only when the
  current company is CLEARLY not the account. Names compared (`employerNames`, as `companyCore` = normalised, legal and
  generic words such as group / gruppe / holding / international / global / se / ag / gmbh dropped): the account name,
  aliases, domain stem, LinkedIn slug, the entities the user set on members, and every LinkedIn company page already
  captured onto the account (`accountCompanyPages`: people-tab list-walk URLs). `sameEmployer` matches when equal
  ignoring spaces, a 2-letter name is the whole first word ("HP" ~ "HP Deutschland GmbH"), a ≥ 3-char name appears as
  whole words of the other, or the two share a prefix of ≥ 5 chars ("LedgerlyPay", slug "ledgerlyag"); the company
  text and its `/company/` slug are both tried. A `companyUrl` equal to the account's page or a captured page counts as
  the account. A blank or vague company ("Self-employed …", "Freelance …", "Selbstständig/Selbständig",
  "Confidential", …) or an account with nothing to compare is never other-employer.
- View (`resolveOrgPlacement`, used by `buildAccountView`): `AccountMember.noise: OrgNoise | ''` (never
  `vendor-funded`) = user override ('none' → '') → inference (even '' = clean) → `other-employer` if `isOtherEmployer`,
  else `noiseFromTitle`. The other-employer rule only looks at the company of a captured **full** profile's current
  experience entry (+ its `companyUrl`): never a company guessed from a headline, a list-walk row, a light contact or a
  connection's headline profile (being in the company's own list is stronger evidence). New
  `AccountMember.vendorFunded: boolean` (tag) = user override `vendor-funded` → inference (`vendorFunded`, or a pre-2b
  `noise: 'vendor-funded'`) → `vendorFundedFromTitle(title, display company)`; false whenever the resolved noise is not
  ''. Tagged people stay in `members` and every headcount; their `subfunction` = the user's, else `partner-marketing`.
  **Stored `noise = 'vendor-funded'`** are kept as stored, no migration. A hand-set one always reads as noise '' + the
  tag + `partner-marketing` (`autoNoise false`) — user intent wins over the heuristic, whatever the company. An older
  `inference_json` holding it reads the same way, except when the captured current employer is clearly another
  company (then `other-employer`). Setting `noise` to '' resets a member to automatic.
- Org inference: the classify prompt lists the account's known entities, asks for `noise` ∈ '' | `ORG_NOISE_FLAGS`
  (other-employer = current company clearly not this company or its entities; blank/vague company is not) and a new
  `vendorFunded` boolean (works here, role funded by / dedicated to a vendor → in the org, noise '',
  partner-marketing). `ORG_CLASSIFY_SCHEMA` requires `vendorFunded`; its `noise` enum has no `vendor-funded`.
  `normalizeInference` reads a model's `noise: 'vendor-funded'` as the tag, forces `partner-marketing` when tagged, and
  never tags someone with a noise flag. The reporting step skips noise-flagged people (incl. other-employer); tagged
  people are in the roster and get managers. The server passes `account.entities` = the members' user-set entities plus the captured company pages.

### v9 Phase 3 — extension list walk + `POST /ext/capture-list`

- Extension 0.3.0 (no new permissions; `content_scripts.js = [list-reader.js, content.js]`). On
  `/company/<slug>/people/` and `/search/results/people/` a floating **⇣ Map to Network Builder** button opens a panel
  (account picker preselected by `linkedinUrl`, cap 300 default / 500 max, keywords from the URL, a ToS warning).
  Only a trusted click on **Start mapping** starts a walk (`startWalk` has exactly one call site; a `starting` flag set
  before the first await blocks double starts). The walk runs in the
  visible tab only: pauses while `document.hidden`; 2.5 s + 0–1.5 s jitter between loads, +1.5 s per load that brought
  nothing (≤ 8 s), 4 such loads in a row → `end` (or `stalled` if LinkedIn still shows Show more / Next); search pages
  via the visible Next button, one per 4–7 s. Stops at the cap, on Cancel / closing the panel / leaving the page /
  a change of the URL's search params other than `page` (new search, keywords or filters) (`cancelled`), and before every step on a checkpoint / captcha / sign-in / "unusual activity" / limit page
  (`checkpoint`, `login`, `rate-limit`) or zero results (`end`). Daily cap 1,000 rows per local date in
  `chrome.storage.local` `nb.listRows.<yyyy-mm-dd>`. No `chrome.windows` / `chrome.tabs` for lists; no queue (a failed
  post pauses the walk with Retry).
- `extension/list-reader.js` (pure DOM, `globalThis.NBList`; tested with happy-dom): `pageKind`, `companySlug`,
  `keywordsOf`, `resultCards` (known LinkedIn selectors, else outermost `main li` / `[role=listitem]` with exactly one
  `/in/` link or a "LinkedIn Member" first line), `readCard → {lines, href}` (visible text only: skips visually-hidden / `[hidden]` /
  inline `display:none` / buttons / inputs / media; first `/in/<slug>` link, query stripped), `headerText`,
  `facetsText` ("What they do" module), `stopReason` (URL, captcha iframes, then the visible text — hidden parts and
  `code`/`script`/`style` skipped, no truncation — of banner / toast / dialog / alert / `aria-live` containers and of
  `main` minus the result cards, so a headline can't stop a walk and a late banner can't be missed; the walk scans at
  most once a second and on every URL change), `noResults`, `loadMoreButton` (label must say "more results" /
  "weitere Ergebnisse anzeigen", never an insight module's "Show more"), `nextButton`.
- `src/accounts/list-capture.ts` (pure): `parseListCard({lines, href}) → {fullName, url, headline, title, company,
  location, degree, anonymous}` (degree / mutual-connection / button / "View …'s profile" lines dropped, pronouns
  stripped from the name, "at|@|bei" split, URN case kept; company = a `Current:`/`Aktuell:` line → the headline → the
  account's name when `pageUrl` filters on `currentCompany` (opts `{pageUrl, accountName}`); a `Past:`/`Früher:` line is
  never used; `cleanCompany` cuts at " - ", " | ", " · ", ", ", " @", " (" and emoji and drops text truncated with "..."
  (the cut-off part is returned as `hint`, not stored); anonymous = no `/in/`
  link or named "LinkedIn Member" → name and URL blanked); `parsePeopleHeader(text) → number | null` (EN/DE "associated
  members|members|results|employees|Mitglieder|Ergebnisse…", separators `,` `.` space NBSP narrow-NBSP, `K`/`M`);
  `parseFunctionFacets(text) → {label, count}[]` (only the "What they do" block; "412 Marketing", "Marketing 412",
  "Marketing (412)" or alternating lines; ≤ 50, unique labels).
- `GET /ext/accounts` items gain `linkedinUrl`.
- `POST /ext/capture-list` (capture token + extension origin, unchanged model) body `{runId (UUID, chosen by the
  extension), accountId? | accountName?, page: {kind: 'people-tab'|'search', url (https linkedin.com), keywords?,
  companyUrl?}, rows: [{idx (0…99,999, position in the walk), lines: string[] (≤ 40 × ≤ 1,000 chars), href?}] (≤ 100,
  may be empty), header? (≤ 2,000), facets? (≤ 20,000), final?: boolean, stopReason?: ListStopReason}` →
  `{account: {id, name}, createdAccount, run: ListRun, added, updated, merged, skipped, anonymous (new anonymous rows),
  totalRows}`. Rules: an existing run keeps its account (other `accountId` → 409) and a finished run refuses posts
  (409); a new run resolves accountId (404 if gone) → name/alias → company URL match → creates the named account
  (with that LinkedIn page) → else 400. A run holds ≤ 1,000 rows (`rowsSeen` ≥ 1,000 → 409; rows with idx ≥ 1,000
  are dropped). Named rows → `upsertLightContacts` with `SourceRef{kind:'extension-list', url: run.url, runId}`;
  anonymous rows → `addAnonRows` (idempotent by idx). `header` → one headcount row (`source` linkedin-people |
  linkedin-search, `scope` company only for a People tab URL with no result-set filters, else query; `label` = the
  keywords when they are the only filter, else `name: value · …` of the filters ('' for an unfiltered search). Filters
  = the allow-list `LIST_FILTER_PARAMS` (`listFilters(url)`: keywords, currentCompany, pastCompany, company, geoUrn,
  network, title, industry, schoolFilter, profileLanguage, serviceCategory, firstName, lastName, facet* …); page,
  origin, spellCorrectionEnabled, prioritizeMessage and other UI flags are ignored. The extension's "search changed"
  guard (`NBList.filterKey`) compares the same allow-list, so paging never ends a run;
  quote = header text, confidence 0.9); `facets` (People tab only) → `scope:'function'` rows; both replace this run's
  earlier rows of that scope (`replaceRunHeadcounts`), but a header or facets text that parses to nothing (e.g. on a
  final post from a changed page) leaves them as they are. The run's `rowsSeen` = max idx + 1, `named` = distinct account members whose sources carry
  the run id, `anonymous` = its anonymous rows; `final` sets `finishedAt` and `stopReason` (default `end`) and emits
  `accounts` with notice "Mapped N people + M anonymous from a LinkedIn list to <account> (stopped: <reason>)"; other
  batches emit `accounts` without a notice. Re-posting a batch adds nothing.
- Repo: `startListRun(…, {id?})` (UUID; duplicate → error), `runMemberCount(accountId, runId)`, `anonCount(runId)`,
  `replaceRunHeadcounts(accountId, runId, scopes, rows)` (one tx). Server constants `LIST_ROWS_PER_REQUEST = 100`,
  `LIST_ROWS_PER_RUN = 1000`.

### v9 Phase 4 — web org research (`claude -p` + WebSearch/WebFetch)

- `src/llm/org-research.ts`. Passes (`ORG_RESEARCH_PASS_IDS`, always run in this order, sequentially):
  `seed` (Company site — leadership/management pages per country site, about/locations, imprint/legal entities,
  marketing & comms contacts; **sonnet**, ≤ 8 searches / 6 fetches), `press` (newsroom, press contacts, appointments),
  `jobs` (careers + job ads: team names, "reports to / berichtet an", hiring entity + location, team size), `events`
  (speaker pages, podcasts, awards, agency case studies), `headcount` (employee counts, annual report, team-size
  statements) — the last four **haiku**, ≤ 4–5 searches / 2–3 fetches. Each pass has `minSearches` (seed 5, press /
  jobs / events 3, headcount 2): the prompt asks for that many DISTINCT searches unless results are clearly exhausted.
  Seed and press carry a checklist of the leadership layer below the C-level (Head of / Leiter(in) Marketing, Brand,
  Communications / PR, Digital / E-Commerce, CRM, Product / Trade Marketing, country leads) to search for before stopping. Every pass calls `runClaude` with `tools:
  ['WebSearch','WebFetch']` (→ `--strict-mcp-config --allowedTools WebSearch WebFetch --tools WebSearch,WebFetch`, no MCP,
  never `--bare`), `retries: 1`, schema `ORG_RESEARCH_SCHEMA`.
- `buildOrgResearchPrompt(account, pass, known, today)`: name, aliases, domain, the LinkedIn company URL as context only,
  known entities / countries, people already on the account (≤ 80, marketing + most senior first: "confirm, don't
  repeat"), the pass focus and budget. Rules: never search or cite linkedin.com; `site:` is ignored (put the domain /
  company in the query as words); German-speaking accounts (`isDach`: .de/.at/.ch domain, a DACH legal form in
  name/aliases/entities, DE/AT/CH countries, DACH places in member locations) also search in German ("Leitung
  Marketing", "Unternehmenskommunikation", "Pressekontakt", "Stellenanzeige … berichtet an", "Impressum
  Geschäftsführer"); record legal entity + ISO country per person/fact (group marketing may sit in a service entity);
  current people only; never invent URLs/names/numbers; when the company's own site confirms a person first seen in a
  third-party article, cite the company's page.
- Output (`ORG_RESEARCH_SCHEMA`): `{people: [{name, title, entity, country, subfunction ('' | SUBFUNCTIONS), evidenceUrl,
  quote, date}], facts: [{kind (ORG_FACT_KINDS), text, entity, country, subject, manager, evidenceUrl, quote,
  confidence}], headcounts: [{label, scope: 'company'|'function', count, evidenceUrl, quote}], searchesRun, rateLimited}`.
- **Evidence rule** (`normalizeOrgResearch`): an item is dropped unless `evidenceUrl` is http(s), ≤ 2,000 chars and not on
  linkedin.com / *.linkedin.com / lnkd.in, and `quote` is non-empty (clipped to 300). People also need a plausible
  personal name (≥ 2 words, no digits/@/URL; honorifics stripped repeatedly — "Frau Dr. Prof. X" → "X"; rejected when a
  WHOLE word is a team / mailbox word such as team, press(e), Pressestelle, Pressebüro, marketing, Marketingteam, office,
  kontakt, contact, Redaktion, Abteilung, (Unternehmens)kommunikation, communications, info, newsroom, media — so
  surnames like "Presser" or "Teamann" stay); duplicate names in one answer are kept once, preferring evidence on the
  account's domain (`normalizeOrgResearch(raw, domain)`). Bad enums → '' (sub-function) / 'other' (fact kind); country two letters upper-case
  or ''; fact confidence clamped to 0–0.9 (default 0.5); `subject`/`manager` only on `reporting` facts; headcounts need
  a whole count 1–10,000,000. `dropped` counts discarded items.
- `runOrgResearchPass({account, pass, known, model?, signal?, timeoutMs?, today?})` → `{pass, status: 'ok' |
  'rate_limited' | 'error', data?, error?, model, costUsd (incl. failed attempts), costIncomplete?, durationMs}`. Never
  rejects except AbortError (carries spend). Rate-limited = CLI error text matching `CLI_RATE_LIMIT_RE` (now exported
  from dossier.ts), or the model set `rateLimited` and returned nothing (or ran no searches).
- `webPersonConfidence(person, account, pass, today)`: 0.9 when the evidence is on the account's own domain or a
  subdomain (`isOwnDomain`); 0.6 from the press pass; 0.4 for other third-party pages and for sources dated > 24
  months ago. Member confidence only goes up, so an own-site confirmation lifts a person first found in an article.
- Estimates (calibrated on a live run: seed $0.135, Haiku press $0.078): per pass `ORG_RESEARCH_PASSES[p].usd` (seed
  $0.10–0.60, others $0.05–0.20 each); `ORG_RESEARCH_USD_ESTIMATE = {min: 0.3, max: 1.4}` = all five; `estimateOrgResearchUsd(passes)`.
  `ExplorerState.estimates.orgResearchUsd` and `.orgResearchPassUsd` (by pass id).
- Repo: `applyWebFindings(accountId, id, {entity?, country?, subfunction?, confidence?, at?})` → false if not a member.
  Fills only **blank** `entity` / `country` / `subfunction` of the stored inference (`model: 'web'` when it creates one);
  user columns are never written (they win at view time anyway); member `confidence` only goes up. Note: a later org
  inference run replaces `inference_json`, but its prompt sees the resolved entity as a hint.
- Page API (session token; paid — only these POSTs start it; nothing in MCP):
  `POST /api/accounts/:id/org/research {passes?: PassId[]}` (default all; unknown / empty / non-array → 400; sorted to
  the canonical order, deduped) → `{started: n, passes, estimate: {min, max}, queue}`; 404 unknown account; 409 while any
  org job (infer or research) runs. `orgJob = {accountId, kind: 'research', phase: <pass id>, done: passes finished,
  total: passes, pausedUntil, pausedManual}`. The seed pass runs on `researchModel`, the rest on `orgModel` (haiku).
  Each pass gets a fresh `known` (so later passes see earlier findings). Spend → ledger stage `org` after every call
  (`markIncomplete` when unknown).
  - Rate-limited pass: wait `backoffMs` (default 1m, 2m, 5m, 10m; `pausedUntil` set, `notice` warn) and retry the **same**
    pass; after the schedule is used up `pausedManual: true` + notice "… Click Resume …" and the job waits.
    `POST /api/accounts/:id/org/resume {}` → `{resumed, queue}` ends the wait (manual or timed) and resets the backoff;
    `resumed: false` when this account's research job isn't waiting. Any Resume (timed or manual wait) and any
    successful pass reset the backoff to its first step.
  - Failed pass (`error`) → notice error, the job continues with the next pass.
  - Results are written **after each pass** (an `accounts` event without notice): people →
    `upsertLightContacts([{fullName, title, company: entity || account name, source: {kind:'web', at, url: evidenceUrl,
    evidenceUrl, quote}}], {matchNameOnly: true})` (no LinkedIn URL; when exactly ONE member of the account has that
    name it is the person whatever the titles say; several same-name members → a new contact + a "possible duplicate"
    warning, listed in the done notice; re-runs add nothing; web sources dedupe by evidence URL) then `applyWebFindings` with `webPersonConfidence`; facts → `addOrgFacts` (entity /
    country appended to the text as "(entity, CC)" when not already in it; `runId` = `web-<hex>` per job; exact
    duplicates skipped); headcounts → `addHeadcount({source:'web', scope, label, count, url = evidenceUrl, evidenceUrl,
    quote, confidence: 0.9 on the account's own domain else 0.6})`, skipped when a web headcount with the same label +
    count + evidence URL exists; `reporting` facts whose `subject` and `manager` each match exactly one member by name
    and fact confidence ≥ `ORG_RESEARCH_MIN_EDGE_CONFIDENCE` (0.6) → `applyInferredReportsTo(…, min(confidence, 0.9),
    'web: “quote” url', 'web')` — never over a `user` line (it returns false), loops
    rejected. A bad item is skipped, never the pass.
  - Done → `accounts` event with notice "Web research done — N new people; M confirmed; F facts; H headcounts; E
    reporting lines; D items without evidence dropped; possible duplicates to check: names…; failed: …". `POST …/org/cancel` aborts the running call or wait:
    notice "Web research cancelled — findings from finished passes are kept." (they are). Deleting the account mid-run
    stops the job quietly. Server option `orgResearchFn` (tests).
- `titlesCompatible` (identity.ts) now canonicalises title phrases before comparing: chief … officer ↔ CEO / CMO / CCO /
  CDO / CRO / COO / CFO / CTO, vice president ↔ VP (SVP, EVP), public relations ↔ PR, managing director /
  Geschäftsführer(in) ↔ MD, Leiter(in) / Leitung ↔ head, (Unternehmens)kommunikation ↔ (corporate) communications,
  Marke ↔ brand.

### v9 Phase 5 — marketing org map (`src/accounts/org.ts`) + "Marketing org" view

- `buildOrgMap(view: AccountView, src: OrgMapSources) → OrgMap` (pure; `orgMapSources(repo, accountId)` loads
  `{headcounts, runs (newest first), facts}`; MCP reuses both in Phase 6). Types (`OrgMap`, `OrgNode`) in
  `src/accounts/types.ts`.
  - **Scope**: a member is in scope when the user set department `marketing`; else (automatic department) when it is
    `marketing`, or one of their sources is `web` or an `extension-list` run that `isMarketingRun` (keywords / URL
    filters match marketing, communication, Kommunikation, PR, Presse, brand, Marke, Werbung, advertising, campaign,
    Kampagne). A department set by hand to anything else is out. In scope + a noise flag → `flagged: [{id, noise}]`
    (never `vendor-funded`: tagged people stay in `members` and every count); the rest → `members` (sorted most senior
    first).
  - **Tree**: each org member hangs under `reportsTo`; a manager outside the org (e.g. the CEO, or a flagged person)
    becomes a `context: true` node and its own chain is followed up. `edge = {source (reportsToSource, '' → 'user'),
    confidence, reason}`. `roots` = nodes with reports and no manager; children sorted by seniority then name.
  - **unplaced**: org members with no manager in the tree and no reports, grouped `{subfunction, entity, ids}`
    (SUBFUNCTIONS order, blank entity last).
  - **headcount**: `captured {total, named, light, full, connections, vendorFunded, bySubfunction, bySeniority}` over
    `members`; `linkedin {company?, marketing?, functions, queries}`: company / function counts are `HeadcountTotal
    {label, count, takenAt, pages}` = the latest snapshot of each distinct page (`snapshotPage`: `company/<slug>`,
    else host + path) for that label, summed over pages (entity pages add up; re-reading a page replaces it); queries
    are the latest snapshot per source + page + label — never summed. `queries` are search / filtered-list result
    counts (query-scoped, not the org). `marketing` = the "What they do" label `Marketing` (else one containing it).
    `anonymous` = sum over distinct lists (`runListKey`: page kind + host/path + `listFilters`, so paging / UI flags
    don't make a new list) of the latest run's anonymous count. `web` = latest web snapshot per scope + label.
    `coverage = members / marketing.count` (`coverageBasis 'function'`), else `/ latest marketing-query count`
    (`'query'`), else absent; above 1 it is capped at 1 with `coverageOver: true` (the page shows "100%+").
  - `entities [{entity, country, n}]` (org members with either set), `facts` (most confident first), `runs` (≤ 10).
- Server: every page-facing AccountView (`GET /api/accounts/:id` and the `view` in all account write responses) now
  carries `org: OrgMap`. SSE `accounts` events carry `costs`; the `queue` event sent when an org job ends carries
  `costs` (so the spend chip catches failed / cancelled runs). No new endpoints.
- Page (`explorer.html`, live mode only — snapshot shows no accounts): the org card has a switch **All departments |
  Marketing org** (localStorage `nb.orgView`; "All departments" unchanged). Marketing org view, rendered only from
  `view.org` (filters hide; the tree is never rebuilt client-side):
  1. Actions: "✦ Classify & suggest reporting lines (≈ $X)" (X = max(0.005, members/100 × `orgInferUsdPer100`)) and
     "🌐 Research on the web (≈ $min–max)" — each opens a confirm dialog with the estimate, then POSTs `…/org/infer` /
     `…/org/research`; disabled while any `queue.orgJob` runs. Progress line from `queue.orgJob` (classify n/total,
     reporting; research pass label (i/total)), "paused until …" / paused (rate limit) with **Resume now** (`…/org/resume`)
     and **Cancel** (`…/org/cancel`); the header shows the same job chip (Resume when `pausedManual`). "Load from
     LinkedIn ↗" opens the unfiltered `<linkedinUrl>/people/` in a new tab (Phase 6; hint: Capture headcount only there, then search "marketing" and walk the results) (the walk is started there, from the
     extension's button — never from this page). The spend chip lists `org`.
  2. Headcount strip: LinkedIn "What they do → Marketing", query counts (labelled list / search, query-scoped), captured
     (full / light / connections / vendor-funded), anonymous, flagged, web hints, coverage — each with a date, source
     link and tooltip.
  3. Sub-function × seniority table with inline bars (click a cell or row total = filter; click again = clear).
  4. Filters (memory only): sub-function chips, seniority, entity/country (+ "No entity known"), source kind, minimum
     confidence (member confidence and suggested-line confidence; unassessed passes), text search. Non-matching managers
     of matching people stay visible, dimmed. No bulk actions in this view (nothing acts on hidden people).
  5. Tree: indented, collapsible; cards show name, title, sub-function, seniority, entity · country, vendor-funded tag,
     role, connection, `light ↗` (open on LinkedIn to capture the full profile), confidence badge, source icons.
     `inferred` / `web` edges are dashed with a confidence badge + reason and **✓ Confirm** (`{confirmReportsTo:true}`),
     **Change…** (`{reportsTo}`; "— no manager (set by you)" = `''`), **↺** (`{reportsToSource:'auto'}`); errors (e.g. a
     reporting loop) show inline on the card. "No known manager" groups by sub-function → entity with **Set manager…**
     and **✕ Not marketing** (`{noise:'not-marketing'}`). Flagged group collapsed at the bottom with **In the org**
     (`{noise:'none'}`) and **↺ Automatic** (`{noise:''}`) for hand-set flags.
  6. Web structure facts (kind, text, confidence, evidence link with quote tooltip) and the last LinkedIn list walks.
- Drawer: reporting-line provenance under "Reports to" (set by you / suggested by AI / from web research, confidence,
  reason, ✓ Confirm, ↺ Reset to automatic) and a "Marketing org" section: sub-function (auto shown as "Auto: …"),
  seniority (read-only), "In the org?" (auto / not noise / vendor-funded tag / each excluding flag), team, country,
  legal entity, responsibilities, member confidence + AI reason, and the sources list (kind, date, evidence link,
  quote).

#### Phase 5 review fixes

- Scope: `isMarketingRun` also matches LinkedIn's Marketing function filter (`facetCurrentFunction` / `functionFacet`
  containing id `15`); `brand` only as a word or marketing compound (not "Brandschutz", "Brandenburg").
- Page performance: member lookups go through a Map (rebuilt per view); the per-card manager pickers are filled only
  on focus / mousedown / keydown (one cached sorted list per view); descendant counts are cached.
- Confidence filter: "High only (assessed)" hides people with no confidence; "Medium or better" shows them; the filter
  row shows "not assessed: N (hidden|shown)".
- Classifier: support clauses ("Assistant / Executive Assistant to …", "Assistenz der GF", "Referent(in) der / für die
  Geschäftsführung", "Office Manager(in) der …") are dropped when the title names its own role ("Marketing Managerin &
  Referentin der Geschäftsführung" → marketing / manager); alone they are ICs. Vendor-funded also when the title ENDS
  with another company + legal suffix ("Portfolio Marketing Manager Globex Inc."); a member with no company is
  compared against the account name (they are on its list).
- List rows: `cleanPersonName` strips pronouns, emoji and trailing LinkedIn badges ("is hiring", "stellt (gerade)
  ein", "Premium", "Verified/Verifiziert", "Open to work", "• 2nd/3rd+") from names.
- `upsertLightContacts`: a `light` contact seen again in an `extension-list` row takes the newest non-empty name /
  title / headline / company / location (contact row + its minimal profile). Full captures, connections, member
  fields and web / manual rows are untouched (blanks only, as before).
- Org inference: `ORG_MIN_EDGE_CONFIDENCE = 0.45` — weaker suggestions are not stored as lines (also enforced by the
  server); they stay in `MemberInference.possibleManager {id, confidence, reason}` and the drawer shows "possible
  manager: X (low)" with a button to set it. The reporting prompt says regional / entity / country leads manage only
  their own region / entity / country and that people stay unplaced when their real head isn't captured. Rules:
  entity-based suggestions need a known entity, and no rule suggests a manager in another known country.
- Extension 0.3.1: People tab panel button **Capture headcount only** (trusted click; reads the visible "N associated
  members" and the visible "What they do" counts — live (2026-11) only the top 5 functions, no "Show more", and the
  job-function filter does not filter the page, so Marketing may be absent; on older layouts with a "Show more" it is
  clicked at most once as a fallback (`NBList.facetsExpandButton`),
  no walking / scrolling / paging) → one `POST /ext/capture-list` with `rows: []`, `final: true`. The response gains
  `headcount: {members: number | null, functions: n}`; the notice for such a post is "Saved LinkedIn headcount for
  <account>: N members, F “What they do” counts".

#### Phase 5 second review fixes

- `POST /ext/capture-list`: "What they do" is stored (scope `function`) only from an UNFILTERED People tab (the same
  rule as a `company` header); on a filtered tab (keywords / facets) it counts the result set and is ignored
  (`headcount.functions: 0`). The org map also ignores older `function` rows whose URL carries filters.
- A run whose first and only post is final with zero rows ("Capture headcount only") gets `stopReason: 'counts-only'`
  (appended to `LIST_STOP_REASONS`). The org map leaves counts-only runs out of `runs`, and picks the latest run per list
  for the anonymous count only among runs that read rows (`rowsSeen > 0`).
- Classifier: Referent(in) / Office Manager(in) are exec support only when followed by to/of/for/der/des/für (die)
  + Geschäftsführung / Geschäftsleitung / Unternehmensleitung / GF / Vorstand / CEO / Managing Director / MD / board;
  "Referentin für Marketing", "Office Manager für Marketing & Events" are specialists in that function.
- Light-row refresh: skipped for contacts with a `manual` source (the user typed those values) and when the posting
  run started before the run of the contact's newest list sighting (a late Retry of an old run never wins).

#### Extension 0.3.2 — walk survives (and ends cleanly after) a full page load; stale runs closed; slow pages

- **Card detection (live 2026-11):** search results may be `div[role=list] > div[role=listitem]` with no `li` and no
  known card class, and 2nd-degree cards carry a "X, Y & 12 other mutual connections" row with its own `/in/` links.
  `resultCards`' structural fallback now counts only a card's *primary* profile links (`profileLinks(root, base, true)`:
  links inside an insight row — an element between the link and the card whose visible lines all match
  /mutual connection|gemeinsame Kontakt/ — are skipped), so such cards are kept (outermost-only rule unchanged), and
  `readCard().href` is the card's own person, never a mutual connection.
- **Full page loads mid-walk** (LinkedIn sends you back to page 1, no `page` param, when you page past the last results
  page; also some reloads) restart the content script. The walk keeps its minimal state per tab in
  `chrome.storage.session` via the background (`walkSave` / `walkLoad` / `walkClear`, keyed `walk.<tabId>` from the
  message sender; removed on tab close): `{runId, account {id, name}, acctRef, cap, rows, kind, path, filters
  (NBList.filterKey), page, lastPage, nextClicked, started}`. It is saved when the walk starts (before the first await),
  after each non-final post (`started: true`), right before clicking Next (`lastPage`, `nextClicked: true`) and after a
  page turned; cleared after the final post. Before each Next click the page's pending rows are posted.
- On every page load the content script calls `recoverWalk()` once: it reads and clears the state, then
  `NBList.reloadVerdict(saved, location.href)` → `'end'` when the same search (same filter key) is back on page 1 or a
  page below `lastPage` right after a Next click, else `'cancelled'`. If the run had started it sends one final post
  `{runId, accountId|accountName, page, rows: [], final: true, stopReason}` and shows a notice: "Done — reached the end of
  the results (N people)" or "The page reloaded or changed while mapping, so the walk stopped (N people saved) … It never
  restarts by itself". **It never walks, clicks or resumes**; a walk still starts only from a trusted Start click.
  Without a full load, a Next click that lands on a page number ≤ the previous one also ends the walk as `end`.
- **Slow pages:** `NBList.isLoading(doc)` (visible `[class*=skeleton]`, `[class*=ghost]`, `[aria-busy=true]` in main).
  While waiting for a page/more results the panel shows "Waiting for LinkedIn to load page N… Xs" (after 2 s). 60 s
  (`STALL_MS`, hidden-tab time not counted) without the page turning or new cards appearing → `stalled`, with "Reload the
  page (⌘R) and start again". A drawn page of already-read people still counts as "no growth" (back-off, then `end` /
  `stalled` as before). A 409 because the run was closed → `cancelled` (not `cap`).
- **Server:** `account_list_runs.updated_at` (migration 7; backfilled from `started_at`) is set on start and every
  `updateListRun`. `AccountsRepo.abandonStaleListRuns({accountId?, idleMs = LIST_RUN_IDLE_MS (10 min), now?})` closes open
  runs idle longer than that with `stop_reason 'abandoned'` (rows kept). Called at explorer server start (all accounts)
  and in `POST /ext/capture-list` before a new run is created (that account only). `abandoned` is in
  `LIST_STOP_REASONS` but the extension may not send it (400). A post to an abandoned run → 409 "this list run was
  closed after 10 minutes without activity — start a new one". `ListRun.updatedAt` is new.
- **Review fixes:** the walk sends a quiet empty post (`rows: []`, not final) whenever nothing was posted for 2 minutes
  (`HEARTBEAT_MS`; from every `check()` and inside the hidden-tab pause), and the server's `updateListRun` on every post
  — empty ones too — refreshes `updated_at`, so a live run is never abandoned. A final post refused with 409 for a
  closed/finished/abandoned run ends quietly (no Retry) with a note saying how many unsent rows were lost. Saved walk
  state older than 15 minutes (`savedAt`) is cleared and ignored on load. Start stays disabled (and its handler refuses)
  until `recoverWalk` has finished.
- **Org map:** the anonymous count's "latest run per list" prefers any non-abandoned walk of that list; an `abandoned`
  run (partial) is used only when the list has no other walk. Abandoned runs still appear in `runs`. The page labels
  them "abandoned (no activity for 10 min)".

### v9 Phase 6 — MCP + docs (v9 complete)

- MCP (`src/mcp/accounts.ts`), 22 tools. The MCP `view()` attaches `org = buildOrgMap(view, orgMapSources(repo, id))`
  (the same pure functions as the page; no AI, nothing under `src/llm/` is imported by the MCP server — tested).
  - New **`network_get_org_map {account, function: 'marketing' (default, only value), detail: 'full' (default) |
    'summary'}`**, `readOnlyHint`. Text = `orgMapMarkdown(view, org, detail)` (`src/accounts/brief.ts`): headcount table
    (captured / LinkedIn Marketing function / company / coverage / query counts / anonymous / flagged / web), sub-function
    × seniority table, reporting tree (indented; edge tags via `edgeTag`: `[confirmed]` for `user`, `[inferred 0.6]`,
    `[web 0.9]`; context nodes marked), "No known manager" groups, flagged, entities, structure facts with evidence URL;
    `full` adds edge reasons, ids, possible managers, responsibilities, quotes and list walks (falls back to `summary`
    when over the size cap). No data → a "not mapped yet" pointer to the explorer workflow.
    `structuredContent = {account {id, name}, function, org: OrgMap, people: [{id, full_name, title, url, kind,
    is_connection, in_org, subfunction, auto_subfunction, seniority, team, entity, country, responsibilities, noise,
    vendor_funded, confidence, reports_to, reports_to_source, reports_to_confidence, reports_to_reason, line, sources}]}`
    for everyone in the org, flagged, or a context node in the tree.
  - `network_get_account`: `accountMarkdown` adds `## Marketing org` (after the org chart, when `view.org` has data —
    `hasOrgData`): counts, coverage, flagged / unplaced, top two tree levels, pointer to `network_get_org_map`.
    `structuredContent.marketing_org = {in_org, flagged, linkedin_marketing, coverage} | null`. The page's
    "Copy for AI" (`GET /api/accounts/:id/brief`) gets the same section, since the server's view carries `org`.
  - `network_account_update_person` also takes `subfunction` (SUBFUNCTIONS | ''), `team`, `entity`, `country`,
    `responsibilities`, `noise` (NOISE_FLAGS | 'none' | ''), `confirm_reports_to: boolean` (→ `confirmReportsTo`; ignored
    when `reports_to` is set in the same call, which is already the user's). Same `updateMember` validation as the page.
  - `network_account_add_people`: `people` is optional; new `contacts: [{full_name, url?, title?, headline?, company?,
    location?, evidence_url?}]` (≤ 200) → `upsertLightContacts` with source `{kind: 'mcp', at, evidenceUrl?}`
    (`evidence_url` must be http(s)); at least one of `people` / `contacts`. `structuredContent.light` =
    `LightUpsertResult`. A repeat call adds nothing (dedupe by URL, or name + compatible title).
  - Size: `summary` puts flagged / entities / facts first, the tree to 3 levels, ≤ 10 people per unplaced group (≤ 20
    flagged) with "… N more"; its `structuredContent` = `{account, function, detail, org}` with `org.runs` left out and no
    `people`. `full` caps `people` at 200 (org members first) + `people_total`, `people_truncated`. Text over 25k chars
    is cut by `cap()` with an explicit org-map note.
  - `confirm_reports_to` with no line (and no `reports_to` in the call) fails before anything is saved; `country` must
    match `/^([A-Za-z]{2})?$/`.
  - No infer / research / list-walk tools. Server instructions say these are started by the user in the explorer /
    extension.
- Docs: README "Map a marketing org" (workflow, live LinkedIn findings, costs, LinkedIn risk, GDPR), docs/MCP.md,
  extension/README.md (walk the people search; headcount from the unfiltered People tab; per entity page), AGENTS.md
  layout + costs, CHANGELOG 0.4.0; package + desktop version 0.4.0.
