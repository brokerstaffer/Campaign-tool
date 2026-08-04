# CLAUDE.md

Guidance for working in this repo.

## Commands

```bash
npm run dev         # dev server (Turbopack)
npm run build       # production build; typecheck happens here
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run test        # node --test, no test framework needed
npm run probe       # read-only EmailBison endpoint prober (needs .env.local)
```

Tests are plain `node:test` files run directly against `.ts` — Node 24 strips
types natively, so there is no test runner, no transform, and no config. This is
why relative imports carry explicit `.ts` extensions and why
`allowImportingTsExtensions` is on in tsconfig.

## What this is

A campaign analytics dashboard over **EmailBison** (`send.brokerstaffer.com`).

The one architectural fact that explains most of the design:

> **EmailBison is the source of truth for every metric. Supabase is a cache.**

EmailBison serves true per-day series (`/api/campaign-events/stats`) and true
per-step range aggregates (`POST /api/campaigns/{id}/stats`). An earlier design
assumed it couldn't, and built a webhook pipeline plus a 3.3M-row/year
partitioned event table to reconstruct what the API already provides. **There
are no webhooks in this app** and no inbound write surface of any kind. Every
ingestion path is a cursor over an idempotent API, so re-running any job is
always safe. A missed webhook is gone forever; a missed poll window is just
re-fetched.

## Rules that are load-bearing

1. **`DASH` is the only way a nullish metric reaches the DOM.** Every formatter
   in `src/lib/analytics/format.ts` returns it for null/NaN/Infinity. Never
   render a bare `0` for "no data" — "no replies yet" and "replies answered
   instantly" must not look alike.

2. **The KPI band and tables format numbers differently, on purpose.**
   Band: `272.4K`, `3.7K` (compact, scannable). Tables: `272,389`, `3,679`
   (exact, comparable). `compactNumber` vs `fullNumber`.

3. **One authority per metric family.** Replies / Human Replies / Positive all
   come from local `replies` rows, never from the daily series — Human Replies
   has no EmailBison equivalent, and three numbers on the same tile row sourced
   two different ways will not add up.

4. **Filter state lives in the URL**, parsed by exactly one zod schema in
   `src/lib/analytics/query-params.ts`, shared by the client hook and every API
   route. If the client and server ever disagreed about what "7d" means, every
   number on the page would be subtly wrong and no test would catch it.

5. **`today` is injected, never read from the clock** inside anything testable.
   The server layout resolves it and passes it through `FiltersProvider`.

6. **Series colour follows the entity, never the rank.** `src/lib/analytics/series.ts`
   is the only place colours are defined; chips, chart, tooltip and legend all
   read from it. Deselecting Replies must not repaint Human.

7. **All aggregation happens in SQL**, never in JS over a `.select()`.
   PostgREST caps rows at 1000 and truncates silently. `count: 'exact'` on
   `replies` times out — use `'estimated'` or get counts from the RPC that
   already grouped.

8. **An outcome is only credited to a campaign the feed can prove is ours.**
   The outcomes feed's `campaign_id` holds an EmailBison integer, an *Instantly*
   UUID, or nothing. `classifyPlatform` in `src/lib/analytics/outcomes.ts` is the
   only place that is decided, and only `emailbison` may reach
   `resolved_campaign_id`. Resolving an Instantly row by email *succeeds* — the
   same people are in both systems — and credits one of our campaigns with
   another platform's result, which is the one failure this tab exists to
   prevent. It also fails upward: EmailBison looks better, so nobody checks.

9. **Client attribution is persisted, not recomputed.** `campaign_clients` holds
   the resolved mapping. Recomputing at read time would make every query do
   string matching, would let a manual override be silently undone, and would
   rewrite historical grouping when a client is renamed.

## Layout

```
src/lib/analytics/    metric contract: format, metrics, series, query-params
src/lib/emailbison/   client, types, daily-series adapter, rate limiter
src/components/analytics/  the dashboard surface
scripts/probe-eb.mjs  read-only prober; writes docs/eb-api-findings.md
```

`src/lib/emailbison/daily-series.ts` is deliberately the **only** place an
EmailBison daily-series URL or label appears. Swapping an endpoint is a one-line
change there and nothing else moves. An unmapped label is logged, never silently
dropped — that log line is the drift detector.

## Syncing

```
src/lib/sync/jobs.ts       the twelve jobs, as JobFn implementations
src/lib/sync/runner.ts     lock + run history + circuit breaker
src/lib/sync/schedule.ts   the cadence, as data
src/lib/sync/scheduler.ts  the in-process ticker
src/instrumentation.ts     starts the ticker at server boot
src/app/api/cron/[job]/    manual / external trigger, Bearer CRON_SECRET
src/app/api/sync/status/   health, behind session auth
```

The scheduler runs **in-process**, started from `instrumentation.ts`. Nothing
depends on it being the only caller: `runJob` holds a `sync_state.running_since`
lock, so the ticker, a manual `curl /api/cron/<job>`, and a second replica can
all fire at once and exactly one runs.

Four rules here are load-bearing:

1. **Every job is idempotent.** That is what makes a missed tick a non-event,
   and it is why this app has no webhooks. Re-running any job converges.
2. **A watermark advances only on success.** A failed run re-covers the same
   window next time rather than skipping it.
3. **Due-ness is computed from the wall clock by modulo, never from an interval
   counter.** A crash-looping deploy therefore cannot turn the 3-hourly job into
   a 30-second one.
4. **The schedule is checked by the compiler, both ways.** `schedule.ts` derives
   `JobName` from the registry via `import type`, so a scheduled name that isn't
   a job fails `satisfies`, and a job that is never scheduled fails the
   `Unscheduled extends never` assertion — with the missing job named in the
   error. Adding a job and forgetting to schedule it has no runtime symptom at
   all, which is exactly why it's a type error.

Frequent jobs are paired with a nightly `-deep` variant. The frequent one is
scoped to what changes (7 days of series, 3 days of stats, replies newer than
the watermark minus a 48h overlap); the deep one re-fetches a wide window
because EmailBison revises recent days after the fact. `sync-replies` full is
~600 calls / 90s; incremental is ~120 / 16s, which is what makes a 10-minute
cadence viable.

Staleness thresholds in `/api/sync/status` derive from each job's own cadence.
A flat threshold is wrong in both directions — it calls the nightly sweep broken
every afternoon and calls a dead 10-minute sync fine for hours.

## Known unknowns

`docs/eb-api-findings.md` is generated by `npm run probe` and is checked in. It
is the answer sheet for questions that change the schema — re-run the probe
rather than re-deriving them. Three of its answers (date timezone,
`total_leads_contacted` semantics, whether a single-day range returns step
stats) decide migrations 003 and 005. **Do not write those migrations before the
probe has run.**

One open discrepancy is documented in `src/lib/analytics/metrics.ts`: the
reference KPI band's Positive Rate (11.0%) is not `Positive / Replies` (10.57%),
though the reference *table* is. Read that comment before touching
`positiveRate`.

## Next.js 16 notes

- Middleware is `src/proxy.ts`, exporting `proxy()` — not `middleware.ts`.
- `cookies()` is async; route `params` and page `searchParams` are Promises.
- `eslint-config-next` ships native flat configs; `FlatCompat` throws here.
- The React Compiler lint rejects `setState` inside an effect. Seed state in the
  event handler instead (see `range-picker.tsx`).
