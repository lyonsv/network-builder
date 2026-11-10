/* Network Builder for LinkedIn — content script.
 *
 * On a profile page (linkedin.com/in/<slug>) it adds a "Network Builder" button next to Message / More. Clicking it
 * opens a small panel to file the person under an account. Only the profile you are looking at is read, only when you
 * click — no crawling, no background page loads.
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
  // The profile page only shows a summary (and LinkedIn renders sections lazily), so on click we open the person's
  // "Show all" pages in hidden same-origin frames — exactly what you'd see clicking through — and read their text.
  const DETAIL_KINDS = ['experience', 'education', 'skills', 'certifications', 'languages', 'volunteering-experiences', 'honors'];

  function loadDetail(slug, kind, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.src = `${location.origin}/in/${encodeURIComponent(decodeURIComponent(slug))}/details/${kind}/`;
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = 'position:fixed;left:0;top:0;width:1100px;height:2400px;opacity:0;pointer-events:none;z-index:-1;border:0;';
      let done = false;
      let last = -1;
      let stableSince = 0;
      const started = Date.now();
      const finish = (val) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        f.remove();
        resolve(val);
      };
      const timer = setInterval(() => {
        let doc;
        try {
          doc = f.contentDocument;
        } catch {
          return finish(null); // not same-origin (blocked)
        }
        const main = doc && (doc.querySelector('main') || doc.body);
        if (main) {
          try {
            f.contentWindow.scrollTo(0, doc.documentElement.scrollHeight); // trigger lazy loading
          } catch {}
          const text = main.innerText || '';
          if (text.length !== last) {
            last = text.length;
            stableSince = Date.now();
          } else if (text.trim().length > 15 && Date.now() - stableSince > 1500) {
            // structured items when the classic list markup is there; the text is always sent
            const lists = [...main.querySelectorAll('ul')].filter((u) => !u.parentElement.closest('ul'));
            const big = lists.sort((a, b) => b.children.length - a.children.length)[0];
            return finish({ text: text.slice(0, 30000), items: big ? listItems(big) : [] });
          }
        }
        if (Date.now() - started > timeoutMs) finish(last > 15 && main ? { text: (main.innerText || '').slice(0, 30000), items: [] } : null);
      }, 400);
      document.documentElement.append(f);
    });
  }

  /** load all detail pages, 3 at a time; onProgress(doneCount, total) */
  async function loadDetails(slug, onProgress) {
    const out = {};
    let n = 0;
    const queue = [...DETAIL_KINDS];
    const worker = async () => {
      while (queue.length) {
        const kind = queue.shift();
        const r = await loadDetail(slug, kind);
        // keep only pages that are that list (a missing section shows LinkedIn's empty / error page instead)
        const word = kind === 'volunteering-experiences' ? 'volunteer' : kind === 'honors' ? 'hono' : kind.slice(0, 7);
        if (r && r.text && r.text.slice(0, 3000).toLowerCase().includes(word)) out[kind] = r;
        onProgress && onProgress(++n, DETAIL_KINDS.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out;
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
    const detailSlot = el('div', { class: 'found muted' }, 'Reading full experience, education & skills…');
    const slug = profileSlug();
    let details = null;
    const detailsReady = loadDetails(slug, (n, t) => {
      if (shadow && n < t) detailSlot.textContent = `Reading full experience, education & skills… ${n}/${t}`;
    }).then((d) => {
      details = d;
      if (!shadow) return d;
      const got = Object.keys(d);
      detailSlot.textContent = got.length
        ? `✓ Full profile read: ${got.map((k) => k.replace('-experiences', '')).join(', ')}`
        : 'Couldn’t open the full lists — the visible profile will be saved.';
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
          banner('ok', `✓ ${d.addedToAccount ? 'Added' : 'Updated'} ${d.person.fullName} ${d.addedToAccount ? 'to' : 'on'} ${d.account.name}${d.createdAccount ? ' (new account)' : ''}${d.isConnection ? ' · your connection' : ''}.`),
        );
        goBtn.textContent = 'Saved ✓';
        goBtn.disabled = true;
        setButtonState(true, d.account.name);
        setTimeout(closePanel, 2500);
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

  // LinkedIn is a single-page app: re-check when the URL or the page changes
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      ensureButton();
    }, 400);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
