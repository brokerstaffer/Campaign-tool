import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  AUTH_COOKIE,
  createSessionToken,
  credentialsMatch,
  sessionCookieOptions,
} from "@/lib/auth";
import { env } from "@/lib/env";

const bodySchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = bodySchema.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: "Malformed request" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "Malformed request" }, { status: 400 });
  }

  const { email, password } = parsed.data;

  let ok: boolean;
  try {
    ok = await credentialsMatch(env.authUsers, email, password);
  } catch {
    // AUTH_USERS / AUTH_SECRET missing. Distinguish from a bad password in the
    // log, but not in the response — an unauthenticated caller learns nothing.
    console.error("[auth] login failed: auth env not configured");
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  if (!ok) {
    // One message for both wrong-email and wrong-password.
    return NextResponse.json(
      { error: "Incorrect email or password" },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    AUTH_COOKIE,
    await createSessionToken(env.authSecret, email.trim().toLowerCase()),
    sessionCookieOptions(request.nextUrl.protocol === "https:"),
  );
  return response;
}
