import { describe, expect, it } from 'vitest';
import { AHOY_PROPOSAL_TOOL, AHOY_READ_TOOLS, normalizeMatch, planAhoySend } from '../src/llm/ahoy';
import { buildArgs } from '../src/llm/claude';
import type { CrmMatch, ExplorerPerson } from '../src/types';

const at = '2026-11-05T10:00:00.000Z';
const person = (id: string, name: string, crm?: Partial<CrmMatch>, over: Partial<ExplorerPerson> = {}): ExplorerPerson => ({
  id, rowIndex: 0, fullName: name, firstName: name.split(' ')[0]!, lastName: name.split(' ').slice(1).join(' '),
  title: `Partner at ${over.company || 'Northwind Ventures'}`, company: 'Northwind Ventures', url: `https://www.linkedin.com/in/${id}/`,
  email: '', connectedOn: '2024-01-01', extra: {}, scores: { angels: { score: 90, reason: 'GP at a fund', basis: 'headline', stale: false } },
  ...(crm ? { crm: { status: 'new', companyStatus: 'new', reason: 'r', checkedAt: at, ...crm } as CrmMatch } : {}),
  ...over,
});
const lens = { id: 'angels', goal: 'potential angel investors' };

describe('claude args for MCP calls', () => {
  it('loads MCP config, allows only the given tools, disallows built-ins', () => {
    const a = buildArgs({ prompt: 'x', model: 'haiku', jsonSchema: {}, mcpTools: AHOY_READ_TOOLS });
    expect(a).not.toContain('--strict-mcp-config');
    expect(a).not.toContain('--tools');
    expect(a.slice(a.indexOf('--allowedTools') + 1)).toEqual(AHOY_READ_TOOLS);
    expect(a).toContain('--disallowedTools');
    expect(a.slice(a.indexOf('--disallowedTools') + 1, a.indexOf('--allowedTools'))).toContain('Bash');
  });
  it('non-MCP calls stay strict', () => {
    const a = buildArgs({ prompt: 'x', model: 'haiku', jsonSchema: {} });
    expect(a).toContain('--strict-mcp-config');
    expect(a.slice(-2)).toEqual(['--tools', '']);
  });
});

describe('normalizeMatch', () => {
  const p = person('a', 'Avery Quinn');
  it('derives company status from what was found', () => {
    expect(normalizeMatch({ id: 'p1', status: 'new', reason: 'x' }, p).companyStatus).toBe('new');
    expect(normalizeMatch({ id: 'p1', status: 'new', reason: 'x', companyId: 'c1', companyName: 'Northwind' }, p).companyStatus).toBe('no_domain');
    expect(normalizeMatch({ id: 'p1', status: 'new', reason: 'x', companyId: 'c1', companyDomain: 'northwind.vc' }, p).companyStatus).toBe('in_crm');
  });
  it('never trusts an in_crm without a contact id, or ambiguous without candidates', () => {
    expect(normalizeMatch({ id: 'p1', status: 'in_crm', reason: 'x' }, p).status).toBe('new');
    expect(normalizeMatch({ id: 'p1', status: 'ambiguous', reason: 'x' }, p).status).toBe('new');
    const amb = normalizeMatch({ id: 'p1', status: 'in_crm', reason: 'x', candidates: [{ id: 'k', name: 'A', detail: 'd' }] }, p);
    expect(amb.status).toBe('ambiguous');
    expect(amb.candidates).toHaveLength(1);
  });
  it('a missing result is an error, and a previous send marker survives a re-check', () => {
    expect(normalizeMatch(undefined, p).status).toBe('error');
    const sent = { at, proposalId: '7', url: 'https://app.ahoy.ai/p/7', title: 't' };
    expect(normalizeMatch({ id: 'p1', status: 'new', reason: 'x' }, { ...p, crm: { status: 'new', companyStatus: 'new', reason: '', checkedAt: at, sent } }).sent).toEqual(sent);
  });
});

describe('planAhoySend', () => {
  it('skips unchecked / ambiguous / errored / already-sent people with reasons', () => {
    const plan = planAhoySend([
      person('u', 'Un Checked'),
      person('a', 'Am Biguous', { status: 'ambiguous', candidates: [{ id: 'x', name: 'X', detail: '' }] }),
      person('e', 'Er Ror', { status: 'error' }),
      person('s', 'Al Ready', { sent: { at, proposalId: '1', url: '', title: '' } }),
    ], lens);
    expect(plan.proposals).toHaveLength(0);
    expect(plan.skipped.map((s) => s.id)).toEqual(['u', 'a', 'e', 's']);
  });

  it('creates each new company once, links its new contacts by temp_id, adds notes; existing contacts get a note only', () => {
    const plan = planAhoySend([
      person('n1', 'New One', { status: 'new', companyName: 'Northwind Ventures', companyStatus: 'new' }),
      person('n2', 'New Two', { status: 'new', companyName: 'northwind ventures', companyStatus: 'new' }),
      person('x1', 'Ex Isting', { status: 'in_crm', contactId: 'contact-uuid', companyId: 'co-uuid', companyName: 'Bluefield', companyStatus: 'in_crm', companyDomain: 'bluefield.vc' }),
      person('n3', 'New Three', { status: 'new', companyId: 'co-uuid', companyName: 'Bluefield', companyStatus: 'in_crm' }),
    ], lens);
    expect(plan.proposals).toHaveLength(1);
    const ops = plan.proposals[0]!.operations;
    const companies = ops.filter((o) => o.object_type === 'ahoy_company');
    expect(companies).toHaveLength(1);
    expect(companies[0]!.properties).toMatchObject({ ahoy_name: 'Northwind Ventures' });
    const links = ops.filter((o) => o.association_type === 'ahoy_contact_to_company');
    expect(links.map((l) => l.target_entity_id).sort()).toEqual(['co-uuid', 'company_1', 'company_1']);
    // the existing contact is not re-created, only noted
    expect(ops.filter((o) => o.object_type === 'ahoy_contact')).toHaveLength(3);
    const noteLinks = ops.filter((o) => o.association_type === 'ahoy_note_to_contact').map((o) => o.target_entity_id);
    expect(noteLinks).toContain('contact-uuid');
    expect(plan.summary).toEqual({ newContacts: 3, newCompanies: 1, notes: 4, existingContacts: 1, linkedCompanies: 3 });
    const created = ops.find((o) => o.object_type === 'ahoy_contact')!;
    expect(created.properties).toMatchObject({ ahoy_first_name: 'New', ahoy_last_name: 'One', ahoy_linkedin_url: 'https://www.linkedin.com/in/n1/' });
    expect(plan.proposals[0]!.title).toBe('network-builder: potential angel investors');
    // every temp_id referenced is created earlier in the same proposal
    const made = new Set<string>();
    for (const o of ops) {
      for (const ref of [o.source_entity_id, o.target_entity_id]) if (ref && !ref.includes('uuid')) expect(made.has(ref), ref).toBe(true);
      if (o.temp_id) made.add(o.temp_id);
    }
  });

  it('splits into proposals of at most 50 operations', () => {
    const many = Array.from({ length: 30 }, (_, i) => person(`p${i}`, `Person ${i}`, { status: 'new', companyName: `Co ${i}`, companyStatus: 'new' }));
    const plan = planAhoySend(many, lens);
    expect(plan.proposals.length).toBeGreaterThan(1);
    for (const pr of plan.proposals) expect(pr.operations.length).toBeLessThanOrEqual(50);
    expect(plan.proposals.flatMap((p) => p.personIds)).toHaveLength(30);
    expect(plan.proposals[0]!.title).toMatch(/\(1\/\d\)$/);
  });

  it('only uses the proposal tool for writes', () => {
    expect(AHOY_PROPOSAL_TOOL).toMatch(/create_proposal$/);
    expect(AHOY_READ_TOOLS.join(' ')).not.toMatch(/execute|create|update|delete/);
  });
});
