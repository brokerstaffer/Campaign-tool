import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/*
 * Server-only Supabase access, service-role.
 *
 * There is deliberately NO browser client and no anon key in this app. Every
 * read goes through /api/analytics/*, which means:
 *   - the browser holds no database credential at all;
 *   - RLS is not load-bearing for security here, so v1 doesn't need an RLS
 *     design to be safe;
 *   - adding scoped client-facing access later is a change to the API layer
 *     rather than a schema-wide migration.
 *
 * Constructed lazily so a missing env var fails on the request that needed the
 * database, with a named variable in the message — not at import time, which
 * would take down the login page too.
 */

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      // No user sessions on this client — it is a machine credential.
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      fetch: (input, init) =>
        // Next's fetch caches aggressively by default; analytics reads must
        // never be served from a stale Data Cache entry.
        fetch(input, { ...init, cache: "no-store" }),
    },
  });

  return client;
}

/**
 * PostgREST caps result sets at 1000 rows and TRUNCATES SILENTLY — `.range()`
 * can only shrink that, never raise it. Any full-table read must page.
 *
 * In practice v1 should almost never need this: all aggregation happens in SQL
 * RPCs. It exists for sync jobs that genuinely have to walk a table.
 */
export async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;

    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}
