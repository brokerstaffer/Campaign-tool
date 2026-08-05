import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
 * Which breakdowns a client sees on the Replies view (spec §5.5).
 *
 * "These groupings are configurable per client. Brokerage, office, county and
 *  sales volume are the ones that matter for this client; another client can be
 *  set up with their own list without a rebuild."
 *
 * The table has supported this since 027 — a row with `client_id = NULL` is the
 * default set and a row with a client_id overrides it — but nothing could edit
 * it, so "configurable" meant "editable in SQL". This is that screen's backend.
 *
 * TURNING A DIMENSION OFF FOR A CLIENT IS A COPY-ON-WRITE, NOT A DELETE: the
 * default row is shared by every client, so deactivating it there would remove
 * the card for everyone. Instead a client-specific row is written with
 * active = false, which the resolver already prefers over the default.
 */

const Body = z.object({
  clientId: z.string().uuid(),
  key: z.string().min(1),
  active: z.boolean(),
});

export async function GET(request: NextRequest) {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);
  const clientId = request.nextUrl.searchParams.get("client_id");

  const sb = getSupabase();
  const [defaults, overrides] = await Promise.all([
    sb
      .from("reply_dimensions")
      .select("key, label, source, sort_position, active")
      .eq("team_id", teamId)
      .is("client_id", null)
      .order("sort_position"),
    clientId
      ? sb
          .from("reply_dimensions")
          .select("key, active")
          .eq("team_id", teamId)
          .eq("client_id", clientId)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (defaults.error) {
    return NextResponse.json({ error: defaults.error.message }, { status: 500 });
  }

  const overrideBy = new Map(
    ((overrides.data ?? []) as Array<{ key: string; active: boolean }>).map((r) => [
      r.key,
      r.active,
    ]),
  );

  return NextResponse.json({
    dimensions: (defaults.data ?? []).map((d) => ({
      key: d.key,
      label: d.label,
      source: d.source,
      // What this client actually sees: their override, else the default.
      active: overrideBy.has(d.key) ? overrideBy.get(d.key) : d.active,
      overridden: overrideBy.has(d.key),
    })),
  });
}

export async function PUT(request: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { clientId, key, active }" }, { status: 400 });
  }

  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);
  const sb = getSupabase();

  const { data: base, error: baseError } = await sb
    .from("reply_dimensions")
    .select("label, source, source_key, bucket, sort_position")
    .eq("team_id", teamId)
    .is("client_id", null)
    .eq("key", parsed.data.key)
    .maybeSingle();

  if (baseError) return NextResponse.json({ error: baseError.message }, { status: 500 });
  if (!base) return NextResponse.json({ error: "Unknown dimension" }, { status: 404 });

  // Copy-on-write: the client gets its own row rather than editing the shared
  // default, so one client's choice cannot change what another client sees.
  const { error } = await sb.from("reply_dimensions").upsert(
    {
      team_id: teamId,
      client_id: parsed.data.clientId,
      key: parsed.data.key,
      label: base.label,
      source: base.source,
      source_key: base.source_key,
      bucket: base.bucket,
      sort_position: base.sort_position,
      active: parsed.data.active,
    },
    { onConflict: "team_id,client_id,key" },
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
