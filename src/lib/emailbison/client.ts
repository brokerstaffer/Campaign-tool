import { limited } from "./rate-limit.ts";
import type {
  EBCampaign,
  EBCampaignStats,
  EBConversationThread,
  EBDailySeriesResponse,
  EBReply,
  EBSenderEmail,
  EBSequenceStepsResponse,
  EBWorkspace,
  Paginated,
} from "./types.ts";

/*
 * EmailBison HTTP client.
 *
 * Ported from outreachify-revyops with three changes:
 *   - one instance, so the BASE_URLS map is gone (base URL is env-configurable
 *     so a second instance stays a config change, not a code change);
 *   - every request goes through the rate-limit gate;
 *   - only the methods v1 actually needs.
 *
 * Two details are carried over VERBATIM because they were clearly earned in
 * production: the error path that tries .json() then falls back to .text()
 * before throwing, and the `{data: ...}` unwrap guard on single-resource GETs
 * (EmailBison is inconsistent about wrapping).
 */

export class EmailBisonApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: unknown,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmailBisonApiError";
  }
}

function retryPolicy(error: unknown) {
  if (!(error instanceof EmailBisonApiError)) {
    // A network error (DNS, socket reset) has no status. Worth one more try.
    return error instanceof TypeError ? {} : null;
  }
  if (error.statusCode === 429 || error.statusCode >= 500) {
    return { statusCode: error.statusCode, retryAfterMs: error.retryAfterMs };
  }
  return null;
}

export interface EmailBisonClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class EmailBisonClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor({ baseUrl, apiKey }: EmailBisonClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    return limited(async () => {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
        // EmailBison is an external service and this data changes constantly.
        // Caching here would silently serve stale numbers.
        cache: "no-store",
      });

      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = await response.text().catch(() => null);
        }

        const retryAfter = response.headers.get("retry-after");
        throw new EmailBisonApiError(
          `EmailBison ${response.status} ${response.statusText} on ${endpoint}`,
          response.status,
          body,
          retryAfter ? Number(retryAfter) * 1000 : undefined,
        );
      }

      return response.json() as Promise<T>;
    }, retryPolicy);
  }

  /**
   * Walks a Laravel-style paginated endpoint to exhaustion.
   *
   * `maxPages` is a runaway guard, not a limit we expect to hit — without it, a
   * malformed `meta` (last_page: null) spins forever against a live API.
   */
  private async fetchAllPages<T>(
    endpoint: string,
    params: Record<string, string | number> = {},
    perPage = 100,
    maxPages = 500,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;

    for (;;) {
      const query = new URLSearchParams({
        ...Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
        page: String(page),
        per_page: String(perPage),
      });

      const response = await this.request<Paginated<T>>(
        `${endpoint}?${query.toString()}`,
      );
      all.push(...(response.data ?? []));

      const lastPage = Number(response.meta?.last_page);
      if (!Number.isFinite(lastPage) || page >= lastPage) break;
      if (page >= maxPages) {
        console.warn(
          `[emailbison] ${endpoint}: stopped at the ${maxPages}-page guard`,
        );
        break;
      }
      page++;
    }

    return all;
  }

  /** EmailBison sometimes wraps single resources in `{ data: ... }` and sometimes doesn't. */
  private unwrap<T extends object>(response: T | { data: T }): T {
    if (response && typeof response === "object" && "data" in response) {
      return (response as { data: T }).data;
    }
    return response as T;
  }

  // --- workspaces ------------------------------------------------------------

  /** Q1: confirms whether the token sees one workspace or several. */
  async getWorkspaces(): Promise<EBWorkspace[]> {
    const response =
      await this.request<{ data: EBWorkspace[] }>("/api/workspaces");
    return response.data ?? [];
  }

  async getWorkspaceStats(from: string, to: string) {
    return this.request<{ data: Record<string, string | number> }>(
      `/api/workspaces/v1.1/stats?start_date=${from}&end_date=${to}`,
    );
  }

  // --- campaigns -------------------------------------------------------------

  async getAllCampaigns(): Promise<EBCampaign[]> {
    return this.fetchAllPages<EBCampaign>("/api/campaigns");
  }

  async getCampaign(id: number): Promise<EBCampaign> {
    return this.unwrap(
      await this.request<EBCampaign | { data: EBCampaign }>(
        `/api/campaigns/${id}`,
      ),
    );
  }

  /**
   * Range aggregate for one campaign, including per-step stats.
   *
   * Called with `from === to` by the nightly job to build the daily table — the
   * top level feeds campaign_day_stats (total_leads_contacted is the Prospects
   * series) and sequence_step_stats feeds campaign_step_stats_daily. One call,
   * two tables. Q6 verifies a single-day range returns both correctly.
   */
  async getCampaignStats(id: number, from: string, to: string) {
    return this.request<EBCampaignStats>(`/api/campaigns/${id}/stats`, {
      method: "POST",
      body: JSON.stringify({ start_date: from, end_date: to }),
    });
  }

  async getCampaignSequenceSteps(id: number) {
    return this.request<EBSequenceStepsResponse>(
      `/api/campaigns/v1.1/${id}/sequence-steps`,
    );
  }

  async getSendingSchedules(
    day: "today" | "tomorrow" | "day_after_tomorrow" = "today",
  ) {
    return this.request<Paginated<unknown>>(
      `/api/campaigns/sending-schedules?day=${day}`,
    );
  }

  // --- sender emails ---------------------------------------------------------

  async getAllSenderEmails(): Promise<EBSenderEmail[]> {
    return this.fetchAllPages<EBSenderEmail>("/api/sender-emails");
  }

  // --- replies ---------------------------------------------------------------

  async getRepliesPage(params: {
    page?: number;
    per_page?: number;
    campaign_id?: number;
    folder?: string;
    status?: string;
  } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return this.request<Paginated<EBReply>>(
      `/api/replies${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Tracked replies for ONE campaign.
   *
   * This, not `/api/replies`, is the reply source. `/api/replies` is the master
   * inbox: ~1.9M rows, 959K of them our own outbound, most with campaign_id
   * NULL. The campaign-scoped feed returns only genuine tracked replies with a
   * real campaign_id and lead_id.
   */
  async getCampaignRepliesPage(campaignId: number, page = 1, perPage = 100) {
    return this.request<Paginated<EBReply>>(
      `/api/campaigns/${campaignId}/replies?page=${page}&per_page=${perPage}`,
    );
  }

  /** Sends made to one lead — the source for first_send_at (Median Reply Time). */
  async getLeadSentEmails(leadId: number) {
    return this.request<{ data?: Array<Record<string, unknown>> }>(
      `/api/leads/${leadId}/sent-emails`,
    );
  }

  /** Both reply timings in one call. See the Q16 note in types.ts. */
  async getConversationThread(replyId: number) {
    return this.request<EBConversationThread>(
      `/api/replies/${replyId}/conversation-thread`,
    );
  }

  // --- daily series ----------------------------------------------------------
  // Raw transport only. Endpoint selection and label mapping live in
  // daily-series.ts so there is exactly one place to change if EB moves them.

  async getDailySeries(
    path: string,
    query: URLSearchParams,
  ): Promise<EBDailySeriesResponse> {
    return this.request<EBDailySeriesResponse>(`${path}?${query.toString()}`);
  }
}

/** Builds a client from the environment. Server-only. */
export function createEmailBisonClient(): EmailBisonClient {
  const baseUrl = (
    process.env.EMAILBISON_BASE_URL || "https://send.brokerstaffer.com"
  ).replace(/\/$/, "");
  const apiKey = process.env.EMAILBISON_API_KEY;

  if (!apiKey) {
    throw new Error(
      "EMAILBISON_API_KEY is not set. See .env.example.",
    );
  }

  return new EmailBisonClient({ baseUrl, apiKey });
}
