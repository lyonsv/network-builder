import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { expandHome } from '../types';

export const isInteractive = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

function bail<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) {
    p.cancel('Cancelled.');
    process.exit(130);
  }
  return v as Exclude<T, symbol>;
}

interface Candidate {
  file: string;
  mtime: number;
}

function findCsvCandidates(): Candidate[] {
  const dirs = [path.join(os.homedir(), 'Downloads'), process.cwd()];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/\.csv$/i.test(name)) continue;
      const file = path.join(dir, name);
      if (seen.has(file)) continue;
      seen.add(file);
      try {
        const st = statSync(file);
        if (st.isFile()) out.push({ file, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  // prefer files that look like LinkedIn exports, then newest
  return out
    .sort((a, b) => {
      const ac = /connections.*\.csv$/i.test(path.basename(a.file)) ? 1 : 0;
      const bc = /connections.*\.csv$/i.test(path.basename(b.file)) ? 1 : 0;
      return bc - ac || b.mtime - a.mtime;
    })
    .slice(0, 8);
}

const tildify = (f: string): string => {
  const home = os.homedir();
  return f.startsWith(home) ? `~${f.slice(home.length)}` : f;
};

async function askPath(): Promise<string> {
  const v = bail(
    await p.text({
      message: 'Path to your connections CSV',
      placeholder: '~/Downloads/Connections.csv',
      validate: (val) => {
        const s = (val ?? '').trim();
        if (!s) return 'Please enter a path';
        if (!existsSync(path.resolve(expandHome(s)))) return 'File not found';
        return undefined;
      },
    }),
  );
  return path.resolve(expandHome(v.trim()));
}

/** Ask for the connections CSV (TTY only): recent CSVs in ~/Downloads and the cwd, or a typed path. */
export async function promptForCsv(): Promise<string> {
  const candidates = findCsvCandidates();
  if (candidates.length === 0) return askPath();
  const MANUAL = '__manual__';
  const choice = bail(
    await p.select<string>({
      message: 'Which CSV of LinkedIn connections should I import?',
      options: [
        ...candidates.map((c) => ({
          value: c.file,
          label: path.basename(c.file),
          hint: `${tildify(path.dirname(c.file))} · ${new Date(c.mtime).toLocaleDateString()}`,
        })),
        { value: MANUAL, label: pc.italic('Enter a path…') },
      ],
    }),
  );
  return choice === MANUAL ? askPath() : choice;
}
