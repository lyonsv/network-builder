import { describe, expect, it } from 'vitest';
import { normalizePersonName, profileRef, profileUrlsConflict, sameName, titlesCompatible } from '../src/accounts/identity';
import { personId } from '../src/io/csv';

describe('profileRef', () => {
  it('lower-cases vanity URLs and derives the usual person id', () => {
    const r = profileRef('https://linkedin.com/in/Riley-Moss/?miniProfileUrn=x');
    expect(r).toEqual({
      canonical: 'https://www.linkedin.com/in/riley-moss',
      url: 'https://www.linkedin.com/in/riley-moss',
      id: personId('https://www.linkedin.com/in/riley-moss', '', ''),
      slug: 'riley-moss',
      kind: 'vanity',
    });
  });

  it('keeps a member URN’s case for navigation, with an id that ignores case', () => {
    const a = profileRef('https://www.linkedin.com/in/ACoAABcdEFg12345XyZ?trk=list')!;
    expect(a.kind).toBe('urn');
    expect(a.url).toBe('https://www.linkedin.com/in/ACoAABcdEFg12345XyZ');
    expect(a.slug).toBe('ACoAABcdEFg12345XyZ');
    expect(a.canonical).toBe('https://www.linkedin.com/in/acoaabcdefg12345xyz');
    expect(profileRef('linkedin.com/in/ACoAABcdEFg12345XyZ/')!.id).toBe(a.id);
    // "aco…" lower-case is a vanity slug, not a URN
    expect(profileRef('https://www.linkedin.com/in/acoaabcdefg12345xyz')!.kind).toBe('vanity');
  });

  it('rejects anything that is not a profile URL', () => {
    expect(profileRef('')).toBeNull();
    expect(profileRef('https://www.linkedin.com/company/ledgerly')).toBeNull();
    expect(profileRef('not a url')).toBeNull();
  });

  it('flags two different URLs of the same kind as different people', () => {
    expect(profileUrlsConflict('https://www.linkedin.com/in/riley-moss', 'https://www.linkedin.com/in/riley-moss-2')).toBe(true);
    expect(profileUrlsConflict('https://www.linkedin.com/in/riley-moss', 'https://www.linkedin.com/in/ACoAABcdEFg12345XyZ')).toBe(false);
    expect(profileUrlsConflict('', 'https://www.linkedin.com/in/riley-moss')).toBe(false);
    expect(profileUrlsConflict('https://www.linkedin.com/in/Riley-Moss/', 'https://linkedin.com/in/riley-moss')).toBe(false);
  });
});

describe('person names', () => {
  it('folds umlauts, transliterations, titles, pronouns and emoji', () => {
    const n = normalizePersonName('Jonas Müller-Brandt');
    expect(n).toBe('jonas muller brandt');
    expect(normalizePersonName('Jonas Mueller-Brandt')).toBe(n);
    expect(normalizePersonName('Dr. Jonas Muller-Brandt')).toBe(n);
    expect(normalizePersonName('Prof. Dr. Jonas Müller-Brandt, MBA (he/him) 🚀')).toBe(n);
    expect(normalizePersonName('Greta Weiß')).toBe(normalizePersonName('Greta Weiss'));
    expect(sameName('Jonas Müller-Brandt', 'jonas mueller brandt')).toBe(true);
    expect(sameName('Jonas Müller-Brandt', 'Jonas Müller')).toBe(false);
    expect(sameName('', '')).toBe(false);
  });

  it('treats titles as compatible when either is blank or they share most words', () => {
    expect(titlesCompatible('', 'Head of Brand')).toBe(true);
    expect(titlesCompatible('Head of Brand', 'Head of Brand & Content')).toBe(true);
    // abbreviations and German titles expand (web research words titles differently from LinkedIn)
    expect(titlesCompatible('CMO', 'Chief Marketing Officer')).toBe(true);
    expect(titlesCompatible('VP Marketing', 'Vice President Marketing')).toBe(true);
    expect(titlesCompatible('Leiterin Unternehmenskommunikation', 'Head of Corporate Communications')).toBe(true);
    expect(titlesCompatible('CMO', 'CFO')).toBe(false);
    expect(titlesCompatible('Head of Sales', 'Director Marketing')).toBe(false);
    expect(titlesCompatible('Geschäftsführerin', 'Managing Director')).toBe(true);
    expect(titlesCompatible('Senior Manager Demand Generation', 'Demand Generation Manager')).toBe(true);
    expect(titlesCompatible('Head of Brand', 'Software Engineer')).toBe(false);
  });
});
