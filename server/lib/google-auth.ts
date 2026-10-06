// server/lib/google-auth.ts — Yashwanth, Phase 1.
// One-time Google sign-in from localhost, encrypted token file, fresh access
// tokens for every Google action. Plain fetch (same pattern as the calendar
// template's google-api.ts), so no `googleapis` dependency.
// NOTE vs prompt.txt: getGoogleClient() returns a minimal
// { getAccessToken() } instead of google-auth-library's OAuth2Client.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
];

const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
export const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

export const REAUTH_ERROR =
  "Google refresh failed — re-auth needed. Open /oauth/google/start in a browser and sign in again.";

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date: number; // epoch ms
  scope?: string;
}

type Env = NodeJS.ProcessEnv;
type FetchFn = typeof fetch;

function required(e: Env, name: string): string {
  const v = e[name];
  if (!v) throw new Error(`${name} is not set. See .env.example (YASHWANTH block).`);
  return v;
}

function tokenPath(e: Env = process.env): string {
  return e.GOOGLE_TOKEN_STORE_PATH ?? "./.data/google-token.json";
}

/** Consent URL with access_type=offline + prompt=consent so we get a refresh token. */
export function getAuthUrl(e: Env = process.env): string {
  const params = new URLSearchParams({
    client_id: required(e, "GOOGLE_CLIENT_ID"),
    redirect_uri: required(e, "GOOGLE_REDIRECT_URI"),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

// --- Encrypted token store (AES-256-GCM, key = 32 bytes hex) ---

function encKey(e: Env = process.env): Buffer {
  const hex = required(e, "TOKEN_ENCRYPTION_KEY").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes as hex (64 hex chars).");
  }
  return Buffer.from(hex, "hex");
}

/** Encrypt tokens -> base64(iv | authTag | ciphertext). Exported for tests. */
export function encryptTokens(tokens: GoogleTokens, e: Env = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(e), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** Decrypt what encryptTokens produced. Exported for tests. */
export function decryptTokens(blob: string, e: Env = process.env): GoogleTokens {
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encKey(e), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as GoogleTokens;
}

async function saveTokens(tokens: GoogleTokens, e: Env = process.env): Promise<void> {
  const file = tokenPath(e);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, encryptTokens(tokens, e), { mode: 0o600 });
}

async function loadTokens(e: Env = process.env): Promise<GoogleTokens | null> {
  try {
    return decryptTokens(await fs.readFile(tokenPath(e), "utf8"), e);
  } catch {
    return null;
  }
}

async function exchangeCode(
  code: string,
  e: Env,
  fetchFn: FetchFn,
): Promise<GoogleTokens> {
  const res = await fetchFn(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({
      code,
      client_id: required(e, "GOOGLE_CLIENT_ID"),
      client_secret: required(e, "GOOGLE_CLIENT_SECRET"),
      redirect_uri: required(e, "GOOGLE_REDIRECT_URI"),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Google token exchange failed: ${data.error_description ?? data.error ?? res.statusText}`,
    );
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

async function refreshAccessToken(
  refreshToken: string,
  e: Env,
  fetchFn: FetchFn,
): Promise<GoogleTokens> {
  const res = await fetchFn(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: required(e, "GOOGLE_CLIENT_ID"),
      client_secret: required(e, "GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Google token refresh failed: ${data.error_description ?? data.error ?? res.statusText}`,
    );
  }
  return {
    access_token: data.access_token,
    refresh_token: refreshToken, // Google usually omits this on refresh
    expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/** Exchange the ?code= from the OAuth callback and persist encrypted tokens. */
export async function handleCallback(
  code: string,
  e: Env = process.env,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  if (!code) throw new Error("Missing authorization code.");
  const prev = await loadTokens(e);
  const fresh = await exchangeCode(code, e, fetchFn);
  await saveTokens({ ...fresh, refresh_token: fresh.refresh_token ?? prev?.refresh_token }, e);
}

/** Fresh access token, refreshing automatically. Throws REAUTH_ERROR when refresh fails. */
export async function getAccessToken(
  e: Env = process.env,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const tokens = await loadTokens(e);
  if (!tokens?.access_token) throw new Error(REAUTH_ERROR);
  if (tokens.expiry_date - Date.now() > 60_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error(REAUTH_ERROR);
  try {
    const fresh = await refreshAccessToken(tokens.refresh_token, e, fetchFn);
    await saveTokens(fresh, e);
    return fresh.access_token;
  } catch {
    throw new Error(REAUTH_ERROR);
  }
}

/** Minimal fetch-based client (see file header note). All Google actions use this. */
export function getGoogleClient(
  e: Env = process.env,
  fetchFn: FetchFn = fetch,
): { getAccessToken: () => Promise<string> } {
  return { getAccessToken: () => getAccessToken(e, fetchFn) };
}

// --- Authed fetch: Bearer + refresh-once on 401 + backoff on 429/5xx ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelay(attempt: number, res?: Response): number {
  const raw = res?.headers?.get("retry-after");
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  return 500 * 2 ** attempt;
}

export class GoogleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`Google API error (${status}): ${message}`);
    this.name = "GoogleApiError";
    this.status = status;
  }
}

export async function googleFetch(
  url: string,
  opts: RequestInit & { responseType?: "json" | "text" } = {},
  e: Env = process.env,
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  const { responseType, ...init } = opts;
  const wantText = responseType === "text";
  let token = await getAccessToken(e, fetchFn);
  for (let attempt = 0; attempt < 3; attempt++) {
    const headers = new Headers(opts.headers);
    headers.set("Authorization", `Bearer ${token}`);
    let res: Response;
    try {
      res = await fetchFn(url, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(retryDelay(attempt));
      continue;
    }
    if (res.status === 401 && attempt === 0) {
      // Token may have expired mid-flight: force a refresh and retry once.
      const tokens = await loadTokens(e);
      if (!tokens?.refresh_token) throw new Error(REAUTH_ERROR);
      try {
        const fresh = await refreshAccessToken(tokens.refresh_token, e, fetchFn);
        await saveTokens(fresh, e);
        token = fresh.access_token;
      } catch {
        throw new Error(REAUTH_ERROR);
      }
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await res.arrayBuffer().catch(() => undefined);
      await sleep(retryDelay(attempt, res));
      continue;
    }
    if (res.status === 204) return null;
    if (wantText) {
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new GoogleApiError(res.status, errText.slice(0, 300));
      }
      return res.text();
    }
    const data = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      throw new GoogleApiError(res.status, data?.error?.message ?? res.statusText);
    }
    return data;
  }
  throw new GoogleApiError(503, "request failed after retries");
}

// --- RFC 2822 MIME builder (shared by gmail.draft/send/reply) ---

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) {
    return subject.replace(/\r?\n/g, " "); // ASCII: header injection guard
  }
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/** Build an RFC 2822 message and base64url-encode it for Gmail send/draft. */
export function buildMimeMessage(input: {
  to: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}): { raw: string } {
  const lines = [
    `To: ${input.to.join(", ")}`,
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) lines.push(`References: ${input.references}`);
  lines.push("", input.body);
  const raw = Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { raw };
}

export function isDryRun(e: Env = process.env): boolean {
  const raw = e.DRY_RUN;
  if (raw !== undefined) return !["0", "false", "no", "off"].includes(raw.toLowerCase().trim());
  return true;
}
