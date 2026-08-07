/*
 * EmailBison response shapes.
 *
 * These describe what EmailBison ACTUALLY returns, not what we wish it returned
 * — several fields come back as strings where you'd expect numbers (the stats
 * endpoint is the worst offender), and that is faithfully typed here so the
 * parsing happens once, in transforms.ts, rather than being rediscovered at
 * every call site.
 *
 * Anything marked UNVERIFIED is inferred from the OpenAPI spec and must be
 * confirmed by scripts/probe-eb.mjs before code depends on it.
 */

/*
 * Both pagination shapes, because EmailBison returns a different `meta`
 * depending on `pagination_type`:
 *
 *   page mode   -> current_page, last_page, per_page, total
 *   cursor mode -> path, per_page, next_cursor, prev_cursor   (no total!)
 *
 * Everything that walks a list uses cursor mode — page mode is capped at 1000
 * pages and truncates silently. So `total` and `last_page` are optional here:
 * relying on them would be relying on fields the walk never receives.
 */
export interface Paginated<T> {
  data: T[];
  meta?: {
    current_page?: number;
    last_page?: number;
    per_page?: number;
    total?: number;
    /** Cursor mode. `null` is the documented end-of-data marker. */
    next_cursor?: string | null;
    prev_cursor?: string | null;
  };
  links?: { next: string | null; prev: string | null };
}

export interface EBTag {
  id: number;
  name: string;
  default?: boolean;
}

export interface EBCampaign {
  id: number;
  uuid?: string;
  sequence_id?: number;
  name: string;
  type?: string;
  status: string;
  emails_sent?: number;
  opened?: number;
  unique_opens?: number;
  replied?: number;
  unique_replies?: number;
  bounced?: number;
  unsubscribed?: number;
  interested?: number;
  total_leads?: number;
  total_leads_contacted?: number;
  max_emails_per_day?: number;
  max_new_leads_per_day?: number;
  completion_percentage?: number;
  // Settings, returned on every campaign list response.
  plain_text?: boolean;
  open_tracking?: boolean;
  can_unsubscribe?: boolean;
  unsubscribe_text?: string | null;
  include_auto_replies_in_stats?: boolean;
  sequence_prioritization?: string;
  tags?: Array<EBTag | string>;
  created_at?: string;
  updated_at?: string;
}

export interface EBSequenceStep {
  id: number;
  active?: boolean;
  email_subject: string;
  email_body: string;
  order: number | string;
  wait_in_days: number | string;
  variant?: boolean;
  variant_from_step_id?: number | null;
  thread_reply?: boolean;
  attachments?: unknown[];
  created_at?: string;
  updated_at?: string;
}

/** GET /api/campaigns/v1.1/{id}/sequence-steps */
export interface EBSequenceStepsResponse {
  data: {
    sequence_id: number;
    sequence_steps: EBSequenceStep[];
  };
}

export interface EBSenderEmail {
  id: number;
  name: string | null;
  email: string;
  /** The provider: google_workspace_oauth, smtp, microsoft_oauth, … */
  type?: string;
  status?: string;
  daily_limit?: number;
  warmup_enabled?: boolean;
  // Lifetime counters, all on the list response.
  emails_sent_count?: number;
  bounced_count?: number;
  total_replied_count?: number;
  unique_replied_count?: number;
  unique_opened_count?: number;
  total_opened_count?: number;
  unsubscribed_count?: number;
  interested_leads_count?: number;
  total_leads_contacted_count?: number;
  created_at?: string;
  tags?: EBTag[];
}

export interface EBReply {
  id: number;
  uuid?: string;
  folder?: string;
  subject?: string;
  read?: boolean;
  interested?: boolean;
  automated_reply?: boolean;
  html_body?: string | null;
  text_body?: string | null;
  date_received: string;
  type?: string;
  tracked_reply?: boolean;
  scheduled_email_id?: number | null;
  campaign_id?: number | null;
  lead_id?: number | null;
  sender_email_id?: number | null;
  parent_id?: number | null;
  from_name?: string | null;
  from_email_address?: string | null;
  primary_to_email_address?: string | null;
}

/**
 * GET /api/replies/{id}/conversation-thread
 *
 * This is the single most important shape in the app — it is what replaces an
 * entire per-send event table. `older_messages` yields the first send to the
 * lead (Median Reply Time); `newer_messages` yields our first outbound after
 * their reply (Median Follow-up Time).
 *
 * !! Q16: how a message's DIRECTION is determined is UNVERIFIED. revyops
 * derives it from `folder === 'sent'` in one place and hardcodes it in another,
 * which suggests EmailBison's signal is not clean. The fallback is matching
 * `from_email_address` against our synced sender_emails. probe-eb.mjs answers
 * this before reply-timing.ts is written.
 */
export interface EBConversationThread {
  data: {
    current_reply: EBReply;
    older_messages: EBReply[];
    newer_messages: EBReply[];
  };
}

/** POST /api/campaigns/{id}/stats — NOTE: every numeric comes back as a STRING. */
export interface EBCampaignStats {
  data: {
    emails_sent: string | number;
    total_leads_contacted: string | number;
    opened: string | number;
    opened_percentage?: string | number;
    unique_opens_per_contact?: string | number;
    unique_replies_per_contact?: string | number;
    bounced: string | number;
    unsubscribed: string | number;
    interested: string | number;
    sequence_step_stats?: EBSequenceStepStat[];
  };
}

export interface EBSequenceStepStat {
  sequence_step_id: number;
  email_subject: string;
  sent: number;
  leads_contacted: number;
  unique_opens: number;
  unique_replies: number;
  unsubscribed: number;
  bounced: number;
  interested: number;
}

/**
 * The daily-series envelope, shared by all three series endpoints:
 *   GET /api/campaign-events/stats
 *   GET /api/campaigns/{id}/line-area-chart-stats
 *   GET /api/workspaces/v1.1/line-area-chart-stats
 *
 * `dates` is an array of [ISO date, value] tuples.
 * Labels: Replied · Total Opens · Unique Opens · Sent · Bounced ·
 *         Unsubscribed · Interested
 */
export interface EBDailySeriesResponse {
  data: Array<{
    label: string;
    color: string;
    dates: Array<[string, number]>;
  }>;
}

export interface EBWorkspace {
  id: number;
  name: string;
  personal_team?: boolean;
  main?: boolean;
}

/**
 * A lead, as EmailBison returns it.
 *
 * `company` is the agent's CURRENT employer (EXP Realty, Compass, ...), which is
 * not the client we recruit for — those are two different groupings and the
 * Replies view exposes both. See 027_reply_dimensions.sql.
 *
 * `custom_variables` is an array of {name, value}, per-workspace and open-ended:
 * office city, sales volume, mls affiliation, top producing city, estimated gci,
 * closed transactions, average sales price, buy-side, list-side, closed rentals.
 */
export interface EBLead {
  id: number;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  status?: string | null;
  custom_variables?: Array<{ name?: string; value?: string | null }> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * One sent email from `/api/scheduled-emails?status=sent`.
 *
 * The nested `lead` is the whole lead record — probed on 150 rows, every one
 * carried it with its custom_variables — which is what makes this feed the
 * cheapest source of both campaign membership and lead detail.
 *
 * `opens` / `clicks` are MUTABLE: they accrue for days after `sent_at`, which
 * is why the sync stores raw send rows rather than summing into a rollup.
 */
export interface EBSentEmail {
  id: number;
  campaign_id?: number | null;
  sequence_step_id?: number | null;
  thread_reply?: boolean | null;
  sent_at?: string | null;
  opens?: number | null;
  unique_opens?: number | null;
  clicks?: number | null;
  lead?: EBLead | null;
  sender_email?: { id?: number | null } | null;
}
