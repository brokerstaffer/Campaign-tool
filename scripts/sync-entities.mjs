#!/usr/bin/env node
/*
 * sync-entities.mjs — teams, clients, campaigns, and the campaign→client map.
 *
 *   node --env-file=.env.local scripts/sync-entities.mjs           # dry run
 *   node --env-file=.env.local scripts/sync-entities.mjs --apply
 *
 * Dry-run is the default, matching every other script here: without --apply it
 * reports exactly what would change and writes nothing.
 *
 * The mapping rules that matter:
 *   - `match_method = 'manual'` rows are NEVER touched. A human pinned that
 *     campaign; a sync must not silently undo it.
 *   - Excluded campaigns (templates, internal lists, tests) are recorded with a
 *     reason rather than dropped, so the exclusion is auditable and reversible.
 *   - An ambiguous match is stored as unassigned + ambiguous, never guessed.
 */

import { createClient } from "@supabase/supabase-js";
import {
  matchCampaign,
  exclusionReason,
} from "../src/lib/clients/match.ts";

const APPLY = process.argv.includes("--apply");
const TEAM_ID = Number(process.env.EMAILBISON_TEAM_ID || 2);

const EB = (process.env.EMAILBISON_BASE_URL || "").replace(/\/$/, "");
const EB_KEY = process.env.EMAILBISON_API_KEY;
const PORTAL = (process.env.PORTAL_BASE_URL || "").replace(/\/$/, "");
const PORTAL_TOKEN = process.env.PORTAL_TOKEN;

for (const [name, value] of Object.entries({
  EMAILBISON_BASE_URL: EB,
  EMAILBISON_API_KEY: EB_KEY,
  PORTAL_BASE_URL: PORTAL,
  PORTAL_TOKEN,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
})) {
  if (!value) {
    console.error(`Missing ${name}. See .env.example.`);
    process.exit(1);
  }
}

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

async function ebGet(path) {
  const response = await fetch(`${EB}${path}`, {
    headers: { Authorization: `Bearer ${EB_KEY}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`EmailBison ${response.status} on ${path}`);
  return response.json();
}

async function portalGet(path) {
  const url = `${PORTAL}${path}${path.includes("?") ? "&" : "?"}token=${PORTAL_TOKEN}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const type = response.headers.get("content-type") || "";
  // The portal host rewrites untokened/blocked /api/* to an HTML page with
  // status 200. Checking ok alone would happily parse a login page as data.
  if (!response.ok || !type.includes("application/json")) {
    throw new Error(
      `Portal ${response.status} (${type || "no content-type"}) on ${path} — ` +
        `expected JSON. Check PORTAL_TOKEN.`,
    );
  }
  return response.json();
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --- fetch -------------------------------------------------------------------

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — team ${TEAM_ID}\n`);

const portalPayload = await portalGet("/api/clients/portals");
const sourceClients = portalPayload.clients ?? [];

let campaigns = [];
for (let page = 1; ; page++) {
  const payload = await ebGet(`/api/campaigns?page=${page}&per_page=100`);
  campaigns.push(...(payload.data ?? []));
  if (page >= (payload.meta?.last_page ?? 1)) break;
}

console.log(`fetched  ${sourceClients.length} clients, ${campaigns.length} campaigns`);

// --- resolve -----------------------------------------------------------------

const matchable = sourceClients.map((c) => ({
  id: c.slug || slugify(c.name),
  name: c.name,
  aliases: c.aliases ?? [],
}));

// Manual pins are sacred: read them first and never recompute them.
const { data: pinned } = await sb
  .from("campaign_clients")
  .select("campaign_id, client_id")
  .eq("match_method", "manual");
const pinnedIds = new Set((pinned ?? []).map((r) => r.campaign_id));

const stats = { matched: 0, excluded: 0, unassigned: 0, ambiguous: 0, pinned: pinnedIds.size };
const mappings = [];

for (const campaign of campaigns) {
  if (pinnedIds.has(campaign.id)) continue;

  const reason = exclusionReason(campaign.name);
  if (reason) {
    stats.excluded++;
    mappings.push({
      campaign_id: campaign.id,
      client_id: null,
      match_method: "auto",
      matched_on: null,
      confidence: null,
      ambiguous: false,
      excluded: true,
      exclude_reason: reason,
    });
    continue;
  }

  const result = matchCampaign(campaign.name, matchable);
  if (result.ambiguous) stats.ambiguous++;
  else if (result.clientId) stats.matched++;
  else stats.unassigned++;

  mappings.push({
    campaign_id: campaign.id,
    client_id: result.clientId, // slug; remapped to a uuid after clients upsert
    match_method: "auto",
    matched_on: result.matchedOn,
    confidence: result.confidence,
    ambiguous: result.ambiguous,
    excluded: false,
    exclude_reason: null,
  });
}

const sentOf = (predicate) =>
  campaigns
    .filter((c) => predicate(mappings.find((m) => m.campaign_id === c.id)))
    .reduce((total, c) => total + (c.emails_sent || 0), 0);

console.log(
  `\n  matched     ${String(stats.matched).padStart(3)}  sent ${sentOf((m) => m && m.client_id && !m.excluded).toLocaleString().padStart(9)}\n` +
    `  excluded    ${String(stats.excluded).padStart(3)}  sent ${sentOf((m) => m && m.excluded).toLocaleString().padStart(9)}\n` +
    `  unassigned  ${String(stats.unassigned).padStart(3)}  sent ${sentOf((m) => m && !m.client_id && !m.excluded && !m.ambiguous).toLocaleString().padStart(9)}\n` +
    `  ambiguous   ${String(stats.ambiguous).padStart(3)}\n` +
    `  pinned      ${String(stats.pinned).padStart(3)}  (left untouched)`,
);

const needsAttention = mappings.filter(
  (m) => !m.excluded && !m.client_id,
);
if (needsAttention.length) {
  console.log("\n  needs a human:");
  for (const m of needsAttention) {
    const c = campaigns.find((x) => x.id === m.campaign_id);
    console.log(
      `    ${String(c.emails_sent || 0).padStart(6)} sent  ${c.name}${m.ambiguous ? "  [AMBIGUOUS]" : ""}`,
    );
  }
}

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(0);
}

// --- write -------------------------------------------------------------------

await sb.from("teams").upsert(
  { id: TEAM_ID, name: "BrokerStaffer's Team", timezone: "America/New_York" },
  { onConflict: "id" },
);

const { data: writtenClients, error: clientError } = await sb
  .from("clients")
  .upsert(
    sourceClients.map((c) => ({
      team_id: TEAM_ID,
      name: c.name,
      slug: c.slug || slugify(c.name),
      aliases: c.aliases ?? [],
    })),
    { onConflict: "team_id,slug" },
  )
  .select("id, slug");
if (clientError) throw clientError;

const idBySlug = new Map(writtenClients.map((c) => [c.slug, c.id]));

const { error: campaignError } = await sb.from("campaigns").upsert(
  campaigns.map((c) => ({
    id: c.id,
    team_id: TEAM_ID,
    name: c.name,
    type: c.type ?? null,
    status: c.status ?? null,
    tags: c.tags ?? [],
    max_emails_per_day: c.max_emails_per_day ?? null,
    total_leads: c.total_leads ?? null,
    lifetime_emails_sent: c.emails_sent ?? null,
    eb_created_at: c.created_at ?? null,
    eb_updated_at: c.updated_at ?? null,
    synced_at: new Date().toISOString(),
  })),
  { onConflict: "id" },
);
if (campaignError) throw campaignError;

const { error: mapError } = await sb.from("campaign_clients").upsert(
  mappings.map((m) => ({
    ...m,
    client_id: m.client_id ? (idBySlug.get(m.client_id) ?? null) : null,
    resolved_at: new Date().toISOString(),
  })),
  { onConflict: "campaign_id" },
);
if (mapError) throw mapError;

console.log(
  `\nWrote ${writtenClients.length} clients, ${campaigns.length} campaigns, ${mappings.length} mappings.`,
);
