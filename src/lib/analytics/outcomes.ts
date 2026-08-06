/*
 * The outcome vocabulary — the one place an event_type is named or ordered.
 *
 * The spec (§7) lists "Introduction · Phone Screen · Meeting · Hire · No-show".
 * The live feed says something adjacent but not identical, which is why this
 * file exists rather than a switch at the render site:
 *
 *   introduction 1171 · no_show 258 · we_they_rejected 227 · keep_warm 101
 *   interview 74 · phone_screen 41 · phone_screen_scheduled 35
 *   interview_scheduled 13 · hired 3
 *
 * Two things follow from that list.
 *
 * FIRST, ORDER IS DATA, NOT A GUESS AT RENDER TIME. A funnel that cannot say
 * phone_screen comes before hired is a bar chart with extra steps. `STAGE_ORDER`
 * is the progression; anything not in it is an off-funnel state.
 *
 * SECOND, THE VOCABULARY IS OPEN. `no_show`, `we_they_rejected` and `keep_warm`
 * are not stages a person passes through — they are where a person stopped.
 * Putting them in a funnel would make it read as though 258 people advanced to
 * "no show". They get their own section. An event type that appears tomorrow and
 * is in neither list still renders, under its own name, rather than vanishing —
 * a silently dropped outcome is indistinguishable from an outcome that never
 * happened.
 */

export const STAGE_ORDER = [
  "introduction",
  "phone_screen_scheduled",
  "phone_screen",
  "interview_scheduled",
  "interview",
  "hired",
] as const;

export type Stage = (typeof STAGE_ORDER)[number];

/** Where a person stopped, not a step they passed through. */
export const TERMINAL_TYPES = ["no_show", "we_they_rejected", "keep_warm"] as const;

const LABELS: Record<string, string> = {
  introduction: "Introduction",
  phone_screen_scheduled: "Phone Screen Scheduled",
  phone_screen: "Phone Screen",
  interview_scheduled: "Interview Scheduled",
  interview: "Interview",
  hired: "Hired",
  no_show: "No-show",
  we_they_rejected: "Rejected",
  keep_warm: "Keep Warm",
};

/** Title-cases an unmapped type rather than dropping it. */
export function outcomeLabel(type: string): string {
  return (
    LABELS[type] ??
    type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function isStage(type: string): type is Stage {
  return (STAGE_ORDER as readonly string[]).includes(type);
}

export function isTerminal(type: string): boolean {
  return (TERMINAL_TYPES as readonly string[]).includes(type);
}

/**
 * The conversion measures from §7: "how many emails it takes to earn one
 * introduction", and the same through to a call and to a hire.
 *
 * Rendered as `1 : N` by `leadToEmail`/`ratio`, same as Lead-to-Email in the KPI
 * band — the ratio a reader already knows how to read on this dashboard.
 */
export const CONVERSION_MEASURES = [
  { key: "introduction", label: "Email to Introduction", types: ["introduction"] },
  {
    key: "phone_screen",
    label: "Email to Phone Call",
    // Both the scheduled and the held event count as reaching a call, because
    // the question is "how much sending buys a conversation".
    types: ["phone_screen", "phone_screen_scheduled"],
  },
  { key: "interview", label: "Email to Interview", types: ["interview", "interview_scheduled"] },
  { key: "hired", label: "Email to Hire", types: ["hired"] },
] as const;

/*
 * Where an outcome came from.
 *
 * `campaign_id` on the feed carries an EmailBison integer, an Instantly UUID, or
 * nothing at all — three different things in one column. Only the first can be
 * credited to a campaign here; see 025_outcome_platform.sql.
 */
export const PLATFORM_LABELS: Record<string, string> = {
  emailbison: "EmailBison",
  instantly: "Instantly",
  direct: "Logged directly",
};

export type OutcomePlatform = "emailbison" | "instantly" | "direct";

/**
 * Which platform a raw `campaign_id` names.
 *
 * The single rule that keeps another platform's results out of our campaign
 * numbers, so it lives here and is tested rather than being a regex inline in
 * the sync job. Only `emailbison` may ever reach `resolved_campaign_id`.
 */
export function classifyPlatform(ref: string | number | null | undefined): OutcomePlatform {
  if (ref == null || ref === "") return "direct";
  const value = String(ref).trim();
  if (/^\d+$/.test(value)) return "emailbison";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return "instantly";
  }
  // Anything else is unrecognised. `direct` is the safe landing: it means
  // "no campaign named", which routes the row to first-touch lookup instead of
  // crediting a campaign that may not be ours.
  return "direct";
}

export const RESOLUTION_LABELS: Record<string, string> = {
  provided: "Campaign given by the feed",
  email: "Matched by email to first send",
  lead_id: "Matched by lead id",
  other_platform: "Instantly — not an EmailBison campaign",
  unresolved: "No EmailBison campaign found",
  /*
   * A campaign WAS found by email — and discarded, because it belonged to a
   * different client than the one MasterInbox names as the owner. The same
   * agents are prospected by several brokerages, so first-touch finds the wrong
   * one constantly: measured at 719 wrong against 36 right. The outcome still
   * counts for its client; it just no longer claims a campaign.
   */
  client_mismatch: "Belongs to this client, but no campaign we can prove",
  pending: "Not yet resolved",
};
