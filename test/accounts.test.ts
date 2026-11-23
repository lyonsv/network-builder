import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountMarkdown } from '../src/accounts/brief';
import {
  canonicalCompanyUrl, canonicalProfileUrl, detailLines, normalizeCompany, parseCapture, parseEducationText, parseExperience,
  parseExperienceText, sectionsFromText, splitHeadline,
} from '../src/accounts/capture';
import {
  classify, departmentFromTitle, isOtherEmployer, noiseFromTitle, seniorityFromTitle, subfunctionFromTitle, tierFromTitle, vendorFundedFromTitle,
} from '../src/accounts/classify';
import { ingestCapture } from '../src/accounts/ingest';
import type { CapturePayload, LightContactInput } from '../src/accounts/types';
import { accountSummaries, buildAccountView, resolveOrgPlacement } from '../src/accounts/view';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/db/schema';
import { Store } from '../src/db/store';
import { createNetworkMcpServer } from '../src/mcp/server';
import type { Person } from '../src/types';

const mk = (id: string, name: string, title: string, url = `https://www.linkedin.com/in/${id}`): Person => ({
  id, rowIndex: 0, fullName: name, firstName: name.split(' ')[0]!, lastName: name.split(' ').slice(1).join(' '),
  title, company: '', url, email: '', connectedOn: '2023-01-01', extra: {},
});

/** what the extension sends for a (fictional) Ledgerly CFO */
const capture = (over: Partial<CapturePayload> = {}): CapturePayload => ({
  url: 'https://www.linkedin.com/in/Riley-Moss-ledgerly/?miniProfileUrn=x',
  fullName: 'Riley Moss',
  headline: 'CFO at Ledgerly | ex-Globex',
  location: 'Dublin, Ireland',
  currentCompany: 'Ledgerly',
  about: 'Finance leader scaling B2B SaaS.',
  sections: {
    experience: {
      heading: 'Experience',
      items: [
        {
          lines: ['Chief Financial Officer', 'Ledgerly · Full-time', 'Mar 2022 - Present · 2 yrs 9 mos', 'Dublin, Ireland · Hybrid', 'Leads finance, procurement and IT.'],
          companyUrl: 'https://www.linkedin.com/company/ledgerly/',
        },
        {
          lines: ['Globex', 'Full-time · 6 yrs', 'London'],
          sub: [
            ['VP Finance', 'Jan 2019 - Feb 2022 · 3 yrs 2 mos', 'Ran FP&A.'],
            ['Finance Director', 'Mar 2016 - Dec 2018 · 2 yrs 10 mos'],
          ],
          companyUrl: 'https://www.linkedin.com/company/globex/',
        },
      ],
    },
    education: { heading: 'Education', items: [{ lines: ['Trinity College Dublin', 'BBS, Business', '2008 - 2012'] }] },
    skills: { heading: 'Skills', items: [{ lines: ['Financial Planning'] }, { lines: ['SaaS Metrics'] }] },
  },
  rawText: 'Riley Moss\nCFO at Ledgerly\nAbout\nFinance leader scaling B2B SaaS.',
  ...over,
});

describe('capture parsing', () => {
  it('canonicalises profile and company URLs', () => {
    expect(canonicalProfileUrl('https://linkedin.com/in/Riley-Moss/?x=1')).toBe('https://www.linkedin.com/in/riley-moss');
    expect(canonicalProfileUrl('https://www.linkedin.com/company/ledgerly')).toBe('');
    expect(canonicalCompanyUrl('https://www.linkedin.com/company/Ledgerly/life/')).toBe('https://www.linkedin.com/company/ledgerly');
    expect(normalizeCompany('Ledgerly, Inc.')).toBe('ledgerly');
    expect(normalizeCompany('Initech Ltd')).toBe('initech');
    expect(splitHeadline('VP Sales at Initech | Speaker')).toEqual({ title: 'VP Sales', company: 'Initech' });
  });

  it('parses single and grouped experience, education and other sections', () => {
    const p = parseCapture(capture());
    expect(p.url).toBe('https://www.linkedin.com/in/riley-moss-ledgerly');
    expect(p.title).toBe('Chief Financial Officer');
    expect(p.company).toBe('Ledgerly');
    expect(p.companyUrl).toBe('https://www.linkedin.com/company/ledgerly');
    expect(p.experience).toHaveLength(3);
    expect(p.experience[0]).toMatchObject({ title: 'Chief Financial Officer', company: 'Ledgerly', employmentType: 'Full-time', current: true, location: 'Dublin, Ireland · Hybrid', description: 'Leads finance, procurement and IT.' });
    expect(p.experience[1]).toMatchObject({ title: 'VP Finance', company: 'Globex', current: false, description: 'Ran FP&A.' });
    expect(p.experience[2]).toMatchObject({ title: 'Finance Director', company: 'Globex' });
    expect(p.education).toEqual([{ school: 'Trinity College Dublin', detail: 'BBS, Business · 2008 - 2012' }]);
    expect(p.other.Skills).toEqual(['Financial Planning', 'SaaS Metrics']);
  });

  it('falls back to the page text when LinkedIn markup changed', () => {
    const raw = ['Sam Ortiz', 'Head of IT at Initech', 'About', 'About', 'Runs IT.', 'Experience', 'Head of IT', 'Initech · Full-time', 'Jan 2021 - Present · 3 yrs',
      'IT Manager', 'Initrode', '2017 - 2020', 'Education', 'UCD', 'People also viewed', 'Someone Else'].join('\n');
    const p = parseCapture({ url: 'https://www.linkedin.com/in/sam-ortiz', fullName: 'Sam Ortiz', headline: 'Head of IT at Initech', rawText: raw });
    expect(p.about).toBe('Runs IT.');
    expect(p.experience.map((e) => [e.title, e.company])).toEqual([['Head of IT', 'Initech'], ['IT Manager', 'Initrode']]);
    expect(p.education[0]!.school).toBe('UCD');
    expect(sectionsFromText(raw)['education']).toEqual(['UCD']); // stops at "People also viewed"
  });

  it('rejects non-profile pages and nameless captures with a clear message', () => {
    expect(() => parseCapture(capture({ url: 'https://www.linkedin.com/feed/' }))).toThrow(/profile URL/);
    expect(() => parseCapture(capture({ fullName: '  ' }))).toThrow(/name/);
  });

  it('reads a single role\'s nested description', () => {
    const [e] = parseExperience([{ lines: ['Head of IT', 'Initech', 'Jan 2021 - Present · 3 yrs'], sub: [['Runs IT and security.'], ['Skills: ITIL · Okta']] }]);
    expect(e).toMatchObject({ title: 'Head of IT', company: 'Initech', description: 'Runs IT and security.\nSkills: ITIL · Okta' });
  });

  it('skips grouped companies whose roles are missing', () => {
    expect(parseExperience([{ lines: ['Globex', '5 yrs 2 mos'] }])).toEqual([]);
  });
});

// what LinkedIn's /details/experience/ page text looks like (screen-reader copies repeat each line; nav + sidebar around it)
const EXPERIENCE_PAGE = [
  'Home', 'My Network', 'Back', 'Experience',
  'Head of Growth', 'Head of Growth', 'Ledgerly · Full-time', 'Jan 2022 - Present · 2 yrs 11 mos', 'Berlin, Germany · Hybrid',
  'Built the partner channel from zero to 40% of new revenue.', 'Skills: Pricing Strategy · Business Development',
  'Globex', '7 yrs 2 mos', 'Dublin, Ireland',
  'VP Sales', 'Full-time', 'Mar 2019 - Dec 2021 · 2 yrs 10 mos', 'Ran EMEA enterprise sales.',
  'Director of Sales', 'Nov 2014 - Mar 2019 · 4 yrs 5 mos',
  'Advisor', 'Initech · Part-time', '2012 - 2014 · 2 yrs',
  'Show all', 'More profiles for you', 'Someone Else', '· 2nd', 'About', 'Accessibility', 'LinkedIn Corporation © 2026',
].join('\n');

describe('full-list (details) pages', () => {
  it('reads every role with dates, tenure, employment type, location, description and grouped companies', () => {
    const lines = detailLines('experience', EXPERIENCE_PAGE);
    expect(lines[0]).toBe('Head of Growth');
    expect(lines).not.toContain('More profiles for you');
    expect(detailLines('certifications', 'Error 404\nNothing matches the given URI')).toEqual([]);
    const ex = parseExperienceText(lines);
    expect(ex.map((e) => [e.title, e.company])).toEqual([
      ['Head of Growth', 'Ledgerly'], ['VP Sales', 'Globex'], ['Director of Sales', 'Globex'], ['Advisor', 'Initech'],
    ]);
    expect(ex[0]).toMatchObject({ employmentType: 'Full-time', dates: 'Jan 2022 - Present · 2 yrs 11 mos', current: true, location: 'Berlin, Germany · Hybrid' });
    expect(ex[0]!.description).toContain('partner channel');
    expect(ex[0]!.description).not.toContain('Globex');
    expect(ex[1]).toMatchObject({ employmentType: 'Full-time', location: 'Dublin, Ireland', description: 'Ran EMEA enterprise sales.' });
    expect(ex[2]!.description).toBeUndefined();
    expect(ex[3]).toMatchObject({ employmentType: 'Part-time', dates: '2012 - 2014 · 2 yrs', current: false });
  });

  it('reads education with degree, years and extras', () => {
    const ed = parseEducationText(detailLines('education', [
      'Education', 'Northwind Business School', 'MSc, Finance', '2010 - 2011', 'Grade: Distinction',
      'Lakeside University', 'BA, Economics', '2006 - 2010', 'Show all',
    ].join('\n')));
    expect(ed).toEqual([
      { school: 'Northwind Business School', detail: 'MSc, Finance · 2010 - 2011 · Grade: Distinction' },
      { school: 'Lakeside University', detail: 'BA, Economics · 2006 - 2010' },
    ]);
  });

  it('a capture with details uses the full lists, fixes skills, and keeps the text', () => {
    const p = parseCapture({
      url: 'https://www.linkedin.com/in/riley-test/', fullName: 'Riley Test', headline: 'Business builder at Ledgerly',
      about: 'Builds things.', sections: {}, rawText: 'Riley Test\nBusiness builder at Ledgerly\nAbout\nBuilds things.',
      details: {
        experience: { text: EXPERIENCE_PAGE, items: [] },
        skills: { text: 'Skills\nAll\nPricing Strategy\nEndorsed by Sam Rivera\n3 endorsements\nBusiness Development\n2 experiences across Ledgerly and Globex\nPricing Strategy', items: [] },
      },
    });
    expect(p.experience).toHaveLength(4);
    expect(p.title).toBe('Head of Growth');
    expect(p.company).toBe('Ledgerly');
    expect(p.other['Skills']).toEqual(['Pricing Strategy', 'Business Development']);
    expect(p.detailsText?.experience).toContain('Director of Sales');
  });

  it('a badge captured as the headline ("LIVE") is replaced from the page text', () => {
    const p = parseCapture({
      url: 'https://www.linkedin.com/in/riley-test/', fullName: 'Riley Test', headline: 'LIVE',
      rawText: 'Riley Test\n\n· 1st\nLIVE\nBusiness builder at Ledgerly | Payments\nBerlin, Germany\n·\nContact info',
    });
    expect(p.headline).toBe('Business builder at Ledgerly | Payments');
    expect(p.location).toBe('Berlin, Germany');
  });
});

describe('org-chart classification', () => {
  it.each([
    ['Chief Financial Officer', 'finance', 'exec'],
    ['CEO & Co-founder', 'executive', 'exec'],
    ['SVP Engineering', 'engineering', 'vp'],
    ['Vice President, Sales EMEA', 'sales', 'vp'],
    ['Head of Procurement', 'finance', 'director'],
    ['Senior Director, Product Marketing', 'marketing', 'director'],
    ['Engineering Manager', 'engineering', 'manager'],
    ['Data Scientist', 'data-ai', 'ic'],
    ['CISO', 'it-security', 'exec'],
    ['Customer Success Lead', 'customer', 'manager'],
    ['Non-Executive Director', 'board', 'board'],
    ['Founder & Board Member', 'executive', 'exec'],
    ['Board Advisor', 'board', 'board'],
    ['', 'other', 'unknown'],
  ])('%s → %s / %s', (title, dept, tier) => {
    expect(departmentFromTitle(title)).toBe(dept);
    expect(tierFromTitle(title)).toBe(tier);
  });
  it.each([
    // title, department, seniority, subfunction, noise
    ['Partner Marketing Manager', 'marketing', 'manager', 'partner-marketing', ''],
    ['Marketing Technology Lead', 'marketing', 'lead', 'marketing-ops', ''],
    ['Senior Director, Brand', 'marketing', 'senior-director', 'brand', ''],
    ['Director Demand Generation', 'marketing', 'director', 'demand-gen', ''],
    ['Leiterin Unternehmenskommunikation', 'marketing', 'director', 'comms-pr', ''],
    ['Teamleiter Online Marketing', 'marketing', 'manager', 'digital-social', ''],
    ['Werkstudent Marketing', 'marketing', 'intern', 'other', ''],
    ['HR Marketing Specialist', 'people', 'ic', 'other', 'hr-marketing'],
    ['Employer Branding Manager', 'people', 'manager', 'other', 'hr-marketing'],
    ['Personalmarketing Referentin', 'people', 'ic', 'other', 'hr-marketing'],
    ['Sales & Marketing Manager', 'marketing', 'manager', 'other', 'sales-hybrid'],
    ['Marketing und Vertrieb Leiter', 'marketing', 'director', 'leadership', 'sales-hybrid'],
    ['Growth Engineer', 'engineering', 'ic', 'other', ''],
    ['Chief Marketing Officer', 'marketing', 'c-level', 'leadership', ''],
    ['SVP Marketing EMEA', 'marketing', 'svp', 'leadership', ''],
    ['Head of Marketing', 'marketing', 'head', 'leadership', ''],
    ['Bereichsleiter Marketing', 'marketing', 'senior-director', 'leadership', ''],
    ['Marketingleitung', 'marketing', 'head', 'leadership', ''],
    ['Leitung Marketing', 'marketing', 'head', 'leadership', ''],
    ['Head of Partner Marketing', 'marketing', 'head', 'partner-marketing', ''],
    ['Recruiting I Personalmarketing I HR Digitalisierung', 'people', 'ic', 'other', 'hr-marketing'],
    ['Geschäftsführerin', 'executive', 'c-level', 'other', ''],
    ['Senior Marketing Manager', 'marketing', 'senior-manager', 'other', ''],
    ['Junior Content Manager', 'marketing', 'junior', 'content', ''],
    ['Senior Content Marketing Specialist', 'marketing', 'senior-ic', 'content', ''],
    ['Pressesprecherin', 'marketing', 'ic', 'comms-pr', ''],
    ['Marketing Data Analyst', 'marketing', 'ic', 'marketing-ops', ''],
    ['Team Lead Performance Marketing', 'marketing', 'lead', 'demand-gen', ''],
    ['Field Marketing Manager DACH', 'marketing', 'manager', 'field-marketing', ''],
    ['Event Manager', 'marketing', 'manager', 'events', ''],
    ['Marketing Intern', 'marketing', 'intern', 'other', ''],
    ['Product Owner', 'product', 'ic', 'other', ''],
    ['', 'other', 'unknown', 'other', ''],
  ])('EN + DE marketing: %s → %s / %s / %s / %s', (title, dept, seniority, sub, noise) => {
    expect(departmentFromTitle(title)).toBe(dept);
    expect(seniorityFromTitle(title)).toBe(seniority);
    expect(subfunctionFromTitle(title)).toBe(sub);
    expect(noiseFromTitle(title)).toBe(noise);
  });
  it.each([
    // review fixes: title, department, tier, seniority, subfunction
    ['Telekommunikationstechniker', 'other', 'ic', 'ic', 'other'],
    ['Projektleiter Telekommunikation', 'other', 'director', 'director', 'other'],
    ['Security Events Analyst', 'it-security', 'ic', 'ic', 'other'],
    ['SIEM Event Engineer', 'engineering', 'ic', 'ic', 'other'],
    ['Event Marketing Manager', 'marketing', 'manager', 'manager', 'events'],
    ['Eventmanagerin', 'marketing', 'manager', 'manager', 'events'],
    ['Marketing Assistant to the CMO', 'marketing', 'ic', 'ic', 'other'],
    ['Assistenz der Geschäftsführung', 'other', 'ic', 'ic', 'other'],
    ['Referentin Presse- und Öffentlichkeitsarbeit', 'marketing', 'ic', 'ic', 'comms-pr'],
    ['Kommunikationsmanagerin', 'marketing', 'manager', 'manager', 'comms-pr'],
    ['Lead Generation Specialist', 'marketing', 'ic', 'ic', 'demand-gen'],
    ['Lead Management Specialist', 'other', 'ic', 'ic', 'other'],
    ['Lead Gen Manager', 'marketing', 'manager', 'manager', 'demand-gen'],
    ['Growth Marketing Lead', 'marketing', 'manager', 'lead', 'demand-gen'],
    ['Director, Partner Marketing', 'marketing', 'director', 'director', 'partner-marketing'],
    // support roles of the exec: the title's own role wins; alone they are ICs
    ['Marketing Managerin & Referentin der Geschäftsführung', 'marketing', 'manager', 'manager', 'other'],
    ['Referentin der Geschäftsführung', 'other', 'ic', 'ic', 'other'],
    ['Referent für die Geschäftsführung', 'other', 'ic', 'ic', 'other'],
    ['Executive Assistant to the CEO', 'other', 'ic', 'ic', 'other'],
    ['Brand Manager | Executive Assistant to the CMO', 'marketing', 'manager', 'manager', 'brand'],
    // Referent(in) / Office Manager(in) FOR a function are specialists, not exec support
    ['Referentin für Marketing', 'marketing', 'ic', 'ic', 'other'],
    ['Referent für Unternehmenskommunikation', 'marketing', 'ic', 'ic', 'comms-pr'],
    ['Office Manager für Marketing & Events', 'marketing', 'manager', 'manager', 'events'],
    ['Referentin des Vorstands', 'other', 'ic', 'ic', 'other'],
  ])('%s → %s / %s / %s / %s', (title, dept, tier, seniority, sub) => {
    expect(departmentFromTitle(title)).toBe(dept);
    expect(tierFromTitle(title)).toBe(tier);
    expect(seniorityFromTitle(title)).toBe(seniority);
    expect(subfunctionFromTitle(title)).toBe(sub);
  });
  it('DE seniority words map to the org-chart tiers', () => {
    expect(tierFromTitle('Abteilungsleiter Kommunikation')).toBe('director');
    expect(tierFromTitle('Teamleiterin Kampagnen')).toBe('manager');
    expect(tierFromTitle('Geschäftsführer')).toBe('exec');
    expect(tierFromTitle('Referentin Presse')).toBe('ic');
    expect(tierFromTitle('Praktikantin Marketing Management')).toBe('ic');
    expect(tierFromTitle('Werkstudent Marketing Manager')).toBe('ic');
    expect(tierFromTitle('Partner Marketing Manager')).toBe('manager'); // not a partner of the firm
  });
  it('vendor-funded is a tag, only on explicit patterns (regions are not vendors)', () => {
    expect(vendorFundedFromTitle('Partner Marketing Manager for Globex Inc', 'Ledgerly')).toBe(true);
    expect(vendorFundedFromTitle('Marketing Manager @ Globex Systems GmbH', 'Ledgerly')).toBe(true);
    expect(vendorFundedFromTitle('Channel Marketing Manager – Globex Corp', 'Ledgerly')).toBe(true);
    expect(vendorFundedFromTitle('Marketing Manager (sponsored by Globex)', 'Ledgerly')).toBe(true);
    expect(vendorFundedFromTitle('Marketing Manager (Vendor-funded, Globex)', 'Ledgerly')).toBe(true);
    // no company suffix → left to Haiku
    for (const t of ['Partner Marketing Manager for Globex', 'Head of Marketing for Initech Partners', 'Marketing Manager for New Business',
      'Marketing for Small Business', 'Portfolio Marketing for Cloud Services', 'Marketing Manager for Germany & Austria']) {
      expect(vendorFundedFromTitle(t, 'Ledgerly')).toBe(false);
    }
    expect(vendorFundedFromTitle('Field Marketing Manager, funded by Globex', '')).toBe(true);
    expect(vendorFundedFromTitle('Marketing Manager for DACH', 'Ledgerly')).toBe(false);
    expect(vendorFundedFromTitle('Marketing Manager @ Ledgerly', 'Ledgerly GmbH')).toBe(false);
    expect(vendorFundedFromTitle('Partner Marketing Manager for Globex Inc', '')).toBe(false); // no company to compare: stay quiet
    expect(vendorFundedFromTitle('Partner Marketing Manager for Globex Inc', 'Globex Inc')).toBe(false); // the vendor is the employer
    // the title ENDS with another company + legal suffix (fictional Globex): vendor-funded; the account's own name: not
    expect(vendorFundedFromTitle('Portfolio Marketing Manager Globex Inc.', 'Ledgerly')).toBe(true);
    expect(vendorFundedFromTitle('Partner Marketing Manager Initech GmbH', 'Ledgerly')).toBe(true);
    expect(vendorFundedFromTitle('Marketing Manager Ledgerly AG', 'Ledgerly')).toBe(false);
    expect(vendorFundedFromTitle('Portfolio Marketing Manager Globex Inc.', '')).toBe(false);
    // never noise any more
    expect(noiseFromTitle('Field Marketing Manager, funded by Globex')).toBe('');
  });
  describe('other-employer (Phase 2b)', () => {
    const acc = { name: 'Ledgerly', aliases: ['Ledgerly Group'], domain: 'ledgerly.example', linkedinUrl: 'https://www.linkedin.com/company/ledgerly-holding' };
    it('flags only a company that is clearly not the account or one of its entities', () => {
      expect(isOtherEmployer('Globex Inc', acc)).toBe(true);
      expect(isOtherEmployer('Northwind Ventures', acc)).toBe(true);
      for (const co of ['Ledgerly', 'Ledgerly GmbH', 'Ledgerly Services GmbH', 'LEDGERLY GROUP', 'Ledgerly Holding', 'ledgerly.example']) {
        expect(isOtherEmployer(co, acc)).toBe(false);
      }
      expect(isOtherEmployer('Initech Payments B.V.', acc, ['Initech Payments B.V.'])).toBe(false); // a user-set entity
      expect(isOtherEmployer('Globex Inc', acc, [], 'https://www.linkedin.com/company/ledgerly-holding/')).toBe(false);
    });
    it('review fixes: generic words, 2-letter names, shared prefixes, captured company pages', () => {
      const l = { name: 'Ledgerly', aliases: [], domain: 'ledgerly.com', linkedinUrl: 'https://www.linkedin.com/company/ledgerly-group' };
      expect(isOtherEmployer('LedgerlyPay', l)).toBe(false); // shared prefix ≥ 5
      expect(isOtherEmployer('Ledgerly AG', l, [], 'https://www.linkedin.com/company/ledgerlyag/')).toBe(false);
      expect(isOtherEmployer('LDG AG', l, [], 'https://www.linkedin.com/company/ledgerlyag/')).toBe(false); // slug matches
      // a company page walked into this account counts as the account
      expect(isOtherEmployer('LDG Schweiz AG', l)).toBe(true);
      expect(isOtherEmployer('LDG Schweiz AG', l, [], '', ['https://www.linkedin.com/company/ldg-schweiz/people/'])).toBe(false);
      expect(isOtherEmployer('Something Else', l, [], 'https://www.linkedin.com/company/ldg-schweiz/', ['https://www.linkedin.com/company/ldg-schweiz/people/'])).toBe(false);
      // generic words stripped on both sides
      expect(isOtherEmployer('Ledgerly Services GmbH', { name: 'Ledgerly Group', aliases: [], domain: '', linkedinUrl: '' })).toBe(false);
      expect(isOtherEmployer('Globex Group', { name: 'Ledgerly Group', aliases: [], domain: '', linkedinUrl: '' })).toBe(true);
      // 2-letter names as the whole first word
      const hp = { name: 'HP', aliases: [], domain: 'hp.com', linkedinUrl: '' };
      expect(isOtherEmployer('HP Deutschland GmbH', hp)).toBe(false);
      expect(isOtherEmployer('HPE Services', hp)).toBe(true);
      expect(isOtherEmployer('Globex Inc', hp)).toBe(true);
    });
    it('a missing or vague company is not other-employer', () => {
      for (const co of ['', '   ', 'Self-employed', 'Self-Employed Consultant', 'Freelance', 'Freelance Marketing Consultant', 'Selbstständig',
        'Selbststaendig', 'Selbständig', 'Confidential']) expect(isOtherEmployer(co, acc)).toBe(false);
      expect(isOtherEmployer('Globex Inc', { name: '', aliases: [], domain: '', linkedinUrl: '' })).toBe(false); // nothing to compare
    });
    const place = (over: Partial<Parameters<typeof resolveOrgPlacement>[0]>) =>
      resolveOrgPlacement({ account: acc, entities: [], title: '', company: '', noiseOverride: '', subfunctionOverride: '', ...over });
    it('vendor-funded at the account → in the org, partner-marketing, tagged', () => {
      const r = place({ title: 'Marketing Manager @ Globex Systems GmbH', company: 'Ledgerly Services GmbH', employer: 'Ledgerly Services GmbH' });
      expect(r).toEqual({ noise: '', vendorFunded: true, subfunction: 'partner-marketing' });
      // the user's sub-function wins
      expect(place({ title: 'Marketing Manager @ Globex Systems GmbH', company: 'Ledgerly', subfunctionOverride: 'events' }).subfunction).toBe('events');
    });
    it('the same title with the vendor as employer → other-employer, not tagged', () => {
      expect(place({ title: 'Marketing Manager @ Globex Systems GmbH', company: 'Globex Systems GmbH', employer: 'Globex Systems GmbH' }))
        .toEqual({ noise: 'other-employer', vendorFunded: false, subfunction: 'other' });
    });
    it('a missing company is not other-employer; a guessed (headline / list-row) company is never used', () => {
      expect(place({ title: 'Partner Marketing Manager', company: '' }).noise).toBe('');
      expect(place({ title: 'Marketing', company: 'a leading fintech' }).noise).toBe(''); // no captured employer
      expect(place({ title: 'Marketing', company: 'Globex Inc', employer: '' }).noise).toBe('');
    });
    it('a hand-set "vendor-funded" always means in the org + tag; older inferences read as the tag unless clearly elsewhere', () => {
      expect(place({ title: 'Marketing Director', employer: 'Ledgerly', noiseOverride: 'vendor-funded' })).toEqual({ noise: '', vendorFunded: true, subfunction: 'partner-marketing' });
      // user intent wins over the heuristic
      expect(place({ title: 'Marketing Director', employer: 'Globex Inc', noiseOverride: 'vendor-funded' })).toEqual({ noise: '', vendorFunded: true, subfunction: 'partner-marketing' });
      expect(place({ title: 'Marketing Director', company: '', noiseOverride: 'vendor-funded' }).noise).toBe('');
      const old = { subfunction: 'brand' as const, noise: 'vendor-funded' as const };
      expect(place({ title: 'Brand Manager', employer: 'Ledgerly', inference: old })).toEqual({ noise: '', vendorFunded: true, subfunction: 'partner-marketing' });
      expect(place({ title: 'Brand Manager', employer: 'Globex Inc', inference: old })).toEqual({ noise: 'other-employer', vendorFunded: false, subfunction: 'brand' });
      // a user "not noise" keeps someone at another employer in the org
      expect(place({ title: 'Brand Manager', employer: 'Globex Inc', noiseOverride: 'none' }).noise).toBe('');
      // any excluding flag (here the user's) clears the tag and the partner-marketing default
      expect(place({ title: 'Marketing Manager @ Globex Systems GmbH', company: 'Ledgerly', noiseOverride: 'hr-marketing' }))
        .toMatchObject({ noise: 'hr-marketing', vendorFunded: false });
      // inference wins over the rule (even '' = clean)
      expect(place({ title: 'Brand Manager', employer: 'Globex Inc', inference: { noise: '', subfunction: 'brand' } }).noise).toBe('');
    });
  });
  it('falls back to the headline profile for vague titles', () => {
    expect(classify('Building things', { company: '', role: '', seniority: 'vp', function: 'product', industry: '', tags: [], region: '' })).toEqual({ department: 'product', tier: 'vp' });
  });
});

describe('accounts store + ingest', () => {
  let dir = '';
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nb-acct-'));
    store = Store.open(path.join(dir, 'network.db'));
    store.upsertPeople([mk('jo-park', 'Jo Park', 'Head of Sales at Ledgerly'), mk('al-vance', 'Al Vance', 'Partner at Northwind Ventures')], 'test.csv');
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the account from the capture, keeps the contact out of the network, and refreshes on re-capture', () => {
    const r = ingestCapture(store.accounts, { profile: capture(), role: 'decision-maker', notes: 'Met at SaaStock' });
    expect(r.createdAccount).toBe(true);
    expect(r.account).toMatchObject({ name: 'Ledgerly', linkedinUrl: 'https://www.linkedin.com/company/ledgerly' });
    expect(r.isConnection).toBe(false);
    // the network (people table, explorer list) is untouched
    expect(store.listExplorerPeople().map((p) => p.fullName).sort()).toEqual(['Al Vance', 'Jo Park']);

    const again = ingestCapture(store.accounts, { profile: capture({ headline: 'CFO at Ledgerly' }), accountName: 'ledgerly inc', notes: 'Follow up in Q1' });
    expect(again.createdAccount).toBe(false);
    expect(again.addedToAccount).toBe(false);
    expect(store.accounts.list()).toHaveLength(1);
    const m = store.accounts.members(r.account.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ role: 'decision-maker', notes: 'Met at SaaStock\nFollow up in Q1' });
    expect(store.accounts.getContact(m[0]!.personId)!.captureCount).toBe(2);
  });

  it('files a captured connection under their existing person id', () => {
    const r = ingestCapture(store.accounts, {
      profile: capture({ url: 'https://www.linkedin.com/in/jo-park/', fullName: 'Jo Park', currentCompany: 'Ledgerly', sections: {} }),
    });
    expect(r.isConnection).toBe(true);
    expect(store.getPeople([r.contact.id]).get(r.contact.id)?.fullName).toBe('Jo Park');
  });

  it('builds the org chart view with warm paths, gaps and reporting lines', () => {
    const r = ingestCapture(store.accounts, { profile: capture(), role: 'decision-maker' });
    const id = r.account.id;
    const ann = ingestCapture(store.accounts, {
      profile: { url: 'https://www.linkedin.com/in/ann-lee-x', fullName: 'Ann Lee', headline: 'Procurement Manager at Ledgerly' },
      accountId: id,
    });
    store.accounts.updateMember(id, ann.contact.id, { reportsTo: r.contact.id, role: 'gatekeeper' });
    expect(() => store.accounts.updateMember(id, r.contact.id, { reportsTo: ann.contact.id })).toThrow(/loop/);
    expect(() => store.accounts.updateMember(id, r.contact.id, { role: 'boss' as never })).toThrow(/role must be/);

    const people = new Map(store.listExplorerPeople().map((p) => [p.id, p]));
    const v = buildAccountView(store.accounts, store.accounts.get(id)!, people);
    expect(v.members.map((m) => [m.fullName, m.department, m.tier])).toEqual([
      ['Riley Moss', 'finance', 'exec'],
      ['Ann Lee', 'finance', 'manager'],
    ]);
    expect(v.warmPaths.map((w) => [w.fullName, w.relation])).toEqual([['Jo Park', 'current']]);
    expect(v.gaps).toContain('No champion yet');
    expect(v.gaps).not.toContain('No decision maker identified');

    const md = accountMarkdown(v);
    expect(md).toContain('# Account: Ledgerly');
    expect(md).toContain('**Decision maker:** Riley Moss (Chief Financial Officer)');
    expect(md).toContain('reports to Riley Moss');
    expect(md).toContain('VP Finance at Globex');
    expect(md).toContain('Jo Park');

    // removing a manager clears reporting lines that pointed at them
    store.accounts.removeMember(id, r.contact.id);
    expect(store.accounts.members(id)[0]!.reportsTo).toBe('');
  });

  it('validates account fields and refuses duplicate names', () => {
    store.accounts.create({ name: 'Initech', domain: 'https://www.initech.example/about' });
    expect(store.accounts.find('initech ltd')!.domain).toBe('initech.example');
    expect(() => store.accounts.create({ name: 'Initech, Inc.' })).toThrow(/already exists/);
    expect(() => store.accounts.create({ name: 'X', linkedinUrl: 'https://example.com' })).toThrow(/linkedin/i);
    expect(() => store.accounts.create({ name: 'Y', status: 'hot' as never })).toThrow(/status/);
  });
});

describe('account MCP tools', () => {
  let dir = '';
  let client: Client;
  let close: () => void;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; structuredContent?: any; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), data: r.structuredContent, isError: Boolean(r.isError) };
  };
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nb-acct-mcp-'));
    const dbPath = path.join(dir, 'network.db');
    const s = Store.open(dbPath);
    s.upsertPeople([mk('jo-park', 'Jo Park', 'Head of Sales at Ledgerly')], 'test.csv');
    ingestCapture(s.accounts, { profile: capture(), role: 'decision-maker' });
    s.close();
    const mcp = createNetworkMcpServer({ dbPath, outDir: path.join(dir, 'out') });
    close = mcp.close;
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 't', version: '0' });
    await Promise.all([mcp.server.connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gets an account by name with full profiles, and keeps captured people out of network search', async () => {
    const r = await call('network_get_account', { account: 'ledgerly' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('## Org chart');
    expect(r.text).toContain('Leads finance, procurement and IT.');
    expect(r.data.warm_paths.map((w: any) => w.fullName)).toEqual(['Jo Park']);
    expect((await call('network_search_people', { query: 'riley' })).data.total).toBe(0);
    expect((await call('network_list_accounts')).text).toContain('**Ledgerly**');
    const c = await call('network_get_contact', { account: 'Ledgerly', person: 'riley' });
    expect(c.text).toContain('Ran FP&A.');
    expect((await call('network_get_account', { account: 'Nope' })).isError).toBe(true);
  });

  it('adds connections, sets roles and reporting lines, appends to the brief', async () => {
    const jo = (await call('network_get_account', { account: 'Ledgerly' })).data.warm_paths[0].id;
    const add = await call('network_account_add_people', { account: 'Ledgerly', people: [jo, 'https://www.linkedin.com/in/stranger'], role: 'champion' });
    expect(add.data.added).toEqual([jo]);
    expect(add.data.unknown).toHaveLength(1);
    const up = await call('network_account_update_person', { account: 'Ledgerly', person: 'Jo Park', reports_to: 'Riley Moss' });
    expect(up.text).toContain('reports to Riley Moss');
    await call('network_update_account', { account: 'Ledgerly', brief: 'Why now: new CFO.', brief_mode: 'replace' });
    await call('network_update_account', { account: 'Ledgerly', brief: 'Plan: exec dinner.' });
    const md = (await call('network_get_account', { account: 'Ledgerly', detail: 'summary' })).text;
    expect(md).toContain('Why now: new CFO.\n\nPlan: exec dinner.');
    expect(md).toContain('**Champion:** Jo Park');
    const res = await client.readResource({ uri: 'account://ledgerly' });
    expect((res.contents[0] as { text: string }).text).toContain('# Account: Ledgerly');
  });
});

describe('marketing org map: data model, light contacts, identity', () => {
  let dir = '';
  let store: Store;
  const RUN = 'run-1';
  const list = (over: Partial<LightContactInput> = {}): LightContactInput[] => [
    { fullName: 'Jonas Müller-Brandt', url: 'https://www.linkedin.com/in/ACoAABjonas1234567', title: 'Head of Brand', location: 'Berlin', source: { kind: 'extension-list', at: '2026-11-01T00:00:00Z', runId: RUN }, ...over },
    { fullName: 'Priya Natarajan', url: 'https://www.linkedin.com/in/priya-natarajan-ledgerly', headline: 'Demand Generation Manager at Ledgerly', source: { kind: 'extension-list', at: '2026-11-01T00:00:00Z', runId: RUN } },
    { fullName: 'Sam Okafor', title: 'Content Lead', source: { kind: 'extension-list', at: '2026-11-01T00:00:00Z', runId: RUN } },
  ];
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nb-org-'));
  });
  afterEach(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = () => {
    store = Store.open(path.join(dir, 'network.db'));
    return store;
  };

  it('migrates a pre-org-map database: rows kept, existing reporting lines marked as the user’s, deletes cascade', () => {
    const file = path.join(dir, 'network.db');
    const old = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    // pinned to the pre-org-map schema (v5) so this keeps covering this upgrade after later migrations land
    for (const m of MIGRATIONS.slice(0, 5)) old.exec(m);
    old.exec('PRAGMA user_version = 5');
    const t = '2026-01-01T00:00:00Z';
    old.prepare("INSERT INTO accounts (id, name, created_at, updated_at) VALUES ('ledgerly', 'Ledgerly', ?, ?)").run(t, t);
    old.prepare("INSERT INTO contacts (id, url, full_name, profile_json, captured_at) VALUES ('c1', 'https://www.linkedin.com/in/c1', 'Riley Moss', '{}', ?)").run(t);
    old.prepare("INSERT INTO account_members (account_id, person_id, role, added_at, updated_at) VALUES ('ledgerly', 'c1', 'champion', ?, ?)").run(t, t);
    old.prepare("INSERT INTO account_members (account_id, person_id, reports_to, notes, added_at, updated_at) VALUES ('ledgerly', 'c2', 'c1', 'met at SaaStock', ?, ?)").run(t, t);
    old.close();

    const s = open();
    expect((s.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    const ms = s.accounts.members('ledgerly');
    expect(ms.map((m) => [m.personId, m.role, m.reportsTo, m.reportsToSource, m.notes])).toEqual([
      ['c1', 'champion', '', '', ''],
      ['c2', '', 'c1', 'user', 'met at SaaStock'],
    ]);
    expect(ms[0]).toMatchObject({ subfunction: '', team: '', noise: '', sources: [], confidence: null });
    expect(s.accounts.getContact('c1')).toMatchObject({ kind: 'full', sources: [], captureCount: 1 });
    // user-set lines are never overwritten by suggestions
    expect(s.accounts.applyInferredReportsTo('ledgerly', 'c2', '', 0.6, 'x', 'inferred')).toBe(false);

    const run = s.accounts.startListRun('ledgerly', { pageKind: 'people-tab', url: 'https://www.linkedin.com/company/ledgerly/people/', keywords: 'marketing' });
    expect(s.accounts.addAnonRows(run.id, [{ idx: 0, headline: 'Marketing Manager' }, { idx: 3, location: 'Munich' }])).toBe(2);
    expect(s.accounts.addAnonRows(run.id, [{ idx: 0, headline: 'Marketing Manager' }])).toBe(0);
    s.accounts.updateListRun(run.id, { rowsSeen: 40, named: 38, anonymous: 2, stopReason: 'end', finishedAt: t });
    expect(s.accounts.listRuns('ledgerly')[0]).toMatchObject({ rowsSeen: 40, named: 38, anonymous: 2, stopReason: 'end' });
    expect(() => s.accounts.updateListRun(run.id, { stopReason: 'bored' as never })).toThrow(/stopReason/);
    s.accounts.addHeadcount('ledgerly', { source: 'linkedin-people', scope: 'function', label: 'Marketing', count: 42, runId: run.id });
    expect(() => s.accounts.addHeadcount('ledgerly', { source: 'guess' as never, scope: 'company', count: 1 })).toThrow(/source/);
    const facts = [{ kind: 'team' as const, text: 'Brand sits under the CMO', evidenceUrl: 'https://ledgerly.example/about', quote: 'Our brand team…', confidence: 0.9 }];
    expect(s.accounts.addOrgFacts('ledgerly', facts)).toEqual({ added: 1, duplicates: 0 });
    expect(s.accounts.addOrgFacts('ledgerly', facts)).toEqual({ added: 0, duplicates: 1 });
    expect(() => s.accounts.addOrgFacts('ledgerly', [{ ...facts[0]!, evidenceUrl: 'ftp://x' }])).toThrow(/evidenceUrl/);
    expect(s.accounts.headcounts('ledgerly')).toHaveLength(1);

    s.accounts.delete('ledgerly');
    const count = (t: string) => (s.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([count('account_headcounts'), count('account_list_runs'), count('account_anon_rows'), count('account_org_facts'), count('account_members')]).toEqual([0, 0, 0, 0, 0]);
  });

  it('view: vendor-funded people at the account stay in the org (tagged, partner-marketing); vendor employees are other-employer', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly', domain: 'ledgerly.example' });
    const src = { kind: 'manual' as const, at: '' };
    const [funded, listed, blank, legacy, handVendor] = s.accounts.upsertLightContacts(a.id, [
      { fullName: 'Mara Lind', title: 'Partner Marketing Manager for Globex Inc', company: 'Ledgerly Services GmbH', source: src },
      // a list-walk row whose company was guessed from a self-written headline: never other-employer
      { fullName: 'Theo Brandt', title: 'Marketing', company: 'a leading fintech', source: { kind: 'extension-list' as const, at: '' } },
      { fullName: 'Ines Kowal', title: 'Partner Marketing Manager', source: src },
      { fullName: 'Owen Hale', title: 'Brand Manager', company: 'Ledgerly', source: src },
      { fullName: 'Lena Voss', title: 'Channel Marketing Manager', company: 'Globex Inc', source: src },
    ]).added;
    // a captured full profile whose current role is at the vendor
    const vendor = ingestCapture(s.accounts, {
      accountId: a.id,
      profile: {
        url: 'https://www.linkedin.com/in/kai-ferro-globex/', fullName: 'Kai Ferro', headline: 'Partner Marketing at Globex', location: 'Berlin',
        currentCompany: 'Globex Inc', about: '',
        sections: { experience: { heading: 'Experience', items: [{
          lines: ['Partner Marketing Manager', 'Globex Inc · Full-time', 'Jan 2023 - Present · 1 yr 10 mos'],
          companyUrl: 'https://www.linkedin.com/company/globex-inc/',
        }] } },
      } as CapturePayload,
    }).contact.id;
    // pre-2b hand-set overrides: kept as stored, read as the tag (user intent wins, even at another employer)
    s.accounts.updateMember(a.id, legacy!, { noise: 'vendor-funded' });
    s.accounts.updateMember(a.id, handVendor!, { noise: 'vendor-funded' });
    const v = buildAccountView(s.accounts, a, new Map());
    const by = (id: string) => v.members.find((m) => m.id === id)!;
    expect(by(funded!)).toMatchObject({ noise: '', vendorFunded: true, subfunction: 'partner-marketing', autoNoise: true });
    expect(by(vendor)).toMatchObject({ noise: 'other-employer', vendorFunded: false });
    expect(by(listed!)).toMatchObject({ noise: '', vendorFunded: false });
    expect(by(blank!)).toMatchObject({ noise: '', vendorFunded: false });
    expect(by(legacy!)).toMatchObject({ noise: '', vendorFunded: true, subfunction: 'partner-marketing', autoNoise: false });
    expect(by(handVendor!)).toMatchObject({ noise: '', vendorFunded: true, subfunction: 'partner-marketing', autoNoise: false });
    expect(s.accounts.members(a.id).find((m) => m.personId === legacy)!.noise).toBe('vendor-funded');
    expect(() => s.accounts.updateMember(a.id, vendor, { noise: 'other-employer' })).not.toThrow();
    // once the vendor's company page is walked into this account, it counts as an entity
    s.accounts.startListRun(a.id, { pageKind: 'people-tab', url: 'https://www.linkedin.com/company/globex-inc/people/', keywords: '' });
    s.accounts.updateMember(a.id, vendor, { noise: '' });
    expect(buildAccountView(s.accounts, a, new Map()).members.find((m) => m.id === vendor)).toMatchObject({ noise: '' });
  });

  it('view: list-walk light rows (no stored department / sub-function) are classified from the title', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const src = { kind: 'extension-list' as const, at: '', url: 'https://www.linkedin.com/search/results/people/?keywords=marketing', runId: 'r1' };
    const [partner, hr, lead] = s.accounts.upsertLightContacts(a.id, [
      { fullName: 'Noor Haddad', title: 'Head of Partner Marketing', company: 'Ledgerly', source: src },
      { fullName: 'Ilka Brenner', title: 'Recruiting I Personalmarketing I HR Digitalisierung', company: 'Ledgerly', source: src },
      { fullName: 'Lars Feld', title: 'Marketingleitung', company: 'Ledgerly', source: src },
    ]).added;
    const stored = s.accounts.members(a.id);
    expect(stored.every((m) => !m.department && !m.subfunction)).toBe(true);
    const v = buildAccountView(s.accounts, a, new Map());
    const by = (id: string) => v.members.find((m) => m.id === id)!;
    expect(by(partner!)).toMatchObject({ department: 'marketing', subfunction: 'partner-marketing', seniority: 'head', tier: 'director', autoDepartment: true, autoSubfunction: true, noise: '' });
    expect(by(hr!)).toMatchObject({ department: 'people', noise: 'hr-marketing', autoNoise: true });
    expect(by(lead!)).toMatchObject({ department: 'marketing', subfunction: 'leadership', seniority: 'head', tier: 'director', noise: '' });
  });

  it('a light row seen again in a list takes the newest values; late retries, manual rows, full captures and user fields are untouched', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const PT = 'https://www.linkedin.com/company/ledgerly/people/';
    const run = (startedAt: string) => {
      const r = s.accounts.startListRun(a.id, { pageKind: 'people-tab', url: PT });
      s.db.prepare('UPDATE account_list_runs SET started_at = ? WHERE id = ?').run(startedAt, r.id);
      return { kind: 'extension-list' as const, at: '', url: PT, runId: r.id };
    };
    const oldRun = run('2026-11-01T10:00:00.000Z');
    const midRun = run('2026-11-10T10:00:00.000Z');
    const newRun = run('2026-11-20T10:00:00.000Z');
    const url = 'https://www.linkedin.com/in/flavio-example';
    const [id] = s.accounts.upsertLightContacts(a.id, [
      { fullName: 'Flavio Example is hiring', url, title: 'Marketing Manager', company: 'Ledgerly - Wir sind Ledgerly | Cloud…', location: 'Munich', source: midRun },
    ]).added;
    s.accounts.updateMember(a.id, id!, { subfunction: 'brand', entity: 'Ledgerly Services GmbH' });
    // a newer run: newest values win (blank ones keep the old value); member fields set by the user stay
    const r = s.accounts.upsertLightContacts(a.id, [{ fullName: 'Flavio Example', url, title: 'Senior Marketing Manager', company: 'Ledgerly', location: '', source: newRun }]);
    expect(r.updated).toEqual([id]);
    expect(s.accounts.getContact(id!)).toMatchObject({ kind: 'light', fullName: 'Flavio Example', title: 'Senior Marketing Manager', company: 'Ledgerly', location: 'Munich' });
    expect(s.accounts.getContact(id!)!.profile).toMatchObject({ fullName: 'Flavio Example', title: 'Senior Marketing Manager', company: 'Ledgerly' });
    expect(s.accounts.members(a.id)[0]).toMatchObject({ subfunction: 'brand', entity: 'Ledgerly Services GmbH' });
    // a late Retry of an OLDER run (posted now) never overwrites the newer sighting
    s.accounts.upsertLightContacts(a.id, [{ fullName: 'Flavio Example', url, title: 'Marketing Intern', company: 'Old Co', source: oldRun }]);
    expect(s.accounts.getContact(id!)).toMatchObject({ title: 'Senior Marketing Manager', company: 'Ledgerly' });
    // web research words titles its own way: it never replaces what LinkedIn showed
    s.accounts.upsertLightContacts(a.id, [{ fullName: 'Flavio Example', title: 'Marketing', source: { kind: 'web', at: '', url: 'https://ledgerly.example/team', evidenceUrl: 'https://ledgerly.example/team', quote: 'x' } }], { matchNameOnly: true });
    expect(s.accounts.getContact(id!)!.title).toBe('Senior Marketing Manager');

    // a person the user added by hand keeps what they typed, even when a list sees them later
    const murl = 'https://www.linkedin.com/in/hand-added-example';
    const [hand] = s.accounts.upsertLightContacts(a.id, [{ fullName: 'Ava Lindqvist', url: murl, title: 'CMO', source: { kind: 'manual', at: '' } }]).added;
    s.accounts.upsertLightContacts(a.id, [{ fullName: 'Ava Lindqvist (She/Her)', url: murl, title: 'Chief Marketing Officer & Board', company: 'Ledgerly', source: newRun }]);
    expect(s.accounts.getContact(hand!)).toMatchObject({ fullName: 'Ava Lindqvist', title: 'CMO' });

    // a full capture is never touched by a list row
    const full = ingestCapture(s.accounts, { profile: capture(), accountId: a.id });
    s.accounts.upsertLightContacts(a.id, [{ fullName: 'Riley Moss', url: full.contact.url, title: 'Intern', company: 'Elsewhere', location: 'Nowhere', source: newRun }]);
    expect(s.accounts.getContact(full.contact.id)).toMatchObject({ kind: 'full', fullName: 'Riley Moss', title: full.contact.title, location: full.contact.location });
  });

  it('view: a light row with no company is at the account, so "… Marketing Manager <Vendor> Inc." is tagged vendor-funded', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const src = { kind: 'extension-list' as const, at: '', url: 'https://www.linkedin.com/company/ledgerly/people/', runId: 'r1' };
    const [pm] = s.accounts.upsertLightContacts(a.id, [{ fullName: 'Kai Wolf', title: 'Portfolio Marketing Manager Globex Inc.', source: src }]).added;
    const m = buildAccountView(s.accounts, a, new Map()).members.find((x) => x.id === pm)!;
    expect(m).toMatchObject({ vendorFunded: true, subfunction: 'partner-marketing', noise: '' });
  });

  it('a repeated light import adds nothing', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const first = s.accounts.upsertLightContacts(a.id, list());
    expect(first.added).toHaveLength(3);
    expect(first.skipped).toEqual([]);
    const counts = () => [
      (s.db.prepare('SELECT count(*) AS n FROM contacts').get() as { n: number }).n,
      s.accounts.members(a.id).length,
      s.accounts.members(a.id).map((m) => m.sources.length),
    ];
    const before = counts();
    const again = s.accounts.upsertLightContacts(a.id, list());
    expect(again.added).toEqual([]);
    expect(again.updated.length + again.merged.length).toBe(3);
    expect(counts()).toEqual(before);

    const jonas = s.accounts.getContact(first.added[0]!)!;
    expect(jonas).toMatchObject({ kind: 'light', url: 'https://www.linkedin.com/in/ACoAABjonas1234567', title: 'Head of Brand', location: 'Berlin', captureCount: 0 });
    expect(s.accounts.getContact(first.added[1]!)).toMatchObject({ title: 'Demand Generation Manager', company: 'Ledgerly' });
    // the network is untouched
    expect(s.listExplorerPeople()).toEqual([]);
    // the account view shows them as light
    const v = buildAccountView(s.accounts, a, new Map());
    expect(v.members.every((m) => m.kind === 'light')).toBe(true);
    expect(v.members.find((m) => m.fullName === 'Sam Okafor')).toMatchObject({ seniority: 'lead', subfunction: 'content', noise: '', autoSubfunction: true });

    // the same name without a URL, with a compatible title → the existing member, not a new one
    const byName = s.accounts.upsertLightContacts(a.id, [{ fullName: 'Dr. Jonas Mueller-Brandt', title: 'Head of Brand & Content', source: { kind: 'manual', at: '' } }]);
    expect(byName.merged).toEqual([jonas.id]);
    expect(s.accounts.upsertLightContacts(a.id, [{ fullName: 'X', url: 'https://example.com/x', source: { kind: 'manual', at: '' } }]).skipped[0]!.reason).toMatch(/LinkedIn/);
  });

  it('folds a list row (member URN) into a later full capture of the same person, keeping what the user set', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const [urnId, boss] = s.accounts.upsertLightContacts(a.id, [list()[0]!, { fullName: 'Ava Lindqvist', title: 'CMO', source: { kind: 'manual', at: '' } }]).added;
    s.accounts.updateMember(a.id, urnId!, { role: 'champion', reportsTo: boss!, notes: 'warm intro via Al' });
    const r = ingestCapture(s.accounts, {
      profile: capture({ url: 'https://www.linkedin.com/in/jonas-muller-brandt/', fullName: 'Jonas Müller-Brandt', headline: 'Head of Brand at Ledgerly', sections: {} }),
      accountId: a.id,
    });
    expect(r.contact.id).not.toBe(urnId);
    const ms = s.accounts.members(a.id);
    expect(ms).toHaveLength(2);
    const me = ms.find((m) => m.personId === r.contact.id)!;
    expect(me).toMatchObject({ role: 'champion', reportsTo: boss, reportsToSource: 'user', notes: 'warm intro via Al' });
    expect(me.sources.map((x) => x.kind).sort()).toEqual(['extension-list', 'extension-profile']);
    expect(s.accounts.knownPerson(urnId!)).toBe(true);
    expect(s.accounts.resolveId(urnId!)).toBe(r.contact.id);
    expect(s.accounts.aliasesOf(r.contact.id).map((x) => x.url)).toContain('https://www.linkedin.com/in/ACoAABjonas1234567');
    expect(s.accounts.getContact(urnId!)).toMatchObject({ id: r.contact.id, kind: 'full' });
    // the list walk seeing the URN again changes nothing
    const again = s.accounts.upsertLightContacts(a.id, [list()[0]!]);
    expect(again).toMatchObject({ added: [], updated: [r.contact.id] });
    expect(s.accounts.getContact(r.contact.id)!.title).toBe('Head of Brand');
    // a light row never overwrites a full contact's fields
    s.accounts.upsertLightContacts(a.id, [{ fullName: 'Jonas Müller-Brandt', url: 'https://www.linkedin.com/in/jonas-muller-brandt', title: 'Intern', location: 'Nowhere', source: { kind: 'manual', at: '' } }]);
    expect(s.accounts.getContact(r.contact.id)).toMatchObject({ title: 'Head of Brand', location: 'Dublin, Ireland', kind: 'full' });
  });

  it('a list row for one of your connections files the connection, without a contact row', () => {
    const s = open();
    s.upsertPeople([mk('jo-park', 'Jo Park', 'Head of Sales at Ledgerly')], 'test.csv');
    const a = s.accounts.create({ name: 'Ledgerly' });
    const r = s.accounts.upsertLightContacts(a.id, [{ fullName: 'Jo Park', url: 'https://www.linkedin.com/in/Jo-Park/', source: { kind: 'extension-list', at: '' } }]);
    expect(r.added).toEqual(['jo-park']);
    expect(s.accounts.allContacts()).toEqual([]);
    const people = new Map(s.listExplorerPeople().map((p) => [p.id, p]));
    expect(buildAccountView(s.accounts, a, people).members[0]).toMatchObject({ id: 'jo-park', kind: 'connection', isConnection: true });
  });

  it('a merge keeps a reporting line the user cleared, and stale light ids still work', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const [boss] = s.accounts.upsertLightContacts(a.id, [{ fullName: 'Ava Lindqvist', title: 'CMO', source: { kind: 'manual', at: '' } }]).added;
    const full = ingestCapture(s.accounts, { profile: capture({ url: 'https://www.linkedin.com/in/riley-moss', headline: 'Head of Brand at Ledgerly', sections: {} }), accountId: a.id });
    const riley = full.contact.id;
    s.accounts.updateMember(a.id, riley, { reportsTo: boss! });
    s.accounts.updateMember(a.id, riley, { reportsTo: '' }); // deliberately cleared
    const [urn] = s.accounts.upsertLightContacts(a.id, [{ fullName: 'Riley Moss', url: 'https://www.linkedin.com/in/ACoAABriley123456', title: 'Marketing Director', source: { kind: 'extension-list', at: '' } }]).added;
    expect(urn).not.toBe(riley); // titles differ → its own row
    s.accounts.applyInferredReportsTo(a.id, urn!, boss!, 0.6, 'same team', 'inferred');
    s.accounts.mergeContacts(urn!, riley);
    expect(s.accounts.members(a.id).find((m) => m.personId === riley)).toMatchObject({ reportsTo: '', reportsToSource: 'user' });
    // the merged (stale) light id still addresses the person, as member and as manager
    expect(s.accounts.updateMember(a.id, urn!, { notes: 'via old id' })).toMatchObject({ personId: riley, notes: 'via old id' });
    expect(s.accounts.updateMember(a.id, boss!, { reportsTo: urn! })).toMatchObject({ reportsTo: riley });
  });

  it('does not merge a same-name light row with a conflicting title at capture time, and says so', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const [light] = s.accounts.upsertLightContacts(a.id, [{ fullName: 'Riley Moss', url: 'https://www.linkedin.com/in/ACoAABriley123456', title: 'Software Engineer', source: { kind: 'extension-list', at: '' } }]).added;
    const r = ingestCapture(s.accounts, { profile: capture(), accountId: a.id });
    expect(r.warnings.join(' ')).toMatch(/not merged.*possible duplicate/);
    expect(s.accounts.getContact(light!)).toMatchObject({ id: light, kind: 'light' });
    expect(s.accounts.members(a.id)).toHaveLength(2);
    const sum = accountSummaries(s.accounts, new Set())[0]!;
    expect(sum).toMatchObject({ memberCount: 2, captured: 1, light: 1 });
  });

  it('reports a reporting loop made only of the user’s own lines when a merge creates one', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const [l, b] = s.accounts.upsertLightContacts(a.id, [
      { fullName: 'Lee Light', title: 'Brand Manager', source: { kind: 'manual', at: '' } },
      { fullName: 'Ben Ortiz', title: 'Director Brand', source: { kind: 'manual', at: '' } },
    ]).added as [string, string];
    const f = ingestCapture(s.accounts, { profile: capture(), accountId: a.id }).contact.id;
    s.accounts.updateMember(a.id, f, { reportsTo: b });
    s.accounts.updateMember(a.id, b, { reportsTo: l });
    const { warnings } = s.accounts.mergeContacts(l, f);
    expect(warnings[0]).toMatch(/reporting loop/);
    const ms = s.accounts.members(a.id);
    expect(ms.filter((m) => m.reportsTo).length).toBe(1);
  });

  it('applyWebFindings fills only blanks of the inference, never user columns; confidence only goes up; web lines survive inference', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const [x, y] = s.accounts.upsertLightContacts(a.id, [
      { fullName: 'Ava Lindqvist', title: 'CMO', source: { kind: 'manual', at: '' } },
      { fullName: 'Riley Moss', title: 'Head of Communications', source: { kind: 'manual', at: '' } },
    ]).added as [string, string];
    s.accounts.updateMember(a.id, y, { entity: 'Ledgerly AG' }); // the user's entity
    s.accounts.applyInference(a.id, [[y, { subfunction: 'brand', model: 'haiku', at: 't' }]]);
    expect(s.accounts.applyWebFindings(a.id, y, { entity: 'Ledgerly Services GmbH', country: 'DE', subfunction: 'comms-pr', confidence: 0.6 })).toBe(true);
    let m = s.accounts.members(a.id).find((r) => r.personId === y)!;
    expect(m).toMatchObject({ entity: 'Ledgerly AG', subfunction: '', confidence: 0.6 });
    expect(m.inference).toMatchObject({ entity: 'Ledgerly Services GmbH', country: 'DE', subfunction: 'brand', model: 'haiku' });
    s.accounts.applyWebFindings(a.id, y, { entity: 'Other GmbH', country: 'xx', confidence: 0.4 });
    m = s.accounts.members(a.id).find((r) => r.personId === y)!;
    expect(m).toMatchObject({ confidence: 0.6, inference: { entity: 'Ledgerly Services GmbH', country: 'DE' } });
    expect(s.accounts.applyWebFindings(a.id, 'not-a-member', { confidence: 0.6 })).toBe(false);
    // a web reporting line is kept by a later inference run
    expect(s.accounts.applyInferredReportsTo(a.id, y, x, 0.9, 'press', 'web')).toBe(true);
    s.accounts.replaceInferredReportsTo(a.id, [y], [{ id: y, managerId: null, confidence: 0.3, reason: '' }]);
    expect(s.accounts.members(a.id).find((r) => r.personId === y)).toMatchObject({ reportsTo: x, reportsToSource: 'web' });
  });

  it('hands a user-owned reporting line back to automatic', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const [x, y] = s.accounts.upsertLightContacts(a.id, [
      { fullName: 'Ava Lindqvist', title: 'CMO', source: { kind: 'manual', at: '' } },
      { fullName: 'Ben Ortiz', title: 'Director Brand', source: { kind: 'manual', at: '' } },
    ]).added as [string, string];
    s.accounts.updateMember(a.id, y, { reportsTo: '' });
    expect(s.accounts.applyInferredReportsTo(a.id, y, x, 0.6, '', 'inferred')).toBe(false);
    expect(() => s.accounts.updateMember(a.id, y, { reportsTo: x, reportsToSource: 'auto' })).toThrow(/not both/);
    expect(() => s.accounts.updateMember(a.id, y, { reportsToSource: 'user' as never })).toThrow(/auto/);
    expect(s.accounts.updateMember(a.id, y, { reportsToSource: 'auto' })).toMatchObject({ reportsTo: '', reportsToSource: '', reportsToConfidence: null });
    expect(s.accounts.applyInferredReportsTo(a.id, y, x, 0.6, '', 'inferred')).toBe(true);
    // noise: auto vs the user's "not noise"
    s.accounts.updateMember(a.id, x, { noise: 'none' });
    const v = buildAccountView(s.accounts, a, new Map());
    expect(v.members.find((m) => m.id === x)).toMatchObject({ noise: '', autoNoise: false });
    expect(v.members.find((m) => m.id === y)).toMatchObject({ noise: '', autoNoise: true });
  });

  it('never merges when the name is ambiguous', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const two = s.accounts.upsertLightContacts(a.id, [
      { fullName: 'Kim Berg', url: 'https://www.linkedin.com/in/ACoAABkimberg11111', title: 'Brand Manager', source: { kind: 'manual', at: '' } },
      { fullName: 'Kim Berg', url: 'https://www.linkedin.com/in/ACoAABkimberg22222', title: 'Brand Manager', source: { kind: 'manual', at: '' } },
    ]);
    expect(two.added).toHaveLength(2);
    const third = s.accounts.upsertLightContacts(a.id, [{ fullName: 'Kim Berg', title: 'Brand Manager', source: { kind: 'manual', at: '' } }]);
    expect(third.added).toHaveLength(1);
    expect(third.warnings[0]!.reason).toMatch(/possible duplicate/);
    const full = ingestCapture(s.accounts, { profile: capture({ url: 'https://www.linkedin.com/in/kim-berg', fullName: 'Kim Berg', headline: 'Brand Manager at Ledgerly', sections: {} }), accountId: a.id });
    expect(s.accounts.members(a.id)).toHaveLength(4);
    // two full contacts are never merged
    expect(() => s.accounts.mergeContacts(full.contact.id, two.added[0]!)).toThrow(/light/);
  });

  it('user reporting lines win over suggestions; suggestions are validated', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const [x, y, z] = s.accounts.upsertLightContacts(a.id, [
      { fullName: 'Ava Lindqvist', title: 'CMO', source: { kind: 'manual', at: '' } },
      { fullName: 'Ben Ortiz', title: 'Director Brand', source: { kind: 'manual', at: '' } },
      { fullName: 'Cleo Park', title: 'Brand Manager', source: { kind: 'manual', at: '' } },
    ]).added as [string, string, string];
    expect(s.accounts.applyInferredReportsTo(a.id, y, x, 0.6, 'CMO is the marketing head', 'inferred')).toBe(true);
    expect(s.accounts.members(a.id).find((m) => m.personId === y)).toMatchObject({ reportsTo: x, reportsToSource: 'inferred', reportsToConfidence: 0.6, reportsToReason: 'CMO is the marketing head' });
    expect(() => s.accounts.applyInferredReportsTo(a.id, x, y, 0.3, 'loop', 'inferred')).toThrow(/loop/);
    expect(() => s.accounts.applyInferredReportsTo(a.id, x, 'nobody', 0.3, '', 'web')).toThrow(/another person/);
    s.accounts.confirmReportsTo(a.id, y);
    expect(s.accounts.members(a.id).find((m) => m.personId === y)).toMatchObject({ reportsToSource: 'user', reportsToConfidence: 1 });
    expect(s.accounts.applyInferredReportsTo(a.id, y, z, 0.9, '', 'web')).toBe(false);

    s.accounts.updateMember(a.id, z, { reportsTo: y, subfunction: 'brand', country: 'de', noise: 'none', team: 'Brand Studio' });
    expect(s.accounts.members(a.id).find((m) => m.personId === z)).toMatchObject({ reportsToSource: 'user', subfunction: 'brand', country: 'DE', noise: 'none', team: 'Brand Studio' });
    expect(() => s.accounts.updateMember(a.id, z, { subfunction: 'sales' as never })).toThrow(/subfunction/);
    expect(() => s.accounts.updateMember(a.id, z, { country: 'Germany' })).toThrow(/country/);
    expect(() => s.accounts.updateMember(a.id, z, { noise: 'meh' as never })).toThrow(/noise/);
    expect(() => s.accounts.updateMember(a.id, z, { responsibilities: 'x'.repeat(1001) })).toThrow(/too long/);
    // removing a manager clears the line and its provenance
    s.accounts.removeMember(a.id, y);
    expect(s.accounts.members(a.id).find((m) => m.personId === z)).toMatchObject({ reportsTo: '', reportsToSource: '', reportsToConfidence: null });
  });

  it('org inference results: stored as inference only; user fields and lines (and web lines) are never overwritten', () => {
    const s = open();
    const a = s.accounts.create({ name: 'Ledgerly' });
    const [cmo, brand, mgr, ic] = s.accounts.upsertLightContacts(a.id, [
      { fullName: 'Ava Lindqvist', title: 'CMO', source: { kind: 'manual', at: '' } },
      { fullName: 'Ben Ortiz', title: 'Director Brand', source: { kind: 'manual', at: '' } },
      { fullName: 'Cleo Park', title: 'Brand Manager', source: { kind: 'manual', at: '' } },
      { fullName: 'Dev Rao', title: 'Brand Specialist', source: { kind: 'manual', at: '' } },
    ]).added as [string, string, string, string];
    s.accounts.updateMember(a.id, mgr, { reportsTo: cmo, subfunction: 'events', noise: 'none' }); // the user's
    s.accounts.applyInferredReportsTo(a.id, ic, cmo, 0.3, 'old guess', 'inferred');
    s.accounts.applyInferredReportsTo(a.id, brand, cmo, 0.9, 'press release', 'web');
    const at = '2026-11-23T00:00:00Z';
    expect(s.accounts.applyInference(a.id, [
      [mgr, { subfunction: 'brand', seniority: 'manager', noise: 'sales-hybrid', team: 'Brand Studio', confidence: 0.6, reason: 'title', model: 'haiku', at }],
      [ic, { subfunction: 'brand', seniority: 'ic', noise: '', country: 'DE', confidence: 0.6, reason: 'title', model: 'haiku', at }],
      ['nobody', { subfunction: 'brand' }],
    ])).toBe(2);
    const r = s.accounts.replaceInferredReportsTo(a.id, [brand, mgr, ic], [
      { id: mgr, managerId: brand, confidence: 0.6, reason: 'same team' }, // user line: ignored
      { id: brand, managerId: mgr, confidence: 0.6, reason: 'nope' }, // web line: ignored
      { id: ic, managerId: mgr, confidence: 0.6, reason: 'team lead' },
    ]);
    expect(r).toEqual({ applied: 1, skipped: [] });
    const rows = new Map(s.accounts.members(a.id).map((m) => [m.personId, m]));
    expect(rows.get(mgr)).toMatchObject({ reportsTo: cmo, reportsToSource: 'user', subfunction: 'events', noise: 'none', inference: { subfunction: 'brand', noise: 'sales-hybrid' } });
    expect(rows.get(brand)).toMatchObject({ reportsTo: cmo, reportsToSource: 'web', reportsToConfidence: 0.9 });
    expect(rows.get(ic)).toMatchObject({ reportsTo: mgr, reportsToSource: 'inferred', reportsToConfidence: 0.6, reportsToReason: 'team lead' });
    const v = buildAccountView(s.accounts, a, new Map());
    const vm = new Map(v.members.map((m) => [m.id, m]));
    expect(vm.get(mgr)).toMatchObject({ subfunction: 'events', autoSubfunction: false, noise: '', autoNoise: false, team: 'Brand Studio' });
    expect(vm.get(ic)).toMatchObject({ subfunction: 'brand', seniority: 'ic', country: 'DE' });
    // a null suggestion clears an earlier inferred line, never the user's
    s.accounts.replaceInferredReportsTo(a.id, [ic, mgr], [{ id: ic, managerId: null, confidence: 0.3, reason: '' }]);
    const after = new Map(s.accounts.members(a.id).map((m) => [m.personId, m]));
    expect(after.get(ic)).toMatchObject({ reportsTo: '', reportsToSource: '' });
    expect(after.get(mgr)).toMatchObject({ reportsTo: cmo, reportsToSource: 'user' });
  });
});
