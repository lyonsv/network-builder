---
name: network-builder
description: Work with the user's LinkedIn network in network-builder (local database of their connections, scored "lenses", saved lists, target accounts) and turn it into an Ahoy CRM pipeline. Use whenever the user asks about people in their network or connections ("who do I know at…", "find the marketing leaders in my network in Ireland", "angel investors I know", "warm intro to…"), wants a target or outreach list, wants companies and contacts put into Ahoy as a pipeline of deals, or asks to set up, update or troubleshoot network-builder.
---

# network-builder

The user's LinkedIn connections live in a local SQLite database that network-builder manages. You reach it three ways:

| Way | What for |
|---|---|
| **MCP tools** `network_*` (server `network-builder`) | Search, read people, curate lenses, save lists, **plan an Ahoy pipeline** (`network_ahoy_plan`), export, accounts. Free and local. |
| **CLI** `network-builder` (in `~/.local/bin`) via Bash | Import a CSV, **create or re-score a lens** (costs a little on the user's Claude plan), `network-builder db` for counts and spend, `network-builder setup --status` for setup health. |
| **The app** (Network Builder in the Dock, or `network-builder` in Terminal) | The user's own UI: browsing, bulk curation, **web profiles** (light/deep research), Ahoy check/send. |

Ahoy CRM tools come from the user's Ahoy connection (`get_crm_pipelines`, `get_crm_schema`, `query_crm_objects`,
`search_crm`, `create_proposal`, `list_proposals`; prefixed by the server, e.g. `mcp__claude_ai_Ahoy__…` or
`mcp__ahoy__…`).

## Rules (the user's; never break them)

1. **Money is spent only when the user says yes.** Creating or re-scoring a lens and web research cost money on their
   Claude plan. Quote the cost (table below), wait for a yes, and report the real spend afterwards (`network_stats`).
   Web profiles are started by the user in the app; you suggest who needs one.
2. **CRM writes go through Ahoy proposals only** (`create_proposal`), which the user approves in the Ahoy app. Never use
   `execute_crm_operations`. After an error, check `list_proposals` before trying again (no duplicates).
3. **Removals are deliberate.** Someone removed from a lens stays out. Never suggest adding them back.
4. **Check Ahoy before creating anything**, so nothing is duplicated.
5. **Be honest about evidence.** Use people's names, not pronouns. Label locations (see *Location*).

## Costs (API-equivalent; counted against the user's Claude plan, not a separate bill)

| Action | Cost |
|---|---|
| Import + headline profiles | ≈ $0.20 per 1,000 people |
| New lens (score everyone, re-check the top min(150, N)) | ≈ $0.30 per 1,000 people + $0.50 per 100 re-checked |
| Light / deep web profile (in the app) | ≈ $0.02 / ≈ $0.17 per person |
| Everything through MCP, including `network_ahoy_plan`; Ahoy reads; proposals | free |

## First: is it set up?

- No `network_*` tools? If `~/.local/bin/network-builder` exists, Claude Code needs a restart (`/exit`, then
  `claude --continue`). Otherwise set it up (*Setup* below).
- `network_stats` shows 0 people? Their connections aren't imported: run `~/.local/bin/network-builder setup --status`
  and follow it.
- No Ahoy tools? They connect Ahoy at https://claude.ai/settings/connectors → Ahoy (same Claude account), then restart
  Claude Code. With an Ahoy MCP link instead: `claude mcp add -s user --transport http ahoy <link>`, then `/mcp` →
  ahoy → Authenticate.

## Recipe: "targets in my network → a pipeline in Ahoy"

Example: *"Find all the marketing targets in my network in Ireland and build a pipeline in Ahoy of target companies and
people to reach out to."* Keep the user in the loop at the three checkpoints (★); otherwise just work.

**1. Pin down the target.** State your reading in one line instead of asking, unless it's genuinely ambiguous. Good goal
text names role, seniority and place/segment, e.g. `Senior marketing decision makers (CMO, VP/Head/Director of
Marketing, Brand, Growth, Digital, Communications) at companies based in Ireland, or working in Ireland`. Defaults:
decision makers and budget holders (Director / Head of and up); leave out agencies, recruiters and students unless asked.

**2. Filter or lens.** `network_list_lenses`; reuse a lens whose goal matches. Otherwise choose, and say which:
- **Filter (free)** when the network is small (under ~400) or the target is fully described by function + seniority +
  place: `network_search_people` with `function`, `seniority`, `location` and free text. Then offer the upgrade in one
  line: "A scored lens would rank fit and catch unusual titles (≈ $X). Want it?"
- **Lens** otherwise, or when the user wants ranking. ★ Cost check first, then:

  ```bash
  network-builder -p "<goal>" --no-serve 2>&1 | tail -25
  ```

  About a minute per 200 people; for more than ~1,000 run it in the background and tell the user. Then report the real
  spend (`network_stats`) and get the lens id from `network_list_lenses`.

**3. Pull the candidates.** `network_lens_members` (view `in`; also skim the top of `candidates` near the cut-off). For
a place, also try `network_search_people` with `location` and free text (`Dublin`, `Cork`, `Galway`, `Ireland`,
Irish company names). Merge and dedupe by id.

**Location.** LinkedIn exports have no location field. MCP `location` comes from a web profile if there is one
(`location_source: confirmed`), otherwise from the headline (`location_source: headline`). Use three labels:
- **confirmed**: from a web profile;
- **stated**: the headline says so (or a remit like "Head of Marketing, Ireland": call it a remit);
- **likely**: inferred from the company or colleagues.
`network_ahoy_plan` never writes an unconfirmed place into Ahoy. If many top people are only *likely*, suggest light
web profiles in the app (≈ $0.02 each): "Open Network Builder, select them, click Light profile".

**4. ★ Shortlist, grouped by company.** A compact table per company: person, title, score, one-line why, location
label; plus warm paths (`network_find_connections_at`: other connections there). Flag doubts (agencies, stale titles,
UK-and-Ireland remits). Ask what to cut or add. Apply cuts with `network_lens_remove` and adds with `network_lens_add`.

**5. Save the list** after the cuts: `network_save_list`, a clear name (e.g. `Ireland marketing targets · 2026-11`),
`lens` set, people in priority order.

**6. Look things up in Ahoy** (all reads, a handful of calls):
- `get_crm_pipelines` with `object_type: "ahoy_deal"`. More than one pipeline → ask which (suggest the sales /
  new-business one). Use its **first stage** unless told otherwise. No deal pipeline → plan with `include_deals: false`.
- Dedupe in bulk: `query_crm_objects` on `ahoy_contact` filtered by `ahoy_linkedin_url` in the shortlist's URLs, and on
  `ahoy_company` by the companies' names. `search_crm` only for names that didn't match. Note any open deal per matched
  company in the chosen pipeline. Unsure whether a match is the same person or company? Ask.

**7. ★ Plan, confirm, send.** Call `network_ahoy_plan` with `list`, `campaign` (e.g. `Ireland marketing outreach`),
`user_request` (the user's words, exactly), `stage_id`, and `people` = what you found in Ahoy
(`{person_id, contact_id?, company_id?, company_name?, deal_id?}`). It returns the summary and the batches (companies,
contacts, one deal per company in the stage, a "why them" note per person, sources on everything, ≤ 50 operations
each). Tell the user the summary in one line ("6 companies (4 new), 11 people (9 new), 6 deals in MEDDIC → Prospect, 3
proposals for you to approve in Ahoy"). On a yes, for each batch i: call `network_ahoy_plan` again with the **same
arguments plus `batch: i`**, and pass the JSON it returns to `create_proposal` **unchanged** (title, description,
operations). Never edit a batch, and never retry one blindly.

**8. ★ Hand over.** List the proposal links (`url` from each `create_proposal`); nothing changes in Ahoy until the
user approves them there. Offer next: first-message drafts per person (warm path first), deep profiles for the top 5 in
the app, or an account plan for the top companies (`network_create_account` + `network_account_add_people`, then the
`abx_campaign` prompt).

## Other recipes

- **Warm intro to a company or person:** `network_find_connections_at` (current and past), then `network_get_person`
  for the best 2–3; suggest who to ask and a short intro request.
- **"Who in my network is …?"** (investors, founders, hires, press): an existing lens → `network_lens_members`; else
  `network_search_people` with filters (seniority, function, tags like `investor`, `founder`, `board`) and free text.
  When it takes judgement across thousands of people, offer a lens with its cost.
- **Account-based campaign for one company:** `network_get_account` → plan → save it to the brief with
  `network_update_account` (`brief_mode: "append"`) after asking.
- **Export:** `network_export` with preset `crm`, `full` or `ahoy` (CSVs in `~/.network-builder/outputs`).
- **Refresh connections:** they export again with the Chrome exporter; then
  `network-builder import ~/Downloads/linkedin-connections-<date>.csv --no-serve 2>&1 | tail -15`, and
  `network-builder lens rescore <lens> --stale -y` for lenses they care about (cheap: only changed people).

## Setup (not installed, or something's broken)

Safe to re-run; it repairs whatever is missing:

```bash
curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh | bash -s -- --agent   # from Claude Code
~/.local/bin/network-builder setup --status                                                               # what's missing
```

`--agent` does every automatic step, then prints **NEXT STEPS FOR THE HUMAN**; walk them through those one at a time
(full runbook: `SETUP.md` in the repo). After installing, Claude Code needs a restart to load the tools and this skill.
