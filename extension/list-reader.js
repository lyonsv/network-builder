/* Network Builder for LinkedIn — list reader (pure DOM helpers, no chrome.* calls, no network, no timers).
 *
 * Used by content.js on a company's People tab and on people-search results. Every function takes the document (and
 * a URL) as arguments so it can be unit-tested against small HTML fixtures (test/list-capture.test.ts). It reads only
 * what is visible on the page: the result cards' text, each card's /in/ link, the header count and the "What they do"
 * module. Screen-reader-only copies, hidden elements, data-* attributes and ids are never read.
 *
 * LinkedIn's class names change often, so each lookup tries known selectors first and falls back to structure/text.
 * Parsing (names, headlines, numbers) happens in Network Builder (src/accounts/list-capture.ts), not here.
 */
(() => {
  /** /company/<slug>/people/ → 'people-tab'; /search/results/people/ → 'search'; else '' */
  function pageKind(pathname) {
    if (/^\/company\/[^/]+\/people\/?$/.test(pathname || '')) return 'people-tab';
    if (/^\/search\/results\/people\/?$/.test(pathname || '')) return 'search';
    return '';
  }
  function companySlug(pathname) {
    const m = /^\/company\/([^/]+)\//.exec(pathname || '');
    return m ? decodeURIComponent(m[1]).toLowerCase() : '';
  }
  function keywordsOf(href) {
    try {
      return (new URL(href).searchParams.get('keywords') || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch {
      return '';
    }
  }

  /**
   * Search params that define the result set (mirrors LIST_FILTER_PARAMS in src/accounts/list-capture.ts). Anything
   * else is UI state LinkedIn adds or changes while paging (page, origin, spellCorrectionEnabled, prioritizeMessage, sid…).
   */
  const FILTER_PARAMS = ['keywords', 'currentCompany', 'pastCompany', 'company', 'geoUrn', 'network', 'title', 'industry', 'schoolFilter', 'school',
    'profileLanguage', 'serviceCategory', 'firstName', 'lastName', 'connectionOf', 'followerOf', 'facetCurrentFunction',
    'facetGeoRegion', 'facetNetwork', 'facetIndustry', 'facetSchool', 'facetCurrentCompany', 'facetPastCompany',
    'functionFacet', 'seniorityFacet', 'yearsAtCompanyFacet'];
  /** a key for "same list": the result-set filters only, so paging (and LinkedIn's extra flags) never looks like a new search */
  function filterKey(href) {
    let q;
    try {
      q = new URL(href).searchParams;
    } catch {
      return '';
    }
    const out = [];
    for (const k of FILTER_PARAMS) {
      for (const v of q.getAll(k)) if (v.trim()) out.push(`${k}=${v.trim()}`);
    }
    return out.join('&');
  }

  // ---------- visible text ----------
  /** not shown on screen (screen-reader-only copies, hidden elements) */
  const HIDDEN = '[class*="visually-hidden"], .sr-only, .a11y-text, [hidden]';
  /** never read as text: hidden parts, media, code and form fields */
  const NOT_TEXT = `${HIDDEN}, script, style, template, noscript, code, svg, img, input, select, textarea`;
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL']);

  function isHiddenEl(e, sel = HIDDEN) {
    if (!e || e.nodeType !== 1) return false;
    if (e.matches(sel)) return true;
    const st = e.getAttribute('style') || '';
    return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(st);
  }

  /**
   * the element's visible text as lines: block elements break lines; screen-reader-only and hidden parts are skipped,
   * and with `noButtons` so are buttons (a card's Connect / Follow — but the insight bars ARE buttons)
   */
  function visibleLines(root, noButtons, skip) {
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === 3) {
        parts.push(n.nodeValue);
        return;
      }
      if (n.nodeType !== 1 || isHiddenEl(n, NOT_TEXT) || (noButtons && n.matches('button, [role="button"]')) || (skip && skip.has(n))) return;
      const block = BLOCK.has(n.tagName);
      if (block) parts.push('\n');
      for (const c of n.childNodes) walk(c);
      if (block) parts.push('\n');
      else parts.push(' ');
    };
    walk(root);
    const out = [];
    for (const raw of parts.join('').split('\n')) {
      const l = raw.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
      if (l && l !== out[out.length - 1]) out.push(l);
    }
    return out;
  }

  // ---------- result cards ----------
  const PROFILE_PATH = /^\/in\/[^/?#]+\/?$/;

  function profileHref(a, base) {
    try {
      const u = new URL(a.getAttribute('href') || '', base);
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return '';
      const m = /^\/in\/[^/?#]+/.exec(u.pathname);
      return m && PROFILE_PATH.test(u.pathname) ? `https://www.linkedin.com${m[0]}` : '';
    } catch {
      return '';
    }
  }
  function profileLinks(root, base) {
    const out = [];
    for (const a of root.querySelectorAll('a[href*="/in/"]')) {
      if (isHiddenEl(a) || a.closest(HIDDEN)) continue;
      const h = profileHref(a, base);
      if (h && !out.includes(h)) out.push(h);
    }
    return out;
  }
  const ANON = /\b(linkedin member|linkedin-mitglied|mitglied von linkedin)\b/i;

  /** known result-card containers first (they change), then any list item holding exactly one profile (or a "LinkedIn Member") */
  const CARD_SELECTORS = [
    'li.org-people-profile-card__profile-card-spacing',
    'li.reusable-search__result-container',
    'ul.reusable-search__entity-result-list > li',
    '.scaffold-finite-scroll__content > ul > li',
  ];

  function resultCards(doc, base) {
    const root = doc.querySelector('main') || doc.body;
    if (!root) return [];
    for (const sel of CARD_SELECTORS) {
      const found = [...root.querySelectorAll(sel)].filter((li) => !li.closest(HIDDEN));
      if (found.length) return found;
    }
    const cands = [...root.querySelectorAll('li, [role="listitem"]')].filter((li) => {
      if (li.closest(HIDDEN) || li.closest('nav, header, footer, aside')) return false;
      const n = profileLinks(li, base).length;
      return n === 1 || (n === 0 && ANON.test(visibleLines(li)[0] || ''));
    });
    // outermost candidates only (a card may contain inner lists)
    return cands.filter((li) => !cands.some((o) => o !== li && o.contains(li)));
  }

  /** one card → {lines, href}: the visible text and the profile link, nothing else */
  function readCard(card, base) {
    return { lines: visibleLines(card, true).slice(0, 20).map((l) => l.slice(0, 500)), href: profileLinks(card, base)[0] || '' };
  }

  // ---------- header count + "What they do" ----------
  const HEADER_TEXT = /\d[\d.,   ]*\s*[KkMm]?\+?\s+(associated members|members|results|employees|zugehörige mitglieder|mitglieder|ergebnisse|beschäftigte|mitarbeiter)/i;

  /** the visible text of the element showing the total ("1,234 associated members", "About 2,300 results") or '' */
  function headerText(doc) {
    const root = doc.querySelector('main') || doc.body;
    if (!root) return '';
    const sels = ['h1', 'h2', 'h3', '[role="heading"]', '.org-people__header', '.search-results-container h2', 'div', 'span', 'p'];
    for (const sel of sels) {
      for (const e of root.querySelectorAll(sel)) {
        if ((e.textContent || '').length > 300 || isHiddenEl(e) || e.closest(HIDDEN) || e.closest('li')) continue;
        const t = visibleLines(e).join(' ');
        if (t.length <= 120 && HEADER_TEXT.test(t)) return t;
      }
    }
    return '';
  }

  const FACET_HEAD = /^(what they do|was sie machen|was sie tun|tätigkeitsbereiche?)$/i;

  /** the smallest visible element holding the "What they do" heading and its counts, or null */
  function facetsBox(doc) {
    const root = doc.querySelector('main') || doc.body;
    if (!root) return null;
    for (const e of root.querySelectorAll('h1, h2, h3, h4, [role="heading"], span, div, p')) {
      if ((e.textContent || '').length > 60 || isHiddenEl(e) || e.closest(HIDDEN)) continue;
      const own = visibleLines(e);
      if (own.length !== 1 || !FACET_HEAD.test(own[0])) continue;
      // climb to the smallest container that also holds the counts
      let box = e.parentElement;
      while (box && box !== root) {
        const lines = visibleLines(box);
        if (lines.length > 2 && lines.some((l) => /\d/.test(l))) return box;
        box = box.parentElement;
      }
    }
    return null;
  }

  /** the visible text of the "What they do" insight module (heading included), or '' */
  function facetsText(doc) {
    const box = facetsBox(doc);
    return box ? visibleLines(box).slice(0, 200).join('\n') : '';
  }

  const EXPAND_LABEL = /^(show more|see more|show all|mehr anzeigen|weitere anzeigen|alle anzeigen)\b/i;
  /**
   * The "Show more" button INSIDE the "What they do" module (it lists only the top functions until expanded), or null.
   * Only ever clicked once, by "Capture headcount only", after the user's click.
   */
  function facetsExpandButton(doc) {
    const box = facetsBox(doc);
    if (!box) return null;
    for (const b of box.querySelectorAll('button, [role="button"]')) {
      if (isHiddenEl(b) || b.closest(HIDDEN) || b.disabled) continue;
      const label = ((b.textContent || '').replace(/\s+/g, ' ').trim() || b.getAttribute('aria-label') || '').trim();
      if (EXPAND_LABEL.test(label) && b.getAttribute('aria-expanded') !== 'true') return b;
    }
    return null;
  }

  // ---------- stop detectors ----------
  const CHECK_TEXT = /unusual activity|security verification|let(?:'|’)s do a quick security check|verify you(?:'|’)re (a )?human|ungewöhnliche aktivität|sicherheitsüberprüfung/i;
  const LIMIT_TEXT = /commercial use limit|reached the (monthly |weekly )?(commercial use )?limit|too many requests|search limit|nutzungslimit/i;

  const NOTICE = '[role="alert"], [role="alertdialog"], [role="dialog"], [aria-live], [class*="toast"], [class*="banner"], [class*="modal"], [class*="alert"], [class*="feedback"]';

  /** '' to carry on, else why to stop now: 'login' | 'checkpoint' | 'rate-limit' */
  function stopReason(doc, href) {
    let path = '';
    try {
      path = new URL(href).pathname;
    } catch {
      /* keep '' */
    }
    if (/^\/(checkpoint|challenge)\b/.test(path)) return 'checkpoint';
    if (/^\/(authwall|login|uas|signup)\b/.test(path)) return 'login';
    if (doc.querySelector('iframe[src*="captcha" i], iframe[src*="challenge" i], iframe[title*="captcha" i], iframe[title*="challenge" i], #captcha-internal')) return 'checkpoint';
    // visible text of banners / toasts / dialogs / alerts anywhere, plus the page's main area — never the result cards
    // (a headline may say "unusual activity"), hidden parts, or code/script blocks (LinkedIn's embedded JSON)
    const cards = new Set(resultCards(doc, href));
    const texts = [];
    const main = doc.querySelector('main') || doc.body;
    for (const e of doc.querySelectorAll(NOTICE)) {
      if (e.closest(HIDDEN) || [...cards].some((c) => c.contains(e))) continue;
      if (main && main.contains(e)) continue; // read with main below
      texts.push(visibleLines(e, false, cards).join('\n'));
    }
    if (main) texts.push(visibleLines(main, false, cards).join('\n'));
    const text = texts.join('\n');
    if (LIMIT_TEXT.test(text)) return 'rate-limit';
    if (CHECK_TEXT.test(text)) return 'checkpoint';
    return '';
  }

  /** the page says there are no results */
  function noResults(doc) {
    const root = doc.querySelector('main') || doc.body;
    return !!root && /\bno results found\b|keine ergebnisse gefunden/i.test(root.textContent || '');
  }

  // ---------- paging ----------
  /** must name results: the insight modules have their own "Show more" toggles */
  const LOAD_MORE = /^(show|load|see|view)\s+(\d+\s+)?more\s+results$|^(weitere|mehr)\s+ergebnisse\s+anzeigen$/i;
  const NEXT = /^(next|weiter|nächste)$/i;
  const btnLabel = (b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim();
  const usable = (b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true' && !isHiddenEl(b) && !b.closest('[hidden]');

  /** the "Show more results" button under a People tab list, or null */
  function loadMoreButton(doc) {
    const root = doc.querySelector('main') || doc.body;
    const bs = [...root.querySelectorAll('button, [role="button"]')].filter((b) => usable(b) && LOAD_MORE.test(btnLabel(b)));
    return bs[bs.length - 1] || null;
  }
  /** the search results' "Next" page button (enabled), or null */
  function nextButton(doc) {
    const root = doc.querySelector('main') || doc.body;
    const bs = [...root.querySelectorAll('button, a[role="button"], a')].filter((b) => usable(b) && NEXT.test(btnLabel(b)));
    return bs[bs.length - 1] || null;
  }

  globalThis.NBList = { pageKind, companySlug, keywordsOf, filterKey, visibleLines, resultCards, readCard, headerText, facetsText, facetsExpandButton, stopReason, noResults, loadMoreButton, nextButton };
})();
