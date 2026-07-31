#!/usr/bin/env node
/*
 * sync-steps.mjs — sequence steps (subject, body, order, wait).
 *
 * Fetched per campaign, so it's one call each. The bodies are what the inline
 * email panel renders, and step_order is what orders the expansion — without
 * this table the Campaigns table can show step STATS but not which step they
 * belong to.
 */
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const TEAM_ID = Number(process.env.EMAILBISON_TEAM_ID || 2);
const EB = (process.env.EMAILBISON_BASE_URL || "").replace(/\/$/, "");
const KEY = process.env.EMAILBISON_API_KEY;
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let calls = 0;
async function eb(path) {
  calls++;
  for (let a = 1; ; a++) {
    const r = await fetch(`${EB}${path}`, { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" } });
    if (r.ok) return r.json();
    if (r.status === 400 || r.status === 404) return null; // draft campaign with no sequence
    if ((r.status === 429 || r.status >= 500) && a < 4) { await sleep(500 * 2 ** (a - 1)); continue; }
    throw new Error(`EmailBison ${r.status}`);
  }
}
async function pool(items, limit, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

const { data: campaigns } = await sb.from("campaigns").select("id").eq("team_id", TEAM_ID);
console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${campaigns.length} campaigns`);

const rows = [];
await pool(campaigns, 4, async (c) => {
  try {
    const p = await eb(`/api/campaigns/v1.1/${c.id}/sequence-steps`);
    const steps = p?.data?.sequence_steps ?? [];
    for (const s of steps) {
      rows.push({
        id: s.id, campaign_id: c.id, team_id: TEAM_ID,
        sequence_id: p?.data?.sequence_id ?? null,
        step_order: Number(s.order) || null,
        email_subject: s.email_subject ?? null,
        email_body: s.email_body ?? null,
        wait_in_days: Number(s.wait_in_days) || null,
        is_variant: Boolean(s.variant),
        variant_from_step_id: s.variant_from_step_id ?? null,
        thread_reply: Boolean(s.thread_reply),
        attachments: s.attachments ?? [],
        synced_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.warn(`   ! c${c.id}: ${e.message}`); }
});

console.log(`  steps ${rows.length}   variants ${rows.filter(r => r.is_variant).length}   API calls ${calls}`);
if (!APPLY) { console.log("\nDry run."); process.exit(0); }
for (let i = 0; i < rows.length; i += 500) {
  const { error } = await sb.from("sequence_steps").upsert(rows.slice(i, i + 500), { onConflict: "id" });
  if (error) throw new Error(error.message);
}
console.log("Written.");
