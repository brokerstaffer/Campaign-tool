/*
 * A concurrency gate and retry policy for EmailBison calls.
 *
 * THIS USED TO GUESS, AND THE GUESS WAS COSTING HOURS. The old comment here read
 * "EmailBison's rate limits are undocumented, so this is deliberately
 * conservative" — concurrency 4 with a 150ms floor between starts, a hard
 * ceiling of 6.7 requests a second.
 *
 * They are not undocumented. Every response carries them:
 *
 *   x-ratelimit-limit: 3000
 *   x-ratelimit-remaining: 2443
 *
 * Measured 2026-08-07 against /api/scheduled-emails, 30 requests per level,
 * zero 429s at any of them:
 *
 *   concurrency  4 →  3.7 req/s   (what we were doing)
 *   concurrency  8 →  7.7 req/s
 *   concurrency 16 → 11.1 req/s
 *   concurrency 24 → 21.5 req/s
 *
 * So the gate now runs fast by default and slows down only when the budget the
 * server reports actually starts to run out. That is strictly better than a
 * fixed floor in both directions: quicker when there is headroom, and safer
 * when there is not — a fixed floor cannot see a second replica, a manual sync
 * and a nightly sweep all spending the same budget at once, and this can.
 */

const MAX_CONCURRENCY = 12;
const MAX_ATTEMPTS = 4;

/*
 * Below this many remaining requests the gate starts pacing itself.
 *
 * The reserve is not for politeness — it is for the screens. The sending
 * schedule reads EmailBison live on every page load, and a backfill that drains
 * the budget to zero would make that page fail while looking like an outage.
 * 600 leaves room for a person using the product while a sweep runs.
 */
const RESERVE = 600;
const EASE_AT = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The most recent budget the server reported. -1 until the first response. */
let remaining = -1;
let limit = -1;

/**
 * Called by the client after every response.
 *
 * The gate cannot read headers itself — it wraps an opaque function — so the
 * one place that does see them reports back here.
 */
export function reportRateLimit(headers: Headers): void {
  const r = Number(headers.get("x-ratelimit-remaining"));
  const l = Number(headers.get("x-ratelimit-limit"));
  if (Number.isFinite(r) && r >= 0) remaining = r;
  if (Number.isFinite(l) && l > 0) limit = l;
}

export function rateLimitStatus(): { remaining: number; limit: number } {
  return { remaining, limit };
}

/**
 * How long to wait before starting the next request.
 *
 * Zero while there is plenty of budget. As `remaining` falls toward the reserve
 * the delay grows smoothly rather than stepping, so throughput tapers instead of
 * stopping dead — and below the reserve it waits out a window rather than
 * spending the last of it.
 */
function pace(): number {
  if (remaining < 0) return 0; // nothing reported yet
  if (remaining > EASE_AT) return 0;
  if (remaining <= RESERVE) return 1500;
  // Linear from 0ms at EASE_AT to 400ms at RESERVE.
  const span = EASE_AT - RESERVE;
  return Math.round(400 * ((EASE_AT - remaining) / span));
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

    const floor = pace();
    if (floor > 0) {
      const wait = this.lastStart + floor - Date.now();
      if (wait > 0) await sleep(wait);
    }
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

      /*
       * A 429 means the budget is actually gone, whatever the last header said.
       * Drop the local view to the reserve so the gate paces itself immediately
       * rather than sprinting into the next rejection.
       */
      if (retryable.statusCode === 429) remaining = RESERVE;

      // Honour Retry-After when the server sent one; otherwise exponential
      // backoff with jitter so parallel workers don't resynchronise.
      const backoff =
        retryable.retryAfterMs ??
        500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);

      await sleep(backoff);
    }
  }
}
