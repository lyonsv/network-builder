import { AccountError, type AccountsRepo } from '../db/accounts';
import { normalizeCompany, parseCapture } from './capture';
import { COMMITTEE_ROLES, type Account, type CapturePayload, type CommitteeRole, type Contact } from './types';

export interface CaptureRequest {
  profile: CapturePayload;
  /** an existing account id; wins over accountName */
  accountId?: string;
  /** an account name: matched to an existing account (name / alias), else created */
  accountName?: string;
  role?: CommitteeRole | '';
  notes?: string;
}

export interface CaptureResult {
  account: Account;
  contact: Contact;
  isConnection: boolean;
  createdAccount: boolean;
  /** false when they were already on the account (the profile is refreshed either way) */
  addedToAccount: boolean;
  firstCapture: boolean;
}

/** Save a LinkedIn capture and file the person under an account. Free and local: no AI runs here. */
export function ingestCapture(repo: AccountsRepo, req: CaptureRequest): CaptureResult {
  const profile = parseCapture(req.profile);
  const role = req.role ?? '';
  if (role && !COMMITTEE_ROLES.includes(role)) throw new AccountError(`role must be one of: ${COMMITTEE_ROLES.join(', ')}`);

  let account: Account | undefined;
  let createdAccount = false;
  if (req.accountId) {
    account = repo.get(req.accountId);
    if (!account) throw new AccountError('that account no longer exists — pick another one');
  } else {
    const name = (req.accountName ?? '').replace(/\s+/g, ' ').trim();
    account = name ? repo.find(name) : repo.match(profile.company, profile.companyUrl);
    if (!account) {
      const newName = name || profile.company;
      if (!newName) throw new AccountError('no company on this profile — type an account name');
      const sameCompany = normalizeCompany(newName) === normalizeCompany(profile.company);
      account = repo.create({ name: newName, ...(sameCompany && profile.companyUrl && !repo.match('', profile.companyUrl) ? { linkedinUrl: profile.companyUrl } : {}) });
      createdAccount = true;
    }
  }
  if (!createdAccount && profile.companyUrl && [account.name, ...account.aliases].some((n) => normalizeCompany(n) === normalizeCompany(profile.company))) {
    repo.fillBlanks(account.id, { linkedinUrl: profile.companyUrl });
  }

  const saved = repo.saveContact(profile);
  const existing = repo.members(account.id).find((m) => m.personId === saved.contact.id);
  const notes = (req.notes ?? '').trim();
  const patch: { role?: CommitteeRole | ''; notes?: string } = {};
  if (role) patch.role = role;
  if (notes) patch.notes = existing?.notes.trim() && !existing.notes.includes(notes) ? `${existing.notes.trim()}\n${notes}` : notes;
  const r = repo.addMembers(account.id, [saved.contact.id], patch);
  repo.touch(account.id);
  return {
    account: repo.get(account.id)!,
    contact: saved.contact,
    isConnection: saved.isConnection,
    createdAccount,
    addedToAccount: r.added.length > 0,
    firstCapture: saved.created,
  };
}
