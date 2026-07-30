/*
 * Session auth for an internal tool with a handful of privileged readers.
 *
 * An HMAC-signed cookie carrying `base64url(email).expiresAt.signature`, signed
 * and verified with Web Crypto so the *same* functions run in the Edge proxy and
 * in Node route handlers. Zero dependencies, no session store, no JWT library.
 *
 * Credentials live in AUTH_USERS as a list of `email:sha256hex` pairs, so adding
 * a teammate is an env change and no password is ever stored in plaintext.
 * SHA-256 (not bcrypt/argon2) is a deliberate, bounded trade-off: this is a
 * fixed, tiny, operator-provisioned user set with no self-service signup, and
 * Web Crypto has no KDF that works identically in Edge and Node without pulling
 * a dependency. If this ever grows real user accounts, that trade-off expires.
 */

const COOKIE_NAME = "bsa_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RENEW_WHEN_UNDER_MS = 7 * 24 * 60 * 60 * 1000; // reissue with <7d left

export const AUTH_COOKIE = COOKIE_NAME;

// --- encoding helpers --------------------------------------------------------

const encoder = new TextEncoder();

function base64UrlEncode(input: string): string {
  const bytes = encoder.encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison. `a === b` short-circuits on the first
 * differing byte, which leaks how much of a forged signature was correct.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- crypto ------------------------------------------------------------------

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

// --- credentials -------------------------------------------------------------

/** Parses AUTH_USERS: `email:sha256hex` pairs separated by newlines or commas. */
function parseAuthUsers(raw: string): Map<string, string> {
  const users = new Map<string, string>();
  for (const entry of raw.split(/[\n,]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.lastIndexOf(":");
    if (separator === -1) continue;
    const email = trimmed.slice(0, separator).trim().toLowerCase();
    const hash = trimmed.slice(separator + 1).trim().toLowerCase();
    if (email && hash) users.set(email, hash);
  }
  return users;
}

/**
 * Verifies a login. Always hashes the supplied password even when the email is
 * unknown, so a wrong-email response takes the same time as a wrong-password
 * one and the endpoint can't be used to enumerate valid addresses.
 */
export async function credentialsMatch(
  authUsers: string,
  email: string,
  password: string,
): Promise<boolean> {
  const users = parseAuthUsers(authUsers);
  const supplied = await sha256Hex(password);
  const expected = users.get(email.trim().toLowerCase());
  if (!expected) {
    safeEqual(supplied, supplied); // keep the timing profile flat
    return false;
  }
  return safeEqual(supplied, expected);
}

// --- session token -----------------------------------------------------------

export async function createSessionToken(
  secret: string,
  email: string,
  now = Date.now(),
): Promise<string> {
  const expiresAt = now + SESSION_TTL_MS;
  const payload = `${base64UrlEncode(email)}.${expiresAt}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export interface Session {
  email: string;
  expiresAt: number;
}

/** Returns the session, or null if the token is malformed, forged or expired. */
export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): Promise<Session | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedEmail, rawExpiry, signature] = parts;
  const payload = `${encodedEmail}.${rawExpiry}`;

  // Verify the signature BEFORE trusting any field inside the payload.
  if (!safeEqual(signature, await hmac(secret, payload))) return null;

  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  try {
    return { email: base64UrlDecode(encodedEmail), expiresAt };
  } catch {
    return null;
  }
}

/** True when the session is valid but close enough to expiry to reissue. */
export function shouldRenew(session: Session, now = Date.now()): boolean {
  return session.expiresAt - now < RENEW_WHEN_UNDER_MS;
}

export function sessionCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
