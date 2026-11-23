# Network Builder for LinkedIn (Chrome extension)

Adds a **＋ Network Builder** button next to *Message / More* on LinkedIn profiles. One click files the person, with
their full profile, under an **account** (a company you're targeting) in your local Network Builder. From there Claude
can plan an ABX campaign with `network_get_account`. On a company's **People** tab or a **people search**, a
**⇣ Map to Network Builder** button files the list you're looking at under an account
([Mapping a team from a list](#mapping-a-team-from-a-list)).

- **Reads only what is on your screen, and only when you click.** For a profile, it then opens that person's own
  "Show all" lists (experience, education, skills, certifications, languages, volunteering, honours) in a minimized
  window, reads them and closes it, so it captures every role with dates and tenure, just as you'd see clicking
  through. Full profiles are always one click per person; nothing opens profiles for you.
- **Lists are walked only in the tab you're looking at**, after you press Start, at human pace and within caps (below).
- **Sends only to your own machine** (`http://127.0.0.1:<port>`). It contacts no other server, and nothing costs money.
- **People you capture are not added to your network.** They live under the account, never in your connections,
  lenses or exports.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose this `extension/` folder.
3. Pin it: 🧩 menu → pin **Network Builder for LinkedIn**.

## Pair it with Network Builder

1. Start Network Builder: the desktop app, or `network-builder` in a terminal.
2. In the explorer, open **Accounts → 🧩 Chrome extension…** and click **Copy pairing code**.
3. Click the extension icon, paste the code and click **Pair**.

The code holds the explorer's local address and a capture token. The token only lets the extension *add* people to
accounts. **Reset pairing** in the same dialog revokes it.

## Using it

Open a profile, click **＋ Network Builder**, then:

1. Check the **account**. It's prefilled from the person's current company. Typing a new name creates that account.
2. Optionally set their **buying-committee role** and add **notes**.
3. Click **Add to Network Builder**.

Adding someone again refreshes their profile, and the earlier capture is kept.

While the panel is open it reads the full lists (a few seconds; a minimized Chrome window appears briefly). The panel
shows what it read, and after saving, how many roles and schools were stored. If LinkedIn won't open the lists, the
visible profile is saved instead.

After updating the extension's files, click ↻ on its card in `chrome://extensions` and reload your LinkedIn tabs.

## Mapping a team from a list

1. Run a LinkedIn **people search** for the team, e.g. *marketing* filtered to the company. (A keyword search on a
   company's **People** tab now redirects to these search results: 10 per page with a **Next** button.)
2. Click **⇣ Map to Network Builder** (bottom right). Check the **account** (preselected when the account's LinkedIn
   page is this company) and the **most rows this run**.
3. Click **Start mapping** and keep the tab in front. **Cancel** stops at once.

**Headcount only.** LinkedIn's people search no longer shows a result count, so the size of the org comes from the
company **People** tab. On that tab (without a keyword search, for the company total), make the member count and the
**What they do** box visible — flip the insights carousel to it if needed — and click **Capture headcount only**. It
reads "N associated members" and the What they do counts that are visible — on LinkedIn's current layout only the top 5
functions, so Marketing may be missing (the job-function filter doesn't filter the page either). On older layouts with
a **Show more** in that box it clicks it at most once, as a fallback. It saves the counts and reads no people. Do it once per company page (each legal entity's page adds up in the org map). For a group company,
capture the headcount and walk the search for each entity page, picking the same account each time.

What it does and doesn't do:

- **Starts only when you press Start** on that page. Nothing runs by itself, on a timer, or in another tab.
- **Runs only in the visible tab.** It pauses as soon as you switch tabs or minimize the window and carries on when
  you come back. It never opens windows or tabs for a list.
- **Human pace:** 2.5–4 s between loads, slower (up to 8 s more) whenever LinkedIn loads nothing new; search pages turn
  at most once every 4–7 s, with the visible **Next** button.
- **Caps:** 300 rows per run by default, 500 at most, and 1,000 rows a day in this browser. Network Builder also refuses
  more than 1,000 rows for one run.
- **Stops immediately** on a LinkedIn checkpoint, captcha, sign-in page, "unusual activity" or limit message, when the
  list ends, or when you leave the page. Complete any check yourself and wait before mapping again.
- **Reads only what you can see:** each result's name, headline, location and profile link, the "N associated members"
  count and the **What they do** numbers. No hidden fields, no data attributes, no requests of its own to LinkedIn.
- **"LinkedIn Member" rows** (people outside your network) are kept only as anonymous counts, never as contacts.
- Everyone else is saved as a *light contact* on the account (no full profile). Open a person and click
  **＋ Network Builder** when you want their full profile.
- If Network Builder isn't running, the walk pauses with the error and a **Retry** button (lists are not queued).
- **Slow pages:** when LinkedIn shows grey placeholder cards, the panel says "Waiting for LinkedIn to load page N… 12s".
  After 60 seconds without new results the walk stops as *stalled*: reload the page and start again (people already
  read are saved).
- **If the page reloads mid-walk** (LinkedIn jumps back to page 1 when you page past the last results page, or you
  reload), the walk can't carry on. The extension remembers the running walk for that tab only while Chrome is open and,
  after the load, closes the run: "Done — reached the end of the results (N people)" when LinkedIn went back to an
  earlier page of the same search right after **Next**, otherwise "the walk stopped". **It never restarts a walk by
  itself** — click **Start** again if you want more.
- Runs that never finish (tab closed, app quit) are closed by Network Builder as *abandoned* after 10 minutes without
  activity, when you start a new run for that account or when Network Builder starts.

**LinkedIn's terms restrict automated browsing.** LinkedIn may limit or restrict accounts that browse a lot. Keep runs
small, map one team at a time, and stop if you see a security check.

## When something's wrong

| You see | What it means / what to do |
|---|---|
| Badge **!**, "Not paired" | Pair it (above). |
| "Network Builder isn't running" | Start the app or `network-builder`. Profiles you save meanwhile wait in the extension (the badge shows how many) and are sent automatically once it answers. Retries run every minute. |
| "Pairing rejected" | The pairing was reset, or you're using a different database. Paste a fresh code. |
| Port changed | If another program had the explorer's usual port, it picked a new one. Re-pair from the popup. |
| Red badge with a number | Some saved profiles were refused (e.g. the account was deleted). Open the popup to see why, then **Retry** or **Remove** each one. |
| "Extension was updated — reload this tab" | Reload the LinkedIn tab after updating the extension. |
| A search walk reads 0 rows though results are visible | Update to 0.3.2+ (2nd-degree cards with mutual connections were skipped on LinkedIn's newer layout). |
| "Waiting for LinkedIn to load page N…" for a long time | LinkedIn is slow; after 60 s the walk stops as *stalled*. Reload the page and start again. |

LinkedIn changes its page markup from time to time. The extension also sends the page's visible text, and Network
Builder falls back to that, so profiles still come through. Parsing lives in `src/accounts/capture.ts` and
`src/accounts/list-capture.ts` (with tests), so most fixes don't require reinstalling the extension. Finding list
cards on the page lives in `list-reader.js` (known selectors first, then a structural fallback).
