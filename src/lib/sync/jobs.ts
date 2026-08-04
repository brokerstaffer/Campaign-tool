import { createEmailBisonClient, type EmailBisonClient } from "@/lib/emailbison/client.ts";
import { classifyPlatform } from "../analytics/outcomes.ts";
import { getSupabase } from "@/lib/supabase/server";
import { exclusionReason, matchCampaign } from "@/lib/clients/match.ts";
import type { JobFn, JobResult } from "./runner";

/*
 * The sync jobs, shared by the cron routes.
 *
 * Every one is IDEMPOTENT: re-running writes the same rows. That is what makes
 * a missed window a non-event — there is no delivery guarantee to preserve,
 * only a cursor to advance. It's also why this app has no webhook endpoint.
 */

const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const isoDaysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await worker(items[cursor++]);
    }),
  );
}

async function chunkUpsert(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  size = 500,
) {
  const sb = getSupabase();
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + size), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function scopedCampaigns(teamId: number) {
  const { data } = await getSupabase()
    .from("campaigns")
    .select("id, name, eb_updated_at")
    .eq("team_id", teamId);
  return data ?? [];
}

// --- entities: campaigns, clients, and the campaign→client mapping ----------

export const syncEntities: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const sb = getSupabase();
  let apiCalls = 0;

  const campaigns = await eb.getAllCampaigns();
  apiCalls += Math.ceil(campaigns.length / 100) + 1;

  await sb.from("teams").upsert(
    { id: teamId, name: "BrokerStaffer's Team", timezone: "America/New_York" },
    { onConflict: "id" },
  );

  await chunkUpsert(
    "campaigns",
    campaigns.map((c) => ({
      id: c.id,
      team_id: teamId,
      name: c.name,
      type: c.type ?? null,
      status: c.status ?? null,
      tags: c.tags ?? [],
      max_emails_per_day: c.max_emails_per_day ?? null,
      total_leads: c.total_leads ?? null,
      lifetime_emails_sent: c.emails_sent ?? null,
      eb_created_at: c.created_at ?? null,
      eb_updated_at: c.updated_at ?? null,
      // Settings and the lifetime funnel arrive on the same list response, so
      // caching them is free and turns the detail page into one indexed read.
      sequence_id: c.sequence_id ?? null,
      max_new_leads_per_day: c.max_new_leads_per_day ?? null,
      plain_text: c.plain_text ?? null,
      open_tracking: c.open_tracking ?? null,
      can_unsubscribe: c.can_unsubscribe ?? null,
      unsubscribe_text: c.unsubscribe_text ?? null,
      include_auto_replies_in_stats: c.include_auto_replies_in_stats ?? null,
      sequence_prioritization: c.sequence_prioritization ?? null,
      completion_percentage: c.completion_percentage ?? null,
      // Cumulative counters. Overview shows them as lifetime totals and says
      // so — never use them for anything date-ranged.
      lifetime_opened: c.opened ?? null,
      lifetime_unique_opens: c.unique_opens ?? null,
      lifetime_replied: c.replied ?? null,
      lifetime_unique_replies: c.unique_replies ?? null,
      lifetime_bounced: c.bounced ?? null,
      lifetime_unsubscribed: c.unsubscribed ?? null,
      lifetime_interested: c.interested ?? null,
      total_leads_contacted: c.total_leads_contacted ?? null,
      synced_at: new Date().toISOString(),
    })),
    "id",
  );

  // Refresh the client roster from the portal before matching, so a client
  // added there is usable here on the next tick. Best-effort: if the portal is
  // down we still match against the clients already stored, rather than
  // unassigning every campaign.
  const portalBase = (process.env.PORTAL_BASE_URL ?? "").replace(/\/$/, "");
  const portalToken = process.env.PORTAL_TOKEN;
  let portalClients = 0;

  if (portalBase && portalToken) {
    try {
      const response = await fetch(
        `${portalBase}/api/clients/portals?token=${portalToken}`,
        { cache: "no-store", headers: { Accept: "application/json" } },
      );
      apiCalls++;
      const type = response.headers.get("content-type") ?? "";
      // That host rewrites blocked /api/* to an HTML page with status 200, so
      // `ok` alone would happily parse a login page as the client list.
      if (response.ok && type.includes("application/json")) {
        const body = await response.json();
        const source: Array<{ name: string; slug?: string; aliases?: string[] }> =
          body.clients ?? [];
        if (source.length) {
          // Aliases are edited locally on /clients and are NOT in the portal
          // payload, so they are omitted from the upsert — writing `[]` here
          // would wipe every alias on every tick.
          const { error } = await sb.from("clients").upsert(
            source.map((c) => ({
              team_id: teamId,
              name: c.name,
              slug: c.slug || slugify(c.name),
            })),
            { onConflict: "team_id,slug" },
          );
          if (!error) portalClients = source.length;
        }
      }
    } catch {
      /* portal unavailable — fall through to the stored roster */
    }
  }

  const { data: clientDetail } = await sb
    .from("clients")
    .select("id, name, aliases, match_mode")
    .eq("team_id", teamId);

  const matchable = (clientDetail ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    aliases: c.aliases ?? [],
    matchMode: c.match_mode as "contains" | "prefix" | "exact",
  }));

  // Manual pins are never recomputed — a human decided those.
  const { data: pinned } = await sb
    .from("campaign_clients")
    .select("campaign_id")
    .eq("match_method", "manual");
  const pinnedIds = new Set((pinned ?? []).map((p) => p.campaign_id));

  const mappings = campaigns
    .filter((c) => !pinnedIds.has(c.id))
    .map((c) => {
      const reason = exclusionReason(c.name);
      if (reason) {
        return {
          campaign_id: c.id,
          client_id: null,
          match_method: "auto",
          matched_on: null,
          confidence: null,
          ambiguous: false,
          excluded: true,
          exclude_reason: reason,
          resolved_at: new Date().toISOString(),
        };
      }
      const result = matchCampaign(c.name, matchable);
      return {
        campaign_id: c.id,
        client_id: result.clientId,
        match_method: "auto",
        matched_on: result.matchedOn,
        confidence: result.confidence,
        ambiguous: result.ambiguous,
        excluded: false,
        exclude_reason: null,
        resolved_at: new Date().toISOString(),
      };
    });

  await chunkUpsert("campaign_clients", mappings, "campaign_id");

  /*
   * Reconcile removals. Upserting alone meant a campaign deleted in EmailBison
   * lived on in the cache forever — still in the picker, still selectable as a
   * copy target.
   *
   * Soft, because campaigns is the parent of the day-stats, step-stats,
   * sequence-steps and client-mapping tables with ON DELETE CASCADE: dropping
   * the row would erase that campaign's history from every chart. The sends
   * happened.
   *
   * And reversible, because EmailBison deletes asynchronously ("queued for
   * deletion") — a campaign can briefly vanish and come back, and a one-way
   * flag would permanently hide a live campaign over a transient blip.
   */
  const liveIds = campaigns.map((c) => c.id);
  const [gone, back] = await Promise.all([
    sb
      .from("campaigns")
      .update({ deleted_at: new Date().toISOString() })
      .eq("team_id", teamId)
      .is("deleted_at", null)
      .not("id", "in", `(${liveIds.join(",")})`)
      .select("id"),
    sb
      .from("campaigns")
      .update({ deleted_at: null })
      .eq("team_id", teamId)
      .not("deleted_at", "is", null)
      .in("id", liveIds)
      .select("id"),
  ]);

  return {
    rowsWritten: campaigns.length + mappings.length,
    apiCalls,
    detail: {
      campaigns: campaigns.length,
      clients: matchable.length,
      portalClients,
      unassigned: mappings.filter((m) => !m.excluded && !m.client_id).length,
      excluded: mappings.filter((m) => m.excluded).length,
      markedDeleted: gone.data?.length ?? 0,
      restored: back.data?.length ?? 0,
    },
  };
};

// --- sequence steps ---------------------------------------------------------

export const syncSteps: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const campaigns = await scopedCampaigns(teamId);
  const rows: Record<string, unknown>[] = [];
  let apiCalls = 0;

  await pool(campaigns, 4, async (c) => {
    try {
      const payload = await eb.getCampaignSequenceSteps(c.id);
      apiCalls++;
      for (const s of payload?.data?.sequence_steps ?? []) {
        rows.push({
          id: s.id,
          campaign_id: c.id,
          team_id: teamId,
          sequence_id: payload?.data?.sequence_id ?? null,
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
    } catch {
      // Draft campaigns have no sequence and 400. One bad campaign must not
      // abort the sweep.
    }
  });

  await chunkUpsert("sequence_steps", rows, "id");
  return { rowsWritten: rows.length, apiCalls };
};

// --- daily series -----------------------------------------------------------

const METRIC_BY_LABEL: Record<string, string> = {
  Sent: "sent",
  Replied: "replies",
  Bounced: "bounces",
  Unsubscribed: "unsubscribes",
  Interested: "positive",
  "Total Opens": "opens_total",
  "Unique Opens": "opens_unique",
};

async function collectSeries(
  eb: EmailBisonClient,
  path: string,
  from: string,
  to: string,
  campaignId: number,
  teamId: number,
  out: Record<string, unknown>[],
  unmapped: Set<string>,
) {
  const payload = await eb.getDailySeries(
    path,
    new URLSearchParams({ start_date: from, end_date: to }),
  );
  for (const series of payload?.data ?? []) {
    const metric = METRIC_BY_LABEL[series.label];
    if (!metric) {
      unmapped.add(series.label);
      continue;
    }
    for (const [date, value] of series.dates ?? []) {
      if (typeof date !== "string" || !Number.isFinite(Number(value))) continue;
      out.push({
        team_id: teamId,
        campaign_id: campaignId,
        stat_date: date,
        metric,
        value: Number(value),
      });
    }
  }
}

/** Each call returns the WHOLE range, so a wide window costs no more than a narrow one. */
export function makeDailySeriesJob(days: number): JobFn {
  return async ({ teamId }): Promise<JobResult> => {
    const eb = createEmailBisonClient();
    const to = isoDaysAgo(0);
    const from = isoDaysAgo(days - 1);
    const rows: Record<string, unknown>[] = [];
    const unmapped = new Set<string>();
    let apiCalls = 0;

    await collectSeries(
      eb, "/api/workspaces/v1.1/line-area-chart-stats", from, to, 0, teamId, rows, unmapped,
    );
    apiCalls++;

    const campaigns = await scopedCampaigns(teamId);
    await pool(campaigns, 4, async (c) => {
      try {
        await collectSeries(
          eb, `/api/campaigns/${c.id}/line-area-chart-stats`, from, to, c.id, teamId, rows, unmapped,
        );
        apiCalls++;
      } catch {
        /* one campaign failing must not abort the sweep */
      }
    });

    if (unmapped.size) {
      // The drift detector: EmailBison adding a series shows up here, not as a
      // number that quietly stops adding up.
      console.warn(`[cron] unmapped daily-series labels: ${[...unmapped].join(", ")}`);
    }

    await chunkUpsert("eb_daily_series", rows, "team_id,campaign_id,stat_date,metric", 1000);
    return { rowsWritten: rows.length, apiCalls, detail: { from, to } };
  };
}

// --- day + step stats (one call fills both tables) ---------------------------

export function makeDayStatsJob(days: number): JobFn {
  return async ({ teamId }): Promise<JobResult> => {
    const eb = createEmailBisonClient();
    const campaigns = await scopedCampaigns(teamId);
    const dates = Array.from({ length: days }, (_, i) => isoDaysAgo(i));

    const dayRows: Record<string, unknown>[] = [];
    const stepRows: Record<string, unknown>[] = [];
    let apiCalls = 0;

    const jobs = campaigns.flatMap((c) => dates.map((d) => ({ c, d })));

    await pool(jobs, 4, async ({ c, d }) => {
      try {
        const payload = await eb.getCampaignStats(c.id, d, d);
        apiCalls++;
        const s = payload?.data ?? {};
        const n = (v: unknown) => Number(v ?? 0) || 0;

        // Skip empty days: writing thousands of all-zero rows would make "no
        // data" indistinguishable from "genuinely zero sends".
        if (n(s.emails_sent) === 0 && n(s.total_leads_contacted) === 0) return;

        dayRows.push({
          campaign_id: c.id, team_id: teamId, stat_date: d,
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
            campaign_id: c.id, team_id: teamId,
            sequence_step_id: step.sequence_step_id, stat_date: d,
            email_subject: step.email_subject ?? null,
            sent: n(step.sent), leads_contacted: n(step.leads_contacted),
            unique_opens: n(step.unique_opens), unique_replies: n(step.unique_replies),
            unsubscribed: n(step.unsubscribed), bounced: n(step.bounced),
            interested: n(step.interested),
          });
        }
      } catch {
        /* drafts 400; skip */
      }
    });

    await chunkUpsert("campaign_day_stats", dayRows, "campaign_id,stat_date");
    await chunkUpsert(
      "campaign_step_stats_daily", stepRows, "campaign_id,sequence_step_id,stat_date",
    );

    return {
      rowsWritten: dayRows.length + stepRows.length,
      apiCalls,
      detail: { days, dayRows: dayRows.length, stepRows: stepRows.length },
    };
  };
}

// --- replies ----------------------------------------------------------------

/*
 * Replies come from /api/campaigns/{id}/replies, NOT /api/replies. The latter
 * is the master inbox: ~1.9M rows, 959K of them our own outbound, most with a
 * NULL campaign_id.
 *
 * The feed is newest-first, which is what makes the incremental mode possible:
 * `overlapHours` stops paging a campaign once a page's oldest row predates the
 * last successful run by that margin. A full walk is 600 calls and six minutes
 * — far too slow for a 10-minute cadence — while the incremental sweep is
 * usually one page per campaign.
 *
 * The 48-hour overlap is not paranoia: EmailBison backfills late deliveries,
 * and a reply that arrives dated yesterday would fall behind an exact
 * watermark and never be picked up.
 */
export function makeRepliesJob(overlapHours: number | null): JobFn {
  return async ({ teamId, watermark }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const campaigns = await scopedCampaigns(teamId);
  const rows: Record<string, unknown>[] = [];
  const startedAt = new Date().toISOString();
  let apiCalls = 0;
  let pagesRead = 0;

  // No watermark yet (first run after deploy) => full walk, whatever the mode.
  const cutoff =
    overlapHours !== null && watermark
      ? new Date(new Date(watermark).getTime() - overlapHours * 3_600_000)
      : null;

  await pool(campaigns, 4, async (c) => {
    try {
      for (let page = 1; ; page++) {
        const payload = await eb.getCampaignRepliesPage(c.id, page, 100);
        apiCalls++;
        pagesRead++;
        const batch = payload.data ?? [];
        for (const r of batch) {
          if (r.tracked_reply === false) continue;
          if ((r.folder ?? "").toLowerCase() === "sent") continue;
          rows.push({
            id: r.id, team_id: teamId,
            campaign_id: r.campaign_id ?? c.id,
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
            // Always true by here — the `=== false` rows were skipped above.
            tracked_reply: r.tracked_reply ?? true,
            automated_reply: Boolean(r.automated_reply),
            interested: Boolean(r.interested),
            synced_at: new Date().toISOString(),
          });
        }
        if (page >= (payload.meta?.last_page ?? 1)) break;

        // Newest-first, so the last row on the page is the oldest seen so far.
        const oldest = batch.length ? batch[batch.length - 1].date_received : null;
        if (cutoff && oldest && new Date(oldest) < cutoff) break;
      }
    } catch {
      /* skip a failing campaign */
    }
  });

  // NOTE the column list: sentiment, first_send_at, first_followup_at and
  // timing_synced_at are locally owned and deliberately absent, or every sweep
  // would erase classification and timing.
  await chunkUpsert("replies", rows, "id");

  return {
    rowsWritten: rows.length,
    apiCalls,
    watermark: startedAt,
    detail: { pagesRead, mode: cutoff ? `incremental (${overlapHours}h overlap)` : "full" },
  };
  };
}

// --- sender emails (the Infrastructure tab) ---------------------------------

export const syncSenders: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const senders = await eb.getAllSenderEmails();

  const rows = senders.map((s) => ({
    id: s.id,
    team_id: teamId,
    email: s.email,
    name: s.name ?? null,
    // Derived here, not stored upstream — it is the whole basis of the
    // by-domain rollup, so it must be consistent for every row.
    domain: s.email?.includes("@") ? s.email.split("@").pop()!.toLowerCase() : null,
    provider: s.type ?? null,
    status: s.status ?? null,
    daily_limit: s.daily_limit ?? null,
    warmup_enabled: s.warmup_enabled ?? null,
    lifetime_sent: s.emails_sent_count ?? null,
    lifetime_bounced: s.bounced_count ?? null,
    lifetime_replied: s.total_replied_count ?? null,
    unique_replied: s.unique_replied_count ?? null,
    unique_opened: s.unique_opened_count ?? null,
    lifetime_unsubscribed: s.unsubscribed_count ?? null,
    interested_leads: s.interested_leads_count ?? null,
    leads_contacted: s.total_leads_contacted_count ?? null,
    eb_created_at: s.created_at ?? null,
    synced_at: new Date().toISOString(),
  }));

  await chunkUpsert("sender_emails", rows, "id");

  return {
    rowsWritten: rows.length,
    // 15 per page, so ~98 calls for the current estate. Cheap enough hourly,
    // and it is the only source of the Infrastructure tab's numbers.
    apiCalls: Math.ceil(rows.length / 15) + 1,
    detail: {
      senders: rows.length,
      sending: rows.filter((r) => (r.lifetime_sent ?? 0) > 0).length,
      domains: new Set(rows.map((r) => r.domain).filter(Boolean)).size,
    },
  };
};

// --- reply timing (Median Reply Time) ---------------------------------------

export const syncReplyTiming: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const sb = getSupabase();
  let apiCalls = 0;

  const { data: pending } = await sb
    .from("replies")
    .select("id, lead_id, campaign_id, date_received")
    .eq("team_id", teamId)
    .is("timing_synced_at", null)
    .not("lead_id", "is", null)
    // Newest first: a fresh reply's timing matters more than a three-month-old
    // one's, and the backlog drains from the useful end.
    //
    // 1000/run is ~470 lead calls and ~4 minutes, which sits comfortably inside
    // the hourly cadence. Steady state is ~120 new replies a day, so this cap
    // only governs how fast an initial backlog clears.
    .order("date_received", { ascending: false })
    .limit(1000);

  if (!pending?.length) return { rowsWritten: 0, apiCalls: 0 };

  const byLead = new Map<number, typeof pending>();
  for (const r of pending) {
    const list = byLead.get(r.lead_id!) ?? [];
    list.push(r);
    byLead.set(r.lead_id!, list);
  }

  const updates: Array<{ id: number; first_send_at: string | null }> = [];

  await pool([...byLead.keys()], 4, async (leadId) => {
    try {
      const payload = await eb.getLeadSentEmails(leadId);
      apiCalls++;
      const sends = Array.isArray(payload?.data) ? payload.data : [];

      for (const reply of byLead.get(leadId)!) {
        const candidates = sends
          .filter(
            (s) =>
              s.sent_at &&
              (reply.campaign_id == null || s.campaign_id === reply.campaign_id) &&
              new Date(String(s.sent_at)) < new Date(reply.date_received),
          )
          .sort(
            (a, b) =>
              new Date(String(a.sent_at)).getTime() - new Date(String(b.sent_at)).getTime(),
          );
        updates.push({
          id: reply.id,
          first_send_at: (candidates[0]?.sent_at as string) ?? null,
        });
      }
    } catch {
      /* lead deleted upstream */
    }
  });

  // Stamped even when no send was found, so a reply whose sends have aged out
  // isn't retried on every single tick forever.
  for (const u of updates) {
    await sb
      .from("replies")
      .update({ first_send_at: u.first_send_at, timing_synced_at: new Date().toISOString() })
      .eq("id", u.id);
  }

  return {
    rowsWritten: updates.length,
    apiCalls,
    detail: { resolved: updates.filter((u) => u.first_send_at).length },
  };
};

/*
 * `satisfies`, not a type annotation: `Record<string, JobFn>` would widen the
 * keys to `string` and silently disable the compile-time schedule check in
 * schedule.ts.
 */
// --- outcomes / attribution (spec §7) ---------------------------------------

interface OutcomeRow {
  id: string;
  email: string;
  event_type: string;
  occurred_at: string;
  updated_at?: string | null;
  voided?: boolean;
  campaign_id?: number | string | null;
  emailbison_lead_id?: number | null;
}

/**
 * Pulls the outcomes feed, incrementally.
 *
 * `updated_since` is driven off the watermark, so a re-run costs one page
 * instead of ten — and because the watermark only advances on success, a failed
 * run re-covers the same window rather than skipping it.
 */
export const syncOutcomes: JobFn = async ({ teamId, watermark }): Promise<JobResult> => {
  const base = (process.env.OUTCOMES_BASE_URL ?? "").replace(/\/$/, "");
  const token = process.env.OUTCOMES_TOKEN;
  if (!base || !token) {
    throw new Error("OUTCOMES_BASE_URL / OUTCOMES_TOKEN are not set");
  }

  const startedAt = new Date().toISOString();
  // Split by whether the FEED decides the attribution or the resolver does.
  const decided: Record<string, unknown>[] = [];
  const undecided: Record<string, unknown>[] = [];
  let apiCalls = 0;

  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ page: String(page), per_page: "200" });
    // A 6h overlap absorbs clock skew and any row written while the last run
    // was mid-flight; re-fetching is free because ids are stable.
    if (watermark) {
      query.set(
        "updated_since",
        new Date(new Date(watermark).getTime() - 6 * 3600_000).toISOString(),
      );
    }

    const response = await fetch(`${base}/api/outcomes?${query}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
    apiCalls++;
    if (!response.ok) {
      throw new Error(`Outcomes API ${response.status} on page ${page}`);
    }

    const body = await response.json();
    for (const o of (body.data ?? []) as OutcomeRow[]) {
      /*
       * campaign_id names THREE different things — confirmed by the person who
       * built the feed, after an earlier read of this file got it wrong:
       *
       *   integer -> an EmailBison campaign      (ours; credit it directly)
       *   UUID    -> an INSTANTLY campaign       (another sending platform)
       *   null    -> logged directly by the client, no campaign named
       *
       * Only the integer branch may ever reach resolved_campaign_id. An Instantly
       * outcome resolved through EmailBison WOULD find a lead — most of these
       * people are in both systems — and would credit one of our campaigns with a
       * result another platform earned. See 025.
       */
      const ref = o.campaign_id == null ? null : String(o.campaign_id);
      const platform = classifyPlatform(ref);
      const providedCampaign = platform === "emailbison" ? Number(ref) : null;

      /*
       * 5 of 1,923 rows arrive with no email, no lead id and no campaign — real
       * outcomes with nothing on them to attribute by. Stamped `unresolved` here
       * rather than left NULL, so the resolver's queue holds only rows it can
       * actually make progress on. They still count in the totals; see 024.
       */
      const unattributable = platform === "direct" && !o.email && !o.emailbison_lead_id;

      const row: Record<string, unknown> = {
        id: o.id,
        team_id: teamId,
        email: o.email ?? null,
        event_type: o.event_type,
        occurred_at: o.occurred_at,
        source_updated_at: o.updated_at ?? null,
        voided: Boolean(o.voided),
        source_campaign_ref: ref,
        source_platform: platform,
        source_lead_id: typeof o.emailbison_lead_id === "number" ? o.emailbison_lead_id : null,
        synced_at: new Date().toISOString(),
      };

      if (providedCampaign) {
        row.resolved_campaign_id = providedCampaign;
        row.resolution = "provided";
        row.resolved_at = new Date().toISOString();
        decided.push(row);
      } else if (platform === "instantly") {
        // Counted in every total, never credited to one of our campaigns.
        row.resolution = "other_platform";
        row.resolved_at = new Date().toISOString();
        decided.push(row);
      } else if (unattributable) {
        row.resolution = "unresolved";
        row.resolved_at = new Date().toISOString();
        decided.push(row);
      } else {
        undecided.push(row);
      }
    }

    const lastPage = Number(body.meta?.last_page) || 1;
    if (page >= lastPage) break;
    if (page >= 200) {
      console.warn("[cron] sync-outcomes: stopped at the 200-page guard");
      break;
    }
  }

  /*
   * TWO UPSERTS, AND THE SPLIT IS THE WHOLE POINT.
   *
   * `resolution` / `resolved_campaign_id` / `resolved_at` are LOCALLY OWNED for
   * a `direct` row — the resolver spent an EmailBison lookup to write them. The
   * feed has no opinion about them, so this job must not touch them.
   *
   * One mixed upsert does touch them. PostgREST builds the ON CONFLICT DO UPDATE
   * column list from the UNION of keys across the batch, so a batch holding both
   * kinds of row writes NULL into `resolution` for every row that omitted it.
   * Observed live: re-running this job reset 63 already-resolved rows to
   * pending and dropped "credited to a campaign" from 388 to 337 — the hourly
   * pair would have undone each other forever, re-spending ~800 API calls a run
   * and leaving the coverage number visibly oscillating.
   *
   * Same rule as `replies.sentiment`: a cache job never writes a column it does
   * not own.
   */
  await chunkUpsert("outcome_events", decided, "id");
  await chunkUpsert("outcome_events", undecided, "id");


  const all = [...decided, ...undecided];
  return {
    rowsWritten: all.length,
    apiCalls,
    watermark: startedAt,
    detail: {
      outcomes: all.length,
      emailbison: all.filter((r) => r.source_platform === "emailbison").length,
      instantly: all.filter((r) => r.source_platform === "instantly").length,
      direct: all.filter((r) => r.source_platform === "direct").length,
    },
  };
};

/**
 * First-touch attribution (§7: "credited back to the campaign that FIRST
 * contacted that person").
 *
 * A draining work queue, like sync-reply-timing: email -> EmailBison lead ->
 * sent-emails -> earliest send -> that campaign. Sampled against the live API
 * before building this, 19 of 20 unattributed addresses resolved to a lead.
 *
 * `resolution` is stamped even when nothing is found, so an address EmailBison
 * has never seen is not retried on every tick forever — and "we looked and
 * found nothing" stays distinguishable from "not looked at yet".
 */
export const syncOutcomeAttribution: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const sb = getSupabase();
  let apiCalls = 0;

  const { data: pending } = await sb
    .from("outcome_events")
    .select("id, email, source_lead_id")
    .eq("team_id", teamId)
    .is("resolution", null)
    .not("email", "is", null)
    // Only `direct` rows. An Instantly outcome is already fully explained, and
    // an EmailBison one already carries its campaign.
    .eq("source_platform", "direct")
    .order("occurred_at", { ascending: false })
    .limit(400);

  if (!pending?.length) return { rowsWritten: 0, apiCalls: 0 };

  // One lookup per distinct address, not per event — the same person often has
  // several outcomes.
  const byEmail = new Map<string, typeof pending>();
  for (const row of pending) {
    const key = row.email!.trim().toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), row]);
  }

  const updates: Array<{ id: string; campaignId: number | null; how: string }> = [];

  await pool([...byEmail.keys()], 4, async (email) => {
    const events = byEmail.get(email)!;
    try {
      let leadId = events.find((e) => e.source_lead_id)?.source_lead_id ?? null;
      let how = leadId ? "lead_id" : "email";

      if (!leadId) {
        const found = await eb.searchLeads(email);
        apiCalls++;
        leadId = found[0]?.id ?? null;
      }

      if (!leadId) {
        for (const e of events) updates.push({ id: e.id, campaignId: null, how: "unresolved" });
        return;
      }

      const sends = await eb.getLeadSentEmails(leadId);
      apiCalls++;
      const first = (Array.isArray(sends?.data) ? sends.data : [])
        .filter((s) => s.sent_at && s.campaign_id)
        .sort(
          (a, b) =>
            new Date(String(a.sent_at)).getTime() - new Date(String(b.sent_at)).getTime(),
        )[0];

      const campaignId = first ? Number(first.campaign_id) : null;
      if (!campaignId) how = "unresolved";
      for (const e of events) updates.push({ id: e.id, campaignId, how });
    } catch {
      // Leave it unstamped so the next run retries — a transient API failure
      // must not be recorded as "this person does not exist".
    }
  });

  for (const u of updates) {
    await sb
      .from("outcome_events")
      .update({
        resolved_campaign_id: u.campaignId,
        resolution: u.how,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", u.id);
  }

  return {
    rowsWritten: updates.length,
    apiCalls,
    detail: {
      attributed: updates.filter((u) => u.campaignId).length,
      unresolved: updates.filter((u) => !u.campaignId).length,
    },
  };
};

export const JOBS = {
  "sync-entities": syncEntities,
  "sync-steps": syncSteps,
  "sync-reply-timing": syncReplyTiming,
  "sync-senders": syncSenders,
  "sync-outcomes": syncOutcomes,
  "sync-outcome-attribution": syncOutcomeAttribution,
  // Frequent: usually one page per campaign.
  "sync-replies": makeRepliesJob(48),
  // Nightly: the full 600-call walk, which also repairs `interested` flips that
  // happened outside the incremental window.
  "sync-replies-deep": makeRepliesJob(null),
  // Recent days only: late events mutate them, older days are settled.
  "sync-daily-series": makeDailySeriesJob(7),
  // Nightly drift repair against EmailBison's own corrections.
  "sync-daily-series-deep": makeDailySeriesJob(120),
  "sync-day-stats": makeDayStatsJob(3),
  "sync-day-stats-deep": makeDayStatsJob(14),
} satisfies Record<string, JobFn>;

export const JOB_NAMES = Object.keys(JOBS);

/** Narrows an untrusted string (a URL segment, a schedule entry) to a real job. */
export function getJob(name: string): JobFn | undefined {
  return Object.hasOwn(JOBS, name)
    ? JOBS[name as keyof typeof JOBS]
    : undefined;
}
