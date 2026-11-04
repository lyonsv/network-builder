import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readPeopleCsv } from '../io/csv';
import { checkClaudeAvailable, checkClaudeLogin } from '../llm/claude';
import { estimateLensUsd } from '../llm/lens';
import { promptForCsv } from './interactive';
import { formatUsd } from './ui';

export const EXPORTER_URL = 'https://github.com/lyonsv/chrome-linkedin-connections-exporter';
/** measured: headline profiles ≈ $0.39 per 2,075 people */
const PROFILE_USD_PER_PERSON = 0.0002;

/** Starter lenses offered on first run (goal text is what gets scored; be specific). */
export const STARTER_LENSES: { label: string; goal?: string; ask?: string }[] = [
  { label: 'Potential angel investors', goal: 'potential angel investors' },
  {
    label: 'Potential customers…',
    ask: 'Who buys what you sell? (roles, industries, company types)',
  },
  { label: 'Heads of marketing', goal: 'heads of marketing and senior marketing leaders' },
  { label: 'People who could help me hire', goal: 'recruiters, talent leaders and well-connected engineering managers' },
  { label: 'Journalists and media', goal: 'journalists, editors and producers at news and media organisations' },
  { label: 'Something else…', ask: 'Describe the list you want to build' },
];

const bail = <T>(v: T | symbol): T => {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled — run network-builder again any time.');
    process.exit(130);
  }
  return v as T;
};

async function ensureClaude(): Promise<boolean> {
  for (;;) {
    const cli = await checkClaudeAvailable();
    if (!cli.ok) {
      p.note(
        [
          'network-builder uses the Claude Code CLI for all AI work, through your own Claude login — no API key.',
          '',
          `  1. Install it:   ${pc.cyan('npm install -g @anthropic-ai/claude-code')}`,
          `  2. Log in:       run ${pc.cyan('claude')} once and follow the prompts`,
          '',
          'Usage counts against your Claude plan (Pro or Max) or Console account.',
        ].join('\n'),
        'Claude Code is not installed',
      );
    } else {
      const login = await checkClaudeLogin();
      if (login.loggedIn !== false) {
        p.log.success(`Claude Code ${pc.dim(cli.version ?? '')}${login.method ? pc.dim(` · logged in (${login.method})`) : ''}`);
        return true;
      }
      p.note(`Run ${pc.cyan('claude')} in another terminal and log in, then come back here.`, 'Claude Code is not logged in');
    }
    const next = bail(
      await p.select({
        message: 'Ready?',
        options: [
          { value: 'retry', label: 'Check again' },
          { value: 'exit', label: 'Exit (run network-builder again later)' },
        ],
      }),
    );
    if (next === 'exit') return false;
  }
}

function howToGetConnections(): void {
  p.note(
    [
      `${pc.bold('Option A — Chrome extension (minutes, includes connection dates)')}`,
      `  ${pc.cyan(EXPORTER_URL)}`,
      '  Load it unpacked (chrome://extensions → Developer mode → Load unpacked), open your',
      '  LinkedIn connections page, click the extension → Start export. Saves a CSV to Downloads.',
      '',
      `${pc.bold("Option B — LinkedIn's own export (arrives by email, includes company)")}`,
      '  LinkedIn → Settings → Data privacy → Get a copy of your data → Connections.',
      '  Unzip it and use Connections.csv.',
      '',
      `${pc.bold('Option C — any CSV')} with name and title columns (e.g. a lead list) also works.`,
    ].join('\n'),
    'Getting your connections',
  );
}

async function pickCsv(): Promise<{ path: string; count: number } | undefined> {
  for (;;) {
    const how = bail(
      await p.select({
        message: 'Import your LinkedIn connections',
        options: [
          { value: 'have', label: 'I have a CSV', hint: 'pick from ~/Downloads or enter a path' },
          { value: 'how', label: 'How do I get one?' },
          { value: 'exit', label: 'Exit' },
        ],
      }),
    );
    if (how === 'exit') return undefined;
    if (how === 'how') {
      howToGetConnections();
      continue;
    }
    const file = await promptForCsv();
    try {
      const { result } = await readPeopleCsv(file);
      if (!result.people.length) {
        p.log.error('No people found in that file. It needs a name column (Name, or First Name + Last Name) and ideally a title.');
        continue;
      }
      for (const w of result.warnings.slice(0, 2)) p.log.warn(w);
      return { path: file, count: result.people.length };
    } catch (e) {
      p.log.error(`Could not read that file: ${(e as Error).message}`);
    }
  }
}

async function pickGoal(): Promise<string | undefined> {
  const choice = bail(
    await p.select({
      message: 'What list do you want to build first? (you can add more lenses any time)',
      options: [
        ...STARTER_LENSES.map((l, i) => ({ value: String(i), label: l.label })),
        { value: 'skip', label: 'Skip — just explore my network' },
      ],
    }),
  );
  if (choice === 'skip') return undefined;
  const lens = STARTER_LENSES[Number(choice)]!;
  if (lens.goal) return lens.goal;
  const text = bail<string>(
    await p.text({
      message: lens.ask ?? 'Describe the list',
      placeholder: lens.label.startsWith('Potential customers')
        ? 'e.g. heads of finance at 50–500 person SaaS companies'
        : 'e.g. founders who have sold a company',
      validate: (v) => (v && v.trim().length >= 3 ? undefined : 'A few words, please'),
    }),
  );
  const t = text.replace(/\s+/g, ' ').trim();
  return lens.label.startsWith('Potential customers') ? `potential customers: ${t}` : t;
}

/**
 * First run (empty database, interactive terminal): welcome, check Claude Code, pick a CSV, pick a starter lens,
 * confirm the estimated spend. Returns what runExplore should do, or undefined to exit.
 */
export async function runSetup(dataHome: string): Promise<{ inputPath: string; goal?: string } | undefined> {
  p.note(
    [
      'Turn your LinkedIn connections into lists you can act on — angel investors, potential',
      'customers, people to hire — scored by AI and refined by you.',
      '',
      `  1. Import your connections (a CSV)`,
      `  2. Pick a goal ("lens") — everyone gets a 0–100 fit score with a reason`,
      `  3. Review in your browser: add/remove people, look up the ones you care about, export to CSV`,
      '',
      `Everything stays on this computer, in ${pc.cyan(dataHome)}.`,
    ].join('\n'),
    'Welcome to network-builder',
  );
  if (!(await ensureClaude())) return undefined;
  const csv = await pickCsv();
  if (!csv) {
    p.outro('Come back with a CSV: network-builder import <file.csv>');
    return undefined;
  }
  const goal = await pickGoal();
  const profileUsd = csv.count * PROFILE_USD_PER_PERSON;
  const lensUsd = goal ? estimateLensUsd(csv.count, 150) : 0;
  const lines = [
    `Import ${pc.bold(csv.count.toLocaleString())} people and read their headlines (role, seniority, industry)   ≈ ${formatUsd(profileUsd)}`,
    ...(goal ? [`Score everyone for “${goal}”, re-checking the top 150 more carefully   ≈ ${formatUsd(lensUsd)}`] : []),
    '',
    pc.dim('Estimates in API-equivalent dollars; on a Claude subscription this counts against your plan limits.'),
    pc.dim('Web lookups on individual people only ever run when you start them in the explorer.'),
  ];
  p.note(lines.join('\n'), 'Ready to go');
  const ok = bail(await p.confirm({ message: 'Start?', initialValue: true }));
  if (!ok) {
    p.outro(`Nothing was done. Later: network-builder import ${csv.path}`);
    return undefined;
  }
  return { inputPath: csv.path, goal };
}
