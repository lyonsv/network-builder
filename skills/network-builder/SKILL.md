---
name: network-builder
description: Work with the user's LinkedIn network in network-builder (local database of their connections, scored "lenses", saved lists, target accounts) and turn it into an Ahoy CRM pipeline. Use whenever the user asks about people in their network or connections ("who do I know at…", "find the marketing leaders in my network in Ireland", "angel investors I know", "warm intro to…"), wants a target or outreach list, wants companies and contacts put into Ahoy as a pipeline of deals, or asks to set up, update or troubleshoot network-builder.
---

# network-builder

The user's LinkedIn connections live in a local SQLite database that network-builder manages. You reach it three ways:

| Way | What for |
|---|---|
| **MCP tools** `network_*` (server `network-builder`) | Search, read people, curate lenses, save lists, export, accounts. Free and local. |
| **CLI** `network-builder` (in `~/.local/bin`) via Bash | Import a CSV, **create or re-score a lens** (costs a little on the user's Claude plan), stats. |
| **Explorer** (the **Network Builder** app in the Dock, or `network-builder` in a terminal) | The user's own UI: browsing, bulk curation, **web profiles** (light/deep research), Ahoy check/send. |

Ahoy CRM tools come from the user's Ahoy connection (names like `get_crm_pipelines`, `get_crm_schema`, `search_crm`,
`create_proposal`, `list_proposals`; prefixed by the server, e.g. `mcp__claude_ai_Ahoy__…` or `mcp__ahoy__…`).

## Rules (the user's — never break them)

1. **Money is spent only when the user says so.** Creating or re-scoring a lens and any web research cost money on their
   Claude plan. Say what it costs (table below) and get a yes first. Web profiles are started by the user in the explorer;
   you suggest which people need one, you don't run research yourself.
2. **CRM writes go through Ahoy proposals only** (`create_proposal`), which the user approves in the Ahoy app. Never use
   `execute_crm_operations`. Never re-send a proposal after an error without checking `list_proposals` first (duplicates).
   Max 50 operations per proposal.
3. **Removals are deliberate.** If someone was removed from a lens, keep them out. Never suggest adding them back.
4. **Check Ahoy before creating anything** so you don't duplicate companies or contacts that already exist.
5. Be honest about evidence. Headlines don't give location; say "likely" when you inferred it (see *Location* below).

## Costs (API-equivalent; billed against the user's Claude plan, not a separate bill)

| Action | Cost |
|---|---|
| Import + headline profiles | ≈ $0.20 per 1,000 people |
| New lens (score everyone + re-check the top 150) | ≈ $0.30 per 1,000 people + $0.75 |
| Light web profile / deep web profile (explorer) | ≈ $0.02 / ≈ $0.17 per person |
| Everything through MCP, Ahoy reads, proposals | free |

## First: is it set up?

- No `network_*` tools? network-builder isn't connected to this Claude Code session. If `~/.local/bin/network-builder`
  exists, the user needs to restart Claude Code. Otherwise run the installer (see *Setup* at the end).
- `network_stats` returns 0 people? They haven't imported connections. Walk them through *Setup → step 7*.
- No Ahoy tools? Ask them to connect Ahoy: claude.ai → Settings → Connectors → Ahoy (same Claude account), then restart
  Claude Code. Or, with an Ahoy MCP link: `claude mcp add -s user --transport http ahoy <link>`, then `/mcp` → Authenticate.

## Recipe: "targets in my network → a pipeline in Ahoy"

Example: *"Find all the marketing targets in my network in Ireland and build a pipeline in Ahoy of target companies and
people to reach out to."* Work through these steps, keeping the user in the loop at the two checkpoints (★).

**1. Pin down the target (one short question at most).** Turn the request into a precise goal. If they gave you enough,
don't ask; state your reading. Good goal text names role, seniority, and place/segment, e.g.
`Senior marketing decision makers (CMO, VP/Head/Director of Marketing, Brand, Growth, Digital, Communications) at companies based in Ireland, or working in Ireland`.
Defaults when unsaid: decision makers and budget holders (Director and up, or Head of), exclude agencies/recruiters/
students unless asked.

**2. Find or build a lens.** `network_list_lenses`. Reuse a lens whose goal matches. Otherwise create one (★ cost check:
"Scoring your N people for this costs about $X on your Claude plan, OK?"), then run:

```bash
network-builder -p "<goal>" --no-serve 2>&1 | tail -40
```

It prints progress and the top 15. Large networks take a few minutes: run it in the background with a long timeout and
tell the user it's working. Then `network_list_lenses` to get the new lens id.

**3. Pull the candidates.** `network_lens_members` (view `members`; also look at the top of `candidates` near the
cut-off). For place filters also try `network_search_people` with `location` (only people with web profiles have one)
and free text (e.g. `Dublin`, `Ireland`, `Cork`, Irish company names). Merge, dedupe by person id.

**Location.** LinkedIn connection exports have no location. A person's location is known only if they have a web profile
(`network_get_person` → web profile `location`). Otherwise infer from the headline (e.g. "Dublin", ".ie", an Irish
company) and mark it *likely*. If many top people are unconfirmed, say so and suggest: *"Open Network Builder, filter to
this lens, select the unconfirmed ones and click **Build light profiles** (≈ $0.02 each); then ask me again."*

**4. ★ Show the shortlist, grouped by company.** A compact table per company: person, title, score, one-line why,
location (✓ confirmed / likely), and any extra people you know there (`network_find_connections_at` gives warm paths:
other connections at the same company). Note obvious gaps ("only one contact at Acme"). Ask the user to cut or add.
Apply cuts with `network_lens_remove` (they stay out for good) and adds with `network_lens_add`.

**5. Save the list.** `network_save_list` with a clear name (e.g. `Ireland marketing targets · 2026-11`), `lens` set to
the lens id, people in priority order.

**6. Map onto Ahoy.**
- `get_crm_pipelines` with `object_type: "ahoy_deal"`. If there's more than one deal pipeline, ask which one (suggest the
  sales/new-business one). Use its **first stage** (prospect/target) unless they say otherwise. No deal pipeline at all →
  say so and offer companies + contacts + notes only.
- `get_crm_schema` for `ahoy_company`, `ahoy_contact`, `ahoy_deal`, `ahoy_note` once, to confirm property and
  association names. Typical ones: company `ahoy_name`, `ahoy_domain`, `ahoy_industry`; contact `ahoy_first_name`,
  `ahoy_last_name`, `ahoy_job_title`, `ahoy_headline`, `ahoy_linkedin_url`, `ahoy_location`; deal `ahoy_name`
  (+ the stage via association `ahoy_deal_to_deal_pipeline_stage` → stage `entity_id`; the schema says if a stage is
  required); note `ahoy_title`, `ahoy_content` (markdown). Associations: `ahoy_contact_to_company`,
  `ahoy_deal_to_company`, `ahoy_deal_to_contact`, `ahoy_note_to_contact`, `ahoy_note_to_deal`. Trust the live schema
  over this list.
- **Dedupe**: for every company `search_crm` (object_type `ahoy_company`) by name; for every person `search_crm`
  (`ahoy_contact`) by name and check company / LinkedIn URL. Also look for an open deal for that company in the chosen
  pipeline (`get_associations` from the company, or `search_crm` `ahoy_deal`). Reuse existing records by `entity_id`;
  if a match is unclear, ask.

**7. ★ Confirm the plan, then propose.** Summarise: "N companies (X new), M people (Y new), N deals in <pipeline> →
<stage>, a note on each person with why they're a target. Sent as K proposals you approve in Ahoy." On a yes, call
`create_proposal` once per batch of companies (≤ 50 operations, never split one company across proposals):
- company: `create` (temp_id `co_<n>`) only if new;
- each person: `create` contact (temp_id `p_<n>`) if new, `associate` `ahoy_contact_to_company`;
- deal: `create` `ahoy_deal` named `<Company> — <campaign>` (e.g. `Acme — Ireland marketing outreach`), `associate`
  to its stage, to the company (`ahoy_deal_to_company`) and to each person (`ahoy_deal_to_contact`);
- note per person: `create` `ahoy_note` titled `Why <first name>: <campaign>` with markdown content (role, why they fit,
  score and reason, location confidence, warm paths, suggested opener), `associate` `ahoy_note_to_contact`.
- **sources** on every operation: a `user_message` source quoting the user's request (exact words), plus a `web` source
  with the person's LinkedIn URL (title `LinkedIn profile of <name>`) for facts about them, or `crm_record` for records
  you read in Ahoy. Associations for records created in the proposal cite the same sources as the create.
- Title: `network-builder: <campaign> (i/K)`; description: what it creates.

**8. Finish.** Give the proposal links (`url` from each `create_proposal`) and say nothing changes in Ahoy until they
approve. Offer next steps: draft first messages per person (warm path first), deep profiles for the top 5 in the
explorer, or an ABX plan for the top accounts (`network_create_account` + `network_account_add_people`, then the
`abx_campaign` prompt).

If a `create_proposal` call errors, stop, check `list_proposals` (title contains the campaign) before trying again.

## Other recipes

- **Warm intro to a company or person:** `network_find_connections_at` (current and past employees), then
  `network_get_person` for the best 2–3; suggest who to ask and a short intro request.
- **"Who in my network is …?"** (investors, founders, hires, press): if a lens exists use `network_lens_members`; else
  `network_search_people` with filters (seniority, function, tags like `investor`, `founder`, `board`) and free text. If
  the result needs judgement across thousands of people, propose a lens (with cost).
- **Account-based campaign for one company:** `network_get_account` (brief, buying committee, org chart, warm paths)
  → plan → save to the brief with `network_update_account` (`brief_mode: "append"`) after asking.
- **Export:** `network_export` with preset `crm`, `full` or `ahoy` (writes CSVs to `~/.network-builder/outputs`).
- **Refresh connections:** export again with the Chrome connections exporter, then
  `network-builder import ~/Downloads/linkedin-connections-<date>.csv --no-serve 2>&1 | tail -15`; then
  `network-builder lens rescore <lens> --stale -y` for lenses they care about (cheap: only changed people).

## Setup (when it isn't installed, or something's broken)

The installer is safe to re-run; it repairs whatever is missing:

```bash
curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh | bash -s -- --agent   # from Claude Code
bash <(curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh) --status        # what's missing
```

Interactive (best for a person in a terminal): `curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh | bash`.
The full guided flow for agents is in `SETUP.md` in the repo. After installing, Claude Code must be restarted to load
the MCP server and this skill.
