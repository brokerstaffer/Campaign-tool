import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/server";
import { COPY_DIMENSION_KEYS } from "@/lib/analytics/copy-dimensions.ts";

/*
 * Copy tags for one sequence step (spec §6.3).
 *
 * "Tagging happens where the copy lives — on each email in the sequence editor
 * there's a small panel for setting its seven dimensions. Values can be picked
 * from the existing list or added as you go."
 *
 * So GET returns both this step's tags AND every value already in use, because
 * a free-text field with no memory produces "Question", "question" and
 * "Questions" as three different values, and the dimension table is then
 * measuring typing rather than copy.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

export async function GET(request: NextRequest) {
  const stepId = Number(request.nextUrl.searchParams.get("step_id"));
  if (!Number.isInteger(stepId) || stepId <= 0) {
    return NextResponse.json({ error: "step_id is required" }, { status: 400 });
  }

  const sb = getSupabase();
  const teamId = TEAM_ID();

  const [mine, all] = await Promise.all([
    sb
      .from("copy_tags")
      .select("dimension, value, source, confirmed_at")
      .eq("sequence_step_id", stepId)
      .eq("team_id", teamId),
    sb.from("copy_tags").select("dimension, value").eq("team_id", teamId),
  ]);

  const failed = mine.error ?? all.error;
  if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });

  const known: Record<string, string[]> = {};
  for (const key of COPY_DIMENSION_KEYS) known[key] = [];
  for (const row of all.data ?? []) {
    const list = known[row.dimension];
    if (list && !list.includes(row.value)) list.push(row.value);
  }
  for (const key of COPY_DIMENSION_KEYS) known[key].sort();

  return NextResponse.json({
    stepId,
    tags: Object.fromEntries(
      (mine.data ?? []).map((t) => [t.dimension, { value: t.value, source: t.source }]),
    ),
    known,
  });
}

/*
 * A null or empty value CLEARS that dimension — a mistag must be reversible.
 *
 * Written out rather than `z.record(z.enum(KEYS), ...)`: in zod v4 a record
 * keyed by an enum requires EVERY key, so a panel saving one changed dimension
 * was rejected for the six it didn't send.
 */
const Tag = z.string().max(80).nullable().optional();
const Body = z.object({
  sequenceStepId: z.number().int().positive(),
  tags: z
    .object({
      subject_line: Tag,
      opening: Tag,
      preposition: Tag,
      social_proof: Tag,
      cta: Tag,
      tone: Tag,
      structure: Tag,
    })
    .refine((v) => Object.keys(v).length > 0, { message: "No dimensions supplied" }),
});

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
    return NextResponse.json(
      { error: "Invalid tags", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { sequenceStepId, tags } = parsed.data;
  const sb = getSupabase();
  const teamId = TEAM_ID();

  const { data: step } = await sb
    .from("sequence_steps")
    .select("id")
    .eq("id", sequenceStepId)
    .eq("team_id", teamId)
    .maybeSingle();
  if (!step) {
    return NextResponse.json({ error: "Sequence step not found" }, { status: 404 });
  }

  // `undefined` means "not part of this update"; null/"" means "clear it".
  const entries = Object.entries(tags).filter(([, v]) => v !== undefined) as Array<
    [string, string | null]
  >;
  const upserts = entries
    .filter(([, value]) => value != null && value.trim() !== "")
    .map(([dimension, value]) => ({
      sequence_step_id: sequenceStepId,
      team_id: teamId,
      dimension,
      value: (value as string).trim(),
      // Typed by a human here. Suggestions only ever arrive from a job that
      // sets source itself, so saving one through this UI promotes it to a
      // confirmed judgement — which is exactly what §6.3 asks for.
      source: "manual",
      confirmed_at: new Date().toISOString(),
      actor: session.email,
      updated_at: new Date().toISOString(),
    }));

  const cleared = entries
    .filter(([, value]) => value == null || value.trim() === "")
    .map(([dimension]) => dimension);

  const [upsert, remove] = await Promise.all([
    upserts.length
      ? sb.from("copy_tags").upsert(upserts, { onConflict: "sequence_step_id,dimension" })
      : Promise.resolve({ error: null }),
    cleared.length
      ? sb
          .from("copy_tags")
          .delete()
          .eq("sequence_step_id", sequenceStepId)
          .in("dimension", cleared)
      : Promise.resolve({ error: null }),
  ]);

  const failed = upsert.error ?? remove.error;
  if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });

  return NextResponse.json({ ok: true, tagged: upserts.length, cleared: cleared.length });
}
