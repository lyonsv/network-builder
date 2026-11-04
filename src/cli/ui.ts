import boxen from 'boxen';
import gradient from 'gradient-string';
import pc from 'picocolors';

const brand = gradient(['#7F5AF0', '#2CB1BC', '#2CB67D']);

const LOGO = String.raw`
 _ __   ___| |___      _____  _ __| | __
| '_ \ / _ \ __\ \ /\ / / _ \| '__| |/ /
| | | |  __/ |_ \ V  V / (_) | |  |   <
|_| |_|\___|\__| \_/\_/ \___/|_|  |_|\_\
           b u i l d e r`;

export function banner(): void {
  const wide = (process.stdout.columns ?? 80) >= 48;
  const title = wide ? brand.multiline(LOGO.slice(1)) : brand('network-builder');
  console.log(
    boxen(`${title}\n\n${pc.dim('import')} ${pc.cyan('→')} ${pc.dim('profile')} ${pc.cyan('→')} ${pc.dim('explore')}`, {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      margin: { top: 1, bottom: 0, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: 'cyan',
      textAlignment: 'center',
    }),
  );
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function colorScore(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return pc.dim('–');
  const s = String(Math.round(n));
  if (n >= 80) return pc.green(pc.bold(s));
  if (n >= 50) return pc.yellow(s);
  return pc.dim(s);
}
