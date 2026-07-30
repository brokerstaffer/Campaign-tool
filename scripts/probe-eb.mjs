#!/usr/bin/env node
/*
 * probe-eb.mjs — read-only EmailBison endpoint prober.
 *
 *   npm run probe                 # uses .env.local
 *   node scripts/probe-eb.mjs     # if the env is already exported
 *
 * This script performs ZERO writes. Every request is a GET, except the campaign
 * stats endpoint which EmailBison models as a POST but which only reads.
 *
 * It exists because three open questions change the DATABASE SCHEMA, and
 * guessing them costs a migration on live data:
 *
 *   Q3  What timezone are the `dates` in the daily-series responses?
 *       -> decides the received_date / stat_date generated-column expression
 *   Q5  Does total_leads_contacted mean contacted-during or first-contacted-
 *       during the range?  -> decides what "Prospects" is
 *   Q6  Does a single-day range (start === end) return correct
 *       sequence_step_stats and total_leads_contacted?
 *       -> decides whether campaign_day_stats / campaign_step_stats_daily can
 *          exist at all, or whether step data must be fetched live
 *
 * And four more that change code rather than schema: Q1 workspace count,
 * Q7 the variant model, Q8 the spintax format, Q16 message direction in a
 * conversation thread, Q17 the campaign-name list for the client matcher.
 *
 * Output: a human-readable run log on stdout, and docs/eb-api-findings.md,
 * which is CHECKED IN so the answers stop being tribal knowledge.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "eb-api-findings.md");

const BASE = (
  process.env.EMAILBISON_BASE_URL || "https://send.brokerstaffer.com"
).replace(/\/$/, "");
const KEY = process.env.EMAILBISON_API_KEY;

if (!KEY) {
  console.error(
    "\n  EMAILBISON_API_KEY is not set.\n" +
      "  Put it in .env.local (see .env.example) and run `npm run probe`.\n",
  );
  process.exit(1);
}

// --- helpers -----------------------------------------------------------------

const findings = [];
let failures = 0;

function isoDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

const TODAY = isoDaysAgo(0);
const THIRTY_DAYS_AGO = isoDaysAgo(29);

async function call(label, path, options = {}) {
  const url = `${BASE}${path}`;
  const started = Date.now();

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });

    const ms = Date.now() - started;
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }

    const ok = response.ok;
    if (!ok) failures++;

    console.log(
      `${ok ? "  ok " : "FAIL "} ${String(response.status).padEnd(3)} ${String(ms).padStart(5)}ms  ${label}`,
    );

    return { ok, status: response.status, body, ms, path };
  } catch (error) {
    failures++;
    console.log(`FAIL  ---        --  ${label}  (${error.message})`);
    return { ok: false, status: 0, body: null, error: error.message, path };
  }
}

function record(question, verdict, detail) {
  findings.push({ question, verdict, detail });
  console.log(`       -> ${question}: ${verdict}`);
}

function preview(value, max = 900) {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  return json.length > max ? `${json.slice(0, max)}\n… truncated` : json;
}

const sections = [];
function section(title, body) {
  sections.push(`## ${title}\n\n${body}\n`);
}

// --- probes ------------------------------------------------------------------

console.log(`\nProbing ${BASE}`);
console.log(`Range for range-scoped calls: ${THIRTY_DAYS_AGO} .. ${TODAY}\n`);

// Q1 — how many workspaces does this token see?
const workspaces = await call("GET /api/workspaces", "/api/workspaces");
if (workspaces.ok) {
  const list = workspaces.body?.data ?? [];
  record(
    "Q1 workspace count",
    `${list.length} visible`,
    list.map((w) => `${w.id}: ${w.name}`).join(", "),
  );
  section(
    "Q1 — Workspaces visible to the token",
    `\`\`\`json\n${preview(list)}\n\`\`\`\n\n` +
      (list.length > 1
        ? "**More than one workspace.** Every sync must either fan out or pin a team id, " +
          "and `teams` is a real dimension rather than a constant."
        : "Single workspace, as assumed. `team_id` stays effectively constant."),
  );
}

// Q17 — the campaign list, which the client matcher must be tested against.
const campaigns = await call(
  "GET /api/campaigns (page 1)",
  "/api/campaigns?page=1&per_page=100",
);
let sampleCampaignId = null;
if (campaigns.ok) {
  const rows = campaigns.body?.data ?? [];
  const meta = campaigns.body?.meta ?? {};
  sampleCampaignId = rows[0]?.id ?? null;

  const statuses = [...new Set(rows.map((c) => c.status))];
  record(
    "Q17 campaign names",
    `${meta.total ?? rows.length} campaigns`,
    `statuses seen: ${statuses.join(", ")}`,
  );
  record("Q8b status vocabulary", statuses.join(" | "), "");

  section(
    "Q17 — Campaign names (for the client matcher)",
    `Total: **${meta.total ?? rows.length}**. Statuses observed: ${statuses
      .map((s) => `\`${s}\``)
      .join(", ")}.\n\n` +
      "The matcher must be pinned by unit tests against these exact names before it\n" +
      "decides how the reporting is grouped.\n\n" +
      "```\n" +
      rows.map((c) => `${String(c.id).padStart(6)}  ${c.name}`).join("\n") +
      "\n```",
  );

  section(
    "Campaign row shape",
    `\`\`\`json\n${preview(rows[0])}\n\`\`\``,
  );
}

// Q3 — timezone + label vocabulary of the daily series.
const series = await call(
  "GET /api/campaign-events/stats (30d)",
  `/api/campaign-events/stats?start_date=${THIRTY_DAYS_AGO}&end_date=${TODAY}`,
);
if (series.ok) {
  const rows = series.body?.data ?? [];
  const labels = rows.map((r) => r.label);
  const dates = rows[0]?.dates ?? [];
  const first = dates[0]?.[0];
  const last = dates[dates.length - 1]?.[0];

  record("Daily-series labels", labels.join(" | "), "");
  record(
    "Q3 date coverage",
    `${first} .. ${last} (${dates.length} points)`,
    `requested ${THIRTY_DAYS_AGO} .. ${TODAY}`,
  );

  const unmapped = labels.filter(
    (l) =>
      ![
        "Sent",
        "Replied",
        "Bounced",
        "Unsubscribed",
        "Interested",
        "Total Opens",
        "Unique Opens",
      ].includes(l),
  );
  if (unmapped.length) {
    record(
      "!! UNMAPPED LABELS",
      unmapped.join(", "),
      "add these to METRIC_BY_LABEL in src/lib/emailbison/daily-series.ts",
    );
  }

  section(
    "Q3 — Daily series: labels, coverage and timezone",
    `Labels: ${labels.map((l) => `\`${l}\``).join(", ")}\n\n` +
      `Requested \`${THIRTY_DAYS_AGO}\` .. \`${TODAY}\`; returned \`${first}\` .. \`${last}\` ` +
      `(${dates.length} points).\n\n` +
      "**Check:** if the first returned date is one day before the requested start, the\n" +
      "series is workspace-local rather than UTC, and the `received_date` / `sent_date`\n" +
      "generated columns must convert rather than truncate.\n\n" +
      `\`\`\`json\n${preview(rows.slice(0, 2))}\n\`\`\``,
  );
}

// Does the campaign filter on the series endpoint actually apply?
if (sampleCampaignId) {
  const filtered = await call(
    `GET /api/campaign-events/stats?campaign_ids[]=${sampleCampaignId}`,
    `/api/campaign-events/stats?start_date=${THIRTY_DAYS_AGO}&end_date=${TODAY}&campaign_ids[]=${sampleCampaignId}`,
  );
  if (filtered.ok && series.ok) {
    const sum = (payload) =>
      (payload?.data ?? [])
        .filter((r) => r.label === "Sent")
        .flatMap((r) => r.dates ?? [])
        .reduce((total, [, value]) => total + Number(value || 0), 0);

    const all = sum(series.body);
    const one = sum(filtered.body);
    record(
      "campaign_ids[] filter",
      one < all ? "APPLIES" : "NO EFFECT — investigate",
      `workspace Sent=${all}, single-campaign Sent=${one}`,
    );
    section(
      "Does `campaign_ids[]` actually filter?",
      `Workspace-wide Sent over the range: **${all}**\n\n` +
        `Filtered to campaign ${sampleCampaignId}: **${one}**\n\n` +
        (one < all
          ? "Filter applies. `eb_daily_series` can store per-campaign rows and the\n" +
            "Campaigns filter becomes a WHERE clause instead of an API fan-out."
          : "**The filter appears to have no effect.** Per-campaign daily rows would have\n" +
            "to come from the per-campaign endpoint, one call each."),
    );
  }

  // Q6 — the single most schema-relevant question.
  const rangeStats = await call(
    `POST /api/campaigns/${sampleCampaignId}/stats (30d)`,
    `/api/campaigns/${sampleCampaignId}/stats`,
    {
      method: "POST",
      body: JSON.stringify({
        start_date: THIRTY_DAYS_AGO,
        end_date: TODAY,
      }),
    },
  );

  const dayStats = await call(
    `POST /api/campaigns/${sampleCampaignId}/stats (single day)`,
    `/api/campaigns/${sampleCampaignId}/stats`,
    {
      method: "POST",
      body: JSON.stringify({ start_date: TODAY, end_date: TODAY }),
    },
  );

  if (rangeStats.ok && dayStats.ok) {
    const rangeSteps = rangeStats.body?.data?.sequence_step_stats ?? [];
    const daySteps = dayStats.body?.data?.sequence_step_stats ?? [];

    record(
      "Q6 single-day step stats",
      daySteps.length > 0
        ? `present (${daySteps.length} steps)`
        : "ABSENT — fall back to range-scoped storage",
      `30d range returned ${rangeSteps.length} steps`,
    );
    record(
      "Q5 total_leads_contacted",
      `30d=${rangeStats.body?.data?.total_leads_contacted}, 1d=${dayStats.body?.data?.total_leads_contacted}`,
      "compare against SUM of daily values once backfilled",
    );

    section(
      "Q6 — Does a single-day range return step stats?",
      `30-day range: **${rangeSteps.length}** entries in \`sequence_step_stats\`.\n\n` +
        `Single day (\`${TODAY}\`): **${daySteps.length}** entries.\n\n` +
        (daySteps.length > 0
          ? "Single-day ranges work. `campaign_day_stats` and `campaign_step_stats_daily`\n" +
            "can both be filled by one call per campaign per day, and any range is a SUM."
          : "**Single-day ranges return no step stats.** Store range-scoped rows keyed by\n" +
            "(campaign, from, to) for the presets only, and fetch live for custom ranges.") +
        `\n\n### Range response\n\`\`\`json\n${preview(rangeStats.body?.data)}\n\`\`\``,
    );

    section(
      "Q5 — What does `total_leads_contacted` count?",
      `Over 30 days: **${rangeStats.body?.data?.total_leads_contacted}**\n\n` +
        `Over a single day: **${dayStats.body?.data?.total_leads_contacted}**\n\n` +
        "This is the Prospects metric. The open question is whether it counts leads\n" +
        "contacted DURING the range, or leads FIRST contacted during it. If the former,\n" +
        "summing daily values overcounts (a lead emailed twice counts twice) and the\n" +
        "chart legitimately will not sum to the KPI — which is the documented exception.",
    );
  }

  // Q7 + Q8 — the variant model and the spintax format.
  const steps = await call(
    `GET /api/campaigns/v1.1/${sampleCampaignId}/sequence-steps`,
    `/api/campaigns/v1.1/${sampleCampaignId}/sequence-steps`,
  );
  if (steps.ok) {
    const list =
      steps.body?.data?.sequence_steps ?? steps.body?.data ?? [];
    const variants = list.filter((s) => s.variant);
    const body = list[0]?.email_body ?? "";
    const spintax = body.match(/\{[^{}]*\|[^{}]*\}/g)?.slice(0, 3) ?? [];

    record(
      "Q7 variants",
      `${list.length} steps, ${variants.length} flagged variant`,
      variants.length
        ? `variant_from_step_id present: ${variants.every((v) => v.variant_from_step_id != null)}`
        : "no variants on this campaign — probe another",
    );
    record(
      "Q8 spintax",
      spintax.length ? `found {a|b} syntax` : "none found in this body",
      spintax.join("  ") || "try a campaign known to use spintax",
    );

    section(
      "Q7 / Q8 — Sequence step model and spintax",
      `${list.length} steps, ${variants.length} flagged as variants.\n\n` +
        (spintax.length
          ? `Spintax groups found, \`{a|b}\` style:\n\n\`\`\`\n${spintax.join("\n")}\n\`\`\`\n\n`
          : "No spintax found in the first step's body. Probe a campaign known to use it\nbefore writing the parser.\n\n") +
        `\`\`\`json\n${preview(list[0])}\n\`\`\``,
    );
  }
}

// Q16 — can we tell OUR messages from THEIRS in a conversation thread?
const replies = await call(
  "GET /api/replies?per_page=5",
  "/api/replies?per_page=5",
);
if (replies.ok) {
  const rows = replies.body?.data ?? [];
  const meta = replies.body?.meta ?? {};
  record("Replies total", String(meta.total ?? rows.length), "");

  const hasAutomated = rows.some((r) => "automated_reply" in r);
  const hasInterested = rows.some((r) => "interested" in r);
  record(
    "Human/Positive fields",
    `automated_reply=${hasAutomated}, interested=${hasInterested}`,
    "these back Human Replies and Positive",
  );

  section(
    "Reply row shape",
    `Total replies: **${meta.total ?? "unknown"}**\n\n` +
      `\`automated_reply\` present: **${hasAutomated}** (backs "Human Replies")\n` +
      `\`interested\` present: **${hasInterested}** (backs "Positive")\n\n` +
      `\`\`\`json\n${preview(rows[0])}\n\`\`\``,
  );

  if (rows[0]?.id) {
    const thread = await call(
      `GET /api/replies/${rows[0].id}/conversation-thread`,
      `/api/replies/${rows[0].id}/conversation-thread`,
    );
    if (thread.ok) {
      const data = thread.body?.data ?? {};
      const older = data.older_messages ?? [];
      const newer = data.newer_messages ?? [];
      const sample = older[0] ?? newer[0] ?? data.current_reply;
      const directionFields = sample
        ? Object.keys(sample).filter((k) =>
            /folder|direction|type|is_sent|sender/i.test(k),
          )
        : [];

      record(
        "Q16 message direction",
        directionFields.length
          ? directionFields.join(", ")
          : "NO obvious direction field",
        `older=${older.length}, newer=${newer.length}`,
      );

      section(
        "Q16 — Message direction in a conversation thread",
        `\`older_messages\`: ${older.length}, \`newer_messages\`: ${newer.length}\n\n` +
          `Candidate direction fields: ${
            directionFields.map((f) => `\`${f}\``).join(", ") || "**none found**"
          }\n\n` +
          "This decides whether Median Reply Time and Median Follow-up Time can be\n" +
          "derived at all. If no field reliably marks our own messages, the fallback is\n" +
          "matching `from_email_address` against the synced `sender_emails`.\n\n" +
          `\`\`\`json\n${preview(sample)}\n\`\`\``,
      );
    }
  }
}

// Sender emails — needed for the Infrastructure tab and the direction fallback.
const senders = await call(
  "GET /api/sender-emails?per_page=5",
  "/api/sender-emails?per_page=5",
);
if (senders.ok) {
  const rows = senders.body?.data ?? [];
  record(
    "Sender emails",
    String(senders.body?.meta?.total ?? rows.length),
    "",
  );
  section("Sender email row shape", `\`\`\`json\n${preview(rows[0])}\n\`\`\``);
}

// Workspace-wide range aggregate — the Prospects KPI source.
const wsStats = await call(
  "GET /api/workspaces/v1.1/stats (30d)",
  `/api/workspaces/v1.1/stats?start_date=${THIRTY_DAYS_AGO}&end_date=${TODAY}`,
);
if (wsStats.ok) {
  section(
    "Workspace range aggregate (Prospects KPI source)",
    `\`\`\`json\n${preview(wsStats.body?.data)}\n\`\`\``,
  );
}

// --- report ------------------------------------------------------------------

const header =
  `# EmailBison API findings\n\n` +
  `Generated by \`scripts/probe-eb.mjs\` against \`${BASE}\`.\n\n` +
  `Probe range: \`${THIRTY_DAYS_AGO}\` .. \`${TODAY}\`.\n\n` +
  `This file is checked in deliberately. It is the answer sheet for the open\n` +
  `questions in the plan — re-run the probe rather than re-deriving them.\n\n` +
  `## Summary\n\n` +
  `| Question | Verdict | Detail |\n|---|---|---|\n` +
  findings
    .map(
      (f) =>
        `| ${f.question} | ${f.verdict} | ${String(f.detail ?? "").replace(/\|/g, "\\|")} |`,
    )
    .join("\n") +
  `\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${header}\n${sections.join("\n")}`);

console.log(`\nWrote ${OUT}`);
console.log(
  failures > 0
    ? `\n${failures} request(s) failed — the findings above are incomplete.\n`
    : `\nAll requests succeeded.\n`,
);

process.exit(failures > 0 ? 1 : 0);
