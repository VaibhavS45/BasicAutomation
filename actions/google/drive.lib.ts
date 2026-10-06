// actions/google/drive.lib.ts — Yashwanth, Phase 7/8. Shared Drive helpers.
// All Drive actions import from here; googleFetch (with its 429/5xx retry +
// backoff) stays in server/lib/google-auth.ts and is NOT reimplemented.
import { GoogleApiError, REAUTH_ERROR } from "../../server/lib/google-auth.js";

export const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

/** Google-native types must use /export; everything else uses ?alt=media. */
export const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export function isNativeType(mimeType: string): boolean {
  return mimeType in EXPORT_MIME;
}

/** Escape backslashes/quotes for a Drive query string literal. Pure. */
export function escapeQueryLiteral(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Read cap for drive.read: explicit input wins, else DRIVE_READ_MAX_CHARS, else 20k. Pure. */
export function maxReadChars(input?: number, e: NodeJS.ProcessEnv = process.env): number {
  if (input !== undefined) return Math.min(Math.max(Math.floor(input), 1), 100_000);
  const raw = Number(e.DRIVE_READ_MAX_CHARS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), 100_000);
  return 20_000;
}

/** Truncate to max chars. Pure. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** Structured error mapping: auth expired, quota, not found, transient. Pure. */
export function mapDriveError(err: unknown): string {
  if (err instanceof GoogleApiError) {
    const msg = err.message;
    if (err.status === 401) return `${REAUTH_ERROR} (${msg})`;
    if (err.status === 404)
      return `Drive file not found. It may be deleted, trashed, or never shared with you. (${msg})`;
    if (err.status === 429 || /rateLimitExceeded|rate limit|quotaExceeded/i.test(msg))
      return `Drive quota/rate limit hit — back off and retry later. (${msg})`;
    if (err.status === 403) return `Drive access denied — missing scope or permission. (${msg})`;
    if (err.status >= 500) return `Drive is temporarily unavailable — retry later. (${msg})`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Build a multipart/related body for uploadType=multipart. Pure. */
export function buildMultipartUpload(args: {
  metadata: Record<string, unknown>;
  content: Buffer;
  contentType: string;
  boundary?: string;
}): { body: Buffer; contentTypeHeader: string } {
  const boundary = args.boundary ?? `drive-${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(args.metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${args.contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, "utf8");
  return {
    body: Buffer.concat([head, args.content, tail]),
    contentTypeHeader: `multipart/related; boundary=${boundary}`,
  };
}
