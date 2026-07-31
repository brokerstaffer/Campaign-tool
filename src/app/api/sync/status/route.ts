import { NextResponse } from "next/server";
import { syncHealth } from "@/lib/sync/health";

/*
 * Sync health for the dashboard, behind the normal session auth.
 *
 * The computation lives in lib/sync/health.ts because the Railway cron
 * dispatcher needs the same answer over a bearer token (/api/cron/status), and
 * two implementations would eventually disagree.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await syncHealth());
}
