#!/usr/bin/env node
/*
 * sync-reply-timing.mjs — fills replies.first_send_at, which is what Median
 * Reply Time is computed from.
 *
 *   node --env-file=.env.local scripts/sync-reply-timing.mjs [--limit=500] [--apply]
 *
 * WHY THIS ENDPOINT: GET /api/replies/{id}/conversation-thread was the obvious
 * candidate and returns older_messages: 0 for every reply tested (15/15), so it
 * is useless here. GET /api/leads/{lead_id}/sent-emails DOES work — it returns
 * the sends to that lead with campaign_id, sequence_step_id and sent_at.
 *
 * Median Reply Time = median(reply.date_received - first send to that lead in
 * that campaign). One call per replying lead, and results are stored, so this
 * is a work queue that drains rather than a per-request cost.
 *
 * `timing_synced_at` marks a reply as processed even when no send is found —
 * otherwise leads whose sends have aged out would be retried forever.
 */

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const LIMIT = Number(
  (process.argv.find((a) => a.startsWith("--limit=")) || "--limit=1000").split("=")[1],
);
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
    if (response.status === 404) return null; // lead deleted upstream
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

const { data: pending, error } = await sb
  .from("replies")
  .select("id, lead_id, campaign_id, date_received")
  .eq("team_id", TEAM_ID)
  .is("timing_synced_at", null)
  .not("lead_id", "is", null)
  .order("date_received", { ascending: false })
  .limit(LIMIT);
if (error) throw new Error(error.message);

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${pending.length} replies awaiting timing\n`);

// One lead can have several replies; fetch its sends once and reuse.
const byLead = new Map();
for (const r of pending) {
  if (!byLead.has(r.lead_id)) byLead.set(r.lead_id, []);
  byLead.get(r.lead_id).push(r);
}

const updates = [];
let resolved = 0;
let noSends = 0;

await pool([...byLead.keys()], 4, async (leadId) => {
  try {
    const payload = await eb(`/api/leads/${leadId}/sent-emails`);
    const sends = Array.isArray(payload?.data) ? payload.data : [];

    for (const reply of byLead.get(leadId)) {
      // First send to this lead in THIS campaign, before the reply arrived.
      // Scoping to the campaign matters: a lead in two campaigns would
      // otherwise take the earlier campaign's send and overstate the gap.
      const candidates = sends
        .filter(
          (s) =>
            s.sent_at &&
            (reply.campaign_id == null || s.campaign_id === reply.campaign_id) &&
            new Date(s.sent_at) < new Date(reply.date_received),
        )
        .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));

      if (candidates.length) resolved++;
      else noSends++;

      updates.push({
        id: reply.id,
        first_send_at: candidates[0]?.sent_at ?? null,
        // Stamped even with no match, so this reply isn't retried forever.
        timing_synced_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn(`   ! lead ${leadId}: ${e.message}`);
  }
});

console.log(
  `  leads queried   ${byLead.size}\n` +
    `  first_send_at   ${resolved}\n` +
    `  no send found   ${noSends}\n` +
    `  API calls       ${calls}`,
);

if (!APPLY) {
  console.log("\nDry run — nothing written.");
  process.exit(0);
}

// Only the two timing columns are written; everything else is left alone.
for (const u of updates) {
  const { error: e } = await sb
    .from("replies")
    .update({ first_send_at: u.first_send_at, timing_synced_at: u.timing_synced_at })
    .eq("id", u.id);
  if (e) console.warn(`   ! write ${u.id}: ${e.message}`);
}

console.log(`\nWrote timing for ${updates.length} replies.`);
