# Setting up network-builder (runbook for Claude Code)

You're setting up network-builder for someone on their Mac. Assume they've never done anything like this. Be warm and
brief. Do every step you can yourself, and give them **one small instruction at a time** for the few things only they
can do (two clicks in Chrome, one on LinkedIn, maybe a login).

When you're done they have: the **Network Builder** app in their Dock; Claude Code connected to their network (MCP
server + skill); their LinkedIn connections imported; Ahoy connected; and they know what to ask next.

Their network stays on their Mac. The AI runs on their own Claude plan (no API key). Importing costs about $0.20 per
1,000 connections; say so before importing.

## 1. Install (you)

```bash
curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh | bash -s -- --agent
```

About a minute. It installs everything automatic (Node.js, the `network-builder` command, the MCP server, the skill, the
desktop app in Applications and the Dock, the Chrome extension folders), checks Claude Code and Ahoy, and ends with a
checklist and **NEXT STEPS FOR THE HUMAN**. Work through those below. It's safe to run again; if a step fails, fix the
cause it names and re-run it.

The command lives at `~/.local/bin/network-builder` (use the full path: this shell may not have it on PATH yet).
`~/.local/bin/network-builder setup --status` shows the checklist at any time (`--json` for machine-readable).

## 2. Add the connections exporter to Chrome (them)

Run this for them first (it copies the folder path and opens Chrome's Extensions page):

```bash
printf '%s' "$HOME/.network-builder/extensions/linkedin-connections-exporter" | pbcopy
open -a "Google Chrome" "chrome://extensions"
```

Then tell them, as one message:

> Chrome just opened its Extensions page.
> 1. Turn on **Developer mode** (the switch at the top right). It only lets you add an extension from a folder on
>    your Mac.
> 2. Click **Load unpacked**.
> 3. Press **⌘ Shift G**, then **⌘ V** (I copied the folder for you), then **Enter** and **Select**.
>
> Tell me when "LinkedIn Connections Exporter" shows up.

Check with `--status` (it reads Chrome's settings; give Chrome a few seconds).
**No Chrome, or a work Chrome that blocks Developer mode?** Use LinkedIn's own export instead: `open
https://www.linkedin.com/mypreferences/d/download-my-data`, they pick **Connections** → **Request archive**, and the
file arrives by email (10 minutes to a day). Step 3 picks up the zip from Downloads too.

## 3. Export and import their connections (them, then you)

```bash
open -a "Google Chrome" "https://www.linkedin.com/mynetwork/invite-connect/connections/"
```

> LinkedIn's Connections page just opened (log in if it asks).
> Click the 🧩 puzzle piece in Chrome's toolbar → **LinkedIn Connections Exporter** → **Start export**, and keep that
> tab in front while it scrolls (about a minute per 500 connections). It downloads a file when it's done.
> If it pauses around 1,900, choose "Pause 60s & retry". If LinkedIn shows a security check, stop and try tomorrow.

Then wait for the file and import it in one go (run it in the background; tell them you're watching for it):

```bash
~/.local/bin/network-builder setup --agent --watch-downloads 30
```

It finds `linkedin-connections-*.csv`, `Connections.csv` or LinkedIn's export zip in Downloads (including names like
`… (1).csv`) and imports it with one progress line per batch.

## 4. Ahoy (them, if it isn't connected)

If the checklist says Ahoy isn't connected: `open https://claude.ai/settings/connectors`, they find **Ahoy** → Connect
and sign in, using the same Claude account as Claude Code. With an Ahoy MCP link instead:
`claude mcp add -s user --transport http ahoy <link>`, and after the restart they type `/mcp` → ahoy → Authenticate.

## 5. Restart and hand over

New MCP servers and skills load when Claude Code starts. Tell them:

> All set! Type `/exit`, then `network-builder claude` to open Claude Code on your network. Then try:
> *"Find the marketing leaders in my network based in Ireland and build an Ahoy pipeline of the target companies and
> people to reach out to."*
>
> The **Network Builder** app in your Dock is where you browse your network, score it for any goal, curate lists and
> research the people you care about.

Open the app for them: `open -a "Network Builder"`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `network_*` tools missing after the restart | `~/.local/bin/network-builder setup --status`; re-run step 1. |
| "Claude Code is not logged in" | They run `claude auth login` in Terminal. |
| The app won't open, or macOS says it's damaged | `xattr -dr com.apple.quarantine "/Applications/Network Builder.app"`, then open it. |
| Intel Mac | No desktop app; `network-builder` opens the same app in the browser. |
| The exporter finds no connections | LinkedIn must be in English; reload the Connections page and start again. |
| LinkedIn security check | Stop for a day. Don't retry repeatedly. |
