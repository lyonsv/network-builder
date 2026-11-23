/* Network Builder for LinkedIn — content script.
 *
 * On a profile page (linkedin.com/in/<slug>) it adds a "Network Builder" button next to Message / More. Clicking it
 * opens a small panel to file the person under an account. Only the profile you are looking at is read, only when you
 * click — no crawling, no background page loads.
 *
 * On a company's People tab or people-search results it adds a "Map to Network Builder" button. A click opens a panel;
 * only its Start button walks the list, in this tab, at human pace, within the caps (see "lists" below).
 */
(() => {
  if (window.__nbLoaded) return;
  window.__nbLoaded = true;

  const ROLES = [
    ['', 'No role yet'],
    ['decision-maker', 'Decision maker'],
    ['champion', 'Champion'],
    ['influencer', 'Influencer'],
    ['user', 'End user'],
    ['gatekeeper', 'Gatekeeper / procurement'],
    ['blocker', 'Blocker'],
  ];

  // ---------- messaging (survives the extension being reloaded under an open tab) ----------
  async function send(msg) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      return r || { ok: false, kind: 'error', message: 'No answer from the extension.' };
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/context invalidated|Receiving end does not exist/i.test(m)) {
        return { ok: false, kind: 'reload', message: 'The Network Builder extension was updated — reload this LinkedIn tab (⌘R) and try again.' };
      }
      return { ok: false, kind: 'error', message: m };
    }
  }

  // ---------- page detection ----------
  const profileSlug = () => {
    const m = /^\/in\/([^/]+)\/?$/.exec(location.pathname);
    return m ? m[1] : '';
  };
  const profileUrl = () => `https://www.linkedin.com/in/${profileSlug()}`;

  // ---------- scraping ----------
  const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  /** LinkedIn renders each visible string in span[aria-hidden=true] (plus a screen-reader copy): read those, in order */
  function linesOf(root, exclude) {
    const spans = [...root.querySelectorAll('span[aria-hidden="true"]')].filter(
      (s) => !(exclude && exclude.contains(s)) && !s.parentElement.closest('span[aria-hidden="true"]'),
    );
    let lines = spans.map(txt).filter(Boolean);
    if (!lines.length) {
      // markup changed: fall back to visible text, de-duplicating the screen-reader copies
      const clone = root.cloneNode(true);
      if (exclude) {
        const ex = clone.querySelector('ul');
        if (ex) ex.remove();
      }
      clone.querySelectorAll('.visually-hidden, button, svg').forEach((n) => n.remove());
      lines = (clone.innerText || clone.textContent || '').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    }
    const out = [];
    for (const l of lines) if (l !== out[out.length - 1] && !/^(…?see more|show all|show more)$/i.test(l)) out.push(l);
    return out;
  }

  /** the name from the tab title ("(3) Riley Test | LinkedIn") — survives markup changes */
  const titleName = () => (document.title || '').replace(/^\(\d+\+?\)\s*/, '').replace(/\s*[|–-]\s*LinkedIn.*$/i, '').trim();

  const visible = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
  const label = (e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).replace(/\s+/g, ' ').trim();

  /** the profile's name heading: <h1> in <main> (classic markup), any <h1>, or a heading whose text is the name */
  function nameEl() {
    const h = document.querySelector('main h1') || document.querySelector('h1');
    if (h && txt(h)) return h;
    const name = titleName();
    if (!name) return null;
    for (const e of document.querySelectorAll('h1, h2, [role="heading"]')) if (txt(e) === name || txt(e).startsWith(name)) return e;
    return null;
  }

  /** profile action buttons (Message / More / Connect / Follow), in page order, skipping our own and the global nav */
  function actionButtons() {
    const root = document.querySelector('main') || document.body;
    const re = /^(message|more|more actions|connect|follow|pending)\b/i;
    return [...root.querySelectorAll('button, a[role="button"], a[href*="/messaging/"]')].filter(
      (e) => visible(e) && !e.closest('#nb-add-btn, header, nav, aside, [role="dialog"]') && label(e).length < 60 && re.test(label(e)),
    );
  }

  /** the row holding Message / More: the smallest element containing two action buttons, else one button's row */
  function findActionBar() {
    const btns = actionButtons().filter((e) => e.getBoundingClientRect().top + window.scrollY < 1400);
    if (!btns.length) return null;
    const [a, b] = btns;
    if (b) {
      let n = a.parentElement;
      while (n && !n.contains(b)) n = n.parentElement;
      if (n && n !== document.body && n.tagName !== 'MAIN') return n;
    }
    return a.parentElement?.parentElement || a.parentElement;
  }

  function topCard() {
    const n = nameEl();
    if (n) return n.closest('section') || n.parentElement?.parentElement?.parentElement || n.parentElement;
    const bar = findActionBar();
    return bar ? bar.closest('section') || bar.parentElement : null;
  }

  function sectionItems(section) {
    const list = section.querySelector('ul');
    return list ? listItems(list) : [];
  }
  function listItems(list) {
    return [...list.children]
      .filter((li) => li.tagName === 'LI')
      .map((li) => {
        const nested = li.querySelector('ul');
        const item = { lines: linesOf(li, nested) };
        if (nested) item.sub = [...nested.children].filter((x) => x.tagName === 'LI').map((x) => linesOf(x)).filter((l) => l.length);
        const a = li.querySelector('a[href*="/company/"]');
        if (a) item.companyUrl = a.href;
        return item;
      })
      .filter((it) => it.lines.length || (it.sub && it.sub.length));
  }

  /** headline + location from the lines after the name (skips "· 1st", pronouns, badges such as "LIVE") */
  function topLines(main, fullName) {
    const lines = (main.innerText || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const i = lines.indexOf(fullName);
    if (i < 0) return { headline: '', location: '' };
    const skip = (l) => /^·/.test(l) || /^(1st|2nd|3rd\+?)$/.test(l) || /^\(?(he|she|they)\/\w+\)?$/i.test(l) ||
      /^(live|verified|premium|open to work|hiring|creator|top voice)$/i.test(l) || l.length < 3;
    const rest = lines.slice(i + 1, i + 12).filter((l) => !skip(l));
    const headline = rest[0] || '';
    const loc = rest[1] && rest[1] !== 'Contact info' && !/followers|connections/i.test(rest[1]) ? rest[1] : '';
    return { headline, location: loc };
  }

  function scrape() {
    const main = document.querySelector('main') || document.body;
    const card = topCard();
    const fullName = txt(nameEl()) || titleName();
    const tl = topLines(main, fullName);
    let headline = tl.headline || txt(card && card.querySelector('.text-body-medium'));
    let location = tl.location || txt(card && card.querySelector('.text-body-small.inline.t-black--light, span.text-body-small.inline'));
    let currentCompany = '';
    const cc = card && card.querySelector('[aria-label^="Current company"]');
    if (cc) currentCompany = (/Current company:\s*(.+?)\.\s*Click/i.exec(cc.getAttribute('aria-label')) || [])[1] || txt(cc);

    const sections = {};
    let about = '';
    for (const anchor of main.querySelectorAll('section > div[id]')) {
      const key = anchor.id;
      const section = anchor.parentElement;
      if (!key || !section) continue;
      const heading = txt(section.querySelector('h2 span[aria-hidden="true"]')) || txt(section.querySelector('h2')) || key;
      if (key === 'about') {
        const body = section.querySelector('.inline-show-more-text span[aria-hidden="true"]') || section.querySelector('.inline-show-more-text');
        about = body ? (body.innerText || txt(body)).trim() : linesOf(section).filter((l) => l !== heading).join('\n');
        continue;
      }
      const items = sectionItems(section);
      if (items.length) sections[key] = { heading, items };
    }
    if (!headline && card) {
      const ls = linesOf(card);
      headline = ls[ls.indexOf(fullName) + 1] || '';
    }
    const firstExp = sections.experience && sections.experience.items[0];
    return {
      url: profileUrl(),
      fullName,
      headline,
      location,
      currentCompany,
      currentCompanyUrl: (firstExp && firstExp.companyUrl) || '',
      about,
      sections,
      rawText: (main.innerText || '').slice(0, 60000),
    };
  }

  // ---------- full lists (/details/<kind>/): every role with dates & tenure, all education, skills, … ----------
  // The profile page only shows a summary (and renders sections lazily). On click, the background opens the person's
  // "Show all" pages in a minimized window — exactly what you'd see clicking through — and this script, running in
  // each of those tabs, answers with the list text once the page has settled.
  const DETAIL_KINDS = ['experience', 'education', 'skills', 'certifications', 'languages', 'volunteering-experiences', 'honors'];

  async function loadDetails(slug) {
    const r = await send({ type: 'readDetails', slug, kinds: DETAIL_KINDS });
    const out = {};
    const diag = {};
    const res = (r && r.results) || {};
    for (const kind of DETAIL_KINDS) {
      const x = res[kind];
      const word = kind === 'volunteering-experiences' ? 'volunteer' : kind === 'honors' ? 'hono' : kind.slice(0, 7);
      const has = x && x.text && x.text.slice(0, 4000).toLowerCase().includes(word);
      diag[kind] = !x ? (r && r.message) || 'not read' : has ? `${x.status} ${x.text.length}` : x.text ? `${x.status} no-list ${x.text.length}` : `${x.status} empty`;
      if (has) out[kind] = { text: x.text.slice(0, 30000), items: x.items || [] };
    }
    return { details: out, diag, error: r && r.ok === false ? r.message : '' };
  }

  // in a list tab opened by the background: report the page's list once its text stops changing
  if (/^\/in\/[^/]+\/details\/[^/]+\/?$/.test(location.pathname)) {
    let lastLen = -1;
    let stableSince = Date.now();
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (!msg || msg.type !== 'nb-read-list') return false;
      const main = document.querySelector('main') || document.body;
      try {
        window.scrollTo(0, document.documentElement.scrollHeight); // trigger lazy loading
      } catch {}
      const text = (main && main.innerText) || '';
      if (text.length !== lastLen) {
        lastLen = text.length;
        stableSince = Date.now();
      }
      const ready = text.trim().length > 15 && Date.now() - stableSince > 1500;
      let items = [];
      if (ready) {
        const lists = [...main.querySelectorAll('ul')].filter((u) => !u.parentElement.closest('ul'));
        const big = lists.sort((x, y) => y.children.length - x.children.length)[0];
        items = big ? listItems(big) : [];
      }
      reply({ ready, text: text.slice(0, 30000), items, url: location.href });
      return false;
    });
  }

  const guessCompany = (p) =>
    p.currentCompany || ((/\s(?:at|@)\s(.+?)(?:\s[|•·]\s|$)/i.exec(p.headline) || [])[1] || '').trim();

  // ---------- UI ----------
  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; }
    .panel { position: fixed; top: 64px; right: 20px; width: 360px; max-height: calc(100vh - 84px); overflow: auto; z-index: 2147483000;
      background: #fff; color: #1c1c1a; border: 1px solid #d2d2cc; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.18); font-size: 13px; line-height: 1.45; }
    @media (prefers-color-scheme: dark) { .panel { background: #1d2226; color: #ecece8; border-color: #3a3a37; } .muted { color: #a3a39d !important; }
      input, select, textarea { background: #12161a !important; color: #ecece8 !important; border-color: #3a3a37 !important; } }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; }
    header b { font-size: 14px; flex: 1; }
    .x { border: 0; background: none; font-size: 18px; cursor: pointer; color: inherit; padding: 0 4px; }
    .body { padding: 0 14px 14px; }
    .who { margin-bottom: 10px; } .who .n { font-weight: 600; font-size: 14px; } .muted { color: #6b6b66; }
    .banner { border-radius: 8px; padding: 8px 10px; margin: 0 0 10px; font-size: 12.5px; }
    .ok { background: #e3f4ea; color: #1f6b3d; } .warn { background: #fbf0dc; color: #7a4b06; } .err { background: #fbe5e4; color: #9b2420; } .info { background: #e7ecff; color: #2a3f9a; }
    label { display: block; font-weight: 600; font-size: 12px; margin: 10px 0 4px; }
    input, select, textarea { width: 100%; border: 1px solid #d2d2cc; border-radius: 8px; padding: 7px 9px; font-size: 13px; background: #fff; color: #1c1c1a; }
    textarea { min-height: 56px; resize: vertical; }
    .hint { font-size: 11.5px; margin-top: 3px; }
    .row { display: flex; gap: 8px; margin-top: 14px; align-items: center; }
    button.go { flex: 1; border: 0; border-radius: 18px; padding: 9px 14px; font-weight: 600; font-size: 14px; cursor: pointer; background: #0a66c2; color: #fff; }
    button.go:disabled { opacity: .6; cursor: default; }
    button.go.later { background: #a8670a; }
    button.sec { border: 1px solid #0a66c2; color: #0a66c2; background: none; border-radius: 18px; padding: 6px 12px; font-weight: 600; cursor: pointer; }
    .found { font-size: 11.5px; margin-top: 8px; }
    .chips span { display: inline-block; background: #eef1fd; color: #2a3f9a; border-radius: 10px; padding: 1px 8px; margin: 2px 4px 0 0; font-size: 11.5px; }
  `;

  let host = null;
  let shadow = null;
  let accountsCache = null;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k);
    return e;
  }

  function closePanel() {
    if (host) host.remove();
    host = shadow = null;
  }

  function banner(kind, text, action) {
    const b = el('div', { class: `banner ${kind}` }, text);
    if (action) b.append(' ', el('button', { class: 'sec', onclick: action.fn, text: action.label, style: 'margin-left:6px;padding:2px 10px;font-size:12px' }));
    return b;
  }

  function statusBanner(r) {
    if (r.ok) return null;
    if (r.kind === 'offline') return banner('warn', `${r.message} You can still save now — it will be sent automatically when Network Builder is running.`);
    if (r.kind === 'unpaired') return banner('err', `${r.message} You can still save now — it will be sent once you pair.`);
    return banner('err', r.message);
  }

  async function openPanel() {
    closePanel();
    if (!profileSlug()) return;
    const p = scrape();
    if (!p.fullName) {
      alert('Network Builder: couldn’t find the person’s name on this page. Scroll to the top of the profile and try again.');
      return;
    }
    host = el('div', { id: 'nb-panel-host' });
    shadow = host.attachShadow({ mode: 'open' });
    shadow.append(el('style', { text: STYLE }));
    document.documentElement.append(host);

    const company = guessCompany(p);
    const statusSlot = el('div');
    const already = el('div');
    const acctInput = el('input', { type: 'text', list: 'nb-accts', value: company, maxlength: '120', placeholder: 'Company / account name', autocomplete: 'off' });
    const dl = el('datalist', { id: 'nb-accts' });
    const acctHint = el('div', { class: 'hint muted' });
    const roleSel = el('select', {}, ROLES.map(([v, l]) => el('option', { value: v, text: l })));
    const notes = el('textarea', { maxlength: '2000', placeholder: 'Optional — why they matter, where you met, …' });
    const goBtn = el('button', { class: 'go', type: 'button', text: 'Add to Network Builder' });
    const result = el('div');
    const nExp = (p.sections.experience && p.sections.experience.items.length) || 0;
    const found = el('div', { class: 'found muted' },
      `Will save: ${[p.headline && 'headline', p.location && 'location', p.about && 'about', nExp && `${nExp} experience item${nExp > 1 ? 's' : ''}`,
        p.sections.education && `${p.sections.education.items.length} education`].filter(Boolean).join(' · ') || 'name and page text'}`);
    const detailSlot = el('div', { class: 'found muted' }, 'Reading the full profile (experience, education, skills…) — LinkedIn’s lists open briefly in a minimized window…');
    const slug = profileSlug();
    let details = null;
    let detailDiag = null;
    const detailsReady = loadDetails(slug).then((d) => {
      details = d.details;
      detailDiag = d.diag;
      if (!shadow) return d;
      const got = Object.keys(d.details).map((k) => k.replace('-experiences', ''));
      detailSlot.textContent = got.length
        ? `✓ Full profile read: ${got.join(', ')}`
        : `Couldn’t read the full lists${d.error ? ` (${d.error})` : ''} — the visible profile will be saved.`;
      detailSlot.title = Object.entries(d.diag).map(([k, v]) => `${k}: ${v}`).join('\n');
      return d;
    });
    const thin = null;

    const panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': 'Add to Network Builder' },
      el('header', {}, el('b', { text: 'Add to Network Builder' }), el('button', { class: 'x', 'aria-label': 'Close', onclick: closePanel, text: '×' })),
      el('div', { class: 'body' },
        el('div', { class: 'who' }, el('div', { class: 'n', text: p.fullName }), el('div', { class: 'muted', text: p.headline || '' })),
        statusSlot,
        already,
        thin,
        el('label', { text: 'Account' }), acctInput, dl, acctHint,
        el('label', { text: 'Buying-committee role' }), roleSel,
        el('label', { text: 'Notes' }), notes,
        found,
        detailSlot,
        el('div', { class: 'row' }, goBtn),
        result,
      ),
    );
    shadow.append(panel);
    acctInput.focus();
    acctInput.select();
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePanel();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) goBtn.click();
    });

    let online = false;
    const paintHint = () => {
      const v = acctInput.value.trim().toLowerCase();
      if (!v) {
        acctHint.textContent = 'Type the company this person belongs to.';
        return;
      }
      if (!accountsCache) {
        acctHint.textContent = online ? '' : 'Matched to an existing account (or created) when it’s sent.';
        return;
      }
      const hit = accountsCache.find((a) => a.name.toLowerCase() === v);
      acctHint.textContent = hit ? `Existing account · ${hit.memberCount} ${hit.memberCount === 1 ? 'person' : 'people'}` : 'New account — it will be created (or matched to one with the same name).';
    };
    acctInput.addEventListener('input', paintHint);
    paintHint();

    const paintGo = () => {
      goBtn.textContent = online ? 'Add to Network Builder' : 'Save — send when Network Builder is running';
      goBtn.classList.toggle('later', !online);
    };

    // connection + what we already know about this person
    statusSlot.replaceChildren(banner('info', 'Checking Network Builder…'));
    const look = await send({ type: 'lookup', url: p.url, company, companyUrl: p.currentCompanyUrl });
    if (!shadow) return; // closed meanwhile
    online = look.ok;
    statusSlot.replaceChildren(...[statusBanner(look)].filter(Boolean));
    paintGo();
    if (look.ok) {
      const d = look.data;
      const bits = [];
      if (d.isConnection) bits.push('your connection');
      if (d.capturedAt) bits.push(`profile saved ${new Date(d.capturedAt).toLocaleDateString()}`);
      if (d.accounts.length) {
        already.replaceChildren(banner('ok', `Already on ${d.accounts.map((a) => a.name + (a.role ? ` (${ROLES.find((r) => r[0] === a.role)?.[1] || a.role})` : '')).join(', ')}${bits.length ? ` · ${bits.join(' · ')}` : ''}. Adding again refreshes their profile.`));
        const first = d.accounts[0];
        acctInput.value = first.name;
        if (first.role) roleSel.value = first.role;
      } else if (bits.length) already.replaceChildren(banner('info', bits.join(' · ')));
      if (!d.accounts.length && d.suggested) acctInput.value = d.suggested.name;
      const acc = await send({ type: 'accounts' });
      if (acc.ok) {
        accountsCache = acc.data.accounts;
        dl.replaceChildren(...accountsCache.map((a) => el('option', { value: a.name })));
      }
      paintHint();
    }

    goBtn.addEventListener('click', async () => {
      const name = acctInput.value.replace(/\s+/g, ' ').trim();
      if (!name) {
        acctHint.textContent = 'Type an account name first.';
        acctInput.focus();
        return;
      }
      goBtn.disabled = true;
      goBtn.textContent = 'Saving…';
      result.replaceChildren();
      if (!details) {
        goBtn.textContent = 'Reading full profile…';
        await detailsReady;
        if (!shadow) return;
        goBtn.textContent = 'Saving…';
      }
      const fresh = scrape(); // the page may have loaded more since the panel opened
      const prof = fresh.fullName ? fresh : p;
      if (details && Object.keys(details).length) prof.details = details;
      if (detailDiag) prof.detailsDiag = detailDiag;
      const hit = accountsCache && accountsCache.find((a) => a.name.toLowerCase() === name.toLowerCase());
      const body = {
        profile: prof,
        ...(hit ? { accountId: hit.id, accountLabel: hit.name } : { accountName: name }),
        role: roleSel.value,
        notes: notes.value.trim(),
      };
      const r = await send({ type: 'capture', body });
      if (!shadow) return;
      goBtn.disabled = false;
      paintGo();
      if (r.ok) {
        const d = r.data;
        result.replaceChildren(
          banner('ok', `✓ ${d.addedToAccount ? 'Added' : 'Updated'} ${d.person.fullName} ${d.addedToAccount ? 'to' : 'on'} ${d.account.name}${d.createdAccount ? ' (new account)' : ''}${d.isConnection ? ' · your connection' : ''}.` +
            (d.saved ? ` Saved ${d.saved.experience} role${d.saved.experience === 1 ? '' : 's'}, ${d.saved.education} education${d.saved.sections.length ? `, ${d.saved.sections.join(', ').toLowerCase()}` : ''}.` : '')),
        );
        goBtn.textContent = 'Saved ✓';
        goBtn.disabled = true;
        setButtonState(true, d.account.name);
        setTimeout(closePanel, 6000);
      } else if (r.queued) {
        result.replaceChildren(banner('warn', `Saved in the browser — ${p.fullName} will be sent to “${name}” automatically when Network Builder is running and paired. (The extension icon shows how many are waiting.)`));
        goBtn.textContent = 'Saved for later ✓';
        goBtn.disabled = true;
        setTimeout(closePanel, 4000);
      } else {
        result.replaceChildren(banner('err', `Not saved: ${r.message}`));
      }
    });
  }

  // ---------- the in-page button ----------
  let btn = null;
  let savedLabel = ''; // remembered per profile so a re-rendered button keeps its "✓ Account" state
  function setButtonState(saved, accountName) {
    savedLabel = saved ? accountName || 'Network Builder' : '';
    if (!btn) return;
    btn.querySelector('.nb-label').textContent = saved ? `✓ ${accountName || 'Network Builder'}` : 'Network Builder';
    btn.title = saved ? `On ${accountName} in Network Builder — click to update` : 'Add this person to an account in Network Builder';
  }

  function makeButton() {
    // reuse LinkedIn's own button classes so it looks native; inline styles are the fallback if those change
    const b = el('button', {
      type: 'button',
      id: 'nb-add-btn',
      // styled inline (LinkedIn's class names change): a filled pill in Network Builder's purple; matchRow() sizes it
      style: 'margin-left:8px;display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;' +
        'height:32px;padding:0 16px;border-radius:999px;border:0;color:#fff;' +
        'background:linear-gradient(135deg,#5b5bf0,#8b4fe0 60%,#c04fd0);box-shadow:none;' +
        'font:600 16px/1 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;cursor:pointer;white-space:nowrap;vertical-align:middle;',
      title: 'Add this person to an account in Network Builder',
    }, el('span', { text: '＋', 'aria-hidden': 'true' }), el('span', { class: 'nb-label', text: 'Network Builder' }));
    b.addEventListener('mouseenter', () => (b.style.filter = 'brightness(1.1)'));
    b.addEventListener('mouseleave', () => (b.style.filter = ''));
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel();
    });
    return b;
  }

  /** same height, font size and spacing as LinkedIn's own buttons in the row (e.g. Message) */
  function matchRow(b, bar) {
    const ref = actionButtons().find((e) => bar.contains(e) && e !== b && e.offsetHeight > 0);
    if (ref) {
      const cs = getComputedStyle(ref);
      b.style.height = `${ref.offsetHeight}px`;
      b.style.fontSize = cs.fontSize;
      b.style.paddingLeft = b.style.paddingRight = cs.paddingLeft !== '0px' ? cs.paddingLeft : '16px';
    }
    const gap = parseFloat(getComputedStyle(bar).columnGap);
    if (gap > 0) b.style.marginLeft = '0';
  }

  let lastSlug = '';
  let slugSince = 0; // when we first saw this profile URL (the float fallback waits for the page to render)
  let floating = false;
  async function ensureButton() {
    const slug = profileSlug();
    if (!slug) {
      if (btn) btn.remove();
      btn = null;
      lastSlug = '';
      return;
    }
    if (slug !== lastSlug && !slugSince) slugSince = Date.now();
    const bar = findActionBar();
    // already placed in the row for this profile (a floating button moves into the row once the row appears)
    if (btn && document.contains(btn) && slug === lastSlug && (!floating || !bar)) return;
    if (!bar && Date.now() - slugSince < 2500) {
      setTimeout(schedule, 800); // page still rendering: look again shortly
      return;
    }
    if (btn) btn.remove();
    btn = makeButton();
    floating = !bar;
    if (bar) {
      bar.append(btn);
      matchRow(btn, bar);
    } else {
      // couldn't find the Message / More row: float the button at the bottom-right instead
      btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147482000;background:#0a66c2;color:#fff;border:0;border-radius:20px;padding:10px 16px;font:600 14px -apple-system,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2);cursor:pointer;display:inline-flex;gap:4px;';
      document.body.append(btn);
    }
    if (slug === lastSlug && savedLabel) setButtonState(true, savedLabel);
    if (slug !== lastSlug) {
      lastSlug = slug;
      slugSince = 0;
      savedLabel = '';
      closePanel();
      const r = await send({ type: 'lookup', url: profileUrl(), company: '', companyUrl: '' });
      if (r.ok && r.data.accounts.length && profileSlug() === slug) setButtonState(true, r.data.accounts.map((a) => a.name).join(', '));
    }
  }

  // ---------- lists: map a team from a company's People tab or a people search ----------
  // Safeguards (AGENTS.md rule 5): starts only from a click on the Start button in this panel; walks only this tab,
  // which must stay in front (it pauses while the tab is hidden); human pace with jitter and back-off; capped per run
  // and per day; stops at once on a checkpoint / captcha / sign-in / limit page; Cancel stops immediately. It reads
  // only the visible text of each result card plus its /in/ link (list-reader.js). It never opens profiles, windows
  // or tabs. "LinkedIn Member" rows are sent without a name and kept only as anonymous counts.
  const LIST = {
    BASE_MS: 2500, // between loads, plus a random 0–1.5 s
    JITTER_MS: 1500,
    PACE_STEP_MS: 1500, // added after each load that brought nothing new …
    MAX_PACE_MS: 8000, // … up to this
    MAX_NO_GROWTH: 4, // loads in a row with nothing new → end of list (or "stalled" if LinkedIn still offers more)
    GROWTH_TIMEOUT_MS: 10000,
    STALL_MS: 60000, // waiting this long for a page that shows no new cards (skeletons, or nothing) → stop as "stalled"
    SHOW_WAIT_MS: 2000, // after this long, the panel shows "Waiting for LinkedIn to load page N… Xs"
    PAGE_MIN_MS: 4000, // search results: at most one page per 4–7 s
    PAGE_JITTER_MS: 3000,
    BATCH: 25, // rows per post to Network Builder
    HEARTBEAT_MS: 120000, // an empty post at least this often (paused, slow pages), so the server never closes a live run
    STATE_MAX_AGE_MS: 15 * 60000, // saved walk state older than this is ignored after a page load
    SETTLE_MS: 15000, // after a page load / page turn: wait this long at most for the results before reading the URL's page
    CAP_DEFAULT: 300,
    CAP_MAX: 500,
    DAILY: 1000,
  };
  const STOP_TEXT = {
    end: 'Reached the end of the list.',
    cap: 'Stopped at your cap.',
    cancelled: 'Stopped.',
    checkpoint: 'LinkedIn showed a security check, so the walk stopped. Complete it yourself, and wait a while before mapping again.',
    login: 'LinkedIn asked you to sign in, so the walk stopped.',
    'rate-limit': 'LinkedIn says you have reached a limit, so the walk stopped. Try again another day.',
    stalled: 'LinkedIn stopped loading more results, so the walk stopped.',
    abandoned: 'The walk was interrupted.',
    error: 'The walk stopped because of an error.',
  };
  const NBL = globalThis.NBList;
  const listKind = () => (NBL ? NBL.pageKind(location.pathname) : '');
  const today = () => {
    const d = new Date();
    return `nb.listRows.${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  async function rowsToday() {
    try {
      const k = today();
      return Number((await chrome.storage.local.get(k))[k]) || 0;
    } catch {
      return 0;
    }
  }
  async function addRowsToday(n) {
    try {
      const k = today();
      const cur = Number((await chrome.storage.local.get(k))[k]) || 0;
      await chrome.storage.local.set({ [k]: cur + n });
    } catch {
      /* the daily count is best effort; the run cap still applies */
    }
  }

  class WalkStop {
    constructor(reason, message) {
      this.reason = reason;
      this.message = message || '';
    }
  }
  const rand = (n) => Math.floor(Math.random() * n);

  // ---------- walk state across full page loads ----------
  // A full page load in this tab (LinkedIn's own redirect, a reload) restarts this script and loses the running walk.
  // The background keeps the walk's minimal state per tab in chrome.storage.session, so the restarted script can close
  // the run on Network Builder: 'end' when LinkedIn sent us back to an earlier page right after Next (past the last
  // results page), else 'cancelled'. It NEVER walks again by itself — only a click on Start does (rule 5).
  const saveWalkState = (state) => send({ type: 'walkSave', state });
  const clearWalkState = () => send({ type: 'walkClear' });

  let noticeHost = null;
  /** a small closable notice (top right), for how a walk ended after a page load; shows text only */
  function walkNotice(kind, text) {
    if (noticeHost) noticeHost.remove();
    noticeHost = el('div', { id: 'nb-walk-notice' });
    const sh = noticeHost.attachShadow({ mode: 'open' });
    sh.append(el('style', { text: STYLE }));
    const close = () => {
      if (noticeHost) noticeHost.remove();
      noticeHost = null;
    };
    sh.append(el('div', { class: 'panel', role: 'status', 'aria-label': 'Network Builder' },
      el('header', {}, el('b', { text: 'Network Builder' }), el('button', { class: 'x', 'aria-label': 'Close', onclick: close, text: '×' })),
      el('div', { class: 'body' }, banner(kind, text))));
    document.documentElement.append(noticeHost);
  }

  /**
   * Once per page load: a walk this tab was running before a full page load either CONTINUES (our own Next click loaded
   * the next page of the same search as a full page — the walk the user started carries on with its pagination) or is
   * closed on Network Builder ('end' / 'cancelled'). See NBList.reloadVerdict. Nothing else ever starts a walk.
   */
  let recovering = true; // Start stays disabled until recoverWalk has finished (it may close or continue a run of this tab)
  const recoveryWaiters = [];
  const whenRecovered = (fn) => (recovering ? recoveryWaiters.push(fn) : fn());
  async function recoverWalk() {
    try {
      await recoverWalkNow();
    } finally {
      recovering = false;
      for (const fn of recoveryWaiters.splice(0)) fn();
    }
  }
  /** wait (≤ SETTLE_MS) until the results have rendered and the URL has stopped changing; LinkedIn may add `page` late */
  async function settle() {
    const end = Date.now() + LIST.SETTLE_MS;
    let href = location.href;
    let since = Date.now();
    while (Date.now() < end) {
      if (location.href !== href) {
        href = location.href;
        since = Date.now();
      }
      if (Date.now() - since >= 1000 && NBL.resultsRendered(document, location.href)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }
  async function recoverWalkNow() {
    const loadedAt = Date.now(); // when this page load began (for "≤ 30 s after our Next click")
    const r = await send({ type: 'walkLoad' });
    const saved = r && r.ok ? r.state : null;
    if (!saved || !saved.runId) return;
    await clearWalkState(); // handled once, whatever happens next (a continuing walk saves its own state again)
    // too old to describe what just happened (Network Builder closes such runs as `abandoned` by itself)
    if (!(Date.now() - Number(saved.savedAt) <= LIST.STATE_MAX_AGE_MS)) return;
    const who = saved.account && saved.account.name ? ` on ${saved.account.name}` : '';
    if (!saved.started) {
      walkNotice('warn', 'The page reloaded before mapping started, so nothing was read. Click “⇣ Map to Network Builder” and Start to map this list.');
      return;
    }
    // read the page number only once the results (or "no results") are on screen
    if (NBL && listKind() === 'search') await settle();
    let verdict = NBL ? NBL.reloadVerdict(saved, location.href, loadedAt) : 'cancelled';
    let capNote = '';
    if (verdict === 'continue') {
      const used = await rowsToday();
      if ((Number(saved.rows) || 0) >= (Number(saved.cap) || 0) || used >= LIST.DAILY) {
        verdict = 'cap'; // never past the run's cap or the daily limit
        capNote = used >= LIST.DAILY ? 'the daily limit' : `your cap of ${saved.cap} rows`;
      } else {
        openListPanel({ resume: saved }); // not awaited: the walk runs on in this tab
        return;
      }
    }
    const res = await send({ type: 'captureList', body: {
      runId: saved.runId, ...(saved.acctRef || {}), page: saved.page, rows: [], final: true, stopReason: verdict,
    } });
    const run = res && res.ok ? res.data.run : null;
    const named = run ? run.named : Number(saved.rows) || 0;
    const anon = run && run.anonymous ? ` + ${run.anonymous} anonymous` : '';
    const people = `${named} ${named === 1 ? 'person' : 'people'}${anon}`;
    const unsaved = res && !res.ok && !/finished|closed/i.test(res.message || '') ? ` (Network Builder didn’t record the end: ${res.message})` : '';
    if (verdict === 'end') {
      walkNotice('ok', `Done — reached the end of the results (${people}${who}).${unsaved}`);
    } else if (verdict === 'cap') {
      walkNotice('ok', `Stopped at ${capNote} (${people}${who}).${unsaved}`);
    } else {
      walkNotice('warn', `The page reloaded or changed while mapping, so the walk stopped (${people} saved${who}). ` +
        `It never restarts by itself: click “⇣ Map to Network Builder” and Start to map again.${unsaved}`);
    }
  }

  let listHost = null;
  let listShadow = null;
  let listBtn = null;
  let walk = null; // the running walk: { cancelled, … }

  function closeListPanel() {
    if (walk) {
      walk.cancelled = true; // closing the panel stops a running walk
      if (walk.resolvePrompt) walk.resolvePrompt('stop');
    }
    if (listHost) listHost.remove();
    listHost = listShadow = null;
  }

  /** `resume`: only from recoverWalk, to continue a walk across our own Next click's full page load */
  async function openListPanel({ resume } = {}) {
    if (listHost) return;
    const kind = listKind();
    if (!kind) return;
    listHost = el('div', { id: 'nb-list-host' });
    listShadow = listHost.attachShadow({ mode: 'open' });
    listShadow.append(el('style', { text: STYLE }));
    document.documentElement.append(listHost);

    const slug = NBL.companySlug(location.pathname);
    const keywords = NBL.keywordsOf(location.href);
    const companyUrl = slug ? `https://www.linkedin.com/company/${slug}` : '';
    const statusSlot = el('div');
    const acctInput = el('input', { type: 'text', list: 'nb-list-accts', maxlength: '120', placeholder: 'Account name', autocomplete: 'off' });
    const dl = el('datalist', { id: 'nb-list-accts' });
    const capInput = el('input', { type: 'number', min: '1', max: String(LIST.CAP_MAX), step: '1', value: String(LIST.CAP_DEFAULT) });
    const usage = el('div', { class: 'hint muted' });
    const goBtn = el('button', { class: 'go', type: 'button', text: 'Start mapping' });
    if (recovering) {
      goBtn.disabled = true; // until a walk interrupted by the last page load is closed
      whenRecovered(() => {
        if (!walk && !resume) goBtn.disabled = false;
      });
    }
    const stopBtn = el('button', { class: 'sec', type: 'button', text: 'Cancel', style: 'display:none' });
    // People tab only: read the member count + "What they do" counts that are on screen (no walking, no scrolling)
    const hcBtn = kind === 'people-tab'
      ? el('button', { class: 'sec', type: 'button', text: 'Capture headcount only',
        title: 'Reads the member count and the “What they do” counts on this page (one click on its “Show more”, nothing else) and saves them — no people are read' })
      : null;
    const progress = el('div', { class: 'found muted' });
    const result = el('div');
    const what = kind === 'people-tab' ? `People tab of ${slug}` : 'People search results';
    const panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': 'Map this list to Network Builder' },
      el('header', {}, el('b', { text: 'Map this list to Network Builder' }), el('button', { class: 'x', 'aria-label': 'Close', onclick: closeListPanel, text: '×' })),
      el('div', { class: 'body' },
        el('div', { class: 'who' }, el('div', { class: 'n', text: what }),
          el('div', { class: 'muted', text: keywords ? `Keywords: “${keywords}”` : 'No keyword filter. Tip: search the People tab for “marketing” first, so only that team is read.' })),
        statusSlot,
        banner('warn', 'Keep this tab in front while it runs. LinkedIn may limit accounts that browse a lot; stop if you see a security check.'),
        el('label', { text: 'Account' }), acctInput, dl,
        el('label', { text: 'Most rows this run' }), capInput, usage,
        el('div', { class: 'row' }, goBtn, stopBtn, hcBtn),
        hcBtn ? el('div', { class: 'hint muted', text: keywords
          ? 'Headcount only: with a keyword filter the count is for this search and “What they do” isn’t saved. Clear the search to read the company figures.'
          : 'Headcount only: saves “N associated members” and the “What they do” counts (incl. Marketing) shown here.' }) : null,
        progress,
        result,
      ),
    );
    listShadow.append(panel);
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !walk) closeListPanel();
    });

    const used = await rowsToday();
    usage.textContent = `Up to ${LIST.CAP_MAX} per run and ${LIST.DAILY.toLocaleString()} a day · ${used.toLocaleString()} read today.`;
    let accounts = [];
    statusSlot.replaceChildren(banner('info', 'Checking Network Builder…'));
    const acc = await send({ type: 'accounts' });
    if (!listShadow) return;
    if (acc.ok) {
      statusSlot.replaceChildren();
      accounts = acc.data.accounts || [];
      dl.replaceChildren(...accounts.map((a) => el('option', { value: a.name })));
      const hit = companyUrl && accounts.find((a) => (a.linkedinUrl || '').replace(/\/$/, '') === companyUrl);
      if (hit) acctInput.value = hit.name;
    } else {
      statusSlot.replaceChildren(banner('err', acc.message));
    }

    stopBtn.addEventListener('click', () => {
      if (walk) {
        walk.cancelled = true;
        if (walk.resolvePrompt) walk.resolvePrompt('stop');
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
      }
    });

    // "Capture headcount only": one trusted click → read what's on screen (at most one click on What they do's
    // "Show more") → one post with zero rows. Never walks, scrolls or pages.
    let hcBusy = false;
    if (hcBtn) {
      hcBtn.addEventListener('click', async (e) => {
        if (!e.isTrusted || walk || starting || hcBusy) return;
        hcBusy = true;
        hcBtn.disabled = goBtn.disabled = true;
        result.replaceChildren();
        try {
          const name = acctInput.value.replace(/\s+/g, ' ').trim();
          if (!name) {
            result.replaceChildren(banner('err', 'Pick an account (or type a name for a new one).'));
            acctInput.focus();
            return;
          }
          const stop = NBL.stopReason(document, location.href);
          if (stop) {
            result.replaceChildren(banner('err', STOP_TEXT[stop] || 'LinkedIn is showing a check or limit page.'));
            return;
          }
          const more = NBL.facetsExpandButton(document);
          if (more) {
            more.click();
            await new Promise((r) => setTimeout(r, 1200));
          }
          const header = NBL.headerText(document);
          const facets = NBL.facetsText(document);
          if (!header && !facets) {
            result.replaceChildren(banner('err', 'No member count or “What they do” box on screen. Scroll so both are visible (flip the insights carousel to “What they do” if needed) and try again.'));
            return;
          }
          const hit = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
          const r = await send({ type: 'captureList', body: {
            runId: crypto.randomUUID(),
            ...(hit ? { accountId: hit.id } : { accountName: name }),
            page: { kind, url: location.href.split('#')[0], keywords: NBL.keywordsOf(location.href), ...(companyUrl ? { companyUrl } : {}) },
            rows: [], header, facets, final: true, stopReason: 'end',
          } });
          if (!listShadow) return;
          if (!r.ok) {
            result.replaceChildren(banner('err', r.message || 'Network Builder didn’t accept the counts.'));
            return;
          }
          const hc = r.data.headcount || {};
          const noMkt = !/marketing/i.test(facets);
          result.replaceChildren(banner(noMkt ? 'warn' : 'ok',
            `Saved for ${r.data.account.name}: ${hc.members != null ? `${hc.members.toLocaleString()} members` : 'no member count'} · ${hc.functions || 0} “What they do” counts.` +
            (noMkt ? ' Marketing wasn’t visible — show it in the “What they do” box (Show more / carousel arrow), then capture again.' : '')));
        } finally {
          hcBusy = false;
          if (hcBtn.isConnected) hcBtn.disabled = goBtn.disabled = false;
        }
      });
    }

    /**
     * run a walk in this panel and show how it ended. Reached only from the trusted Start click below, or with `resume`
     * from recoverWalk when our own Next click loaded the next page as a full page load.
     * Synchronous up to startWalk(), which sets `walk` before its first await.
     */
    const runWalk = async ({ account, cap, resume }) => {
      goBtn.disabled = true;
      acctInput.disabled = capInput.disabled = true;
      stopBtn.style.display = '';
      stopBtn.disabled = false;
      stopBtn.textContent = 'Cancel';
      result.replaceChildren();
      const ui = {
        phase: (t) => (progress.textContent = t),
        prompt: (message) =>
          new Promise((resolve) => {
            walk.resolvePrompt = resolve;
            result.replaceChildren(banner('err', `${message} The walk is paused.`, { label: 'Retry', fn: () => resolve('retry') }));
          }).then((choice) => {
            if (walk) walk.resolvePrompt = null;
            result.replaceChildren();
            return choice;
          }),
      };
      const walkDone = startWalk({ account, cap, kind, companyUrl, ui, resume });
      const out = await walkDone;
      walk = null;
      if (!listShadow) return;
      stopBtn.style.display = 'none';
      goBtn.disabled = false;
      goBtn.textContent = 'Start again';
      acctInput.disabled = capInput.disabled = false;
      const r = out.data;
      const reason = (out.reason === 'cap' ? `Stopped at ${cap} rows. ` : STOP_TEXT[out.reason] ? STOP_TEXT[out.reason] + ' ' : '') + (out.message ? out.message + ' ' : '');
      if (r) {
        result.replaceChildren(banner(['end', 'cap', 'cancelled'].includes(out.reason) ? 'ok' : 'warn',
          `${reason}${r.run.named} ${r.run.named === 1 ? 'person' : 'people'}${r.run.anonymous ? ` + ${r.run.anonymous} anonymous` : ''} on ${r.account.name}.`));
      } else {
        result.replaceChildren(banner('err', `${reason}Nothing more was sent.`));
      }
      usage.textContent = `Up to ${LIST.CAP_MAX} per run and ${LIST.DAILY.toLocaleString()} a day · ${(await rowsToday()).toLocaleString()} read today.`;
    };

    // the ONLY place a walk starts: a real click on this button
    let starting = false;
    goBtn.addEventListener('click', async (e) => {
      if (!e.isTrusted || walk || starting || recovering) return;
      starting = true; // before any await: a double click must not start two walks
      goBtn.disabled = true;
      const name = acctInput.value.replace(/\s+/g, ' ').trim();
      if (!name) {
        result.replaceChildren(banner('err', 'Pick an account (or type a name for a new one).'));
        acctInput.focus();
        starting = false;
        goBtn.disabled = false;
        return;
      }
      const usedNow = await rowsToday();
      if (usedNow >= LIST.DAILY) {
        result.replaceChildren(banner('err', `You have read ${usedNow.toLocaleString()} rows today, the daily limit. Try again tomorrow.`));
        starting = false;
        goBtn.disabled = false;
        return;
      }
      const capWanted = Math.max(1, Math.min(LIST.CAP_MAX, Math.floor(Number(capInput.value) || LIST.CAP_DEFAULT)));
      const cap = Math.min(capWanted, LIST.DAILY - usedNow);
      capInput.value = String(capWanted);
      const hit = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
      const done = runWalk({ account: hit ? { id: hit.id, name: hit.name } : { name }, cap });
      starting = false; // runWalk → startWalk has set `walk` synchronously
      await done;
    });

    // continuing our own walk after its Next click loaded the next page as a full page load (see recoverWalk)
    if (resume && !walk) {
      acctInput.value = (resume.account && resume.account.name) || '';
      capInput.value = String(resume.cap);
      statusSlot.replaceChildren(banner('info', `Continuing on page ${NBL.pageNumber(location.href)}: LinkedIn loaded the next page as a new page. Cancel stops it.`));
      runWalk({ account: resume.account, cap: Number(resume.cap), resume });
    }
  }

  /** the paced walk (ported from the connections exporter's loop). → { reason, message, data: last server answer } */
  /**
   * `resume`: the saved state of this tab's walk whose own Next click loaded the next page as a full page load (from
   * recoverWalk only): same run id, cap, counts, people seen and pacing; the run already exists on Network Builder.
   */
  async function startWalk({ account, cap, kind, companyUrl, ui, resume }) {
    const run = { id: resume ? resume.runId : crypto.randomUUID(), cancelled: false, rows: resume ? Number(resume.rows) || 0 : 0, resolvePrompt: null };
    walk = run;
    const startRows = run.rows;
    const startPath = resume ? resume.path : location.pathname;
    // the list's result-set filters (keywords, company, location, …) — paging and LinkedIn's UI flags aside; a new
    // search or changed filters ends this run
    const filtersOf = (href) => NBL.filterKey(href);
    const startFilters = resume ? resume.filters : filtersOf(location.href);
    const page = resume ? resume.page : { kind, url: location.href.split('#')[0], keywords: NBL.keywordsOf(location.href), ...(companyUrl ? { companyUrl } : {}) };
    const acctRef = resume ? resume.acctRef : account.id ? { accountId: account.id } : { accountName: account.name };
    const seenHrefs = new Set(resume && Array.isArray(resume.seen) ? resume.seen : []);
    const walkState = {
      runId: run.id, account: { id: account.id || '', name: account.name }, acctRef, cap, rows: run.rows, kind, path: startPath,
      filters: startFilters, page, lastPage: NBL.pageNumber(location.href), nextClicked: false, clickedNextAt: 0,
      started: !!resume, paceMs: resume ? Number(resume.paceMs) || 0 : 0, seen: [],
    };
    const persist = (patch) => {
      Object.assign(walkState, patch || {}, { rows: run.rows, seen: [...seenHrefs].slice(-LIST.CAP_MAX * 2) });
      return saveWalkState(walkState);
    };
    persist(); // before the first await: a reload from here on is noticed
    let seenEls = new WeakSet(); // cards already read on this page (search: reset per page)
    let pending = [];
    let last = null;
    let phase = '';
    const say = (t) => {
      phase = t;
      ui.phase(`${t} · ${run.rows} read`);
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let lastStopScan = 0;
    let lastScanHref = '';
    let lastPostAt = Date.now();
    let beating = false;
    /**
     * an empty post (no rows) when nothing was posted for HEARTBEAT_MS: keeps the run's last activity fresh on Network
     * Builder while the tab is paused or LinkedIn is slow, so it is never closed as `abandoned` mid-walk. Quiet: a
     * failure is retried on the next beat; only "this run was closed" ends the walk.
     */
    const heartbeat = async () => {
      if (beating || !walkState.started || Date.now() - lastPostAt < LIST.HEARTBEAT_MS) return;
      beating = true;
      try {
        lastPostAt = Date.now();
        const r = await send({ type: 'captureList', body: { runId: run.id, ...acctRef, page, rows: [] } });
        if (!r.ok && r.status === 409 && /finished|closed/i.test(r.message || '')) throw new WalkStop('cancelled', r.message);
        await persist(); // refreshes savedAt too
      } finally {
        beating = false;
      }
    };
    /** throws WalkStop when the walk must end now; waits (paused) while the tab is hidden */
    const check = async () => {
      if (run.cancelled) throw new WalkStop('cancelled');
      await heartbeat();
      if (Date.now() - lastStopScan >= 1000 || location.href !== lastScanHref) {
        lastStopScan = Date.now();
        lastScanHref = location.href;
        const s = NBL.stopReason(document, location.href);
        if (s) throw new WalkStop(s);
      }
      if (listKind() !== kind || (kind === 'people-tab' && location.pathname !== startPath)) throw new WalkStop('cancelled', 'You left the list page.');
      if (filtersOf(location.href) !== startFilters) throw new WalkStop('cancelled', 'The search or its filters changed. Start a new run for the new list.');
      if (document.hidden) {
        const was = phase;
        say('Paused: this tab is in the background. Switch back to it to continue');
        while (document.hidden) {
          if (run.cancelled) throw new WalkStop('cancelled');
          await heartbeat();
          await sleep(500);
        }
        say(was);
      }
    };
    const pause = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await check();
        await sleep(Math.min(250, end - Date.now()));
      }
      await check();
    };
    /**
     * wait for `pred` while LinkedIn loads. 'ok' as soon as it holds; 'quiet' after `quietMs` with no placeholders on
     * screen (unless `mustArrive`); 'stalled' after STALL_MS. Shows "<label>… Ns" once the wait gets noticeable, so a
     * slow page (skeleton placeholders) never looks frozen. Time while the tab is hidden doesn't count.
     */
    const waitLoad = async (pred, { label, quietMs = LIST.GROWTH_TIMEOUT_MS, mustArrive = false }) => {
      const was = phase;
      let waited = 0;
      let at = Date.now();
      let shown = false;
      try {
        while (true) {
          if (document.hidden) {
            await check(); // pauses until the tab is back
            at = Date.now();
          }
          await check();
          if (pred()) return 'ok';
          waited += Date.now() - at;
          at = Date.now();
          const loading = NBL.isLoading(document);
          if (waited >= LIST.STALL_MS) return 'stalled';
          if (!mustArrive && !loading && waited >= quietMs) return 'quiet';
          if (waited >= LIST.SHOW_WAIT_MS && (loading || mustArrive)) {
            shown = true;
            say(`${label}… ${Math.round(waited / 1000)}s`);
          }
          await sleep(500);
        }
      } finally {
        if (shown) say(was);
      }
    };
    const stalled = (what) => new WalkStop('stalled', `LinkedIn didn’t load ${what} within ${LIST.STALL_MS / 1000} seconds. Reload the page (⌘R) and start again — the people read so far are saved.`);

    /** read new cards on screen into `pending`; stops at the cap */
    const harvest = () => {
      for (const card of NBL.resultCards(document, location.href)) {
        if (seenEls.has(card)) continue;
        const c = NBL.readCard(card, location.href);
        if (!c.lines.length) continue; // not rendered yet: read it on the next pass
        seenEls.add(card);
        if (c.href) {
          if (seenHrefs.has(c.href)) continue;
          seenHrefs.add(c.href);
        }
        if (run.rows >= cap) throw new WalkStop('cap');
        pending.push({ idx: run.rows++, lines: c.lines, href: c.href });
      }
      if (run.rows >= cap) throw new WalkStop('cap');
    };

    /** send what's pending (≤100 per request); on failure pause and ask: Retry, or Cancel → stop */
    const post = async (extra, { final = false } = {}) => {
      while (true) {
        const rows = pending.slice(0, 100);
        const lastChunk = pending.length <= 100;
        const body = { runId: run.id, ...acctRef, page, rows, ...extra, ...(final && lastChunk ? { final: true } : {}) };
        const r = await send({ type: 'captureList', body });
        if (r.ok) {
          lastPostAt = Date.now();
          pending = pending.slice(rows.length);
          last = r.data;
          if (rows.length) await addRowsToday(rows.length);
          if (!final) await persist({ started: true }); // the run exists on Network Builder now
          if (lastChunk) return;
          continue;
        }
        if (r.status === 409 && !final) throw new WalkStop(/finished|closed/i.test(r.message || '') ? 'cancelled' : 'cap', r.message);
        if (final && (run.cancelled || r.kind === 'reload')) return; // nothing more we can do
        // the run was already closed (e.g. `abandoned` by Network Builder): a Retry could never succeed
        if (final && r.status === 409 && /finished|closed|abandoned/i.test(r.message || '')) {
          closedNote = `Network Builder had already closed this run (${r.message}); ${pending.length ? `the last ${pending.length} rows weren’t saved, but ` : ''}the people sent before are kept.`;
          return;
        }
        const choice = await ui.prompt(r.message || 'Network Builder didn’t accept the rows.');
        if (choice !== 'retry') {
          if (final) return;
          throw new WalkStop('cancelled');
        }
      }
    };
    const pageInfo = () => ({ header: NBL.headerText(document), ...(kind === 'people-tab' ? { facets: NBL.facetsText(document) } : {}) });

    let stop = null;
    let closedNote = '';
    try {
      say(resume ? `Continuing on page ${NBL.pageNumber(location.href)}` : 'Starting');
      await check();
      if (!resume) await post(pageInfo()); // creates the run on the account; checks pairing before anything is read
      say('Reading the list');
      const first = await waitLoad(() => {
        harvest();
        if (run.rows > startRows || NBL.noResults(document)) return true;
        // continuing: a drawn page of people we already have is read too
        const cards = NBL.resultCards(document, location.href);
        return !!resume && cards.length > 0 && !NBL.isLoading(document) && cards.every((c) => seenEls.has(c));
      }, { label: 'Waiting for LinkedIn to load the results', quietMs: 15000 });
      if (first === 'stalled') throw stalled('the results');
      if (run.rows === startRows && (!resume || NBL.noResults(document))) throw new WalkStop('end', resume ? 'LinkedIn shows no more results.' : 'No results on this page.');
      let noGrowth = 0;
      let paceMs = walkState.paceMs;
      while (true) {
        await check();
        harvest();
        if (pending.length >= LIST.BATCH) await post({});
        const before = run.rows;
        if (kind === 'people-tab') {
          await pause(LIST.BASE_MS + rand(LIST.JITTER_MS) + paceMs);
          say(noGrowth ? `Nothing new yet, trying again (${noGrowth}/${LIST.MAX_NO_GROWTH})` : 'Loading more');
          const more = NBL.loadMoreButton(document);
          if (more) more.click();
          else {
            const cards = NBL.resultCards(document, location.href);
            const lastCard = cards[cards.length - 1];
            if (lastCard) lastCard.scrollIntoView({ block: 'end' });
            window.scrollTo(0, document.documentElement.scrollHeight);
          }
          const grew = await waitLoad(() => {
            harvest();
            return run.rows > before;
          }, { label: 'Waiting for LinkedIn to load more results' });
          if (grew === 'stalled') throw stalled('more results');
        } else {
          // search results: read this page (scrolled into view), then the visible "Next" button, same tab
          window.scrollTo(0, document.documentElement.scrollHeight);
          await pause(1000);
          harvest();
          const next = NBL.nextButton(document);
          if (!next) throw new WalkStop('end');
          say('Next page');
          await pause(LIST.PAGE_MIN_MS + rand(LIST.PAGE_JITTER_MS) + paceMs);
          if (pending.length) await post({}); // send this page's rows first: a full page load would lose them
          const firstBefore = NBL.resultCards(document, location.href)[0];
          const hrefBefore = location.href;
          const pageBefore = NBL.pageNumber(hrefBefore);
          const want = `page ${pageBefore + 1}`;
          // saved BEFORE the click: if it causes a full page load, recoverWalk continues (next page) or ends (page ≤ this)
          await persist({ lastPage: pageBefore, nextClicked: true, clickedNextAt: Date.now(), paceMs });
          next.click();
          const turned = await waitLoad(() => location.href !== hrefBefore || NBL.resultCards(document, location.href)[0] !== firstBefore,
            { label: `Waiting for LinkedIn to load ${want}`, mustArrive: true });
          if (turned === 'stalled') throw stalled(want);
          // read the page number only once the URL has stopped changing and the new results (or "no results") are on
          // screen: LinkedIn may change the URL in steps and add `page` late
          let urlNow = location.href;
          let urlSince = Date.now();
          await waitLoad(() => {
            if (location.href !== urlNow) {
              urlNow = location.href;
              urlSince = Date.now();
            }
            const fresh = NBL.noResults(document) || NBL.resultCards(document, location.href)[0] !== firstBefore;
            return Date.now() - urlSince >= 1000 && fresh && NBL.resultsRendered(document, location.href);
          }, { label: `Waiting for LinkedIn to load ${want}`, quietMs: LIST.SETTLE_MS });
          // LinkedIn sends you back to an earlier page (page 1, no `page`) when you page past the last results page
          if (location.href !== hrefBefore && NBL.pageNumber(location.href) <= pageBefore) {
            throw new WalkStop('end', `LinkedIn went back to page ${NBL.pageNumber(location.href)} after page ${pageBefore}, so this was the last page.`);
          }
          seenEls = new WeakSet(); // a new page (LinkedIn may reuse card elements); people are de-duplicated by link
          await persist({ lastPage: NBL.pageNumber(location.href), nextClicked: false, clickedNextAt: 0 });
          const loaded = await waitLoad(() => {
            harvest();
            if (run.rows > before || NBL.noResults(document)) return true;
            // a page of people we already have: drawn (no placeholders) and every card read
            const cards = NBL.resultCards(document, location.href);
            return cards.length > 0 && !NBL.isLoading(document) && cards.every((c) => seenEls.has(c));
          }, { label: `Waiting for LinkedIn to load ${want}`, mustArrive: true });
          if (loaded === 'stalled') throw stalled(want);
          if (run.rows === before && NBL.noResults(document)) throw new WalkStop('end', 'LinkedIn shows no more results.');
        }
        if (run.rows > before) {
          noGrowth = 0;
        } else {
          noGrowth++;
          paceMs = Math.min(LIST.MAX_PACE_MS, paceMs + LIST.PACE_STEP_MS); // back off instead of hammering LinkedIn
          if (noGrowth >= LIST.MAX_NO_GROWTH) {
            const offersMore = kind === 'people-tab' ? NBL.loadMoreButton(document) : NBL.nextButton(document);
            throw new WalkStop(offersMore ? 'stalled' : 'end');
          }
        }
      }
    } catch (e) {
      stop = e instanceof WalkStop ? e : new WalkStop('error', String((e && e.message) || e));
    }
    // tell Network Builder how it ended (header/facets again only if we're still on a normal list page)
    say('Finishing');
    const onList = ['end', 'cap', 'cancelled', 'stalled'].includes(stop.reason) && listKind() === kind;
    try {
      await post({ stopReason: stop.reason, ...(onList ? pageInfo() : {}) }, { final: true });
    } catch {
      /* a final post that can't be delivered leaves the run unfinished (closed as `abandoned` later); rows sent are kept */
    }
    await clearWalkState();
    ui.phase('');
    return { reason: stop.reason, message: [stop.message, closedNote].filter(Boolean).join(' '), data: last };
  }

  /** the floating "Map to Network Builder" button on list pages; never starts anything by itself */
  function ensureListButton() {
    const kind = listKind();
    if (!kind) {
      if (listBtn) listBtn.remove();
      listBtn = null;
      if (listHost && !walk) closeListPanel();
      return;
    }
    if (listBtn && document.contains(listBtn)) return;
    listBtn = el('button', {
      type: 'button',
      id: 'nb-list-btn',
      title: 'Map the people in this list to an account in Network Builder',
      style: 'position:fixed;right:20px;bottom:20px;z-index:2147482000;border:0;border-radius:20px;padding:10px 16px;color:#fff;' +
        'background:linear-gradient(135deg,#5b5bf0,#8b4fe0 60%,#c04fd0);font:600 14px -apple-system,system-ui,sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.2);cursor:pointer;',
      text: '⇣ Map to Network Builder',
    });
    listBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted) openListPanel();
    });
    document.documentElement.append(listBtn);
  }

  // LinkedIn is a single-page app: re-check when the URL or the page changes
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      ensureButton();
      ensureListButton();
    }, 400);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
  recoverWalk(); // a walk interrupted by a full page load in this tab is closed, never resumed
})();
