import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanCompany, cleanPersonName, listFilters, parseCount, parseFunctionFacets, parseListCard, parsePeopleHeader } from '../src/accounts/list-capture';

// Everything here is fictional: Ledgerly is not a real company and nobody named is a real person.

const root = path.join(import.meta.dirname, '..');
const fixture = (f: string) => readFileSync(path.join(root, 'test/fixtures', f), 'utf8');

interface NBList {
  pageKind(p: string): string;
  companySlug(p: string): string;
  keywordsOf(href: string): string;
  filterKey(href: string): string;
  resultCards(doc: Document, base: string): Element[];
  readCard(card: Element, base: string): { lines: string[]; href: string };
  headerText(doc: Document): string;
  facetsText(doc: Document): string;
  facetsExpandButton(doc: Document): HTMLElement | null;
  stopReason(doc: Document, href: string): string;
  noResults(doc: Document): boolean;
  loadMoreButton(doc: Document): Element | null;
  nextButton(doc: Document): Element | null;
  pageNumber(href: string): number;
  isLoading(doc: Document): boolean;
  reloadVerdict(saved: unknown, href: string, at: number): 'continue' | 'end' | 'cancelled';
  resultsRendered(doc: Document, href: string): boolean;
}
let L: NBList;
beforeAll(() => {
  // the extension's list reader is a plain script that sets globalThis.NBList (no build step)
  new Function(readFileSync(path.join(root, 'extension/list-reader.js'), 'utf8'))();
  L = (globalThis as unknown as { NBList: NBList }).NBList;
});

function page(html: string, url: string): { doc: Document; url: string } {
  const w = new Window({ url });
  w.document.body.innerHTML = html;
  return { doc: w.document as unknown as Document, url };
}

describe('parseListCard (server side)', () => {
  it('reads a vanity card: name, degree, headline split, noise dropped', () => {
    const c = parseListCard({
      lines: ['Riley Moss', '· 2nd', 'Head of Brand at Ledgerly | Storytelling', '12 mutual connections', 'Connect'],
      href: 'https://www.linkedin.com/in/Riley-Moss-Example?miniProfileUrn=x',
    });
    expect(c).toEqual({
      fullName: 'Riley Moss', url: 'https://www.linkedin.com/in/riley-moss-example', headline: 'Head of Brand at Ledgerly | Storytelling',
      title: 'Head of Brand', company: 'Ledgerly', location: '', degree: '2nd', anonymous: false,
    });
  });

  it('keeps a URN link’s case, reads a trailing degree and a location; DE "bei"; the Current: line wins for the company', () => {
    const c = parseListCard({
      lines: ['Jonas Müller-Brandt • 2nd', 'Leiter Marketing bei Ledgerly', 'Berlin, Germany', 'Current: Leiter Marketing bei Ledgerly Services GmbH'],
      href: 'https://www.linkedin.com/in/ACoAABcdEfGh1234567',
    });
    expect(c).toMatchObject({
      fullName: 'Jonas Müller-Brandt', url: 'https://www.linkedin.com/in/ACoAABcdEfGh1234567', degree: '2nd', title: 'Leiter Marketing',
      company: 'Ledgerly Services GmbH', location: 'Berlin, Germany', anonymous: false,
    });
  });

  it('LinkedIn badge text never ends up in a name (EN + DE)', () => {
    expect(cleanPersonName('Ava Lindqvist is hiring')).toBe('Ava Lindqvist');
    expect(cleanPersonName('Jonas Müller-Brandt stellt ein')).toBe('Jonas Müller-Brandt');
    expect(cleanPersonName('Mia Chen Premium · 2nd')).toBe('Mia Chen');
    expect(cleanPersonName('Dev Rao (He/Him) ✅ Verified')).toBe('Dev Rao');
    expect(cleanPersonName('Noor Haddad • 3rd+')).toBe('Noor Haddad');
    expect(cleanPersonName('Sam Okafor 🚀')).toBe('Sam Okafor');
    expect(cleanPersonName('Riley Hiring')).toBe('Riley Hiring'); // a surname, not the badge
    expect(parseListCard({ lines: ['Ben Ortiz is hiring', 'Brand Manager at Ledgerly'], href: 'https://www.linkedin.com/in/ben-ortiz-example' }).fullName).toBe('Ben Ortiz');
  });

  it('a headline without " at " uses the Current: line for the company; pronouns leave the name', () => {
    const c = parseListCard({ lines: ['Ava Lindqvist (she/her)', 'CMO', 'Munich', 'Current: Chief Marketing Officer at Ledgerly'], href: 'https://www.linkedin.com/in/ava-lindqvist-example' });
    expect(c).toMatchObject({ fullName: 'Ava Lindqvist', headline: 'CMO', title: 'Chief Marketing Officer', company: 'Ledgerly', location: 'Munich' });
    expect(parseListCard({ lines: ['Dev Rao', 'Brand Specialist'], href: 'https://www.linkedin.com/in/dev-rao-example' })).toMatchObject({ title: 'Brand Specialist', company: '' });
  });

  it('"LinkedIn Member" or no profile link → anonymous, no name or URL', () => {
    const a = parseListCard({ lines: ['LinkedIn Member', 'Senior Marketing Manager at Ledgerly', 'Hamburg, Germany'], href: 'https://www.linkedin.com/in/ACoAABcdEfGh1234567' });
    expect(a).toMatchObject({ anonymous: true, fullName: '', url: '', headline: 'Senior Marketing Manager at Ledgerly', location: 'Hamburg, Germany' });
    expect(parseListCard({ lines: ['Pat Example', 'Marketing'], href: '' }).anonymous).toBe(true);
    expect(parseListCard({ lines: ['Pat Example'], href: 'https://www.linkedin.com/company/ledgerly/' }).anonymous).toBe(true);
    expect(parseListCard({ lines: 'nope' as unknown, href: 42 as unknown }).anonymous).toBe(true);
  });
});

describe('live findings (2026-11-23 search walk)', () => {
  const p1 = 'https://www.linkedin.com/search/results/people/?keywords=marketing&origin=COMPANY_PAGE_CANNED_SEARCH&currentCompany=%5B%224242424%22%5D';
  const p2 = `${p1}&page=2&spellCorrectionEnabled=true&prioritizeMessage=false`;

  it('paging (page=2 + LinkedIn’s extra flags) is the same list; a changed filter is not', () => {
    expect(L.filterKey(p2)).toBe(L.filterKey(p1));
    expect(L.filterKey(p1)).toBe('keywords=marketing&currentCompany=["4242424"]');
    expect(L.filterKey(p1.replace('keywords=marketing', 'keywords=brand'))).not.toBe(L.filterKey(p1));
    expect(L.filterKey(`${p1}&geoUrn=%5B%22101282230%22%5D`)).not.toBe(L.filterKey(p1));
    expect(L.filterKey(p1.replace('currentCompany=%5B%224242424%22%5D', 'pastCompany=%5B%224242424%22%5D'))).not.toBe(L.filterKey(p1));
    expect(L.filterKey('not a url')).toBe('');
    // the server labels headcounts with the same filters
    expect(listFilters(p2)).toEqual([['keywords', 'marketing'], ['currentCompany', '["4242424"]']]);
  });

  it('a Past: line never sets the company; a currentCompany search falls back to the account', () => {
    const lines = ['Mila Ostrowski', '· 3rd', 'Brand & Campaigns', 'Frankfurt, Germany', 'Past: Marketing Manager at Acme GmbH & Co. KG'];
    const href = 'https://www.linkedin.com/in/mila-ostrowski-example';
    expect(parseListCard({ lines, href })).toMatchObject({ title: 'Brand & Campaigns', company: '' });
    expect(parseListCard({ lines, href, pageUrl: p2, accountName: 'Ledgerly' })).toMatchObject({ title: 'Brand & Campaigns', company: 'Ledgerly' });
    // no currentCompany filter: no fallback
    expect(parseListCard({ lines, href, pageUrl: 'https://www.linkedin.com/search/results/people/?keywords=marketing', accountName: 'Ledgerly' }).company).toBe('');
    expect(parseListCard({ lines: ['Mila Ostrowski', 'Früher: Marketing Manager bei Acme GmbH & Co. KG'], href }).company).toBe('');
    // Current / Aktuell beat the headline; the headline beats the fallback
    expect(parseListCard({ lines: ['Noor Haddad', 'Marketing at Ledgerly', 'Aktuell: Head of Partner Marketing bei Ledgerly Niederlassung GmbH'], href, pageUrl: p1, accountName: 'Ledgerly' }))
      .toMatchObject({ title: 'Head of Partner Marketing', company: 'Ledgerly Niederlassung GmbH' });
    expect(parseListCard({ lines: ['Noor Haddad', 'Marketing Manager @Ledgerly Clouds'], href, pageUrl: p1, accountName: 'Ledgerly' })).toMatchObject({ title: 'Marketing Manager', company: 'Ledgerly Clouds' });
  });

  it('messy headline companies are trimmed to the company', () => {
    expect(cleanCompany('Ledgerly @Ledgerly Clouds ☁️')).toEqual({ company: 'Ledgerly', hint: 'Ledgerly Clouds' });
    expect(cleanCompany('Ledgerly - Aufbau und Leitung des Marketing-Teams für die Ledgerly Niederlassung Nord und das...').company).toBe('Ledgerly');
    expect(cleanCompany('Ledgerly | Brand · Content').company).toBe('Ledgerly');
    expect(cleanCompany('Ledgerly 🚀 we are hiring').company).toBe('Ledgerly');
    expect(cleanCompany('Ledgerly Niederlassung Nord und das...').company).toBe('');
    expect(cleanCompany('Acme GmbH & Co. KG')).toEqual({ company: 'Acme GmbH & Co. KG', hint: '' });
    const c = parseListCard({ lines: ['Lars Feld', 'Marketingleitung bei Ledgerly - Aufbau und Leitung des Marketing-Teams für die Ledgerly Niederlassung und das...'], href: 'https://www.linkedin.com/in/lars-feld-example' });
    expect(c).toMatchObject({ title: 'Marketingleitung', company: 'Ledgerly' });
    expect(parseListCard({ lines: ['Lars Feld', 'Growth Marketing at Ledgerly @Ledgerly Clouds ☁️'], href: 'https://www.linkedin.com/in/lars-feld-example' }).company).toBe('Ledgerly');
  });

  it('search results count (EN/DE) is read as a header', () => {
    expect(parsePeopleHeader('About 1,234 results')).toBe(1234);
    expect(parsePeopleHeader('Ungefähr 1.234 Ergebnisse')).toBe(1234);
    const { doc } = page('<main><h2><div>Ungefähr 1.234 Ergebnisse</div></h2><ul><li><a href="/in/x-example">X</a></li></ul></main>', p1);
    expect(parsePeopleHeader(L.headerText(doc))).toBe(1234);
  });
});

describe('header + facets (server side)', () => {
  it('parses EN/DE header counts with every thousands separator', () => {
    expect(parsePeopleHeader('1,234 associated members')).toBe(1234);
    expect(parsePeopleHeader('1.234 Mitglieder')).toBe(1234);
    expect(parsePeopleHeader('1.234 zugehörige Mitglieder')).toBe(1234);
    expect(parsePeopleHeader('1 234 associated members')).toBe(1234);
    expect(parsePeopleHeader('About 2,300 results')).toBe(2300);
    expect(parsePeopleHeader('Etwa 2.300 Ergebnisse')).toBe(2300);
    expect(parsePeopleHeader('87 results')).toBe(87);
    expect(parsePeopleHeader('1.2K associated members')).toBe(1200);
    expect(parsePeopleHeader('People you may know')).toBeNull();
    expect(parsePeopleHeader(undefined)).toBeNull();
    expect(parseCount('12,345,678')).toBe(12345678);
  });

  it('parses "What they do" in either layout and stops at the next module', () => {
    const text = ['Where they live', '612 Germany', 'What they do', '412 Marketing', '1,023 Sales', '57', 'Media and Communication', '+ Add', 'Where they studied', '30 Example University'].join('\n');
    expect(parseFunctionFacets(text)).toEqual([
      { label: 'Marketing', count: 412 },
      { label: 'Sales', count: 1023 },
      { label: 'Media and Communication', count: 57 },
    ]);
    expect(parseFunctionFacets('Was sie machen\nMarketing\n1.023\nVertrieb (88)')).toEqual([
      { label: 'Marketing', count: 1023 },
      { label: 'Vertrieb', count: 88 },
    ]);
    expect(parseFunctionFacets('')).toEqual([]);
  });
});

describe('extension list reader (DOM, fictional fixtures)', () => {
  it('detects list pages, the company slug and keywords', () => {
    expect(L.pageKind('/company/ledgerly/people/')).toBe('people-tab');
    expect(L.pageKind('/search/results/people/')).toBe('search');
    expect(L.pageKind('/in/riley-moss-example/')).toBe('');
    expect(L.pageKind('/company/ledgerly/')).toBe('');
    expect(L.companySlug('/company/ledgerly/people/')).toBe('ledgerly');
    expect(L.keywordsOf('https://www.linkedin.com/company/ledgerly/people/?keywords=marketing%20ops')).toBe('marketing ops');
  });

  it('People tab: known card selectors, visible text only, header, facets, Show more', () => {
    const { doc, url } = page(fixture('linkedin-people-tab.html'), 'https://www.linkedin.com/company/ledgerly/people/?keywords=marketing');
    const cards = L.resultCards(doc, url).map((c) => L.readCard(c, url));
    expect(cards).toHaveLength(3);
    expect(cards[0]).toEqual({
      lines: ['Riley Moss', '· 2nd', 'Head of Brand at Ledgerly | Storytelling for fintech', '12 mutual connections'],
      href: 'https://www.linkedin.com/in/riley-moss-example',
    });
    expect(cards[1]!.href).toBe('');
    expect(cards[2]!.href).toBe('https://www.linkedin.com/in/ACoAABcdEfGh1234567');
    // no hidden fields, screen-reader copies, buttons, data-* attributes
    const all = JSON.stringify(cards);
    for (const bad of ['hidden-field', 'hidden-input', 'degree connection', 'Connect', 'Follow', 'urn:li:member', 'miniProfileUrn']) expect(all).not.toContain(bad);

    const parsed = cards.map((c) => parseListCard(c));
    expect(parsed.map((p) => [p.fullName, p.anonymous, p.title])).toEqual([
      ['Riley Moss', false, 'Head of Brand'],
      ['', true, 'Senior Marketing Manager'],
      ['Sam Okafor', false, 'Content Lead'],
    ]);

    expect(parsePeopleHeader(L.headerText(doc))).toBe(1234);
    expect(L.headerText(doc)).not.toContain('Total');
    expect(parseFunctionFacets(L.facetsText(doc))).toEqual([
      { label: 'Marketing', count: 412 },
      { label: 'Sales', count: 1023 },
      { label: 'Media and Communication', count: 57 },
    ]);
    expect(L.loadMoreButton(doc)?.textContent).toContain('Show more results');
    expect(L.stopReason(doc, url)).toBe('');
  });

  it('search results: structural fallback finds the cards; Next button; header', () => {
    const { doc, url } = page(fixture('linkedin-search.html'), 'https://www.linkedin.com/search/results/people/?keywords=marketing&currentCompany=%5B%221%22%5D');
    const cards = L.resultCards(doc, url).map((c) => L.readCard(c, url));
    expect(cards).toHaveLength(3);
    const parsed = cards.map((c) => parseListCard(c));
    expect(parsed[0]).toMatchObject({ fullName: 'Jonas Müller-Brandt', degree: '2nd', title: 'Leiter Marketing', company: 'Ledgerly Services GmbH', location: 'Berlin, Germany' });
    expect(JSON.stringify(cards[0])).not.toContain('View Jonas');
    expect(parsed[1]).toMatchObject({ anonymous: true, headline: 'Marketing Operations Specialist at Ledgerly', location: 'Hamburg, Germany' });
    expect(parsed[2]).toMatchObject({ fullName: 'Ava Lindqvist', degree: '1st', title: 'Chief Marketing Officer', company: '', location: 'Munich, Bavaria, Germany' });
    // the search filters on the current company, so a card without a company works at the account
    expect(parseListCard({ ...cards[2]!, pageUrl: url, accountName: 'Ledgerly' })).toMatchObject({ company: 'Ledgerly' });
    expect(parsePeopleHeader(L.headerText(doc))).toBe(2300);
    expect(L.nextButton(doc)?.getAttribute('aria-label')).toBe('Next');
    expect(L.loadMoreButton(doc)).toBeNull();
    expect(L.facetsText(doc)).toBe('');
  });

  it('stop scan: a late banner stops the walk; card text and embedded JSON never do', () => {
    const cards = Array.from({ length: 60 }, (_, i) =>
      `<li><a href="https://www.linkedin.com/in/person-${i}-example">Person ${i}</a><div>${'Marketing at Ledgerly. '.repeat(40)}</div></li>`).join('');
    const json = `<code style="display: none">${JSON.stringify({ x: 'unusual activity commercial use limit '.repeat(50) })}</code>`;
    const url = 'https://www.linkedin.com/company/ledgerly/people/';
    // a headline that says "unusual activity", hidden JSON blocks that mention limits → carry on
    const quiet = page(`${json}<main><ul>${cards}<li><a href="https://www.linkedin.com/in/sec-example">Sec Example</a><div>Detecting unusual activity at Ledgerly</div></li></ul></main>`, url);
    expect((quiet.doc.body.textContent || '').length).toBeGreaterThan(40_000);
    expect(L.stopReason(quiet.doc, url)).toBe('');
    // the same page with a limit toast at the very end (after 40k chars of cards) → stop
    const late = page(`${json}<main><ul>${cards}</ul></main><div class="artdeco-toasts"><div role="alert"><p>You’ve reached the monthly limit for profile searches.</p></div></div>`, url);
    expect(L.stopReason(late.doc, url)).toBe('rate-limit');
    const lateCheck = page(`<main><ul>${cards}</ul><div class="msg-banner"><p>We’ve noticed some unusual activity.</p></div></main>`, url);
    expect(L.stopReason(lateCheck.doc, url)).toBe('checkpoint');
    // a hidden alert doesn't count
    const hidden = page(`<main><ul>${cards}</ul></main><div role="alert" hidden>You’ve reached the monthly limit.</div>`, url);
    expect(L.stopReason(hidden.doc, url)).toBe('');
  });

  it('headcount only: the one expand button is the "Show more" inside What they do, nothing else', () => {
    const url = 'https://www.linkedin.com/company/ledgerly/people/';
    const { doc } = page(
      '<main><h2>1,250 associated members</h2><div class="where"><h4>Where they live</h4><div>800 Germany</div><div>200 France</div><button>Show more</button></div>' +
        '<div class="insights"><h4>What they do</h4><div>90 Sales</div><div>60 Engineering</div><button aria-expanded="false">Show more</button></div>' +
        '<ul><li><a href="/in/dev-rao-example">Dev Rao</a></li></ul><button>Show more results</button></main>',
      url,
    );
    const b = L.facetsExpandButton(doc)!;
    expect(b.closest('.insights')).not.toBeNull();
    expect(parsePeopleHeader(L.headerText(doc))).toBe(1250);
    const expanded = page('<main><div class="insights"><h4>What they do</h4><div>90 Sales</div><div>44 Marketing</div><button aria-expanded="true">Show less</button></div></main>', url);
    expect(L.facetsExpandButton(expanded.doc)).toBeNull();
    expect(parseFunctionFacets(L.facetsText(expanded.doc))).toEqual([{ label: 'Sales', count: 90 }, { label: 'Marketing', count: 44 }]);
    expect(L.facetsExpandButton(page('<main><p>nothing here</p></main>', url).doc)).toBeNull();
  });

  it('the headcount-only action: one trusted click, zero rows, at most one expand click, no walking', () => {
    const content = readFileSync(path.join(root, 'extension/content.js'), 'utf8');
    const h = content.slice(content.indexOf("hcBtn.addEventListener('click'"), content.indexOf('* run a walk in this panel'));
    expect(h).toContain('if (!e.isTrusted || walk || starting || hcBusy) return;');
    expect(h).toContain('rows: []');
    expect(h).toContain('final: true');
    expect(h.match(/\.click\(\)/g)).toHaveLength(1); // the What they do "Show more", once
    expect(h).not.toMatch(/startWalk|scroll|nextButton|loadMoreButton|while \(/);
  });

  it('Show more: only a "results" button, never an insight module toggle', () => {
    const { doc } = page('<main><div class="insights"><h4>What they do</h4><button>Show more</button></div><ul><li><a href="/in/dev-rao-example">Dev Rao</a></li></ul></main>', 'https://www.linkedin.com/company/ledgerly/people/');
    expect(L.loadMoreButton(doc)).toBeNull();
    const de = page('<main><ul><li><a href="/in/dev-rao-example">Dev Rao</a></li></ul><button>Weitere Ergebnisse anzeigen</button></main>', 'https://www.linkedin.com/company/ledgerly/people/');
    expect(L.loadMoreButton(de.doc)).not.toBeNull();
  });

  it('structural fallback also finds role="listitem" cards', () => {
    const url = 'https://www.linkedin.com/search/results/people/?keywords=brand';
    const { doc } = page(`<main><div role="list">
      <div role="listitem"><a href="https://www.linkedin.com/in/dev-rao-example"><span aria-hidden="true">Dev Rao</span></a><div>Brand Specialist at Ledgerly</div></div>
      <div role="listitem"><span aria-hidden="true">LinkedIn Member</span><div>Brand Manager at Ledgerly</div></div>
    </div></main>`, url);
    const parsed = L.resultCards(doc, url).map((c) => parseListCard(L.readCard(c, url)));
    expect(parsed.map((p) => [p.fullName, p.anonymous, p.title])).toEqual([['Dev Rao', false, 'Brand Specialist'], ['', true, 'Brand Manager']]);
  });

  it('role="listitem" cards with mutual-connection links: one card per person, the card’s own link (live 2026-11)', () => {
    const url = 'https://www.linkedin.com/search/results/people/?keywords=marketing&currentCompany=%5B%221%22%5D';
    const { doc } = page(fixture('linkedin-search-listitems.html'), url);
    const cards = L.resultCards(doc, url).map((c) => L.readCard(c, url));
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.href)).toEqual([
      'https://www.linkedin.com/in/mara-feld-example',
      'https://www.linkedin.com/in/oskar-brandl-example',
      '',
    ]);
    const parsed = cards.map((c) => parseListCard({ ...c, pageUrl: url, accountName: 'Ledgerly' }));
    expect(parsed.map((p) => [p.fullName, p.anonymous, p.title])).toEqual([
      ['Mara Feld', false, 'Head of Content'],
      ['Oskar Brandl', false, 'Performance Marketing Manager'],
      ['', true, 'Brand Manager'],
    ]);
    // a single mutual connection ("X is a mutual connection") never becomes the card's person either
    const one = page(`<main><div role="list"><div role="listitem"><div><a href="/in/ana-reiss-example">Ana Reiss</a></div><div>CMO at Ledgerly</div>
      <div><a href="/in/tomas-vey-example">Tomas Vey</a> is a mutual connection</div></div></div></main>`, url);
    expect(L.resultCards(one.doc, url).map((c) => L.readCard(c, url).href)).toEqual(['https://www.linkedin.com/in/ana-reiss-example']);
  });

  it('a disabled Next button means the last page', () => {
    const { doc } = page('<main><ul><li><a href="/in/dev-rao-example">Dev Rao</a></li></ul><button aria-label="Next" disabled>Next</button></main>', 'https://www.linkedin.com/search/results/people/');
    expect(L.nextButton(doc)).toBeNull();
  });

  it('stop detectors: checkpoint / sign-in URLs, captcha frames, security and limit pages, no results', () => {
    const blank = page('<main><p>Hi</p></main>', 'https://www.linkedin.com/company/ledgerly/people/');
    expect(L.stopReason(blank.doc, 'https://www.linkedin.com/checkpoint/challenge/abc')).toBe('checkpoint');
    expect(L.stopReason(blank.doc, 'https://www.linkedin.com/authwall?trk=x')).toBe('login');
    expect(L.stopReason(blank.doc, 'https://www.linkedin.com/login')).toBe('login');
    expect(L.stopReason(blank.doc, 'https://www.linkedin.com/uas/login')).toBe('login');
    const cap = page('<main><iframe src="https://www.linkedin.com/checkpoint/captcha-frame"></iframe></main>', 'https://www.linkedin.com/company/ledgerly/people/');
    expect(L.stopReason(cap.doc, cap.url)).toBe('checkpoint');
    const sec = page('<main><h1>Let’s do a quick security check</h1></main>', 'https://www.linkedin.com/company/ledgerly/people/');
    expect(L.stopReason(sec.doc, sec.url)).toBe('checkpoint');
    const unusual = page('<main><p>We’ve noticed some unusual activity on your account.</p></main>', 'https://www.linkedin.com/search/results/people/');
    expect(L.stopReason(unusual.doc, unusual.url)).toBe('checkpoint');
    const lim = page('<main><p>You’ve reached the monthly limit for profile searches.</p></main>', 'https://www.linkedin.com/search/results/people/');
    expect(L.stopReason(lim.doc, lim.url)).toBe('rate-limit');
    const commercial = page('<main><p>You’ve reached the commercial use limit on search.</p></main>', 'https://www.linkedin.com/search/results/people/');
    expect(L.stopReason(commercial.doc, commercial.url)).toBe('rate-limit');
    const none = page('<main><h2>No results found</h2></main>', 'https://www.linkedin.com/search/results/people/');
    expect(L.noResults(none.doc)).toBe(true);
    expect(L.noResults(blank.doc)).toBe(false);
  });
});

describe('walk across a full page load (live 2026-11: LinkedIn sends you back to page 1 past the last page)', () => {
  const S = 'https://www.linkedin.com/search/results/people/?keywords=marketing&currentCompany=%5B%221%22%5D';
  const saved = { runId: 'r', kind: 'search', path: '/search/results/people/', filters: '', lastPage: 13, nextClicked: true, started: true };
  beforeAll(() => {
    saved.filters = L.filterKey(S);
  });

  it('reads the page number', () => {
    expect(L.pageNumber(`${S}&page=13`)).toBe(13);
    expect(L.pageNumber(S)).toBe(1);
    expect(L.pageNumber(`${S}&page=abc`)).toBe(1);
    expect(L.pageNumber('not a url')).toBe(1);
  });

  const T = 1_800_000_000_000; // when the page load began
  const clicked = { ...saved, clickedNextAt: T - 4000 }; // our Next click, 4 s before the load
  beforeAll(() => {
    clicked.filters = saved.filters;
  });

  it('same search, page = lastPage + 1 within 30 s of our Next click → continue (live: Next does a full page load)', () => {
    const two = { ...clicked, lastPage: 1 };
    expect(L.reloadVerdict(two, `${S}&page=2&spellCorrectionEnabled=true&prioritizeMessage=false`, T)).toBe('continue');
    expect(L.reloadVerdict(clicked, `${S}&page=14`, T)).toBe('continue');
    expect(L.reloadVerdict({ ...clicked, clickedNextAt: T - 30_000 }, `${S}&page=14`, T)).toBe('continue');
    // too long after the click, a page skipped, or the click is unknown → not ours to continue
    expect(L.reloadVerdict({ ...clicked, clickedNextAt: T - 31_000 }, `${S}&page=14`, T)).toBe('cancelled');
    expect(L.reloadVerdict(clicked, `${S}&page=15`, T)).toBe('cancelled');
    expect(L.reloadVerdict(saved, `${S}&page=14`, T)).toBe('cancelled');
    expect(L.reloadVerdict({ ...clicked, clickedNextAt: T + 5000 }, `${S}&page=14`, T)).toBe('cancelled');
  });

  it('same search back on page ≤ lastPage after our Next click (page 1, no `page`) → end', () => {
    expect(L.reloadVerdict(clicked, `${S}&origin=FACETED_SEARCH&sid=x1`, T)).toBe('end');
    expect(L.reloadVerdict(clicked, `${S}&page=4`, T)).toBe('end');
    expect(L.reloadVerdict(clicked, `${S}&page=13`, T)).toBe('end');
    expect(L.reloadVerdict({ ...clicked, lastPage: 1 }, S, T)).toBe('end');
  });

  it('a reload without a recent Next click, another URL or search, a People tab → cancelled', () => {
    const noNext = { ...clicked, nextClicked: false, clickedNextAt: 0 };
    expect(L.reloadVerdict(noNext, S, T)).toBe('cancelled');
    expect(L.reloadVerdict(noNext, `${S}&page=14`, T)).toBe('cancelled');
    expect(L.reloadVerdict(clicked, 'https://www.linkedin.com/search/results/people/?keywords=sales&page=14', T)).toBe('cancelled');
    expect(L.reloadVerdict(clicked, 'https://www.linkedin.com/in/someone-example/', T)).toBe('cancelled');
    expect(L.reloadVerdict({ ...clicked, kind: 'people-tab' }, 'https://www.linkedin.com/company/ledgerly/people/', T)).toBe('cancelled');
    expect(L.reloadVerdict({ ...clicked, started: false }, `${S}&page=14`, T)).toBe('cancelled');
    expect(L.reloadVerdict(null, S, T)).toBe('cancelled');
  });

  it('a late `page` param: before the results render the URL reads as page 1; the verdict uses the settled URL', () => {
    const two = { ...clicked, lastPage: 1 };
    const w = new Window({ url: S }); // LinkedIn first shows the URL without `page` and no results yet
    const doc = w.document as unknown as Document;
    expect(L.resultsRendered(doc, w.location.href)).toBe(false);
    expect(L.reloadVerdict(two, w.location.href, T)).toBe('end'); // why the recovery must not judge yet
    w.history.replaceState(null, '', `${S}&page=2&spellCorrectionEnabled=true`);
    w.document.body.innerHTML = fixture('linkedin-search-listitems.html');
    expect(L.resultsRendered(doc, w.location.href)).toBe(true);
    expect(L.reloadVerdict(two, w.location.href, T)).toBe('continue');
    expect(L.resultsRendered(page('<main><h2>No results found</h2></main>', S).doc, S)).toBe(true);
    expect(L.resultsRendered(page('<main><div class="search-results__skeleton-card"></div></main>', S).doc, S)).toBe(false);
  });

  it('sees skeleton placeholders while a page loads, not hidden ones', () => {
    const url = S;
    expect(L.isLoading(page('<main><div class="search-results__skeleton-card"><div class="ghost-text"></div></div></main>', url).doc)).toBe(true);
    expect(L.isLoading(page('<main><ul aria-busy="true"></ul></main>', url).doc)).toBe(true);
    expect(L.isLoading(page('<main><div class="artdeco-skeleton" hidden></div><ul><li><a href="/in/dev-rao-example">Dev Rao</a></li></ul></main>', url).doc)).toBe(false);
    expect(L.isLoading(page(fixture('linkedin-search-listitems.html'), url).doc)).toBe(false);
  });

  const content = readFileSync(path.join(root, 'extension/content.js'), 'utf8');
  const fn = (name: string) => {
    const at = content.indexOf(`async function ${name}(`);
    return content.slice(at, content.indexOf('\n  }\n', at));
  };

  it('after a reload the restarted script settles, then continues our own pagination or closes the run; it never clicks', () => {
    const r = fn('recoverWalkNow');
    expect(r).toContain("send({ type: 'walkLoad' })");
    // the page number is read only after the results have settled
    expect(r.indexOf('await settle()')).toBeGreaterThan(0);
    expect(r.indexOf('await settle()')).toBeLessThan(r.indexOf('NBL.reloadVerdict(saved, location.href, loadedAt)'));
    expect(r.indexOf('const loadedAt = Date.now()')).toBeLessThan(r.indexOf('await send('));
    const st = fn('settle');
    expect(st).toContain('LIST.SETTLE_MS');
    expect(st).toContain('NBL.resultsRendered(document, location.href)');
    expect(content).toMatch(/SETTLE_MS: 15000/);
    // continue only on 'continue', never past the run cap or the daily limit
    const cont = r.slice(r.indexOf("if (verdict === 'continue')"), r.indexOf("type: 'captureList'"));
    expect(cont).toMatch(/saved\.rows[\s\S]*>= \(Number\(saved\.cap\)[\s\S]*used >= LIST\.DAILY/);
    expect(cont.indexOf("verdict = 'cap'")).toBeLessThan(cont.indexOf('openListPanel({ resume: saved })'));
    expect(r.match(/openListPanel\(/g)).toHaveLength(1);
    expect(r).toMatch(/rows: \[\], final: true, stopReason: verdict/);
    expect(r).toContain('Done — reached the end of the results (');
    expect(r).toContain('never restarts by itself');
    expect(r).not.toMatch(/startWalk|\.click\(|scroll|nextButton|loadMoreButton|while \(/);
    expect(fn('settle')).not.toMatch(/\.click\(|scroll|startWalk/);
    // the state is cleared before anything else, so a second load never handles it again
    expect(r.indexOf('await clearWalkState()')).toBeLessThan(r.indexOf("type: 'captureList'"));
    // a run that never reached Network Builder is not created by the recovery
    expect(r.indexOf('if (!saved.started)')).toBeLessThan(r.indexOf("type: 'captureList'"));
    expect(content).toMatch(/\n  recoverWalk\(\);/);
  });

  it('the walk saves its state before the first await, marks Next before clicking it, and clears it at the end', () => {
    const w = fn('startWalk');
    expect(w.indexOf('persist(); // before the first await')).toBeLessThan(w.indexOf('await '));
    expect(w.indexOf('persist({ lastPage: pageBefore, nextClicked: true, clickedNextAt: Date.now(), paceMs })')).toBeLessThan(w.indexOf('next.click()'));
    // persist() always stores the counts and the people seen (so a continuation never re-counts them)
    expect(w).toMatch(/Object\.assign\(walkState, patch \|\| \{\}, \{ rows: run\.rows, seen: \[\.\.\.seenHrefs\]/);
    // in-page: the page number after a turn is read once the URL and the results have settled
    const turn = w.slice(w.indexOf('next.click()'));
    expect(turn.indexOf('Date.now() - urlSince >= 1000')).toBeLessThan(turn.indexOf('NBL.pageNumber(location.href) <= pageBefore'));
    // a continuation keeps the run id, counts, people seen and pacing, and doesn't create a new run
    expect(w).toContain('id: resume ? resume.runId : crypto.randomUUID()');
    expect(w).toContain('rows: resume ? Number(resume.rows) || 0 : 0');
    expect(w).toContain('if (!resume) await post(pageInfo())');
    expect(w).toContain('let paceMs = walkState.paceMs;');
    expect(w).toMatch(/if \(pending\.length\) await post\(\{\}\);[^\n]*\n[\s\S]*next\.click\(\)/);
    expect(w).toContain('await clearWalkState();');
    for (const k of ['runId', 'account', 'cap', 'rows', 'filters', 'lastPage', 'started']) expect(w).toMatch(new RegExp(`${k}[:,]`));
    // LinkedIn going back to an earlier page without a full load ends the walk too
    expect(w).toMatch(/NBL\.pageNumber\(location\.href\) <= pageBefore[\s\S]*WalkStop\('end'/);
  });

  it('a slow page shows "Waiting for LinkedIn to load page N… Xs"; 60 s without new cards stops as stalled', () => {
    const w = fn('startWalk');
    expect(content).toMatch(/STALL_MS: 60000/);
    expect(w).toContain('Waiting for LinkedIn to load ${want}');
    expect(w).toContain('`page ${pageBefore + 1}`');
    expect(w).toContain('say(`${label}… ${Math.round(waited / 1000)}s`)');
    expect(w).toMatch(/new WalkStop\('stalled', `[^`]*Reload the page/);
    expect(w).toMatch(/if \(turned === 'stalled'\) throw stalled\(want\)/);
    expect(w).toMatch(/if \(loaded === 'stalled'\) throw stalled\(want\)/);
  });

  it('review fixes: heartbeat while paused / waiting; closed run ends quietly; stale state ignored; Start waits for recovery', () => {
    const w = fn('startWalk');
    // 1. an empty post at least every 2 minutes, from check() and inside the hidden-tab pause loop
    expect(content).toMatch(/HEARTBEAT_MS: 120000/);
    const hb = w.slice(w.indexOf('const heartbeat = async'), w.indexOf('const check = async'));
    expect(hb).toContain('Date.now() - lastPostAt < LIST.HEARTBEAT_MS');
    expect(hb).toMatch(/rows: \[\] \}/);
    expect(hb).not.toMatch(/final: true|ui\.prompt/);
    const chk = w.slice(w.indexOf('const check = async'), w.indexOf('const pause = async'));
    expect(chk.indexOf('await heartbeat()')).toBeLessThan(chk.indexOf('while (document.hidden)'));
    expect(chk.slice(chk.indexOf('while (document.hidden)'))).toContain('await heartbeat()');
    expect(w).toMatch(/if \(r\.ok\) \{\s*lastPostAt = Date\.now\(\);/);
    // 2. a final post refused because the run is closed returns before the Retry prompt
    const p = w.slice(w.indexOf('const post = async'), w.indexOf('const pageInfo'));
    const closed = p.indexOf("final && r.status === 409 && /finished|closed|abandoned/i");
    expect(closed).toBeGreaterThan(0);
    expect(closed).toBeLessThan(p.indexOf('ui.prompt('));
    expect(w).toContain("message: [stop.message, closedNote].filter(Boolean).join(' ')");
    // 3. state older than 15 minutes is cleared and ignored
    expect(content).toMatch(/STATE_MAX_AGE_MS: 15 \* 60000/);
    const r = fn('recoverWalkNow');
    expect(r.indexOf('await clearWalkState()')).toBeLessThan(r.indexOf('LIST.STATE_MAX_AGE_MS'));
    expect(r.indexOf('LIST.STATE_MAX_AGE_MS')).toBeLessThan(r.indexOf("type: 'captureList'"));
    // 4. Start is disabled and refused until recovery has finished, whatever it did
    expect(fn('recoverWalk')).toMatch(/try \{\s*await recoverWalkNow\(\);\s*\} finally \{\s*recovering = false;/);
    expect(content).toMatch(/if \(recovering\) \{\s*goBtn\.disabled = true;/);
  });

  it('the background keeps the state per tab in chrome.storage.session', () => {
    const bg = readFileSync(path.join(root, 'extension/background.js'), 'utf8');
    for (const h of ['walkSave', 'walkLoad', 'walkClear']) expect(bg).toMatch(new RegExp(`async ${h}\\(`));
    expect(bg).toMatch(/chrome\.storage\.session\.set\(\{ \[`walk\.\$\{tab\}`\]/);
    expect(bg).toContain('.then(() => h(msg, sender))');
    expect(bg).not.toMatch(/chrome\.storage\.local\.set\([^)]*walk/);
  });
});

describe('extension safeguards (static checks, so they cannot quietly regress)', () => {
  // code only: comments may mention what the code must not do
  const code = (f: string) => readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const content = readFileSync(path.join(root, 'extension/content.js'), 'utf8');
  const reader = code('extension/list-reader.js');
  const background = readFileSync(path.join(root, 'extension/background.js'), 'utf8');
  const listBranch = content
    .slice(content.indexOf('// ---------- lists:'), content.indexOf('// LinkedIn is a single-page app'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('the list branch exists and opens no windows or tabs, and has no timers that could start it', () => {
    expect(listBranch.length).toBeGreaterThan(1000);
    for (const src of [listBranch, reader]) {
      expect(src).not.toMatch(/chrome\.windows|chrome\.tabs|window\.open\(|setInterval|minimized/);
    }
    expect(reader).not.toMatch(/chrome\.|fetch\(|XMLHttpRequest|setTimeout|dataset|getAttribute\('data-/);
    const handler = background.slice(background.indexOf('async captureList('), background.indexOf('async flush()'));
    expect(handler).toContain("'/ext/capture-list'");
    expect(handler).not.toMatch(/chrome\.windows|chrome\.tabs|enqueue/);
  });

  it('a walk starts only from a trusted click on the Start button (and only continues its own pagination after a page load)', () => {
    const calls = [...listBranch.matchAll(/startWalk\(/g)];
    expect(calls).toHaveLength(2); // the definition + one call, inside runWalk
    expect(listBranch.indexOf('= startWalk(')).toBeGreaterThan(listBranch.indexOf('const runWalk = async'));
    // runWalk is called from exactly two places: the trusted Start handler, and the resume branch of openListPanel
    expect([...listBranch.matchAll(/runWalk\(\{/g)]).toHaveLength(2);
    const handlerAt = listBranch.indexOf("goBtn.addEventListener('click'", listBranch.indexOf('const runWalk = async'));
    const callAt = listBranch.indexOf('runWalk({', handlerAt);
    expect(handlerAt).toBeGreaterThan(0);
    const handler = listBranch.slice(handlerAt, callAt);
    const resumeAt = listBranch.indexOf('if (resume && !walk) {');
    expect(listBranch.indexOf('runWalk({', callAt + 1)).toBeGreaterThan(resumeAt);
    // openListPanel gets `resume` only from recoverWalkNow, after a 'continue' verdict
    const opens = [...listBranch.matchAll(/openListPanel\(\{ resume: /g)];
    expect(opens).toHaveLength(1);
    expect(listBranch.lastIndexOf("if (verdict === 'continue')", opens[0]!.index)).toBeGreaterThan(listBranch.indexOf('async function recoverWalkNow('));
    expect(handler).toContain('if (!e.isTrusted || walk || starting || recovering) return;');
    // the double-click guard is set before the first await
    expect(handler.indexOf('starting = true')).toBeLessThan(handler.indexOf('await '));
    // the floating button only opens the panel
    expect(listBranch).toMatch(/if \(e\.isTrusted\) openListPanel\(\);/);
  });

  it('pace, caps, hidden-pause, stop detectors and cancel are all wired in', () => {
    expect(listBranch).toMatch(/BASE_MS: 2500/);
    expect(listBranch).toMatch(/JITTER_MS: 1500/);
    expect(listBranch).toMatch(/MAX_PACE_MS: 8000/);
    expect(listBranch).toMatch(/CAP_MAX: 500/);
    expect(listBranch).toMatch(/DAILY: 1000/);
    expect(listBranch).toMatch(/nb\.listRows\./);
    expect(listBranch).toMatch(/while \(document\.hidden\)/);
    expect(listBranch).toMatch(/NBL\.stopReason\(document, location\.href\)/);
    expect(listBranch).toMatch(/run\.cancelled = true|walk\.cancelled = true/);
    // a new search / changed filters mid-walk ends the run
    expect(listBranch).toMatch(/filtersOf\(location\.href\) !== startFilters/);
  });

  it('the manifest asks for no new permissions and loads the reader before content.js', () => {
    const m = JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
    expect(m.permissions).toEqual(['storage', 'alarms', 'notifications']);
    expect(m.host_permissions).toEqual(['http://127.0.0.1/*']);
    expect(m.content_scripts[0].js).toEqual(['list-reader.js', 'content.js']);
    expect(m.description.length).toBeLessThanOrEqual(132);
  });
});
