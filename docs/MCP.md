# Use your network from Claude Code (MCP)

`network-builder mcp` runs a local [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Add it to
Claude Code, or to any MCP client, and you can ask things like:

> *Who in my network could intro me to Stripe?*
> *List my angel-investor lens members in Dublin who have deep profiles.*
> *Save the top 20 as "Q4 outreach" and export them for Ahoy.*

It reads the same local database as the explorer, re-reading it on every call. You can use both at the same time, and
changes made through MCP (lens adds and removes, lists) appear in the explorer straight away.

## Setup

You need network-builder with your connections already imported. The first run of `network-builder` sets that up.

**Recommended: install once, available in every project.**

```bash
npm install -g github:lyonsv/network-builder
claude mcp add -s user network-builder -- network-builder mcp
```

**Without a global install** (slower to start the first time, while npx downloads and builds):

```bash
claude mcp add -s user network-builder -- npx -y github:lyonsv/network-builder mcp
```

**From a local clone** (after `pnpm build`):

```bash
claude mcp add -s user network-builder -- node /absolute/path/to/network-builder/dist/bin.js mcp
```

The scope option `-s` decides where the server is available:
- `user`: every project.
- `local` (the default): just this project, private to you.
- `project`: writes `.mcp.json` so you can share the setup with your team.

To use a different database, add `-e NETWORK_BUILDER_HOME=/path/to/folder`, or append `--db /path/network.db` after
`mcp`. Check it's connected with `claude mcp list`, or `/mcp` inside Claude Code.

## Tools

| Tool | What it does | Changes data? |
|---|---|---|
| `network_search_people` | Free-text and filter search across headlines, parsed profiles and web profiles (career, investments, boards, recent themes). Filters: seniority, function, tags, company, past company, location, industry, web-profile depth, lens (with view and minimum score), Ahoy CRM status. Sort by score, name or connected date. | no |
| `network_get_person` | Everything about one person, found by id, LinkedIn URL or name: profile, web profile, recent activity, every lens score with membership, and Ahoy status. Lists the candidates if a name is ambiguous. | no |
| `network_find_connections_at` | Who works, or used to work, at a company. Useful for warm intros. | no |
| `network_list_lenses` | Lenses with cut-off, member count, stale scores, and manual adds and removes. | no |
| `network_lens_members` | A lens's members, candidates or removed people, ranked with reasons. | no |
| `network_stats` | Network overview: coverage, breakdowns, top companies, lenses, lists, spend. | no |
| `network_list_lists` / `network_get_list` | Saved lists and their people. | no |
| `network_lens_add` / `network_lens_remove` | Add people to a lens by hand, or remove (dismiss) them. Each undoes the other. | local, reversible |
| `network_set_lens_threshold` | Change a lens's score cut-off. | local, reversible |
| `network_save_list` | Create, replace or append to a named list. | local |
| `network_export` | Write CSVs to the outputs folder: `crm`, `full`, or `ahoy` (Companies, Contacts and Notes files). | writes files |

**Prompts:**
- `warm_intro`: find intro paths to a company or person.
- `lens_shortlist`: build a reasoned shortlist from a lens and save it, asking you first.

Results are paged with `limit`, `offset`, `has_more` and `next_offset`. Search tools take
`response_format: "concise" | "detailed"`. Text output is capped at about 25k characters, with a note saying how to
narrow the results.

## What it deliberately doesn't do

- **Nothing that costs money or touches other systems.** It won't start web research, create or re-score lenses, or send
  anything to Ahoy. Those stay human-triggered in the explorer (`network-builder`). If a task needs them, Claude will
  tell you which people to research there.
- **No deletes.** Removing someone from a lens is reversible, and lists are only created or updated.
- **No network access.** Everything is read from and written to your local SQLite database and outputs folder.

People you've removed from a lens stay hidden from that lens's results, the same as in the explorer, and Claude is told
to respect that.

## Example prompts

- "Who in my network could intro me to Stripe? Rank them by how strong the intro would be."
- "List my angel-investor lens members in Dublin with deep profiles, and what each has been talking about lately."
- "Find heads of marketing at fintech companies I'm connected to."
- "Which candidates in my angel lens score 60–69? Add the ones who've had an exit."
- "Save the top 20 angel-lens members as 'Q4 outreach' and export it for Ahoy."
- "Give me an overview of my network: top companies, seniority mix, and how many people have web profiles."
