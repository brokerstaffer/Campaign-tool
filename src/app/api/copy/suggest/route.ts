import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/server";
import { suggestSubjectLineType } from "@/lib/analytics/copy-dimensions.ts";

/*
 * Seeds `subject_line` tags for untagged first emails (spec §6.3: "Where tags
 * have been suggested automatically, they're marked as such so someone can
 * confirm or correct them").
 *
 * Only this one dimension, and deliberately so. A subject's TYPE is decidable
 * from the text — a trailing question mark makes it a question, a merge tag
 * makes it variable, a "Re:" prefix makes it the thread trick. Tone,
 * preposition and social proof are judgements about intent that a rule would
 * only pretend to make, and a confident wrong tag is worse than an empty one
 * because it looks like evidence.
 *
 * Everything written here is source='suggested' and renders marked as such
 * until a human saves it.
 */

export const dynamic = "force-dynamic";

export async function POST() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = getSupabase();
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);

  const [{ data: steps }, { data: existing }] = await Promise.all([
    sb
      .from("sequence_steps")
      .select("id, email_subject, step_order, is_variant, variant_from_step_id")
      .eq("team_id", teamId),
    sb.from("copy_tags").select("sequence_step_id").eq("dimension", "subject_line"),
  ]);

  const all = steps ?? [];
  const byId = new Map(all.map((s) => [s.id, s]));
  const alreadyTagged = new Set((existing ?? []).map((t) => t.sequence_step_id));

  // First emails only, matching the analysis: step 1 plus its variants.
  const firstEmails = all.filter((s) => {
    if (!s.is_variant) return s.step_order === 1;
    const parent = s.variant_from_step_id ? byId.get(s.variant_from_step_id) : null;
    return parent?.step_order === 1;
  });

  const rows = firstEmails
    // Never overwrite an existing tag — a human's judgement outranks a rule,
    // and so does an earlier suggestion they have already corrected.
    .filter((s) => !alreadyTagged.has(s.id) && s.email_subject)
    .map((s) => ({
      sequence_step_id: s.id,
      team_id: teamId,
      dimension: "subject_line",
      value: suggestSubjectLineType(s.email_subject!),
      source: "suggested",
      confirmed_at: null,
      actor: session.email,
      updated_at: new Date().toISOString(),
    }));

  if (rows.length) {
    const { error } = await sb
      .from("copy_tags")
      .upsert(rows, { onConflict: "sequence_step_id,dimension" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    suggested: rows.length,
    skipped: firstEmails.length - rows.length,
  });
}
