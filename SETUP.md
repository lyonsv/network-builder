# Setting up network-builder (runbook for Claude Code)

You are setting up network-builder for someone on their Mac. Assume they have never used a terminal tool like this.
Be warm and brief, do every step you can yourself, and give them **one small instruction at a time** for the parts only
they can do (clicking in Chrome, logging in). When it's done, they should have:

- the `network-builder` command, its MCP server connected to Claude Code, and the `network-builder` skill;
- the **Network Builder** desktop app in Applications and the Dock;
- the LinkedIn connections exporter in Chrome, and their connections imported;
- Ahoy CRM connected to Claude Code;
- and know what to ask next.

Everything stays on their Mac. AI work runs through their own Claude Code login (no API key). Importing costs about
$0.20 per 1,000 connections on their Claude plan; tell them that before importing.

## 1. Run the installer

```bash
curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh | bash -s -- --agent
```

It's idempotent; re-run it whenever something looks wrong. It installs a private Node.js, the CLI, the MCP server
(`claude mcp add -s user network-builder`), the skill (`~/.claude/skills/network-builder`), the desktop app, and
downloads the Chrome extensions to `~/.network-builder/extensions/`. It ends with **NEXT STEPS FOR THE HUMAN**; work
through those below. If it fails, read the error, fix the cause (network, disk, permissions), and run it again.

Check progress at any point:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh) --status
```

(Agent mode skips the "add to Dock" confirmation; it adds the app to the Dock.)

## 2. Load the connections exporter in Chrome (the human does this)

Run these for them first:

```bash
printf '%s' "$HOME/.network-builder/extensions/linkedin-connections-exporter" | pbcopy
open -a "Google Chrome" "chrome://extensions"
```

Then tell them, one message:

> Chrome just opened its Extensions page.
> 1. Turn on **Developer mode** (top right).
> 2. Click **Load unpacked**.
> 3. Press **⌘ Shift G**, then **⌘ V** (I copied the folder for you), **Enter**, then **Select**.
> Tell me when you see "LinkedIn Connections Exporter" on the page.

Verify: `--status` shows `Chrome: LinkedIn Connections Exporter loaded`. Chrome may take a few seconds to save it.
No Chrome? Ask them to install it from https://www.google.com/chrome/ first.

The second extension, **Network Builder for LinkedIn** (`~/.network-builder/extensions/network-builder`), is optional:
it adds a button on LinkedIn profiles to file people under target companies, and maps a company's team. Mention it,
don't push it. To pair it they open Network Builder → Accounts → 🧩 Chrome extension… → Copy pairing code.

## 3. Export their connections (the human does this)

```bash
open -a "Google Chrome" "https://www.linkedin.com/mynetwork/invite-connect/connections/"
```

> LinkedIn's Connections page just opened (log in if asked).
> Click the 🧩 puzzle icon in Chrome's toolbar → **LinkedIn Connections Exporter** → **Start export**.
> Keep that tab in front while it scrolls, about a minute per 500 connections. It downloads a CSV when it's done.
> (If it pauses around 1,900, choose "Pause 60s & retry".)

Watch for the file yourself instead of asking them to find it:

```bash
ls -t ~/Downloads/linkedin-connections-*.csv ~/Downloads/Connections*.csv 2>/dev/null | head -1
```

Poll every 30 seconds or so (tell them you're watching). LinkedIn's own data export (`Connections.csv`, emailed by
LinkedIn) works too.

## 4. Import

Tell them the cost first (≈ $0.20 per 1,000 people on their Claude plan), then:

```bash
~/.local/bin/network-builder import "<the csv>" --no-serve 2>&1 | tail -15
```

The output ends with the counts (the spinner is noisy, hence `tail`). Run it in the background for big networks (several minutes for a few thousand). It's resumable: if it stops, run it
again. Afterwards, `~/.local/bin/network-builder db` shows the counts.

## 5. Connect Ahoy

```bash
claude mcp list 2>/dev/null | grep -i ahoy
```

If nothing shows as `✔ Connected`, either:
- **claude.ai connector (easiest):** `open https://claude.ai/settings/connectors`. They find **Ahoy**, click Connect,
  sign in to Ahoy. It must be the same Claude account they use in Claude Code.
- **MCP link from Ahoy:** if they have a link like `https://api.ahoy.ai/api/orgs/<id>/mcp/`, run
  `claude mcp add -s user --transport http ahoy <link>`; after the restart in step 6 they type `/mcp` → ahoy →
  Authenticate.

Check again with `claude mcp list`.

## 6. Restart and hand over

New MCP servers and skills load when Claude Code starts. Tell them:

> All set. Type `/exit`, then run `claude` again (or `claude --continue` to keep this conversation).
> Then try: *"Find the marketing leaders in my network based in Ireland and build an Ahoy pipeline of the target
> companies and people to reach out to."*

Also tell them about the **Network Builder** app in their Dock: it's where they browse their network, curate lists, and
start web research on the people they care about. Open it for them: `open -a "Network Builder"`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `network_*` tools missing after restart | `claude mcp get network-builder`; re-run the installer. |
| "Claude Code not logged in" | `claude auth login` (they do it in a terminal). |
| Desktop app won't open / "damaged" | `xattr -dr com.apple.quarantine "/Applications/Network Builder.app"`, then open it again. |
| Intel Mac | No desktop app; `network-builder` opens the same explorer in the browser. |
| Exporter finds no cards | LinkedIn UI must be in English; reload the connections page and start again. |
| LinkedIn shows a security check | Stop. Wait a day. Don't retry repeatedly. |
