import { createEmailBisonClient, type EmailBisonClient } from "@/lib/emailbison/client.ts";
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

  return {
    rowsWritten: campaigns.length + mappings.length,
    apiCalls,
    detail: {
      campaigns: campaigns.length,
      clients: matchable.length,
      portalClients,
      unassigned: mappings.filter((m) => !m.excluded && !m.client_id).length,
      excluded: mappings.filter((m) => m.excluded).length,
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
export const JOBS = {
  "sync-entities": syncEntities,
  "sync-steps": syncSteps,
  "sync-reply-timing": syncReplyTiming,
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
