import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { DEFAULTS, type ClaudeCallOptions, type ClaudeCliJson, type ClaudeResult } from '../types';

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly details: {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      /** spend across all attempts so far (known part) */
      costUsd?: number;
      /** true when some spend is unknown (a timed-out or killed call), so costUsd is a lower bound */
      costIncomplete?: boolean;
      retryable?: boolean;
      timedOut?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/** Env for the subprocess: inherit everything except ANTHROPIC_API_KEY so Claude Code uses the user's login. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ANTHROPIC_API_KEY') env[k] = v;
  }
  return env;
}

let workDirPromise: Promise<string> | undefined;
/** Neutral cwd so subprocesses don't pick up a project CLAUDE.md. Created lazily once. */
function workDir(): Promise<string> {
  workDirPromise ??= mkdtemp(path.join(os.tmpdir(), 'network-builder-'));
  return workDirPromise;
}

export async function checkClaudeAvailable(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const r = await execa('claude', ['--version'], { env: childEnv(), extendEnv: false, timeout: 30_000, reject: false });
    if (r.exitCode === 0) return { ok: true, version: String(r.stdout).trim() };
    return { ok: false, error: String(r.stderr || r.stdout || `exit code ${r.exitCode}`).trim() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Whether the Claude Code CLI is logged in (`claude auth status`). `undefined` when the CLI can't tell us. */
export async function checkClaudeLogin(): Promise<{ loggedIn?: boolean; method?: string }> {
  try {
    const r = await execa('claude', ['auth', 'status'], { env: childEnv(), extendEnv: false, timeout: 30_000, reject: false });
    const j = JSON.parse(String(r.stdout).trim()) as { loggedIn?: boolean; authMethod?: string };
    return { loggedIn: typeof j.loggedIn === 'boolean' ? j.loggedIn : undefined, method: j.authMethod };
  } catch {
    return {};
  }
}

/** built-in tools that MCP-only calls must never use */
const BUILTIN_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'];

export function buildArgs(opts: ClaudeCallOptions): string[] {
  const { model, jsonSchema, tools, mcpTools, appendSystemPrompt } = opts;
  const base = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(jsonSchema),
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    ...(appendSystemPrompt ? ['--append-system-prompt', appendSystemPrompt] : []),
  ];
  // MCP calls (e.g. the user's Ahoy connector): load their MCP config, allow only the named tools, no built-ins.
  // (`--tools ""` would hide MCP tools too, and --strict-mcp-config would hide claude.ai connectors.)
  if (mcpTools?.length) return [...base, '--disallowedTools', ...BUILTIN_TOOLS, '--allowedTools', ...mcpTools];
  return [
    ...base,
    '--strict-mcp-config',
    // variadic flags LAST so they can't swallow other args
    ...(tools?.length ? ['--allowedTools', ...tools, '--tools', tools.join(',')] : ['--tools', '']),
  ];
}

function parseCliJson(stdout: string): ClaudeCliJson | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as ClaudeCliJson;
  } catch {
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line.startsWith('{')) continue;
      try {
        return JSON.parse(line) as ClaudeCliJson;
      } catch {
        /* keep scanning */
      }
    }
  }
  return undefined;
}

function tryParseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
  }
  return undefined;
}

// Only matched against CLI-generated error text (stderr / is_error results), never model output.
const RETRYABLE_RE =
  /rate.?limit|overloaded|\b(?:429|500|502|503|504|529)\b|timed? ?out|ECONNRESET|ETIMEDOUT|socket hang up|temporarily unavailable/i;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** AbortError that still carries the spend so far (as a ClaudeError so callers can read details.costUsd). */
function makeAbortError(costUsd = 0, costIncomplete = false): ClaudeError {
  const err = new ClaudeError('Aborted', { costUsd, costIncomplete, retryable: false });
  err.name = 'AbortError';
  return err;
}

/** Spend attached to any error thrown by runClaude (including aborts). */
export function errorCost(e: unknown): { usd: number; incomplete: boolean } {
  if (e instanceof ClaudeError) return { usd: e.details.costUsd ?? 0, incomplete: Boolean(e.details.costIncomplete) };
  return { usd: 0, incomplete: false };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(makeAbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(makeAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function runOnce<T>(opts: ClaudeCallOptions, timeoutMs: number): Promise<ClaudeResult<T>> {
  const started = Date.now();
  const r = await execa('claude', buildArgs(opts), {
    input: opts.prompt,
    cwd: await workDir(),
    env: childEnv(),
    extendEnv: false,
    timeout: timeoutMs,
    cancelSignal: opts.signal,
    forceKillAfterDelay: 5000,
    reject: false,
    maxBuffer: 50_000_000,
  });

  // killed mid-flight: whatever it spent is unknown
  if (r.isCanceled || opts.signal?.aborted) throw makeAbortError(0, true);

  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '');

  // Could not spawn at all (ENOENT/EACCES…): no exit code. Retrying won't help.
  if (r.failed && r.exitCode === undefined && !r.timedOut) {
    throw new ClaudeError(`could not run claude: ${String((r as { shortMessage?: string }).shortMessage ?? r.message ?? 'spawn failed').slice(0, 300)}`, {
      stderr, retryable: false,
    });
  }

  if (r.timedOut) {
    throw new ClaudeError(`claude timed out after ${Math.round(timeoutMs / 1000)}s`, {
      exitCode: r.exitCode, stderr, stdout: stdout.slice(0, 2000), retryable: true, timedOut: true, costIncomplete: true,
    });
  }

  const json = parseCliJson(stdout);
  const costUsd = json?.total_cost_usd ?? 0;

  if (!json) {
    // e.g. auth failure printed to stderr: only retry when it looks transient
    throw new ClaudeError(`claude returned no parseable JSON (exit ${r.exitCode}): ${(stderr || stdout).slice(0, 500)}`, {
      exitCode: r.exitCode, stderr, stdout: stdout.slice(0, 2000), costUsd, retryable: RETRYABLE_RE.test(stderr),
    });
  }

  if (json.is_error || r.exitCode !== 0) {
    const msg = (json.result || stderr || json.subtype || `exit code ${r.exitCode}`).toString().slice(0, 500);
    // When is_error is set, `result` is CLI-generated error text (e.g. "API Error: 529 …"), not model output.
    const errText = `${json.is_error ? (json.result ?? '') : ''}\n${json.subtype === 'success' ? '' : (json.subtype ?? '')}\n${stderr}`;
    throw new ClaudeError(`claude error: ${msg}`, {
      exitCode: r.exitCode, stderr, stdout: stdout.slice(0, 2000), costUsd,
      retryable: RETRYABLE_RE.test(errText),
    });
  }

  const data = json.structured_output ?? tryParseJson(json.result);
  if (data === undefined || data === null) {
    throw new ClaudeError('claude returned no structured output', {
      exitCode: r.exitCode, stderr, stdout: stdout.slice(0, 2000), costUsd, retryable: true,
    });
  }

  return {
    data: data as T,
    costUsd,
    durationMs: json.duration_ms ?? Date.now() - started,
    rawResult: json.result ?? '',
  };
}

/**
 * Run `claude -p` as a subprocess with a JSON schema and return the structured output.
 * Retries on rate limits / overload / timeouts / parse failures. Never retries on abort.
 * The returned costUsd includes the cost of failed attempts; on final failure the accumulated
 * cost is on `ClaudeError.details.costUsd`.
 */
export async function runClaude<T>(opts: ClaudeCallOptions): Promise<ClaudeResult<T>> {
  const retries = opts.retries ?? DEFAULTS.retries;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.researchTimeoutMs;
  let spent = 0;
  let incomplete = false;
  let timeouts = 0;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw makeAbortError(spent, incomplete);
    try {
      const res = await runOnce<T>(opts, timeoutMs);
      return { ...res, costUsd: res.costUsd + spent, ...(incomplete ? { costIncomplete: true } : {}) };
    } catch (e) {
      const { usd, incomplete: inc } = errorCost(e);
      spent += usd;
      incomplete ||= inc;
      if (isAbortError(e) || opts.signal?.aborted) throw makeAbortError(spent, true);
      lastErr = e;
      const ce = e instanceof ClaudeError ? e : undefined;
      // unknown errors (bugs, spawn issues) are not retried
      let retryable = ce ? ce.details.retryable !== false : false;
      // a timed-out call may have burned a full timeout of spend: retry it at most once
      if (ce?.details.timedOut && ++timeouts > 1) retryable = false;
      if (!retryable || attempt === retries) break;
      const backoff = 2000 * 3 ** attempt + Math.floor(Math.random() * 1000);
      try {
        await sleep(backoff, opts.signal);
      } catch {
        throw makeAbortError(spent, incomplete);
      }
    }
  }

  if (lastErr instanceof ClaudeError) {
    lastErr.details.costUsd = spent;
    lastErr.details.costIncomplete = incomplete;
    throw lastErr;
  }
  throw new ClaudeError((lastErr as Error)?.message ?? 'claude failed', { costUsd: spent, costIncomplete: incomplete });
}
