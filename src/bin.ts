#!/usr/bin/env node
// Entry point: check the Node version BEFORE loading anything that needs node:sqlite (Node ≥ 22.13), so people on an
// older Node get a clear message instead of a module-not-found stack trace.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `network-builder needs Node.js 22.13 or newer (you have ${process.versions.node}).\n` +
      'Install the current LTS from https://nodejs.org (or `nvm install --lts`), then run it again.',
  );
  process.exit(1);
}

// node:sqlite prints an "ExperimentalWarning" on some Node versions; it's expected here, so keep the terminal clean.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning as Error)?.name;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(msg)) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

await import('./index');
export {};
