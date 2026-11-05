# AGENTS.md — working on network-builder

Guidance for AI coding agents (Claude Code, etc.) and contributors. Read this before changing anything.
Private, machine-specific context (if present) lives in the git-ignored `STATUS.md` — read it too, never commit it.

## What this is

A local CLI + browser "explorer" that turns a LinkedIn connections CSV into goal-scored lists ("lenses"), lets the user
research chosen people on the web, curate lens membership, and export / send to a CRM (Ahoy). All AI runs through the
**Claude Code CLI** (`claude -p`) on the user's own login — never an API key (`ANTHROPIC_API_KEY` is stripped from the
child env). Data is one local SQLite file.

## Layout

| Path | What |
|---|---|
| `src/bin.ts` | Entry: Node ≥ 22.13 check, silences the node:sqlite ExperimentalWarning, then dynamic-imports the app (tsup `splitting: true`, chunks `dist/app-*.js`) |
| `src/index.ts` | commander wiring: default (explorer / first-run setup), `serve`, `import`, `lists`, `export`, `db`, `lens list/rescore/rm`, `mcp` |
| `src/cli/` | `explore.ts` main flow, `setup.ts` first-run wizard, `db.ts` subcommands, `interactive.ts` CSV picker |
| `src/db/` | `schema.ts` (append-only migrations via `PRAGMA user_version`), `store.ts` (all SQL), `hash.ts` (lens input hashes → staleness) |
| `src/llm/` | `claude.ts` (subprocess runner, retries, `buildArgs`), `enrich.ts` (headline profiles), `dossier.ts` (light/deep web profiles), `lens.ts` (scoring rubric + Haiku pass + Sonnet rerank), `ahoy.ts` (Ahoy check / proposal plan / send) |
| `src/io/` | `csv.ts` (any CSV; LinkedIn exports incl. "Notes:" preamble), `explorer-export.ts` (CRM / full / Ahoy files — mirrored in the page) |
| `src/web/` | `explorer.html` (single-file vanilla UI, no deps), `explorer-server.ts` (node:http API + SSE), `http-common.ts` (security), `CONTRACT.md` (**the API/data-model spec — update it with every change**) |
| `src/mcp/` | stdio MCP server (`network-builder mcp`): 13 `network_*` tools + 2 prompts; see `docs/MCP.md` |
| `desktop/` | macOS Electron shell (own pnpm root + lockfile, so CLI installs never pull Electron): `src/main.ts`, `scripts/build.mjs` (main + fully-bundled server `dist-server/bin.mjs`), `scripts/icon.mjs`, `scripts/install.mjs` (→ /Applications + Dock), `electron-builder.yml` (unsigned, ad-hoc) |
| `test/` | vitest; `test/fixtures/*.csv` are fictional |

## Commands

```bash
pnpm install          # pnpm 12 (packageManager); `prepare` builds dist/
pnpm dev              # tsx from source
pnpm typecheck && pnpm test && pnpm build    # run all three before every commit
```
CI (`.github/workflows/ci.yml`) runs install --frozen-lockfile, typecheck, test, build on Node 22 + 24.

## Product rules (from the user — do not break)

1. **Paid AI work is human-triggered.** Web profiles (light/deep), lens creation/scoring and Ahoy calls are started by the
   user in the explorer (or an explicit CLI command / explicit request). Never auto-research; the MCP server exposes no
   paid actions. Cheap re-scoring of *stale* people after the user's own research is fine when asked.
2. **Lens removals are deliberate.** A person pinned *out* of a lens is the user's judgement — never suggest restoring
   them, never show them outside the lens's "Removed" tab, exports or MCP results, and re-scores must not override pins.
3. **CRM writes go through Ahoy proposals only** (`create_proposal`), which the user approves in the Ahoy app. Never
   use `execute_crm_operations`. Never retry a write blindly (duplicate-proposal risk).
4. **Selection survives filtering**, so every bulk action asks before touching selected people the filters hide
   (`scopeToShown` in the page). Keep that for new actions.
5. **Scores reward evidence, not keywords** (see `LENS_RUBRIC` in `src/llm/lens.ts`): institutional roles and named
   investments beat self-applied headline labels; for "potential …" goals, *capacity* (exits, C-level at scaled
   companies, boards) counts and "no investments found" is neutral.

## Engineering conventions

- **Lens membership** = pinned in, OR (score ≥ lens threshold AND not pinned out). Add pins only where the score alone
  disagrees; remove always pins out. Same logic in the page, server and `src/mcp/data.ts`.
- **Export parity:** page mappers (`crmRow`, `fullRow`, `ahoyFiles`, …, column markers `/*NB_…*/[...]/*END*/`) must
  match `src/io/explorer-export.ts` byte-for-byte; `test/export.test.ts` extracts the page functions and compares.
  Change both sides together.
- **Ahoy field names come from the live schema** (`get_crm_schema` via the Ahoy MCP): Companies `Company Name, Domain,
  Industry`; Contacts `First Name, Last Name, Email, Job Title, Company, LinkedIn URL, Headline, Location`; Notes
  `Title, Content` (markdown). Re-check the schema before adding fields.
- **`claude -p` flags:** non-MCP calls use `--strict-mcp-config` + `--tools ''` (or an explicit built-in tool list).
  MCP calls (`mcpTools`) must NOT pass `--strict-mcp-config` (hides claude.ai connectors) or `--tools ''` (hides MCP
  tools); they disallow all built-ins and allow only the named MCP tools. Never `--bare` (forces API-key auth).
- **Server:** 127.0.0.1 only, per-session token (header `X-NB-Token`; SSE `?t=`), Host/Origin checks, 1 MB bodies.
  One lens job and one Ahoy job at a time (409). Rate-limited web profiles back off, then wait for a manual Resume.
- **Template is re-read per request**, so `pnpm build` (copies `explorer.html` to `dist/`) updates a running explorer's
  page on browser refresh — but new API endpoints need a server restart. The in-memory profile queue is lost on
  restart: save queued ids and re-queue them (don't re-queue people the user cancelled).
- **Data folder:** `$NETWORK_BUILDER_HOME`, else whichever of `~/.network-builder` / the legacy folder actually holds
  `network.db` (an empty new folder must never hide an existing database).
- **Testing UI changes:** run a second explorer on a *copy* of the DB (`sqlite3 db ".backup copy.db"`, `--db copy.db
  --port 47990`, `NB_EXPLORER_TEMPLATE=src/web/explorer.html`) and drive headless Chrome over CDP; never test against
  the user's live explorer or database. pty tests need a real window size (TIOCSWINSZ) or clack renders 1 column.
- **Costs:** web search is rate-limited; light profiles ≈ $0.02 (8 parallel is fine, 16 trips limits), deep ≈ $0.17,
  lens ≈ $0.30/1,000 + $0.50/100 re-checked, Ahoy check ≈ $0.005/person. Two searches rarely identify junior people.

## Desktop app

- The server runs as an Electron **utilityProcess** (Electron 45's Node has `node:sqlite`) from `resources/server/bin.mjs`,
  started with `--no-open --ready-file <tmp>` and `NB_FORCE_SERVE=1`; the window loads the URL from that file. If an
  explorer already runs on the database, the CLI writes `{reused:true}` with its URL and exits.
- Dock-launched apps get a minimal PATH: `main.ts` reads the login shell's PATH (`$SHELL -ilc`) so `claude` is found.
- Smoke test without touching real data: `NETWORK_BUILDER_HOME=<copy> NB_DESKTOP_SMOKE=1 "release/mac-arm64/Network
  Builder.app/Contents/MacOS/Network Builder"` prints `NB_SMOKE_OK <url>` and quits. Logs: `~/Library/Application
  Support/Network Builder/logs/server.log`.
- Rebuild after changing `src/` (the app bundles the CLI): `cd desktop && pnpm build && node scripts/install.mjs`.

## Privacy (the repo is public)

- Never commit the database, real connection CSVs, `outputs/`, `.claude/` or `STATUS.md` (all git-ignored).
- Prompts, tests, docs and screenshots use **fictional** people/companies only (Northwind Ventures, Ledgerly, …).
  Before every push, grep for real contact names, the user's paths/emails and CRM org ids.
- README screenshots are generated from `examples/sample-connections.csv` (fictional) in a temp `NETWORK_BUILDER_HOME`.
