import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
 * The merge tags this workspace can actually fill in (spec §9.3: "insert
 * personalisation placeholders from a menu rather than typing them by hand").
 *
 * READ FROM THE DATA, NOT HARDCODED, because the hardcoded list was wrong.
 * The editor offered {COMPANY_NAME}, {JOB_TITLE}, {CITY} and {STATE} — none of
 * which appear in a single one of the 299 sequence steps, and none of which
 * correspond to anything on a lead here. Inserting one would have put a
 * placeholder into a live email that merges to nothing.
 *
 * What IS in use, counted across every step:
 *
 *   {FIRST_NAME}          324
 *   {TOP PRODUCING CITY}    6
 *   {PHONE NUMBER}          2
 *
 * The last two are custom variables, and that is the pattern: a lead's custom
 * variable is addressable as its name in capitals. We already sync all twelve
 * of them into `lead_attributes` for the Replies view, so the menu can offer
 * exactly what this workspace can merge — and stops offering one that is
 * removed upstream.
 *
 * NOTE ON BRACES: merge tags use SINGLE braces, the same delimiter as spintax
 * `{a|b}`. They are told apart by the pipe, which is why the spintax parser
 * requires one. A tag containing a pipe would be ambiguous; none do.
 */

/** Built-ins, kept because they are not lead custom variables. */
const BUILT_IN = ["FIRST_NAME", "LAST_NAME", "EMAIL", "COMPANY"];

export async function GET() {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);

  const { data, error } = await getSupabase()
    .from("lead_attributes")
    .select("name")
    .eq("team_id", teamId)
    .limit(5000);

  if (error) {
    // Degrade to the built-ins rather than an empty menu: a personalisation
    // menu that offers nothing is worse than one offering only the basics.
    return NextResponse.json({ tags: BUILT_IN.map((t) => `{${t}}`), degraded: true });
  }

  const fromLeads = [
    ...new Set((data ?? []).map((r) => String(r.name).trim().toUpperCase()).filter(Boolean)),
  ].sort();

  return NextResponse.json({
    tags: [
      ...BUILT_IN.map((t) => `{${t}}`),
      ...fromLeads.filter((t) => !BUILT_IN.includes(t)).map((t) => `{${t}}`),
    ],
    degraded: false,
  });
}
