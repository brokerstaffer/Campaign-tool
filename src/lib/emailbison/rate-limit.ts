/*
 * A concurrency gate and retry policy for EmailBison calls.
 *
 * EmailBison's rate limits are undocumented (open question Q1), so this is
 * deliberately conservative: the nightly day-stats job makes ~550 calls and the
 * 90-day backfill makes ~16,500. Getting throttled mid-backfill and having to
 * restart is the failure this prevents.
 *
 * No dependency — a semaphore and a sleep is the whole thing.
 */

const MAX_CONCURRENCY = 4;
const MIN_INTERVAL_MS = 150; // floor between request STARTS, not completions
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Gate {
  private active = 0;
  private lastStart = 0;
  private queue: Array<() => void> = [];

  private release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENCY) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;

    const wait = this.lastStart + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStart = Date.now();

    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const gate = new Gate();

export interface RetryableError {
  statusCode?: number;
  retryAfterMs?: number;
}

/**
 * Runs `fn` through the gate, retrying on 429 and 5xx.
 *
 * Deliberately does NOT retry other 4xx: a 422 is a real answer about the
 * request, and retrying it just burns quota to get the same rejection.
 */
export async function limited<T>(
  fn: () => Promise<T>,
  isRetryable: (error: unknown) => RetryableError | null,
): Promise<T> {
  let attempt = 0;

  for (;;) {
    try {
      return await gate.run(fn);
    } catch (error) {
      attempt++;
      const retryable = isRetryable(error);
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;

      // Honour Retry-After when the server sent one; otherwise exponential
      // backoff with jitter so parallel workers don't resynchronise.
      const backoff =
        retryable.retryAfterMs ??
        500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);

      await sleep(backoff);
    }
  }
}
