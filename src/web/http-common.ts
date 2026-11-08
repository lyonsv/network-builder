import { createHash, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Shared plumbing for the local (127.0.0.1-only, token-protected) servers. */

export const MAX_BODY = 1024 * 1024;
export const MAX_IDS = 10_000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Deterministic port in 47000–47999 for a key (report stem / db path), so reopening lands on the same origin
 * (browser localStorage prefs are per origin).
 */
export function stablePortFor(key: string): number {
  return 47000 + (createHash('sha1').update(key).digest().readUInt32BE(0) % 1000);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function parseIds(v: unknown, required: boolean): string[] | undefined {
  if (v === undefined && !required) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new HttpError(400, '`ids` must be an array of strings');
  if (v.length > MAX_IDS) throw new HttpError(400, `too many ids (max ${MAX_IDS})`);
  return [...new Set(v as string[])];
}

export const isAbortError = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

export const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

/** DNS-rebinding + cross-site protection: Host must be ours; an Origin, if sent, must be ours too. */
export function checkHostAndOrigin(req: IncomingMessage, port: number): void {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowed.has(req.headers.host ?? '')) throw new HttpError(403, 'bad host');
  const origin = req.headers.origin;
  if (origin && !allowed.has(origin.replace(/^http:\/\//, ''))) throw new HttpError(403, 'foreign origin');
}

/**
 * Requests from the Chrome extension (its background service worker): Host must be ours; the Origin, if sent, must be
 * a chrome-extension:// origin. Authorisation is the long-lived capture token (checked by the caller), never the
 * per-session page token.
 */
export function checkExtensionRequest(req: IncomingMessage, port: number): void {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowed.has(req.headers.host ?? '')) throw new HttpError(403, 'bad host');
  const origin = req.headers.origin;
  if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw new HttpError(403, 'foreign origin');
}

/** Listen on 127.0.0.1: exact `port`, else `preferredPort` falling back to a random free port. */
export async function listenLocal(server: http.Server, opts: { port?: number; preferredPort?: number }): Promise<number> {
  const listen = (p: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
  if (opts.port) await listen(opts.port);
  else if (opts.preferredPort) {
    try {
      await listen(opts.preferredPort);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw e;
      await listen(0);
    }
  } else await listen(0);
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}
