/*
 * Typed environment access.
 *
 * Two tiers deliberately:
 *   - `required(name)` throws AT CALL TIME, not at import time. A missing
 *     Supabase key must not stop the login page from rendering — it should fail
 *     loudly on the request that actually needed it, with a name in the message.
 *   - `optional(name, fallback)` for things with a sane default.
 *
 * Nothing here is exposed to the browser. There is no NEXT_PUBLIC_* variable in
 * this app: every read goes through /api/*, so the client needs no credentials.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  get emailbisonBaseUrl() {
    return optional(
      "EMAILBISON_BASE_URL",
      "https://send.brokerstaffer.com",
    ).replace(/\/$/, "");
  },
  get emailbisonApiKey() {
    return required("EMAILBISON_API_KEY");
  },
  get supabaseUrl() {
    return required("SUPABASE_URL");
  },
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get authSecret() {
    return required("AUTH_SECRET");
  },
  get authUsers() {
    return required("AUTH_USERS");
  },
  get cronSecret() {
    return required("CRON_SECRET");
  },
  get reconcileEnabled() {
    return process.env.ENABLE_RECONCILE === "true";
  },
};
