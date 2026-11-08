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
  port, extensionDir}`. The capture token lives in meta `ext_token` (survives restarts; `rotate` revokes it).
- Extension API `/ext/*`: header `X-NB-Capture: <token>` (never the page token); Origin absent or
  `chrome-extension://[a-p]{32}`; Host must be ours. `GET /ext/ping`, `GET /ext/accounts` (id, name, status,
  memberCount), `GET /ext/lookup?url&company&companyUrl` → `{id, isConnection, capturedAt, accounts:[{id,name,role}],
  suggested}`, `POST /ext/capture {profile: CapturePayload, accountId? | accountName?, role?, notes?}` →
  `{account, person, createdAccount, addedToAccount, isConnection, firstCapture}`. Account resolution: accountId → name
  or alias match → LinkedIn company URL / company name match → create. Notes append; re-capture refreshes the profile
  and keeps history. 401 = re-pair, 400 = bad capture (not retried by the extension).
- CapturePayload: `{url, fullName, headline, location, currentCompany, about, sections: {<anchor id>: {heading, items:
  [{lines, sub?, companyUrl?}]}}, rawText ≤ 60k}`. All interpretation is server-side (`parseCapture`): grouped
  roles, nested descriptions, employment type, dates/current, location, and a raw-text section fallback.
- UI: header switch People | Accounts (persisted in localStorage `nb.mode` / `nb.account`). Accounts view = account list
  + header fields + autosaving brief + buying committee & gaps + warm paths (＋ Add) + org chart (department columns →
  tier rows, cards with role, connection, ↳ manager) + person drawer (role, department, level, reports to, notes,
  captured profile, remove). Selection bar gains "Add to account ▾" (uses `scopeToShown`). Person detail shows
  "Accounts" chips. The "Chrome extension…" dialog shows the extension folder, the pairing code (copy) and Reset.
