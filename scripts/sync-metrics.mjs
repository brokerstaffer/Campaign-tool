#!/usr/bin/env node
/*
 * sync-metrics.mjs — fills eb_daily_series, campaign_day_stats and
 * campaign_step_stats_daily. This is what gives the KPI band and the charts
 * something to draw.
 *
 *   node --env-file=.env.local scripts/sync-metrics.mjs --days=7          # dry run
 *   node --env-file=.env.local scripts/sync-metrics.mjs --days=7 --apply
 *
 * Two very different cost profiles, which is why they're separate flags:
 *
 *   daily series  — each call returns the WHOLE range, so a year costs the same
 *                   as a week: 1 workspace call + 1 per campaign (~96 total).
 *                   Always run for the full window.
 *   day stats     — one call per campaign PER DAY (~95/day). 30 days is ~2,850
 *                   calls. Bounded by --days, default 7.
 */

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const DAYS = Number(
  (process.argv.find((a) => a.startsWith("--days=")) || "--days=7").split("=")[1],
);
const SERIES_DAYS = Number(
  (process.argv.find((a) => a.startsWith("--series-days=")) || "--series-days=120").split("=")[1],
);
const TEAM_ID = Number(process.env.EMAILBISON_TEAM_ID || 2);

const EB = (process.env.EMAILBISON_BASE_URL || "").replace(/\/$/, "");
const KEY = process.env.EMAILBISON_API_KEY;

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// EmailBison label -> our metric key. An unmapped label is reported, never
// silently dropped: that warning is how we find out EmailBison added a series.
const METRIC_BY_LABEL = {
  Sent: "sent",
  Replied: "replies",
  Bounced: "bounces",
  Unsubscribed: "unsubscribes",
  Interested: "positive",
  "Total Opens": "opens_total",
  "Unique Opens": "opens_unique",
};

const isoDaysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
async function eb(path, init) {
  calls++;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${EB}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...init?.headers,
      },
    });
    if (response.ok) return response.json();
    // Retry only on throttling and server faults; a 4xx is a real answer.
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(`EmailBison ${response.status} on ${path}`);
  }
}

/** Runs tasks with a concurrency cap — EmailBison's rate limits are undocumented. */
async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

const TO = isoDaysAgo(0);
const SERIES_FROM = isoDaysAgo(SERIES_DAYS - 1);
const STATS_DAYS = Array.from({ length: DAYS }, (_, i) => isoDaysAgo(i));

console.log(
  `${APPLY ? "APPLYING" : "DRY RUN"} — team ${TEAM_ID}\n` +
    `  daily series : ${SERIES_FROM} .. ${TO}\n` +
    `  day stats    : ${STATS_DAYS[STATS_DAYS.length - 1]} .. ${TO} (${DAYS} days)\n`,
);

const { data: campaigns } = await sb
  .from("campaigns")
  .select("id, name, lifetime_emails_sent")
  .eq("team_id", TEAM_ID);
console.log(`  ${campaigns.length} campaigns in scope\n`);

// --- 1. daily series ---------------------------------------------------------
// campaign_id 0 is the workspace roll-up, so the unfiltered chart reads one row
// per day instead of summing 95.

const seriesRows = [];
const unmappedLabels = new Set();

function collect(payload, campaignId) {
  for (const series of payload?.data ?? []) {
    const metric = METRIC_BY_LABEL[series.label];
    if (!metric) {
      unmappedLabels.add(series.label);
      continue;
    }
    for (const [date, value] of series.dates ?? []) {
      if (typeof date !== "string" || !Number.isFinite(Number(value))) continue;
      seriesRows.push({
        team_id: TEAM_ID,
        campaign_id: campaignId,
        stat_date: date,
        metric,
        value: Number(value),
      });
    }
  }
}

collect(
  await eb(
    `/api/workspaces/v1.1/line-area-chart-stats?start_date=${SERIES_FROM}&end_date=${TO}`,
  ),
  0,
);

await pool(campaigns, 4, async (campaign) => {
  try {
    collect(
      await eb(
        `/api/campaigns/${campaign.id}/line-area-chart-stats?start_date=${SERIES_FROM}&end_date=${TO}`,
      ),
      campaign.id,
    );
  } catch (error) {
    // One bad campaign must not abort the sweep.
    console.warn(`   ! series c${campaign.id}: ${error.message}`);
  }
});

console.log(`  daily series : ${seriesRows.length} rows`);
if (unmappedLabels.size) {
  console.log(`   ! UNMAPPED LABELS: ${[...unmappedLabels].join(", ")}`);
}

// --- 2. day stats + step stats ----------------------------------------------
// One call per campaign per day fills BOTH tables: the response's top level is
// the day row, its sequence_step_stats[] array is the step rows.

const dayRows = [];
const stepRows = [];
const jobs = campaigns.flatMap((c) => STATS_DAYS.map((d) => ({ c, d })));

await pool(jobs, 4, async ({ c, d }) => {
  try {
    const payload = await eb(`/api/campaigns/${c.id}/stats`, {
      method: "POST",
      body: JSON.stringify({ start_date: d, end_date: d }),
    });
    const s = payload?.data ?? {};
    const n = (v) => Number(v ?? 0) || 0;

    // Skip empty days entirely — writing ~2,800 all-zero rows would bloat the
    // table and make "no data" indistinguishable from "genuinely zero sends".
    if (n(s.emails_sent) === 0 && n(s.total_leads_contacted) === 0) return;

    dayRows.push({
      campaign_id: c.id,
      team_id: TEAM_ID,
      stat_date: d,
      emails_sent: n(s.emails_sent),
      total_leads_contacted: n(s.total_leads_contacted),
      opened: n(s.opened),
      unique_opens: n(s.unique_opens_per_contact),
      unique_replies: n(s.unique_replies_per_contact),
      bounced: n(s.bounced),
      unsubscribed: n(s.unsubscribed),
      interested: n(s.interested),
    });

    for (const step of s.sequence_step_stats ?? []) {
      stepRows.push({
        campaign_id: c.id,
        team_id: TEAM_ID,
        sequence_step_id: step.sequence_step_id,
        stat_date: d,
        email_subject: step.email_subject ?? null,
        sent: n(step.sent),
        leads_contacted: n(step.leads_contacted),
        unique_opens: n(step.unique_opens),
        unique_replies: n(step.unique_replies),
        unsubscribed: n(step.unsubscribed),
        bounced: n(step.bounced),
        interested: n(step.interested),
      });
    }
  } catch (error) {
    console.warn(`   ! stats c${c.id} ${d}: ${error.message}`);
  }
});

console.log(`  day stats    : ${dayRows.length} rows (non-empty days only)`);
console.log(`  step stats   : ${stepRows.length} rows`);
console.log(`  API calls    : ${calls}`);

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(0);
}

/** PostgREST rejects very large payloads; chunk every bulk write. */
async function upsertAll(table, rows, onConflict, size = 1000) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await sb
      .from(table)
      .upsert(rows.slice(i, i + size), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

await upsertAll("eb_daily_series", seriesRows, "team_id,campaign_id,stat_date,metric");
await upsertAll("campaign_day_stats", dayRows, "campaign_id,stat_date");
await upsertAll("campaign_step_stats_daily", stepRows, "campaign_id,sequence_step_id,stat_date");

console.log("\nWritten.");
