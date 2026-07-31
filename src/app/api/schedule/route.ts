import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/emailbison/errors.ts";
import { getSupabase } from "@/lib/supabase/server";

/*
 * The sending forecast (spec §10).
 *
 * "Choose Today, Tomorrow or Day after tomorrow and see how many emails each
 * campaign is due to send, grouped by client with per-client totals. If a
 * client's schedule can't be retrieved, that's shown against that client rather
 * than silently omitted."
 *
 * This is the one screen that CANNOT read from the cache: a forecast is about
 * what EmailBison intends to do next, and nothing in Supabase knows that. So it
 * is a live call — but only two of them (the endpoint pages at 15/page), and
 * the client grouping still comes from the local mapping.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

const Day = z.enum(["today", "tomorrow", "day_after_tomorrow"]);

interface ScheduleRow {
  campaignId: number;
  name: string;
  status: string;
  emails: number;
}

interface ScheduleGroup {
  clientId: string | null;
  name: string;
  rows: ScheduleRow[];
}

export async function GET(request: NextRequest) {
  const parsed = Day.safeParse(request.nextUrl.searchParams.get("day") ?? "today");
  if (!parsed.success) {
    return NextResponse.json(
      { error: "day must be today, tomorrow or day_after_tomorrow" },
      { status: 400 },
    );
  }
  const day = parsed.data;
  const sb = getSupabase();
  const teamId = TEAM_ID();

  let schedules: Array<{ campaign_id: number; emails_being_sent: number }> = [];
  let fetchError: string | null = null;

  try {
    schedules = await createEmailBisonClient().getAllSendingSchedules(day);
  } catch (error) {
    // §10: report the failure rather than render an empty forecast, which reads
    // identically to "nothing is scheduled" — the opposite conclusion.
    fetchError = describeEmailBisonError(error);
  }

  const [{ data: campaigns }, { data: mappings }, { data: clients }] = await Promise.all([
    sb.from("campaigns").select("id, name, status").eq("team_id", teamId),
    sb.from("campaign_clients").select("campaign_id, client_id, excluded"),
    sb.from("clients").select("id, name").eq("team_id", teamId),
  ]);

  const campaignById = new Map((campaigns ?? []).map((c) => [c.id, c]));
  const mappingBy = new Map((mappings ?? []).map((m) => [m.campaign_id, m]));
  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name]));

  const groups = new Map<string, ScheduleGroup>();

  for (const entry of schedules) {
    const campaign = campaignById.get(entry.campaign_id);
    const mapping = mappingBy.get(entry.campaign_id);

    // Excluded campaigns (templates, internal lists) are not client work and
    // would inflate every total they appear in.
    if (mapping?.excluded) continue;

    const clientId = mapping?.client_id ?? null;
    const key = clientId ?? "__unassigned";
    const group: ScheduleGroup = groups.get(key) ?? {
      clientId,
      name: clientId ? (clientName.get(clientId) ?? "Unknown client") : "Unassigned",
      rows: [],
    };
    group.rows.push({
      campaignId: entry.campaign_id,
      // A campaign scheduled to send but missing from our cache is new since
      // the last sync — named by id rather than dropped from the forecast.
      name: campaign?.name ?? `Campaign #${entry.campaign_id}`,
      status: campaign?.status ?? "unknown",
      emails: Number(entry.emails_being_sent) || 0,
    });
    groups.set(key, group);
  }

  const clientGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      total: group.rows.reduce((sum, r) => sum + r.emails, 0),
      rows: group.rows.sort((a, b) => b.emails - a.emails),
    }))
    // Unassigned last: it is a to-do list, not a client.
    .sort((a, b) =>
      a.clientId === null ? 1 : b.clientId === null ? -1 : b.total - a.total,
    );

  return NextResponse.json({
    day,
    error: fetchError,
    groups: clientGroups,
    total: clientGroups.reduce((sum, g) => sum + g.total, 0),
    campaignCount: clientGroups.reduce((sum, g) => sum + g.rows.length, 0),
  });
}
