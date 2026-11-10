# Network Builder for LinkedIn (Chrome extension)

Adds a **＋ Network Builder** button next to *Message / More* on LinkedIn profiles. One click files the person, with
their full profile, under an **account** (a company you're targeting) in your local Network Builder. From there Claude
can plan an ABX campaign with `network_get_account`.

- **Reads only the person you're viewing, and only when you click.** It then opens that person's own "Show all" lists
  (experience, education, skills, certifications, languages, volunteering, honours) in hidden frames in the same tab, so it
  captures every role with dates and tenure, just as you'd see clicking through. No crawling of anyone else.
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

While the panel is open it reads the full lists (a few seconds); the panel shows what it read. If LinkedIn won't open
them, the visible profile is saved instead.

After updating the extension's files, click ↻ on its card in `chrome://extensions` and reload your LinkedIn tabs.

## When something's wrong

| You see | What it means / what to do |
|---|---|
| Badge **!**, "Not paired" | Pair it (above). |
| "Network Builder isn't running" | Start the app or `network-builder`. Profiles you save meanwhile wait in the extension (the badge shows how many) and are sent automatically once it answers. Retries run every minute. |
| "Pairing rejected" | The pairing was reset, or you're using a different database. Paste a fresh code. |
| Port changed | If another program had the explorer's usual port, it picked a new one. Re-pair from the popup. |
| Red badge with a number | Some saved profiles were refused (e.g. the account was deleted). Open the popup to see why, then **Retry** or **Remove** each one. |
| "Extension was updated — reload this tab" | Reload the LinkedIn tab after updating the extension. |

LinkedIn changes its page markup from time to time. The extension also sends the page's visible text, and Network
Builder falls back to that, so profiles still come through. Parsing lives in `src/accounts/capture.ts` (with tests), so
fixes don't require reinstalling the extension.
