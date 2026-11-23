# PLAN: Marketing org map (branch `feature/marketing-org-map`)

Goal: for an existing Account, load **all marketing people**, show **org size** (headcount), **structure** (sub-functions,
teams, legal entities, reporting tree), **titles** and **responsibilities**. Every inferred fact carries **source +
confidence**. Free sources only: (1) the user's Chrome extension, (2) `claude -p` + WebSearch/WebFetch on the user's
subscription, (3) the LLM for classification/inference. No Clay/Apollo/PDL/paid APIs, no API key.

Fixtures, prompts, docs and tests use **fictional** companies/people only (Ledgerly, Northwind Ventures, Globex,
"Riley Moss", "Jonas Müller-Brandt", …). Never put real target companies or names in this repo.

## Status

| Phase | Title | Status | Commit |
|---|---|---|---|
| 1 | Data model, light contacts, identity/dedupe, CONTRACT | done (reviewed) | see git log |
| 2 | Classifier fixes + Haiku org-inference job | done (reviewed) | see git log |
| 2b | Vendor-funded = in org; `other-employer` noise | done (reviewed) | see git log |
| 3 | Extension list walk + `POST /ext/capture-list` + rule 5 | done (reviewed; live LinkedIn test pending) | see git log |
| 4 | Web org-research job | done (reviewed; live-calibrated $0.21 for 2 passes) | see git log |
| 5 | Org tree UI + headcount + jobs UI | done (reviewed x2; live-tested on 48 rows) | see git log |
| 6 | MCP + docs + release notes | done (reviewed) | see git log |

Every phase ends with `pnpm typecheck && pnpm test && pnpm build` green, CONTRACT.md updated for anything it changes,
and one commit (orchestrator commits; message ends with the attribution line from the session).

---

## Shared vocabulary (define in Phase 1, `src/accounts/types.ts`)

```ts
export const SUBFUNCTIONS = ['leadership','brand','product-marketing','demand-gen','content','comms-pr','events',
  'partner-marketing','marketing-ops','digital-social','field-marketing','other'] as const;   // labels in SUBFUNCTION_LABELS
// demand-gen covers growth/performance/campaigns/ABM; field-marketing = regional/country/field; digital-social = web, SEO/SEA, social
export const SENIORITIES = ['c-level','svp','vp','senior-director','director','head','senior-manager','manager','lead',
  'senior-ic','ic','junior','intern','unknown'] as const;    // SENIORITY_TIER maps each to the existing TIERS
export const NOISE_FLAGS = ['hr-marketing','sales-hybrid','vendor-funded','not-marketing','stale'] as const;
export const SOURCE_KINDS = ['extension-profile','extension-list','web','connection','manual','mcp'] as const;
export interface SourceRef { kind: SourceKind; at: string; url?: string; evidenceUrl?: string; quote?: string; runId?: string }
export type ReportsToSource = '' | 'user' | 'inferred' | 'web';
export type Confidence01 = number; // 0..1; null/undefined = not assessed
```

Confidence scale (use everywhere, from research): stated in a source (job ad "reports to", press, user) 0.9; same
team + clear seniority gap 0.6; title heuristic only 0.3. Badge: high ≥ 0.75, medium ≥ 0.45, else low.

---

## Phase 1: data model, light contacts, identity, CONTRACT

**Goal:** the DB and repo can hold light contacts (name/title/URL/location/source, no full profile), per-member
org fields with provenance, headcount snapshots, list runs, anonymous rows and org facts; URN (`/in/ACoAA…`) vs vanity
URLs dedupe without duplicates on re-runs. No UI, no AI.

**Files**
- `src/db/schema.ts`: append migration **#7** (array index 6). Never edit #1–#6.
  ```sql
  ALTER TABLE contacts ADD COLUMN kind TEXT NOT NULL DEFAULT 'full';          -- 'full' | 'light'
  ALTER TABLE contacts ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]';    -- SourceRef[]
  CREATE TABLE contact_aliases (alias_id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, url TEXT NOT NULL, added_at TEXT NOT NULL);
  ALTER TABLE account_members ADD COLUMN subfunction TEXT NOT NULL DEFAULT '';  -- user override; '' = automatic
  ALTER TABLE account_members ADD COLUMN team TEXT NOT NULL DEFAULT '';
  ALTER TABLE account_members ADD COLUMN entity TEXT NOT NULL DEFAULT '';       -- legal entity, e.g. "Ledgerly Services GmbH"
  ALTER TABLE account_members ADD COLUMN country TEXT NOT NULL DEFAULT '';      -- ISO-3166 alpha-2 or ''
  ALTER TABLE account_members ADD COLUMN responsibilities TEXT NOT NULL DEFAULT '';
  ALTER TABLE account_members ADD COLUMN noise TEXT NOT NULL DEFAULT '';        -- user override: '' auto | 'none' | NOISE_FLAG
  ALTER TABLE account_members ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE account_members ADD COLUMN confidence REAL;                       -- person is in this org/role now
  ALTER TABLE account_members ADD COLUMN reports_to_source TEXT NOT NULL DEFAULT '';
  ALTER TABLE account_members ADD COLUMN reports_to_confidence REAL;
  ALTER TABLE account_members ADD COLUMN reports_to_reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE account_members ADD COLUMN inference_json TEXT NOT NULL DEFAULT ''; -- last AI result (Phase 2)
  UPDATE account_members SET reports_to_source = 'user' WHERE reports_to <> '';  -- existing lines were set by hand
  CREATE TABLE account_headcounts (id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, taken_at TEXT NOT NULL,
    source TEXT NOT NULL,   -- 'linkedin-people' | 'linkedin-search' | 'web' | 'user'
    scope TEXT NOT NULL,    -- 'company' | 'function' | 'query'
    label TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL, url TEXT NOT NULL DEFAULT '',
    evidence_url TEXT NOT NULL DEFAULT '', quote TEXT NOT NULL DEFAULT '', confidence REAL, run_id TEXT NOT NULL DEFAULT '');
  CREATE INDEX account_headcounts_acc ON account_headcounts(account_id, taken_at);
  CREATE TABLE account_list_runs (id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, page_kind TEXT NOT NULL, -- 'people-tab'|'search'
    url TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '',
    rows_seen INTEGER NOT NULL DEFAULT 0, named INTEGER NOT NULL DEFAULT 0, anonymous INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT NOT NULL DEFAULT '');  -- 'end'|'cap'|'cancelled'|'checkpoint'|'rate-limit'|'login'|'stalled'|'error'
  CREATE TABLE account_anon_rows (run_id TEXT NOT NULL REFERENCES account_list_runs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, headline TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', PRIMARY KEY (run_id, idx));
  CREATE TABLE account_org_facts (id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,     -- 'team'|'entity'|'reporting'|'leadership'|'hiring'|'headcount'|'other'
    text TEXT NOT NULL, evidence_url TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', confidence REAL,
    found_at TEXT NOT NULL, run_id TEXT NOT NULL DEFAULT '');
  ```
  (node:sqlite enables FK constraints by default; a test asserts cascades.)
- `src/accounts/types.ts`: shared vocabulary above; extend `Contact` (`kind`, `sources`), `AccountMemberRow`
  (`subfunction, team, entity, country, responsibilities, noise, sources, confidence, reportsToSource,
  reportsToConfidence, reportsToReason, inference?: MemberInference`), `AccountMember` (resolved: `subfunction`,
  `autoSubfunction`, `seniority`, `noise` (resolved, '' = clean), plus the raw provenance fields and `kind:
  'full'|'light'|'connection'`). Add `HeadcountSnapshot`, `ListRun`, `OrgFact`, `LightContactInput {fullName, url?,
  title?, headline?, company?, location?, source: SourceRef}`.
- New `src/accounts/identity.ts` (pure, no DB):
  - `profileRef(url) → {canonical, id, slug, kind: 'vanity'|'urn'} | null`. URN = slug matches
    `/^ACo[A-Za-z0-9_-]{8,}$/` (case-sensitive): keep the **original-case URL** for navigation, `id` from the
    lower-cased canonical (reuse `canonicalProfileUrl`, capture.ts:17-27, and `personId`, src/io/csv.ts:102).
  - `normalizePersonName(s)`: NFKD + strip marks, `ä/ö/ü→a/o/u` and `ae/oe/ue` folding, `ß→ss`, drop `Dr.|Prof.|MBA|PhD`,
    pronouns, emoji, collapse spaces, lower-case. `sameName(a,b)`.
  - `titlesCompatible(a,b)`: either blank, or token-overlap ≥ 0.5 after stopwords.
- `src/db/accounts.ts` (`AccountsRepo`):
  - `resolveId(id)`: follows `contact_aliases`. Use it in `knownPerson` (:319), `getContact` (:228), `contacts`
    (:233), `idForProfileUrl` (:251, check alias table after the people lookup).
  - `upsertLightContacts(accountId, inputs: LightContactInput[]) → {added: string[], updated: string[], merged:
    string[], skipped: {input, reason}[]}` in one tx. Per input: (1) id by URL (via `profileRef` + alias) → exists:
    append source, fill **blank** title/headline/location only (never overwrite a `full` contact's fields); (2) no URL
    or new URL → look for exactly one member of this account with `sameName` + `titlesCompatible` → reuse it, add the URL
    as alias if it differs; >1 candidates → create new + note `possible duplicate` in reason; (3) else create
    `kind='light'` with `profile_json` = minimal `CapturedProfile` (empty sections; `title/company` from
    `splitHeadline`, capture.ts:352). No-URL ids: `personId('', name, accountId)`. Then `addMembers` (:324) with
    `sources_json` appended (dedupe SourceRef by kind+url+runId).
  - `saveContact` (:267): when called for a full capture, set `kind='full'`, merge `sources_json`.
  - `mergeContacts(fromId, intoId)`: only if `from` is `light` (never auto-merge two full contacts). Moves memberships
    (if `into` already a member: user-set fields win, then non-empty, sources union), rewrites `reports_to` pointers,
    writes alias `fromId → intoId`, deletes the `from` contact row. Used by ingest below.
  - `addHeadcount(...)`, `headcounts(accountId)`, `startListRun/updateListRun/listRuns`, `addAnonRows(runId, rows)`
    (idempotent by `(run_id, idx)`), `addOrgFacts(...)` (skip exact duplicate `kind+text+evidence_url`), `orgFacts`.
  - `MemberPatch` (:42) + `validateMember` (:345-ish) + `patchMemberRaw`: accept `subfunction` (∈ SUBFUNCTIONS or ''),
    `team` (≤120), `entity` (≤200), `country` (`/^[A-Z]{2}$/` or ''), `responsibilities` (≤1000), `noise`
    ('' | 'none' | NOISE_FLAG). Any `reportsTo` set through `updateMember` = user → `reports_to_source='user'`,
    confidence 1, reason ''. New `confirmReportsTo(accountId, id)` flips `inferred|web` → `user`.
  - New `applyInferredReportsTo(accountId, id, managerId, conf, reason, source: 'inferred'|'web')`: no-op when current
    source is `user`; same cycle/same-account validation as `validateMember`; `removeMember` (:419) also clears
    provenance of rows it un-points.
- `src/accounts/ingest.ts` `ingestCapture` (:26): after `saveContact`, if the account has a `light` member with
  `sameName` (exactly one) and a different id → `mergeContacts(light, full)`; record `SourceRef{kind:'extension-profile'}`.
- `src/accounts/view.ts` `buildAccountView` (:58): fill new `AccountMember` fields; `subfunction = row.subfunction ||
  inference.subfunction || subfunctionFromTitle(title)` (stub returning `'other'` until Phase 2 if needed);
  `seniority` likewise. Light contacts show `kind:'light'`.
- `src/web/explorer-server.ts`: `PUT /api/accounts/:id/members/:pid` accepts the new fields + `confirmReportsTo: true`;
  new `POST /api/accounts/:id/contacts {contacts: LightContactInput[] (≤500), role?}` → `{added, updated, merged,
  skipped, view, accounts}` (source forced to `manual`). Add both to `known` (:1030).
- `src/web/CONTRACT.md`: new `## v9 — Marketing org map` section: migration, types, identity rules, endpoints above.

**Tests** (`test/accounts.test.ts`, new `test/identity.test.ts`)
- Migration from a v6 fixture DB (build with migrations 1–6, insert a member with `reports_to`) → v7: rows kept,
  `reports_to_source='user'`, new tables exist; deleting an account cascades to headcounts/runs/anon rows/facts.
- `profileRef`: vanity lower-cased; URN keeps case in `url`, stable `id`; garbage → null.
- `normalizePersonName`: "Jonas Müller-Brandt" == "Jonas Mueller-Brandt" == "Dr. Jonas Muller-Brandt".
- `upsertLightContacts` twice with the same 3 rows → second call `added=[]`, contact/member counts unchanged.
- URN row then vanity full capture of same name on same account → one member, alias exists, `knownPerson(urnId)` true,
  user-set `role`/`reportsTo` preserved; two same-name candidates → no merge.
- Light upsert never overwrites a full contact's title; user `reportsTo` → source `user`;
  `applyInferredReportsTo` refuses to overwrite `user`, rejects cycles.
- Server: `POST /api/accounts/:id/contacts` 400 on >500 / bad URL type / missing name; 401 without token.

**Acceptance**
- `SCHEMA_VERSION === 7`; migrations 1–6 byte-identical to `main` (`git diff main -- src/db/schema.ts` shows only an
  appended array element).
- Running the same light import twice yields zero new rows (test).
- No change to `people` table, lenses, exports, People view (export parity test untouched and green).

**Manual check:** `sqlite3 <live db> ".backup /tmp/…/copy.db"`; `node dist/bin.js --db copy.db --port 47990 --no-open`;
confirm the copy migrates to v7 and the existing account view still loads.

---

## Phase 2: classifier fixes + Haiku org-inference job

**Goal:** deterministic marketing sub-function/seniority/noise from EN + DE titles, and a human-triggered cheap Haiku
batch job that classifies members and suggests managers with confidence + reason, never overwriting user choices.

**Files**
- `src/accounts/classify.ts`:
  - Fix rule order (DEPT_RULES :33-48): insert, before `it-security`, a marketing-hybrid rule matching
    `(partner|channel|alliance|field|revenue|growth|performance|product|portfolio|brand|content|event|digital|social|
    regional|trade|vendor)[\s-]+marketing`, `marketing[\s-]+(technology|tech|ops|operations|automation|analyst|analytics|
    data|engineer|manager|lead|director|specialist|coordinator)`, `\b(marcom|mops|abm|pmm)\b`, DE
    `(marketing|kommunikation|unternehmenskommunikation|pressesprecher(in)?|pressereferent(in)?|produktmarketing|
    markenf[üu]hrung|veranstaltung|kampagnen)`. "Sales & Marketing" / "Marketing & Sales" stay `marketing` with noise
    `sales-hybrid`; "Growth Engineer" stays engineering; "HR Marketing"/"Employer Branding"/"Personalmarketing" →
    `people` + noise `hr-marketing`.
  - DE seniority words in `tierFromTitle` (:21): `leiter(in)?|leitung|bereichsleiter|abteilungsleiter|head` → director;
    `teamleiter(in)?|teamlead` → manager; `gesch[äa]ftsf[üu]hrer(in)?` → exec; `referent(in)?|spezialist(in)?|
    sachbearbeiter` → ic; `werkstudent(in)?|praktikant(in)?|trainee|azubi` → ic.
  - New exports: `seniorityFromTitle(title): Seniority` (fine ladder incl. "Senior Director" vs "Director", "Senior
    Manager" vs "Manager", "Head of", DE equivalents, `junior`, `intern`); `subfunctionFromTitle(title): Subfunction`;
    `noiseFromTitle(title, company?): NoiseFlag | ''` (`vendor-funded` = "<Vendor> Marketing Manager" patterns like
    `(marketing|portfolio).*(for|@|–|-)\s*[A-Z][\w.]+ (Inc|Corp)?` or "funded by"; keep conservative).
- New `src/llm/org-infer.ts` (clone the shape of `src/llm/enrich.ts` :26-232):
  - `buildOrgClassifyPrompt(account, batch)`: members as `p0..pN` with title, headline, location, company, entity
    hints, ≤600 chars of `about`/current experience description when a full profile exists. Output per id:
    `{subfunction, seniority, noise, team, entity, country, responsibilities (≤240 chars, only from the given text,
    else ''), confidence, reason}`.
  - `buildOrgReportingPrompt(account, roster)`: one call over the compact roster (≤400 rows: id, title, seniority,
    subfunction, entity, country, location, user-confirmed edges listed as fixed) → `{edges: [{id, managerId|null,
    confidence, reason}]}`. Rules in prompt: manager must be more senior or a team lead in the same
    sub-function/entity; prefer same entity+country; never invent people; null if unsure.
  - `suggestManagersRuleBased(members)` (pure fallback): most senior in same (entity, subfunction) → same entity
    marketing → overall marketing head; confidence 0.3–0.6 per the scale; reason string.
  - `runOrgInference({account, members, model='haiku', batchSize=40, concurrency=2, signal, costs, onProgress})` →
    `{classified: Map<id, MemberInference>, edges: Edge[], costUsd}`. Uses `runClaude` (claude.ts:240) with
    `tools: []` (→ `--strict-mcp-config --tools ''`), JSON schemas in `src/llm/schemas.ts`, one retry for missing ids
    (as enrich.ts :188-200), `errorCost` on failures. Validates enums; drops edges to unknown ids/self/cycles.
  - `ORG_INFER_USD_PER_100 = 0.01` (est.), exported for the UI estimate.
- `src/db/accounts.ts`: `applyInference(accountId, results)` writes `inference_json` only (user overrides live in their
  own columns and win at view time); `applyInferredReportsTo` for edges (skips `user`).
- `src/types.ts`: `CostStage` += `'org'`; `ExplorerCosts.org?`; `JobQueueState.orgJob?: {accountId, kind:
  'infer'|'research', phase: string, done, total, pausedUntil?: string|null, pausedManual?: boolean} | null`;
  `estimates.orgInferUsdPer100?`. `src/db/store.ts` `explorerCosts` (:782) maps stage `org`.
- `src/web/explorer-server.ts`: one org job at a time, modelled on `runAhoyJob` (:603-620): `orgBusy()` → 409;
  `POST /api/accounts/:id/org/infer {ids?: string[]}` → `{started: n, estimateUsd, queue}`; `POST
  /api/accounts/:id/org/cancel`. Injectable `orgInferFn` in `ExplorerServerOptions` (:60-92) for tests. On finish:
  `accountsChanged(id, 'Classified N people; M reporting lines suggested')`, `costs.add('org', usd)`.

**Tests** (`test/accounts.test.ts`, new `test/org-infer.test.ts`, `test/explorer-server.test.ts`)
- Table-driven classify cases (EN + DE): "Partner Marketing Manager"→marketing/partner-marketing; "Marketing
  Technology Lead"→marketing/marketing-ops; "Senior Director, Brand"→senior-director/brand; "Director Demand
  Generation"→director/demand-gen; "Leiterin Unternehmenskommunikation"→director/comms-pr; "Teamleiter Online
  Marketing"→manager/digital-social; "Werkstudent Marketing"→intern/other; "HR Marketing Specialist"→people +
  hr-marketing; "Sales & Marketing Manager"→marketing + sales-hybrid; existing classify tests unchanged and green.
- `buildOrgClassifyPrompt` contains no real names; schema enums match `SUBFUNCTIONS`/`SENIORITIES`.
- `runOrgInference` with a stubbed `runClaude` (vi.mock): normalises bad enums to `other`/`unknown`, drops edges to
  unknown ids and cycles, retries missing ids once, sums cost incl. failures.
- `suggestManagersRuleBased` on a fictional 8-person Ledgerly org → expected edges + confidences.
- Server: infer with injected fn writes inference, adds inferred edges, leaves a user-set `reportsTo` untouched;
  second concurrent POST → 409; costs ledger gets stage `org`; no endpoint runs without a POST from the page token.

**Acceptance**: classify table passes; user-confirmed edges/sub-functions provably untouched (test); job only
startable via the session-token API; `claude -p` args for this job contain `--strict-mcp-config` and `--tools ''`
(assert via `buildArgs` snapshot).

**Manual check:** on the DB copy, add ~10 fictional light contacts via `POST /api/accounts/:id/contacts`, run
`POST …/org/infer` with the token from the server log; inspect `GET /api/accounts/:id`. Cost should be < $0.02.

---

## Phase 3: extension list walk + `POST /ext/capture-list` + rule 5

**Goal:** on a LinkedIn company People tab or people-search results page, a user click starts a visible, paced,
capped, cancellable walk that sends light rows (and anonymous "LinkedIn Member" rows) plus the People tab's headcount
and "What they do" counts to the app. Full profile capture stays one click per person.

**Files**
- `extension/content.js`: new branch (keep the profile code untouched):
  - Page detection: `/company/<slug>/people/` and `/search/results/people/`. Inject a floating button
    "⇣ Map to Network Builder" (reuse `el()` :269, `send()` :22, panel styles). No auto-start ever.
  - Panel: account picker (`GET /ext/accounts` via background; preselect the account whose `linkedinUrl` matches the
    company slug), cap (default 300, max 500), shows keywords from the URL, a warning line ("Keep this tab in front.
    LinkedIn may limit accounts that browse a lot; stop if you see a security check.").
  - Walk loop ported from `~/git/tools/linkedin-exporter/content.js` :555-600 (`loadMore` :324-355, `waitFor`,
    `waitWhileHidden` :464, `MAX_NO_GROWTH_ATTEMPTS`, `PACE_STEP_MS`/`MAX_PACE_MS`) with: base delay 2.5 s + random
    jitter 0–1.5 s between loads; pace +1.5 s per stall up to 8 s; **pauses while `document.hidden`**; stops at the
    cap; Cancel button stops immediately; search results page via the visible "Next" button only (same tab), max 1
    page per 4–7 s.
  - Stop detectors, checked before every step: URL path `/checkpoint|/authwall|/login|/uas/`; a captcha/challenge
    iframe; page text `/unusual activity|security verification|commercial use limit|reached the (monthly )?limit|
    let's do a quick security check/i`; zero results. Stop reason sent to the server.
  - Card reading: for each result `li` read visible lines (`linesOf` :46 style, `span[aria-hidden=true]`) + first
    `a[href*="/in/"]` href (strip query). Cards without an `/in/` link or named "LinkedIn Member" → `anonymous: true`
    (headline/location lines only). No hidden attributes, no data-* ids, no network calls of its own.
  - Header/facets (People tab only): send the visible text of the header ("N associated members") and of the "What
    they do" / "Where they live" insight modules as raw text; parsing is server-side.
  - Batching: post every 25 new rows and once at the end (`final: true`). If the post fails, pause the walk and show
    the error (no offline queue for lists).
  - Daily cap: rows per local date in `chrome.storage.local` (`nb.listRows.<yyyy-mm-dd>`), default 1,000; the panel
    refuses to start beyond it.
- `extension/background.js`: handler `captureList` → `call('POST', '/ext/capture-list', body)` (reuse `call()` :79-116);
  no `chrome.windows`/tabs use for lists.
- `extension/manifest.json`: version 0.3.0; **no new permissions**; update description.
- `src/accounts/list-capture.ts` (new, pure): `parseListCard({lines, href, pageKind}) → {fullName, url?, headline,
  title, company, location, degree, anonymous}` (reuse `splitHeadline`, `canonicalProfileUrl`);
  `parsePeopleHeader(text) → number|null` (EN/DE: "associated members", "results", "Mitglieder", "Ergebnisse",
  thousands separators `,` `.` and narrow space); `parseFunctionFacets(text) → {label, count}[]`.
- `src/web/explorer-server.ts` `handleExtension` (:972): add `POST /ext/capture-list` body
  `{runId (uuid from extension), accountId? | accountName?, page: {kind: 'people-tab'|'search', url, keywords,
  companyUrl?}, rows: ListCardPayload[] (≤100 per request), header?: string, facets?: string, final?: boolean,
  stopReason?: string}` → `{account: {id,name}, run: ListRun, added, updated, merged, anonymous, totalRows}`.
  Server rules: reject when the run already has ≥ 1,000 rows (409); anonymous rows → `addAnonRows`; named → 
  `upsertLightContacts` with `SourceRef{kind:'extension-list', url: page.url, runId}`; header → headcount
  `scope:'query'` (keywords set) or `'company'`; facets → one `scope:'function'` row per label (`source:
  'linkedin-people'`, same `run_id`; re-posts of the same run replace that run's facet rows). Account resolution as
  `ingestCapture` (match by company URL). Emits `accountsChanged` with a notice on `final`.
- Docs (same commit, because the behaviour changes here):
  - `AGENTS.md` rule 5 → "Captured LinkedIn people never enter the network … The extension reads only what is on the
    screen. Full profiles: one click per person. Lists (company People tab, people search): only after a click on that
    page, in the visible foreground tab, at human pace with jitter, capped per run (300 default, 500 max) and per day,
    stops on any checkpoint/captcha/login/limit page, cancellable; out-of-network 'LinkedIn Member' rows are kept only
    as anonymous counts. No hidden fields, no background or minimized-window walking, no money spent."
  - `extension/README.md` :7-9 + a "Mapping a team from a list" section with the same safeguards and the LinkedIn ToS
    risk note.
  - `src/web/CONTRACT.md` v9: `/ext/capture-list`, payload, caps, stop reasons.

**Tests** (`test/list-capture.test.ts`, `test/explorer-server.test.ts` "accounts + Chrome extension API" :525)
- Fixtures `test/fixtures/linkedin-people-tab.txt` / `-search.txt` (hand-written, fictional Ledgerly staff): card
  parsing (vanity, URN, "LinkedIn Member", headline without " at "), header numbers ("1,234 associated members",
  "1.234 Mitglieder"), function facets.
- Endpoint: 401 without capture token; 403 for a non-extension Origin; >100 rows → 400; same batch posted twice → no
  new contacts; anonymous counted in run, not in members; run row capped at 1,000 → 409; `final` with `stopReason
  'checkpoint'` stored; facets replace within a run.
- A static check test: `extension/content.js` contains no `chrome.windows.create` in the list branch and no
  `setInterval`-driven auto start (grep-based, keeps the safeguard from regressing).

**Acceptance**: no new manifest permissions (diff); walk can only start from the panel's button handler; stop
detectors + cancel + hidden-pause + caps present (reviewer reads the code against the list above); AGENTS.md rule 5,
extension README and CONTRACT updated.

**Manual check (user present, own LinkedIn):** load unpacked, open a small company's People tab with
`?keywords=marketing`, set cap 30, start, switch tabs (walk pauses), come back, Cancel; confirm rows + facets on the
account in the DB-copy explorer (pair the extension to the copy's port). Do not run on large companies during testing.

---

## Phase 4: web org-research job

**Goal:** a human-triggered job that uses `claude -p` WebSearch/WebFetch to find marketing leadership, teams, legal
entities, headcount hints and hiring/reporting facts; every person and fact carries an evidence URL + quote or is
dropped. Never relies on LinkedIn snippets or `site:` (WebSearch ignores `site:`; WebFetch can't read linkedin.com).

**Files**
- New `src/llm/org-research.ts`:
  - `ORG_RESEARCH_PASSES`: `seed` (sonnet, WebSearch+WebFetch: company site, management/leadership pages per
    country, about/locations, legal entities/imprint), `press` (haiku: newsroom, press contacts, "joins as … marketing"),
    `jobs` (haiku: careers/job ads → team names, "reports to", entities, locations), `events` (haiku: conference
    speakers, podcasts, award/agency case studies), `headcount` (haiku: employee counts, annual report, marketing team
    size statements). Queries in the account's languages (EN + DE when domain/aliases/country suggest DACH).
  - `buildOrgResearchPrompt(account, pass, known)`: includes name, domain, aliases, company LinkedIn URL (as context
    only), names already on the account (to confirm, not repeat), rules adapted from `src/llm/research.ts` :94-110
    (never invent URLs, sources only from results, prefer unknown, confidence) plus: "do not search or cite
    linkedin.com; site: is ignored".
  - Schema `ORG_RESEARCH_SCHEMA` (schemas.ts): `{people: [{name, title, entity, country, subfunction, evidenceUrl,
    quote, date?}], facts: [{kind, text, evidenceUrl, quote, confidence}], headcounts: [{label, scope, count,
    evidenceUrl, quote}], searchesRun, rateLimited}`.
  - `normalizeOrgResearch(raw)`: drop items with missing/non-http(s) `evidenceUrl` or empty `quote`; drop
    `evidenceUrl` on linkedin.com for people (they cannot be verified); clamp lengths; enum-check.
  - Rate limiting: reuse `classifyRateLimited` (dossier.ts :357) logic + `CLI_RATE_LIMIT_RE` (:366) →
    `status:'rate_limited'`.
  - `ORG_RESEARCH_USD_ESTIMATE = {min: 0.5, max: 2.5}`.
- `src/web/explorer-server.ts`: `POST /api/accounts/:id/org/research {passes?: PassId[]}` → `{started, estimate,
  queue}` (409 if an org job runs); passes run **sequentially**; on `rate_limited` back off with `opts.backoffMs`
  (default 1m, 2m, 5m, 10m) then set `orgJob.pausedManual` and wait for `POST /api/accounts/:id/org/resume`; cancel via
  the Phase 2 endpoint. Results persisted **after each pass**: people → `upsertLightContacts` (`SourceRef{kind:'web',
  evidenceUrl, quote}`, member `confidence` 0.6 company site/press, 0.4 directories/older than 24 months), facts →
  `addOrgFacts`, headcounts → `addHeadcount(source:'web')`, "reporting" facts naming two members →
  `applyInferredReportsTo(…, 0.9, quote, 'web')`. Injectable `orgResearchFn`. Costs → stage `org`.
- CONTRACT.md v9: endpoints, pass ids, evidence rule, job state.

**Tests** (`test/org-research.test.ts`, server tests)
- `normalizeOrgResearch`: drops people without evidence/quote, drops linkedin.com evidence, keeps valid ones.
- Prompt: contains "do not search or cite linkedin.com", contains no real names, lists known members.
- `buildArgs` for the seed pass: `--strict-mcp-config`, `--allowedTools WebSearch,WebFetch` (as built today), no
  `--bare`, no MCP tools.
- Server with injected fn: rate-limited first pass → backoff then success (fake timers / tiny `backoffMs`); exhausted
  backoff → `pausedManual`, resume continues remaining passes; results of finished passes persist after cancel;
  re-running research does not duplicate contacts or facts; inferred web edge never overwrites a user edge.

**Acceptance**: no person stored from research without an evidence URL (test); job only starts via the page API; one
org job at a time; costs recorded; rate-limit path ends in manual Resume, never a tight retry loop.

**Manual check:** on the DB copy, run research for a fictional-looking test account only if the user agrees to spend
≈$1–2; otherwise verify with the injected stub. Inspect stored facts' evidence URLs open.

---

## Phase 5: org tree UI + headcount + job controls (`src/web/explorer.html`)

**Goal:** a "Marketing org" view on the account page with a real reporting tree, headcounts, LinkedIn-reported vs
captured counts, confidence badges, inline confirm/edit of reporting lines, filters, and the buttons that start the
paid jobs (with estimate + confirm). Vanilla JS with `h()`; no deps, no external requests.

**Server first** (`src/accounts/org.ts`, new, pure; used by the page via the API and by MCP in Phase 6):
`buildOrgMap(view, repo, {fn: 'marketing'}) → OrgMap`:
```ts
interface OrgMap {
  scope: 'marketing';
  members: string[];              // ids in scope: department==='marketing' OR source run/research was marketing-scoped
  flagged: {id: string; noise: NoiseFlag}[];   // shown in a "Flagged" group, not deleted
  roots: OrgNode[];               // reports_to backbone; node {id, children: OrgNode[], edge?: {source, confidence, reason}}
  unplaced: {subfunction: Subfunction; entity: string; ids: string[]}[];  // no manager known
  headcount: {
    captured: {total, named, light, full, bySubfunction: Record<Subfunction, number>, bySeniority: Record<Seniority, number>};
    linkedin: {company?: HeadcountSnapshot; marketing?: HeadcountSnapshot; functions: HeadcountSnapshot[]} ; // latest per label
    anonymous: number;            // from the latest run per (url) — not summed across re-runs
    web: HeadcountSnapshot[];
    coverage?: number;            // captured marketing / LinkedIn marketing count
  };
  entities: {entity: string; country: string; n: number}[];
  facts: OrgFact[];
  runs: ListRun[];                // last 10
}
```
`GET /api/accounts/:id` adds `org: OrgMap` to `AccountView` (CONTRACT.md).

**Page** (`renderAccMain` :3561-3681; org chart block :3635-3663; drawer :3700-3760; queue vars :957-968, :1425):
- Org card gets a switch "All departments | Marketing org" (localStorage `nb.orgView`, try/catch). "All departments"
  keeps today's grid unchanged.
- Marketing org view:
  1. **Headcount strip**: LinkedIn-reported (company members, "What they do → Marketing" with date + source link),
     captured named (full / light), anonymous seen, web hints, coverage %. Each number has a tooltip with source + date.
  2. **Breakdown**: sub-function × seniority count table with inline CSS bars; click a cell = filter.
  3. **Filters**: sub-function chips, seniority, entity/country select, source (list/profile/web/connection/manual),
     min confidence (low/medium/high), "show flagged", text search. Filters only hide; any bulk action keeps
     `scopeToShown` (:1165) semantics.
  4. **Tree**: indented collapsible `ul` from `org.roots`; node = name, title, sub-function chip, seniority, entity /
     country, confidence badge, source icons, `light` tag ("open on LinkedIn to capture the full profile" link).
     Inferred/web edges drawn dashed with a ✓ Confirm button (`PUT …/members/:pid {confirmReportsTo:true}`) and a
     "Change…" select (`PUT … {reportsTo}`, cycle errors shown inline). "No known manager" groups by sub-function →
     entity. Flagged group collapsed at the bottom.
  5. **Facts**: structure facts with evidence links and confidence.
  6. **Actions** (live mode only, disabled in snapshot; disabled while `orgJob` set): "Classify & suggest reporting
     lines (≈$X)" → confirm → `POST …/org/infer`; "Research on the web (≈$0.50–2.50)" → confirm → `POST
     …/org/research`; progress line from `queue.orgJob` in the header job area (:1425) with Cancel / Resume; "Load from
     LinkedIn" opens `<linkedinUrl>/people/?keywords=marketing` in a new tab with a hint that the walk starts from the
     extension button there (the page never triggers the walk).
- Drawer: sub-function (auto shown as "auto: …"), seniority, team, entity, country, responsibilities, noise
  ("not noise" option), sources list with evidence links, reports-to provenance (source, confidence, reason).
- Cost display: add `org` to the costs breakdown wherever `ahoy` is shown.

**Tests**
- `test/org-map.test.ts`: `buildOrgMap` on a fictional 15-person Ledgerly org: tree shape, unplaced grouping,
  flagged excluded from counts but listed, anonymous from latest run only (two runs of the same URL don't add),
  coverage, user edge vs inferred edge provenance.
- Existing `test/export.test.ts` passes unchanged (page export mappers untouched).
- A test that `explorer.html` has no `http(s)://` script/link/img src except existing allowed ones (add if missing).

**Acceptance**: marketing view renders from `org` only (no client-side re-derivation of the tree); all paid actions
need a click + confirm; snapshot mode shows no enabled paid buttons; existing "All departments" grid unchanged; light
and dark themes both readable.

**Manual check (required):** DB copy + `NB_EXPLORER_TEMPLATE=src/web/explorer.html node dist/bin.js --db copy.db
--port 47990`, seed a fictional account (≈25 light + 3 full members, 2 runs, facets, 2 facts) via the API, drive
headless Chrome over CDP: switch views, filter, confirm an inferred edge, change a manager (cycle rejected), open
drawer, screenshot light + dark. Never the user's live explorer/DB.

---

## Phase 6: MCP + docs + release notes

**Goal:** Claude can read the org map; docs describe the feature; no paid action reachable via MCP.

**Files**
- `src/mcp/accounts.ts`: new read-only tool `network_get_org_map {account, function: 'marketing' (default), detail:
  'summary'|'full'}` → markdown (headcount table, sub-function × seniority, indented tree with `[inferred 0.6]` /
  `[confirmed]` tags, unplaced groups, flagged, facts with evidence URLs) + `structuredContent: OrgMap`. Extend
  `network_get_account` (:109-134) summary with a short "## Marketing org" section (counts + top 2 levels + pointer to
  `network_get_org_map`). `network_account_update_person` (:257-289) accepts `subfunction, team, entity, country,
  responsibilities, noise, confirm_reports_to`; `network_account_add_people` (:232-255) accepts `contacts:
  LightContactInput[]` (source `mcp`, evidence URL optional). No infer/research/walk tools.
- `src/accounts/brief.ts`: `orgMapMarkdown(orgMap, detail)`; reuse in `accountMarkdown` (:84).
- `src/mcp/server.ts` instructions text: mention org map + that classification/research/LinkedIn list walks are
  started by the user in the explorer.
- Docs: `README.md` Accounts section (:237-240 area) "Map a marketing org" walkthrough + costs; `docs/MCP.md` tool
  table; `AGENTS.md` layout table (new files: identity.ts, list-capture.ts, org.ts, org-infer.ts, org-research.ts),
  tool count 21 → 22, Costs line (org infer ≈ $0.01/100 people, org research ≈ $0.50–2.50/account); `CHANGELOG.md`
  entry; CONTRACT.md v9 complete.

**Tests** (`test/mcp.test.ts`): `network_get_org_map` on a fictional account returns tree + headcounts; light contact
add via MCP dedupes on second call; tool list contains no tool that calls `runClaude` (assert names) and
`network_get_org_map` has `readOnlyHint`.

**Acceptance**: MCP tool count matches docs; no MCP path imports `org-infer`/`org-research` (grep test or review);
README/AGENTS/extension README consistent with rule 5; pre-push privacy grep clean.

---

## Review checklist (reviewer runs this for every phase)

1. **Gates**: `pnpm typecheck && pnpm test && pnpm build` green; new tests exist for each new pure function and endpoint.
2. **Product rules (AGENTS.md)**: 1 paid AI only from a user click in the explorer (or explicit CLI); MCP exposes no
   paid action. 2 lens removals untouched. 3 no CRM writes. 4 any new bulk action uses `scopeToShown`. 5 captured /
   light people only in `contacts`, never `people`; lenses/People view/network search/exports unaffected. 6 n/a.
3. **CONTRACT.md** updated (v9 section) for every endpoint, type, migration and SSE/queue change in the phase.
4. **Export parity**: `src/io/explorer-export.ts` and page mappers untouched, or changed together with
   `test/export.test.ts` green.
5. **Migrations append-only**: only a new array element in `src/db/schema.ts`; old ones byte-identical; existing data
   preserved (test from a v6 DB).
6. **User intent wins**: inferred/web values never overwrite user-set `reports_to`, sub-function, tier, department,
   noise; user edits set `reports_to_source='user'`.
7. **Evidence**: every stored web person/fact has an http(s) evidence URL + quote; confidence on every inferred field.
8. **`claude -p` conventions**: via `runClaude` only; non-MCP calls `--strict-mcp-config` + `--tools ''` or explicit
   built-in list; never `--bare`; `ANTHROPIC_API_KEY` stripped (childEnv); no API key usage anywhere; costs recorded
   (stage `org`), including failed attempts (`errorCost`); abort respected.
9. **Extension safeguards**: list walk starts only from a click on that page; foreground only (pauses on hidden), no
   `chrome.windows.create` / minimized windows / background navigation for lists; base pace ≥2.5 s + jitter, stall
   back-off; per-run cap (≤500) and per-day cap; stops on checkpoint/captcha/login/limit/zero results; Cancel works;
   reads visible text + `/in/` hrefs only (no hidden fields, no data-* ids); no new manifest permissions; server
   enforces ≤100 rows/request and ≤1,000 rows/run.
10. **Security**: new `/api/*` routes in `known` and token-checked; `/ext/*` only via capture token + extension origin;
    1 MB body limit respected; inputs length-checked; 400/404/409 semantics as existing.
11. **Privacy**: fixtures/prompts/docs fictional only; no real names, user paths, emails, CRM ids; no DB/CSV/STATUS.md
    committed; data stays local (no new outbound calls besides `claude -p`).
12. **UI**: vanilla JS, no external requests, works in light/dark, snapshot mode disables live actions; tested on a DB
    copy, never the live explorer.
13. **Scope**: phase did only its own items; no drive-by refactors.

## Decisions after planning (user, 2026-11-23)

- **Vendor-funded roles are part of the org** when the person works for the account's company (current company is the
  account or one of its entities). Applies to Phase 2b (below), Phase 5 and Phase 6:
  - `vendor-funded` is a **tag**, not exclusion noise: those people stay in `members`, the tree and every headcount;
    the rule-based sub-function becomes `partner-marketing` unless the user set one; the card shows a small
    "vendor-funded" tag. `buildOrgMap.flagged` never contains `vendor-funded`.
  - Someone whose current employer is the vendor (or any company other than the account / its entities) is not in the
    org: new noise flag `other-employer` (append to `NOISE_FLAGS`), excluded like other noise.
  - Haiku prompt: same rules (vendor-funded = still in org, partner-marketing; other employer = `other-employer`).
- **Phase 2b** (small, after Phase 3): implement the above in `types.ts`, `classify.ts`, `org-infer.ts`, the view and
  CONTRACT.md, with tests.

## Notes / risks
- Coverage expectation: list walks ~60–85% of named marketing staff; web research gives the top layers + structure;
  reporting lines are mostly inferred — the UI must show that honestly (dashed + confidence).
- Group companies have many LinkedIn company pages; the user runs the walk per entity page — all runs land on the same
  account (account picker), entity comes from the card/company and from inference.
- LinkedIn ToS risk is the user's accepted trade-off; keep caps conservative and never automate full-profile opening.
- `PLAN.md` is a working file; the orchestrator decides whether it is committed (it contains no private data).
