# Changelog

## Unreleased

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
