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

  function topCard() {
    const h1 = document.querySelector('main h1');
    return h1 ? h1.closest('section') || h1.parentElement : null;
  }

  function sectionItems(section) {
    const list = section.querySelector('ul');
    if (!list) return [];
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

  function scrape() {
    const main = document.querySelector('main') || document.body;
    const card = topCard();
    const h1 = document.querySelector('main h1');
    const fullName = txt(h1);
    let headline = txt(card && card.querySelector('.text-body-medium'));
    let location = txt(card && card.querySelector('.text-body-small.inline.t-black--light, span.text-body-small.inline'));
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
    const thin = !nExp ? banner('info', 'Experience hasn’t loaded on this page yet. Scroll down the profile so LinkedIn loads it, then reopen this panel — or save now (the page text is kept).') : null;

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
      const fresh = scrape(); // the page may have loaded more since the panel opened
      const hit = accountsCache && accountsCache.find((a) => a.name.toLowerCase() === name.toLowerCase());
      const body = {
        profile: fresh.fullName ? fresh : p,
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
      class: 'artdeco-button artdeco-button--2 artdeco-button--secondary',
      style: 'margin-left:8px;display:inline-flex;align-items:center;gap:4px;',
      title: 'Add this person to an account in Network Builder',
    }, el('span', { text: '＋', 'aria-hidden': 'true' }), el('span', { class: 'nb-label artdeco-button__text', text: 'Network Builder' }));
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel();
    });
    return b;
  }

  function findActionBar(card) {
    if (!card) return null;
    const more = card.querySelector('button[aria-label*="More actions"], button[aria-label^="More"]');
    if (more) {
      const bar = more.closest('div.pvs-profile-actions, div[class*="profile-actions"]') || more.parentElement?.parentElement || more.parentElement;
      if (bar) return bar;
    }
    const msg = card.querySelector('a[href*="/messaging/"], button[aria-label^="Message"]');
    return msg ? msg.parentElement?.parentElement || msg.parentElement : null;
  }

  let lastSlug = '';
  async function ensureButton() {
    const slug = profileSlug();
    if (!slug) {
      if (btn) btn.remove();
      btn = null;
      lastSlug = '';
      return;
    }
    const card = topCard();
    if (!card) return;
    if (btn && document.contains(btn) && slug === lastSlug) return;
    if (btn) btn.remove();
    btn = makeButton();
    const bar = findActionBar(card);
    if (bar) bar.append(btn);
    else {
      // couldn't find the Message/More row: float the button at the bottom-right instead
      btn.className = '';
      btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147482000;background:#0a66c2;color:#fff;border:0;border-radius:20px;padding:10px 16px;font:600 14px -apple-system,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2);cursor:pointer;display:inline-flex;gap:4px;';
      document.body.append(btn);
    }
    if (slug === lastSlug && savedLabel) setButtonState(true, savedLabel);
    if (slug !== lastSlug) {
      lastSlug = slug;
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
