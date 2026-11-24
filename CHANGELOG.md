# Changelog

## 0.6.0

**A one-paste setup a newcomer can follow, and an Ahoy pipeline that Claude builds for a few dollars.** Shaped by new-user
walkthroughs of the whole path: README → installer → app → Claude Code.

- **`network-builder setup`**: a guided setup wizard (Claude Code and its login, the Claude Code connection and skill,
  the desktop app, Chrome, your connections, Ahoy) that ends with a checklist of what's done and what's left. Safe to
  run again. `--status [--json]` checks everything (exit code 1 when something's missing); `--agent` is the same for
  Claude Code, with `--watch-downloads <min>` to wait for the export and import it.
  - Connections: the Chrome exporter, **LinkedIn's own export** (its emailed zip works too), or a file you drag in
    (`~`, quotes and `\ (1)` escapes handled). It spots the file in Downloads.
  - The desktop app is downloaded only when its version changes, swapped in safely, and only that copy is quit.
  - Apple silicon is detected even under Rosetta.
- **`install.sh` is now a small bootstrap**: a private Node.js and the CLI from the pinned latest release (skipped when
  current), the `network-builder` command, then the wizard. No more build-from-`main` fallback.
- **`network_ahoy_plan`** (MCP, free, local): turns a list, a lens or chosen people into ready `create_proposal` batches:
  companies, contacts, one deal per company in a pipeline stage and a "why them" note per person, grouped by company,
  ≤ 50 operations, with sources on every operation. Claude passes them on unchanged. The Ireland → Ahoy flow now costs
  ≈ $2.40 and ~2 minutes instead of an estimated $8–12. Guessed (headline) locations are never written to Ahoy.
- MCP: `location_source` (`confirmed` from a web profile, `headline` otherwise) on people; the instructions now say a
  lens can be created with the CLI when the user agrees to the cost (they used to say it couldn't).
- The skill: filter-or-lens rule with the price, three location labels (confirmed / stated / likely), bulk Ahoy dedupe,
  the planner, real spend reported after paid runs; fixed a wrong view name and a nonexistent command.
- **`network-builder claude`** opens Claude Code in a network workspace (not your home folder, so no "trust your home
  folder" warning). **`network-builder uninstall [--delete-data]`** removes everything setup added.
- When output isn't a terminal (Claude Code, logs), progress is one line every few seconds instead of a spinner flood,
  and there's no banner. Model work checks the Claude Code login first instead of failing silently ("Profiled 0/N").
- **Send to Ahoy** (in the app) now includes a LinkedIn source on each operation, as Ahoy requires.
- README rewritten for newcomers: one labelled install line, what it changes, uninstall, "Your first 15 minutes", a
  task-by-task **Using the app**, costs, data. Accounts and the marketing org map moved to `docs/`.

## 0.5.0

- **One-step setup for someone new.** `install.sh` and the `network-builder` Claude Code skill; `SETUP.md` runbook.

### Also in 0.5.0

- **Chrome extension 0.3.3:** when LinkedIn's **Next** loads the next results page as a full page load, the walk now
  continues on that page (same run, cap and counts) instead of stopping after page 1. The page number is read only once
  the results have rendered.
- **Chrome extension 0.3.2:** people-search cards on LinkedIn's newer layout (`role="listitem"`, 2nd-degree cards with
  a mutual-connections row) are read again, with the card's own profile link. A full page load mid-walk (LinkedIn
  jumps back to page 1 past the last results page) now ends the run cleanly — "Done — reached the end of the results"
  or "stopped" — and never resumes by itself. Slow pages show "Waiting for LinkedIn to load page N… Xs"; 60 s without
  new results stops as *stalled*.
- List runs that never finish are closed as *abandoned* after 10 minutes idle (on the next run for the account, or at
  start). Schema migration 7 (`account_list_runs.updated_at`).

## 0.4.0

- **Marketing org map** (Accounts → **Marketing org**): for one account, everyone in marketing, the team's size
  (captured vs LinkedIn's "What they do → Marketing" count when Marketing is among the top 5 functions LinkedIn shows,
  else the company total), sub-function × seniority, legal entities, and a reporting
  tree where every suggested line shows its source and confidence. See the README's "Map a marketing org".
  - **Chrome extension 0.3.1:** walks a LinkedIn people search (or People tab list) after your click, in the visible
    tab only, at human pace, capped per run and per day, and stops on any security check. **Capture headcount only**
    reads the People tab's member count and the visible "What they do" numbers (usually the top 5). Listed people become *light contacts* on the
    account; "LinkedIn Member" rows are kept only as counts.
  - **✦ Classify & suggest reporting lines** (Haiku, titles only, about $0.02 for 48 people) and **🌐 Research on the
    web** (company pages, press, job ads, never LinkedIn; every finding has an evidence URL and quote; about $0.21 for
    two passes, an estimated $0.30–1.40 for a full run). Both are started by you and show an estimate first.
  - **✓ Confirm / Change… / ↺** on every suggested line; your choices always win over later suggestions.
  - Identity and dedupe across list rows, full captures and connections (URN vs vanity URLs, name + title).
  - Vendor-funded marketers stay in the org with a tag; people at another employer are flagged and not counted.
  - Live LinkedIn findings: a keyword search on a People tab now redirects to people search results (10 per page, no
    results count), so the headcount comes from "Capture headcount only" on the unfiltered People tab, and group
    companies are walked per entity page.
- **MCP:** new read-only `network_get_org_map` (tree with `[confirmed]` / `[inferred 0.6]` / `[web 0.9]` tags,
  headcounts, sub-functions, flagged people, evidence). `network_get_account` adds a short "Marketing org" section.
  `network_account_update_person` sets sub-function, team, entity, country, responsibilities and noise, and
  `confirm_reports_to` accepts a suggested line. `network_account_add_people` takes `contacts` (light contacts, deduped).
  No paid actions over MCP. 22 tools.
- Schema migration 6: light contacts and their sources, org fields on account members, reporting-line provenance,
  headcount snapshots, list runs and org facts.
- **Desktop app:** if the explorer server can't start (e.g. the database is newer than the app), the window now shows
  the error instead of spinning forever.
- **Explorer header:** People / Accounts are now clear tabs beside the logo, and a 🧩 button shows the Chrome
  extension's status (not set up / waiting to pair / connected) and opens pairing.
- **Accounts (ABX):** the explorer has a new **Accounts** view. Each account holds:
  - an ABX brief in markdown;
  - its key people as an org chart (department → seniority, placed from job titles and correctable), each with a
    buying-committee role, reporting line and notes;
  - coverage gaps and your warm paths in.

  **⧉ Copy for AI** copies the whole account as one markdown document. In People, **Add to account ▾** files selected
  connections under an account.
- **Chrome extension** (`extension/`): a **＋ Network Builder** button on LinkedIn profiles captures the person you're
  viewing into an account. It reads their full "Show all" lists (every role with dates and tenure, education, skills,
  certifications, languages, volunteering, honours) plus the page text as a fallback.
  - Pairing uses a long-lived, add-only capture token.
  - If the app isn't running, profiles wait in the extension and are sent automatically, with clear status, retry and
    notifications.
  - Captured people are kept out of your network: no lenses, People view, network search or exports.
- **MCP:** 8 new account tools (`network_get_account` returns everything for one account in one call), an `abx_campaign`
  prompt and `account://<id>` resources.
- Schema migration: `accounts`, `contacts` (+ `contact_captures` history), `account_members`.

## 0.3.0

- **Desktop app (macOS):** `desktop/` is an Electron shell (Network Builder.app) that runs the explorer server as a
  utility process, shows the explorer in a native window, and picks up your login-shell PATH so Claude Code works from
  the Dock.
  - It handles first-run CSV import, has a File menu (import, open in browser, data/exports folders, server log), and
    stops the server gracefully on quit.
  - `scripts/install.mjs` copies it to /Applications and pins it to the Dock.
- CLI: `--ready-file <path>` writes the explorer URL once it's up. `NB_FORCE_SERVE=1` serves without a TTY.

## 0.2.0

- **MCP server** (`network-builder mcp`) so Claude Code and other MCP clients can use your network. It has 13 tools:
  search, people, connections at a company, lenses, lens membership and cut-off, lists, stats and export, plus two
  prompts. It reads the database live and exposes no paid actions. See [docs/MCP.md](docs/MCP.md).
- **Ahoy CRM integration** through your Ahoy connector in Claude Code:
  - a read-only check of who's already in Ahoy, with company domains and association checks;
  - picking the right record when several match;
  - sending new people, companies and research notes as proposals you approve in Ahoy.

  The explorer gains an Ahoy column, filter, menu and panel.

## 0.1.0 — first public release

- `npx github:lyonsv/network-builder`: guided first-run setup. It checks Claude Code, imports your LinkedIn connections CSV, profiles
  every headline cheaply, offers a starter lens, then opens the local explorer.
- Imports the [LinkedIn connections exporter](https://github.com/lyonsv/chrome-linkedin-connections-exporter) CSV,
  LinkedIn's official `Connections.csv`, or any CSV with name, title and URL columns. Repeat imports merge.
- **Lenses** score your whole network against any goal: Haiku scores everyone, then Sonnet re-checks the top candidates.
  - Membership is editable: In lens, Candidates, Removed and Everyone tabs, a score cut-off, manual add, remove and
    restore, and bulk actions on filtered rows.
  - You can reword and re-score a lens in place.
- **Web profiles** (light and deep) for the people you pick, built with Claude's web search. Deep profiles include
  recent activity and themes. A queue spaces out searches to stay under web-search rate limits.
- Saved lists and CSV export: a CRM preset (HubSpot/Salesforce-friendly columns), a full preset, and an **Ahoy CRM import**
  bundle (one .zip with Companies, Contacts and Notes CSVs using Ahoy's field names). You can also export a whole lens.
- Add or remove people from any lens via the selection bar. Before acting on selected people that the current filters
  hide, it asks whether to include them.
- Everything is stored locally in SQLite under `~/.network-builder/`. Model calls run through your Claude Code login,
  so no API key is needed.
