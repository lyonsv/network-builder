import type { DatabaseSync } from 'node:sqlite';
import { canonicalCompanyUrl, canonicalProfileUrl, normalizeCompany } from '../accounts/capture';
import {
  ACCOUNT_STATUSES,
  COMMITTEE_ROLES,
  DEPARTMENTS,
  TIERS,
  type Account,
  type AccountMemberRow,
  type AccountStatus,
  type CapturedProfile,
  type CommitteeRole,
  type Contact,
  type Department,
  type Tier,
} from '../accounts/types';
import { personId } from '../io/csv';
import { slugify } from '../io/output';

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const json = <T>(v: unknown, d: T): T => {
  try {
    return JSON.parse(str(v)) as T;
  } catch {
    return d;
  }
};

export class AccountError extends Error {}

export interface AccountPatch {
  name?: string;
  domain?: string;
  linkedinUrl?: string;
  aliases?: string[];
  status?: AccountStatus;
  brief?: string;
}

export interface MemberPatch {
  department?: Department | '';
  tier?: Tier | '';
  role?: CommitteeRole | '';
  reportsTo?: string;
  notes?: string;
}

const LIMITS = { name: 120, domain: 200, alias: 120, aliases: 20, brief: 100_000, notes: 10_000 };

export const cleanDomain = (d: string): string =>
  (d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').slice(0, LIMITS.domain);

/** Accounts, captured contacts and membership. All SQL for the ABX feature lives here. */
export class AccountsRepo {
  constructor(private readonly db: DatabaseSync) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- accounts ----------
  private toAccount(r: Row): Account {
    const status = str(r.status) as AccountStatus;
    return {
      id: str(r.id),
      name: str(r.name),
      domain: str(r.domain),
      linkedinUrl: str(r.linkedin_url),
      aliases: json<string[]>(r.aliases_json, []).filter((a) => typeof a === 'string'),
      status: ACCOUNT_STATUSES.includes(status) ? status : 'target',
      brief: str(r.brief),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    };
  }

  list(): Account[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY updated_at DESC, name COLLATE NOCASE').all() as Row[]).map((r) => this.toAccount(r));
  }

  get(id: string): Account | undefined {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toAccount(r) : undefined;
  }

  /** by id, exact LinkedIn company URL, or (normalised) name / alias */
  find(ref: string): Account | undefined {
    const q = (ref || '').trim();
    if (!q) return undefined;
    const byId = this.get(q);
    if (byId) return byId;
    const all = this.list();
    const cu = canonicalCompanyUrl(q);
    if (cu) return all.find((a) => a.linkedinUrl === cu);
    const n = normalizeCompany(q);
    if (!n) return undefined;
    return all.find((a) => normalizeCompany(a.name) === n || a.aliases.some((x) => normalizeCompany(x) === n));
  }

  /** match a capture to an account: LinkedIn company URL first, then name/alias */
  match(companyName: string, companyUrl: string): Account | undefined {
    const cu = canonicalCompanyUrl(companyUrl);
    const all = this.list();
    if (cu) {
      const hit = all.find((a) => a.linkedinUrl === cu);
      if (hit) return hit;
    }
    const n = normalizeCompany(companyName);
    return n ? all.find((a) => normalizeCompany(a.name) === n || a.aliases.some((x) => normalizeCompany(x) === n)) : undefined;
  }

  private validate(p: AccountPatch): AccountPatch {
    const out: AccountPatch = {};
    if (p.name !== undefined) {
      const name = String(p.name).replace(/\s+/g, ' ').trim();
      if (!name) throw new AccountError('account name is required');
      if (name.length > LIMITS.name) throw new AccountError(`account name is too long (max ${LIMITS.name} chars)`);
      out.name = name;
    }
    if (p.domain !== undefined) out.domain = cleanDomain(String(p.domain));
    if (p.linkedinUrl !== undefined) {
      const u = String(p.linkedinUrl).trim();
      const cu = canonicalCompanyUrl(u);
      if (u && !cu) throw new AccountError('LinkedIn URL must be a linkedin.com/company/… page');
      out.linkedinUrl = cu;
    }
    if (p.aliases !== undefined) {
      if (!Array.isArray(p.aliases)) throw new AccountError('aliases must be a list of names');
      const seen = new Set<string>();
      out.aliases = p.aliases
        .map((a) => String(a).replace(/\s+/g, ' ').trim().slice(0, LIMITS.alias))
        .filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))
        .slice(0, LIMITS.aliases);
    }
    if (p.status !== undefined) {
      if (!ACCOUNT_STATUSES.includes(p.status)) throw new AccountError(`status must be one of: ${ACCOUNT_STATUSES.join(', ')}`);
      out.status = p.status;
    }
    if (p.brief !== undefined) {
      const b = String(p.brief);
      if (b.length > LIMITS.brief) throw new AccountError(`brief is too long (max ${LIMITS.brief.toLocaleString()} chars)`);
      out.brief = b;
    }
    return out;
  }

  private uniqueId(name: string): string {
    const base = slugify(name, 60, 'account');
    let id = base;
    for (let n = 2; this.get(id); n++) id = `${base.slice(0, 56)}-${n}`;
    return id;
  }

  create(p: AccountPatch & { name: string }): Account {
    const v = this.validate(p);
    const clash = this.find(v.name!);
    if (clash) throw new AccountError(`an account called “${clash.name}” already exists`);
    if (v.linkedinUrl) {
      const byUrl = this.list().find((a) => a.linkedinUrl === v.linkedinUrl);
      if (byUrl) throw new AccountError(`“${byUrl.name}” already uses that LinkedIn page`);
    }
    const id = this.uniqueId(v.name!);
    const t = now();
    this.db
      .prepare(`INSERT INTO accounts (id, name, domain, linkedin_url, aliases_json, status, brief, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, v.name!, v.domain ?? '', v.linkedinUrl ?? '', JSON.stringify(v.aliases ?? []), v.status ?? 'target', v.brief ?? '', t, t);
    return this.get(id)!;
  }

  update(id: string, p: AccountPatch): Account {
    const cur = this.get(id);
    if (!cur) throw new AccountError('no such account');
    const v = this.validate(p);
    if (v.name && normalizeCompany(v.name) !== normalizeCompany(cur.name)) {
      const clash = this.find(v.name);
      if (clash && clash.id !== id) throw new AccountError(`an account called “${clash.name}” already exists`);
    }
    const next = { ...cur, ...v };
    this.db
      .prepare('UPDATE accounts SET name = ?, domain = ?, linkedin_url = ?, aliases_json = ?, status = ?, brief = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.domain, next.linkedinUrl, JSON.stringify(next.aliases), next.status, next.brief, now(), id);
    return this.get(id)!;
  }

  /** fill blanks only (used when a capture tells us the company's LinkedIn URL) */
  fillBlanks(id: string, p: { linkedinUrl?: string }): void {
    const cu = canonicalCompanyUrl(p.linkedinUrl ?? '');
    if (!cu) return;
    if (this.list().some((a) => a.linkedinUrl === cu)) return;
    this.db.prepare("UPDATE accounts SET linkedin_url = ? WHERE id = ? AND linkedin_url = ''").run(cu, id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
  }

  touch(id: string): void {
    this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(now(), id);
  }

  // ---------- contacts (captured LinkedIn profiles) ----------
  private toContact(r: Row): Contact {
    return {
      id: str(r.id),
      url: str(r.url),
      fullName: str(r.full_name),
      headline: str(r.headline),
      title: str(r.title),
      company: str(r.company),
      location: str(r.location),
      profile: json<CapturedProfile>(r.profile_json, {} as CapturedProfile),
      capturedAt: str(r.captured_at),
      captureCount: Number(r.capture_count) || 1,
    };
  }

  getContact(id: string): Contact | undefined {
    const r = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toContact(r) : undefined;
  }

  contacts(ids: string[]): Map<string, Contact> {
    const out = new Map<string, Contact>();
    const st = this.db.prepare('SELECT * FROM contacts WHERE id = ?');
    for (const id of ids) {
      const r = st.get(id) as Row | undefined;
      if (r) out.set(id, this.toContact(r));
    }
    return out;
  }

  allContacts(): Contact[] {
    return (this.db.prepare('SELECT * FROM contacts ORDER BY full_name COLLATE NOCASE').all() as Row[]).map((r) => this.toContact(r));
  }

  /**
   * The id to file a profile URL under: the connection's id when this person is in your network (matched by URL,
   * tolerant of http/www/trailing-slash/encoding differences), else personId(canonical URL).
   */
  idForProfileUrl(url: string): { id: string; isConnection: boolean } {
    const canon = canonicalProfileUrl(url);
    if (!canon) throw new AccountError('not a LinkedIn profile URL');
    const id = personId(canon, '', '');
    if (this.db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) return { id, isConnection: true };
    const slug = canon.slice(canon.lastIndexOf('/') + 1);
    const variants = new Set([slug, encodeURIComponent(slug).toLowerCase()]);
    for (const s of variants) {
      const hit = this.db
        .prepare("SELECT id FROM people WHERE lower(rtrim(url, '/')) LIKE ? OR lower(rtrim(url, '/')) LIKE ? LIMIT 1")
        .get(`%linkedin.com/in/${s}`, `%linkedin.com/in/${s}?%`) as Row | undefined;
      if (hit) return { id: str(hit.id), isConnection: true };
    }
    return { id, isConnection: false };
  }

  saveContact(profile: CapturedProfile): { contact: Contact; isConnection: boolean; created: boolean } {
    const { id, isConnection } = this.idForProfileUrl(profile.url);
    const t = now();
    const blob = JSON.stringify(profile);
    let created = false;
    this.tx(() => {
      created = !this.db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(id);
      this.db
        .prepare(`INSERT INTO contacts (id, url, full_name, headline, title, company, location, profile_json, captured_at, capture_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(id) DO UPDATE SET url = excluded.url, full_name = excluded.full_name, headline = excluded.headline,
            title = excluded.title, company = excluded.company, location = excluded.location, profile_json = excluded.profile_json,
            captured_at = excluded.captured_at, capture_count = contacts.capture_count + 1`)
        .run(id, profile.url, profile.fullName, profile.headline, profile.title, profile.company, profile.location, blob, t);
      this.db.prepare('INSERT INTO contact_captures (contact_id, profile_json, captured_at) VALUES (?, ?, ?)').run(id, blob, t);
    });
    return { contact: this.getContact(id)!, isConnection, created };
  }

  // ---------- membership ----------
  private toMember(r: Row): AccountMemberRow {
    const d = str(r.department) as Department;
    const t = str(r.tier) as Tier;
    const role = str(r.role) as CommitteeRole;
    return {
      accountId: str(r.account_id),
      personId: str(r.person_id),
      department: DEPARTMENTS.includes(d) ? d : '',
      tier: TIERS.includes(t) ? t : '',
      role: COMMITTEE_ROLES.includes(role) ? role : '',
      reportsTo: str(r.reports_to),
      notes: str(r.notes),
      addedAt: str(r.added_at),
      updatedAt: str(r.updated_at),
    };
  }

  members(accountId: string): AccountMemberRow[] {
    return (this.db.prepare('SELECT * FROM account_members WHERE account_id = ? ORDER BY added_at, person_id').all(accountId) as Row[]).map((r) =>
      this.toMember(r),
    );
  }

  allMembers(): AccountMemberRow[] {
    return (this.db.prepare('SELECT * FROM account_members ORDER BY added_at').all() as Row[]).map((r) => this.toMember(r));
  }

  membershipsOf(personId: string): AccountMemberRow[] {
    return (this.db.prepare('SELECT * FROM account_members WHERE person_id = ?').all(personId) as Row[]).map((r) => this.toMember(r));
  }

  /** is this id a known person (a connection or a captured contact)? */
  knownPerson(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM people WHERE id = ? UNION ALL SELECT 1 FROM contacts WHERE id = ? LIMIT 1').get(id, id));
  }

  /** add people (new ones only; existing members keep their settings unless `patch` is given) → ids actually added */
  addMembers(accountId: string, ids: string[], patch: MemberPatch = {}): { added: string[]; already: string[]; unknown: string[] } {
    if (!this.get(accountId)) throw new AccountError('no such account');
    const v = this.validateMember(accountId, patch);
    const added: string[] = [];
    const already: string[] = [];
    const unknown: string[] = [];
    this.tx(() => {
      const t = now();
      for (const id of ids) {
        if (!this.knownPerson(id)) {
          unknown.push(id);
          continue;
        }
        const exists = this.db.prepare('SELECT 1 FROM account_members WHERE account_id = ? AND person_id = ?').get(accountId, id);
        if (exists) {
          already.push(id);
          if (Object.keys(v).length) this.patchMemberRaw(accountId, id, v, t);
          continue;
        }
        this.db
          .prepare(`INSERT INTO account_members (account_id, person_id, department, tier, role, reports_to, notes, added_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(accountId, id, v.department ?? '', v.tier ?? '', v.role ?? '', v.reportsTo ?? '', v.notes ?? '', t, t);
        added.push(id);
      }
      if (added.length || already.length) this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(t, accountId);
    });
    return { added, already, unknown };
  }

  private validateMember(accountId: string, p: MemberPatch, selfId?: string): MemberPatch {
    const out: MemberPatch = {};
    if (p.department !== undefined) {
      if (p.department !== '' && !DEPARTMENTS.includes(p.department)) throw new AccountError(`department must be one of: ${DEPARTMENTS.join(', ')} (or "" for automatic)`);
      out.department = p.department;
    }
    if (p.tier !== undefined) {
      if (p.tier !== '' && !TIERS.includes(p.tier)) throw new AccountError(`tier must be one of: ${TIERS.join(', ')} (or "" for automatic)`);
      out.tier = p.tier;
    }
    if (p.role !== undefined) {
      if (p.role !== '' && !COMMITTEE_ROLES.includes(p.role)) throw new AccountError(`role must be one of: ${COMMITTEE_ROLES.join(', ')} (or "" for none)`);
      out.role = p.role;
    }
    if (p.reportsTo !== undefined) {
      const r = String(p.reportsTo);
      if (r) {
        if (r === selfId) throw new AccountError('someone can’t report to themselves');
        if (!this.db.prepare('SELECT 1 FROM account_members WHERE account_id = ? AND person_id = ?').get(accountId, r)) {
          throw new AccountError('reportsTo must be another person on this account');
        }
        // no cycles: walk up from the proposed manager
        let cur = r;
        for (let i = 0; i < 100 && cur; i++) {
          if (cur === selfId) throw new AccountError('that would make a reporting loop');
          cur = str((this.db.prepare('SELECT reports_to FROM account_members WHERE account_id = ? AND person_id = ?').get(accountId, cur) as Row | undefined)?.reports_to);
        }
      }
      out.reportsTo = r;
    }
    if (p.notes !== undefined) {
      const n = String(p.notes);
      if (n.length > LIMITS.notes) throw new AccountError(`notes are too long (max ${LIMITS.notes.toLocaleString()} chars)`);
      out.notes = n;
    }
    return out;
  }

  private patchMemberRaw(accountId: string, id: string, v: MemberPatch, t: string): void {
    const sets: string[] = [];
    const args: string[] = [];
    const col = { department: 'department', tier: 'tier', role: 'role', reportsTo: 'reports_to', notes: 'notes' } as const;
    for (const [k, c] of Object.entries(col) as [keyof MemberPatch, string][]) {
      if (v[k] !== undefined) {
        sets.push(`${c} = ?`);
        args.push(String(v[k]));
      }
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE account_members SET ${sets.join(', ')}, updated_at = ? WHERE account_id = ? AND person_id = ?`).run(...args, t, accountId, id);
  }

  updateMember(accountId: string, id: string, p: MemberPatch): AccountMemberRow {
    if (!this.db.prepare('SELECT 1 FROM account_members WHERE account_id = ? AND person_id = ?').get(accountId, id)) {
      throw new AccountError('that person isn’t on this account');
    }
    const v = this.validateMember(accountId, p, id);
    const t = now();
    this.tx(() => {
      this.patchMemberRaw(accountId, id, v, t);
      this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(t, accountId);
    });
    return this.members(accountId).find((m) => m.personId === id)!;
  }

  removeMember(accountId: string, id: string): boolean {
    return this.tx(() => {
      const n = this.db.prepare('DELETE FROM account_members WHERE account_id = ? AND person_id = ?').run(accountId, id).changes;
      if (n) {
        // anyone who reported to them now has no known manager
        this.db.prepare("UPDATE account_members SET reports_to = '' WHERE account_id = ? AND reports_to = ?").run(accountId, id);
        this.db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(now(), accountId);
      }
      return n > 0;
    });
  }
}
