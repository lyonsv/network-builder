# Changelog

## 0.1.0 — first public release

- `npx network-builder`: guided first-run setup. It checks Claude Code, imports your LinkedIn connections CSV, profiles
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
