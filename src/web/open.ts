import { spawn } from 'node:child_process';

/** Open a URL in the default browser. Best effort: never throws, returns false if it couldn't try. */
export function openInBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
          : ['xdg-open', [url]];
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
