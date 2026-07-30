#!/usr/bin/env node
/*
 * sync-replies.mjs — campaign-scoped tracked replies.
 *
 *   node --env-file=.env.local scripts/sync-replies.mjs [--apply]
 *
 * Source is GET /api/campaigns/{id}/replies, NOT GET /api/replies.
 * /api/replies is the master inbox: ~1.9M rows, 959K of them our own outbound,
 * most inbox rows untracked with campaign_id = NULL. The campaign-scoped
 * endpoint returns only type="Tracked Reply" rows with real campaign_id and
 * lead_id -- roughly 3,500 across the whole workspace.
 *
 * The upsert column list deliberately EXCLUDES sentiment/first_send_at/
 * first_followup_at/timing_synced_at: those are locally owned, and a sweep that
 * wrote them would erase classification and timing on every run.
 */

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const TEAM_ID = Number(process.env.EMAILBISON_TEAM_ID || 2);
const EB = (process.env.EMAILBISON_BASE_URL || "").replace(/\/$/, "");
const KEY = process.env.EMAILBISON_API_KEY;

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function eb(path) {
  calls++;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${EB}${path}`, {
      headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
    });
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(`EmailBison ${response.status} on ${path}`);
  }
}

async function pool(items, limit, worker) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await worker(items[cursor++]);
    }),
  );
}

const { data: campaigns } = await sb
  .from("campaigns")
  .select("id")
  .eq("team_id", TEAM_ID);

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${campaigns.length} campaigns\n`);

const rows = [];
let human = 0;
let interested = 0;

await pool(campaigns, 4, async (campaign) => {
  try {
    for (let page = 1; ; page++) {
      const payload = await eb(
        `/api/campaigns/${campaign.id}/replies?page=${page}&per_page=100`,
      );
      for (const r of payload.data ?? []) {
        // Only inbound tracked replies count. Our own outbound sits in the same
        // feed and would double every reply metric.
        if (r.tracked_reply === false) continue;
        if ((r.folder || "").toLowerCase() === "sent") continue;

        if (!r.automated_reply) human++;
        if (r.interested) interested++;

        rows.push({
          id: r.id,
          team_id: TEAM_ID,
          campaign_id: r.campaign_id ?? campaign.id,
          lead_id: r.lead_id ?? null,
          sender_email_id: r.sender_email_id ?? null,
          scheduled_email_id: r.scheduled_email_id ?? null,
          parent_id: r.parent_id ?? null,
          folder: r.folder ?? null,
          subject: r.subject ?? null,
          text_body: r.text_body ?? null,
          from_email_address: r.from_email_address ?? null,
          from_name: r.from_name ?? null,
          date_received: r.date_received,
          tracked_reply: r.tracked_reply !== false,
          automated_reply: Boolean(r.automated_reply),
          interested: Boolean(r.interested),
          synced_at: new Date().toISOString(),
        });
      }
      if (page >= (payload.meta?.last_page ?? 1)) break;
    }
  } catch (error) {
    console.warn(`   ! c${campaign.id}: ${error.message}`);
  }
});

console.log(
  `  replies    ${rows.length}\n` +
    `  human      ${human}\n` +
    `  interested ${interested}\n` +
    `  API calls  ${calls}`,
);

if (!APPLY) {
  console.log("\nDry run — nothing written.");
  process.exit(0);
}

for (let i = 0; i < rows.length; i += 500) {
  const { error } = await sb
    .from("replies")
    .upsert(rows.slice(i, i + 500), { onConflict: "id" });
  if (error) throw new Error(error.message);
}

console.log("\nWritten.");
