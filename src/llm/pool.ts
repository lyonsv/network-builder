import pLimit from 'p-limit';

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Map items with bounded concurrency, preserving order.
 * Once `signal` aborts, no new items are started and the promise rejects with an AbortError
 * (after in-flight items settle, so their side effects such as cache writes complete).
 */
export async function mapWithConcurrency<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I, index: number) => Promise<O>,
  signal?: AbortSignal,
): Promise<O[]> {
  const limit = pLimit(Math.max(1, Math.floor(concurrency) || 1));
  const settled = await Promise.allSettled(
    items.map((item, index) =>
      limit(async () => {
        if (signal?.aborted) throw abortError(signal);
        return fn(item, index);
      }),
    ),
  );
  if (signal?.aborted) throw abortError(signal);
  const out: O[] = [];
  for (const r of settled) {
    if (r.status === 'rejected') throw r.reason;
    out.push(r.value);
  }
  return out;
}
