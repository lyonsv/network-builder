import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, writeFileAtomic } from './fs-utils';

export const DEFAULT_SIGNALS_MD = `# Research signals

These are the signals the research model looks for on each person. Each \`##\` heading
is one signal: the model returns one finding per heading, rated none / weak / moderate / strong.
Edit, add, or remove sections freely. Changing this file automatically invalidates
cached research on the next run.

Keep the goal from the run prompt in mind for every signal (e.g. "potential angel investors").

## 1. Who is this person? (basic web search)

Run a basic web search to establish who this person is.

- Search: \`"<full name>" "<company>"\`, \`"<full name>" <title>\`, and \`"<full name>" linkedin\`.
- Establish: current role and company, notable past roles, education, location, and
  any public profile (personal site, company bio page, Crunchbase, AngelList, Wikipedia, press).
- Disambiguate carefully: common names have many matches. Use company, title, and the LinkedIn
  URL slug to confirm it is the same person. If you cannot confirm, say so.

## 2. Direct relevance to the goal

Look for direct, public evidence that this person already does the thing the goal asks about.

- e.g. for investors: listed angel investments, syndicate leads, scout roles, LP positions,
  Crunchbase/AngelList investor profiles, "I invest in…" statements, portfolio pages.
- e.g. for advisors/hires/customers: board seats, advisory roles, buying authority, relevant expertise.
- Queries: \`"<full name>" angel investor\`, \`"<full name>" invested in\`, \`"<full name>" advisor board\`.

## 3. Capacity and seniority

Signals that they have the means, authority, or influence to act on the goal.

- Founder exits or acquisitions, IPOs, C-level / VP / partner roles, fund affiliations,
  large-company tenure with equity, family offices.

## 4. Recent activity (last 12 months)

What have they been doing publicly recently?

- News coverage, funding announcements, job changes, podcasts, conference talks,
  blog posts, newsletters, notable social posts.
- Note dates. Recent activity relevant to the goal is a strong timing signal.

## 5. Warm-intro angles and shared context

What would make outreach feel natural?

- Shared employers, schools, cities, communities, accelerators, or interests.
- Topics they care about publicly that relate to the goal.
- Mutual organisations or people mentioned alongside them.
`;

export function hashSignals(md: string): string {
  return createHash('sha1').update(md).digest('hex').slice(0, 12);
}

export async function ensureSignalsFile(
  filePath: string,
): Promise<{ path: string; content: string; created: boolean }> {
  let created = false;
  try {
    await access(filePath);
  } catch {
    await ensureDir(path.dirname(filePath));
    await writeFileAtomic(filePath, DEFAULT_SIGNALS_MD);
    created = true;
  }
  const content = await readFile(filePath, 'utf8');
  return { path: filePath, content, created };
}
