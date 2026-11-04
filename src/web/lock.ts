import { open, readFile, unlink } from 'node:fs/promises';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LockResult = { ok: true; release: () => Promise<void> } | { ok: false; pid: number };

/**
 * Exclusive lock file holding our pid. A lock left by a dead process is replaced; a lock held by a live
 * process is reported so the caller can refuse to start a second server on the same report.
 */
export async function acquireLock(lockPath: string): Promise<LockResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fh = await open(lockPath, 'wx');
      try {
        await fh.writeFile(String(process.pid));
      } finally {
        await fh.close();
      }
      return {
        ok: true,
        release: async () => {
          try {
            if ((await readFile(lockPath, 'utf8')).trim() === String(process.pid)) await unlink(lockPath);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) return { ok: false, pid };
      await unlink(lockPath).catch(() => {}); // stale (dead pid / garbage) → replace
    }
  }
  return { ok: false, pid: 0 };
}

export interface ShutdownGate {
  /** resolves with the signal name on the first SIGINT / SIGTERM / SIGHUP */
  requested: Promise<NodeJS.Signals>;
  isRequested(): boolean;
  dispose(): void;
}

/** First signal requests a graceful shutdown; a second one force-quits (exit 130). */
export function installShutdown(): ShutdownGate {
  let resolve!: (s: NodeJS.Signals) => void;
  let fired = false;
  const requested = new Promise<NodeJS.Signals>((r) => (resolve = r));
  const handlers: [NodeJS.Signals, () => void][] = [];
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
    const h = () => {
      if (fired) process.exit(130);
      fired = true;
      resolve(sig);
    };
    process.on(sig, h);
    handlers.push([sig, h]);
  }
  return {
    requested,
    isRequested: () => fired,
    dispose: () => {
      for (const [s, h] of handlers) process.off(s, h);
    },
  };
}
