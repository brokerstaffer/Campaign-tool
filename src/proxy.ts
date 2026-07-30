import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_COOKIE,
  createSessionToken,
  sessionCookieOptions,
  shouldRenew,
  verifySessionToken,
} from "@/lib/auth";

/*
 * Next 16 renamed middleware to `proxy`. Same execution model: Edge runtime,
 * runs before every matched request.
 *
 * Order matters here — public paths are checked before the session is read, so
 * a broken AUTH_SECRET can't lock out the login page or the cron endpoints.
 *
 * `/api/cron/*` is exempt because it authenticates itself with a bearer token;
 * it is machine-called by Railway and has no cookie. There is deliberately NO
 * `/api/webhooks/*` exemption — this app has no inbound webhook surface, and so
 * no unauthenticated write path at all.
 */

const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/cron"];

const HOME = "/analytics/campaign";

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const secret = process.env.AUTH_SECRET;

  // Without a secret nothing can be verified. Fail closed rather than open,
  // but keep public paths reachable so the failure is diagnosable.
  if (!secret) {
    if (isPublic(pathname)) return NextResponse.next();
    return NextResponse.redirect(new URL("/login?error=config", request.url));
  }

  const token = request.cookies.get(AUTH_COOKIE)?.value;
  const session = await verifySessionToken(secret, token);

  if (isPublic(pathname)) {
    // An authenticated user landing on /login goes straight to the dashboard.
    if (session && pathname === "/login") {
      return NextResponse.redirect(new URL(HOME, request.url));
    }
    return NextResponse.next();
  }

  if (!session) {
    // API routes get a 401 rather than an HTML redirect, so fetch() callers see
    // a status they can act on instead of parsing a login page as JSON.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === "/") {
    return NextResponse.redirect(new URL(HOME, request.url));
  }

  const response = NextResponse.next();

  // Sliding expiry: reissue when under a week remains so an active user is
  // never logged out mid-session.
  if (shouldRenew(session)) {
    response.cookies.set(
      AUTH_COOKIE,
      await createSessionToken(secret, session.email),
      sessionCookieOptions(request.nextUrl.protocol === "https:"),
    );
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static assets. Matching _next/* would
     * run this on every chunk request for no benefit.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
