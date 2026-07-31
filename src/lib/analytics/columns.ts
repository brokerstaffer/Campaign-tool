import {
  compactNumber,
  duration,
  fullNumber,
  percent,
  ratio,
} from "./format.ts";
import {
  bounceRate,
  humanRate,
  leadToEmail,
  positiveRate,
  replyRate,
} from "./metrics.ts";

/*
 * The Campaigns-table column registry.
 *
 * One place defines what a column is called, which group it belongs to, how it
 * renders, and whether it's on by default. The picker, the header, the body and
 * the localStorage preferences all read from here — so adding a column is one
 * entry, not four edits that can drift.
 */

export interface CampaignRow {
  campaignId: number;
  campaignName: string;
  clientName: string | null;
  status: string | null;
  stepCount: number;
  sent: number;
  prospects: number;
  replies: number;
  humanReplies: number;
  positive: number;
  negative: number;
  neutral: number;
  botReplies: number;
  bounces: number;
  medianReplySeconds: number | null;
}

export type ColumnGroup =
  | "Volume"
  | "Rates"
  | "Reply Sentiment"
  | "Reply Source"
  | "Timing";

export interface ColumnDef {
  key: string;
  label: string;
  group: ColumnGroup;
  defaultVisible: boolean;
  render: (row: CampaignRow) => string;
  /** Draws attention when non-zero — the reference underlines Bounces. */
  emphasizeNonZero?: boolean;
}

export const COLUMNS: ColumnDef[] = [
  // Volume
  { key: "sent", label: "Sent", group: "Volume", defaultVisible: true, render: (r) => fullNumber(r.sent) },
  { key: "prospects", label: "Prospects", group: "Volume", defaultVisible: false, render: (r) => fullNumber(r.prospects) },
  { key: "replies", label: "Replies", group: "Volume", defaultVisible: true, render: (r) => fullNumber(r.replies) },
  {
    key: "bounces",
    label: "Bounces",
    group: "Volume",
    defaultVisible: true,
    render: (r) => fullNumber(r.bounces),
    emphasizeNonZero: true,
  },

  // Rates
  { key: "replyRate", label: "Reply %", group: "Rates", defaultVisible: true, render: (r) => percent(replyRate(r.replies, r.sent), 2) },
  { key: "humanRate", label: "Human %", group: "Rates", defaultVisible: true, render: (r) => percent(humanRate(r.humanReplies, r.sent), 2) },
  { key: "positiveRate", label: "Positive %", group: "Rates", defaultVisible: true, render: (r) => percent(positiveRate(r.positive, r.replies), 2) },
  { key: "bounceRate", label: "Bounce %", group: "Rates", defaultVisible: false, render: (r) => percent(bounceRate(r.bounces, r.sent), 2) },
  { key: "leadToEmail", label: "Lead:Email", group: "Rates", defaultVisible: true, render: (r) => ratio(leadToEmail(r.sent, r.positive)) },

  // Reply sentiment. `negative` is honestly 0 until a classifier exists —
  // EmailBison's `interested` is a positive signal only, with no negative
  // counterpart. Shipping the column at 0 is truthful; inventing one is not.
  { key: "sentimentPositive", label: "+", group: "Reply Sentiment", defaultVisible: false, render: (r) => fullNumber(r.positive) },
  { key: "sentimentNegative", label: "−", group: "Reply Sentiment", defaultVisible: false, render: (r) => fullNumber(r.negative) },
  { key: "sentimentNeutral", label: "~", group: "Reply Sentiment", defaultVisible: false, render: (r) => fullNumber(r.neutral) },

  // Reply source — EmailBison's own automated-reply heuristic.
  { key: "sourceHuman", label: "Human", group: "Reply Source", defaultVisible: false, render: (r) => fullNumber(r.humanReplies) },
  { key: "sourceBot", label: "Bot", group: "Reply Source", defaultVisible: false, render: (r) => fullNumber(r.botReplies) },

  // Timing
  { key: "medianReply", label: "Median Reply", group: "Timing", defaultVisible: true, render: (r) => duration(r.medianReplySeconds) },
];

export const COLUMN_GROUPS: ColumnGroup[] = [
  "Volume",
  "Rates",
  "Reply Sentiment",
  "Reply Source",
  "Timing",
];

export const DEFAULT_VISIBLE = COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);

/*
 * Bumped whenever the column set changes. The stored preference is discarded on
 * mismatch, so adding a column doesn't resurrect a stale selection that hides
 * it forever — the classic "why can't I see the new column" bug.
 */
export const COLUMN_PREFS_VERSION = 1;
export const COLUMN_PREFS_KEY = "bsa.campaign-columns.v1";

/** Sort keys the server understands. Anything else falls back to `sent`. */
export const SORTABLE = new Set([
  "sent",
  "prospects",
  "replies",
  "positive",
  "bounces",
]);

export { compactNumber };
