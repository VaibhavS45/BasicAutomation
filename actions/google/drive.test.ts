import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptTokens } from "../../server/lib/google-auth.js";
import { requireApproval } from "../../server/lib/approvals.js";
import { buildDriveQuery } from "./drive.search.js";
import search from "./drive.search.js";
import read from "./drive.read.js";
import upload from "./drive.upload.js";
import createDoc, { markdownToHtml } from "./drive.createDoc.js";
import share from "./drive.share.js";
import { buildMultipartUpload, escapeQueryLiteral, mapDriveError, maxReadChars, truncateText } from "./drive.lib.js";
import { GoogleApiError } from "../../server/lib/google-auth.js";

vi.mock("../../server/lib/approvals.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/lib/approvals.js")>();
  return { ...original, requireApproval: vi.fn(async () => ({ approved: true, approvalId: "test" })) };
});
const requireApprovalMock = vi.mocked(requireApproval);

const KEY = "ef".repeat(32);
let tmp: string;
const KEYS = ["GOOGLE_TOKEN_STORE_PATH", "TOKEN_ENCRYPTION_KEY", "DATA_DIR", "DRY_RUN", "DRIVE_READ_MAX_CHARS"] as const;
const prev: Record<string, string | undefined> = {};
const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

async function seedToken(): Promise<void> {
  await fs.writeFile(
    process.env.GOOGLE_TOKEN_STORE_PATH as string,
    encryptTokens({ access_token: "at", expiry_date: Date.now() + 3600_000 }, process.env),
  );
}

beforeEach(async () => {
  for (const k of KEYS) prev[k] = process.env[k];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drive-test-"));
  process.env.DATA_DIR = tmp;
  process.env.DRY_RUN = "true";
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  process.env.GOOGLE_TOKEN_STORE_PATH = path.join(tmp, "token.json");
  delete process.env.DRIVE_READ_MAX_CHARS;
  await seedToken();
  requireApprovalMock.mockClear().mockResolvedValue({ approved: true, approvalId: "test" });
});

afterEach(async () => {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("drive pure helpers", () => {
  it("buildDriveQuery always excludes trashed and escapes quotes", () => {
    expect(buildDriveQuery("report", "name")).toBe("name contains 'report' and trashed = false");
    expect(buildDriveQuery("o'brien", "fullText")).toBe("fullText contains 'o\\'brien' and trashed = false");
    expect(escapeQueryLiteral("a\\b")).toBe("a\\\\b");
  });
  it("truncateText flags cuts only", () => {
    expect(truncateText("abc", 5)).toEqual({ text: "abc", truncated: false });
    expect(truncateText("abcdef", 5)).toEqual({ text: "abcde", truncated: true });
  });
  it("maxReadChars prefers input, then env, then 20k", () => {
    expect(maxReadChars()).toBe(20_000);
    process.env.DRIVE_READ_MAX_CHARS = "5000";
    expect(maxReadChars()).toBe(5000);
    expect(maxReadChars(100)).toBe(100);
  });
  it("mapDriveError categorizes auth/quota/not-found/transient", () => {
    expect(mapDriveError(new GoogleApiError(401, "bad"))).toMatch(/re-auth/i);
    expect(mapDriveError(new GoogleApiError(404, "nope"))).toMatch(/not found/i);
    expect(mapDriveError(new GoogleApiError(429, "throttled"))).toMatch(/quota|rate limit/i);
    expect(mapDriveError(new GoogleApiError(403, "rateLimitExceeded"))).toMatch(/quota|rate limit/i);
    expect(mapDriveError(new GoogleApiError(500, "boom"))).toMatch(/temporarily unavailable/i);
  });
  it("markdownToHtml converts headings, lists, emphasis", () => {
    const html = markdownToHtml("# T\n\nHello **bold** and *em* `code`\n\n- a\n- b");
    expect(html).toContain("<h1>T</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
  });
  it("buildMultipartUpload wraps metadata + content with boundary", () => {
    const { body, contentTypeHeader } = buildMultipartUpload({
      metadata: { name: "x" },
      content: Buffer.from("hi"),
      contentType: "text/plain",
      boundary: "b1",
    });
    const s = body.toString("utf8");
    expect(contentTypeHeader).toContain("boundary=b1");
    expect(s).toContain('{"name":"x"}');
    expect(s).toContain("hi");
  });
});

describe("drive.search", () => {
  it("sends q with trashed=false and returns files", async () => {
    let seenUrl = "";
    vi.stubGlobal("fetch", (async (url: string) => {
      seenUrl = url;
      return json({ files: [{ id: "f1", name: "r.txt", mimeType: "text/plain" }] });
    }) as typeof fetch);
    const res = await search.run({ query: "report", mode: "name", maxResults: 5 });
    expect(res.ok).toBe(true);
    expect(decodeURIComponent(seenUrl).replaceAll("+", " ")).toContain("trashed = false");
    expect(seenUrl).toContain("pageSize=5");
    expect((res.data as { files: unknown[] }).files).toHaveLength(1);
  });
  it("maps 401 to re-auth error", async () => {
    vi.stubGlobal("fetch", (async () => json({ error: { message: "invalid" } }, 401)) as typeof fetch);
    const res = await search.run({ query: "x", mode: "fullText", maxResults: 10 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/re-auth/i);
  });
});

describe("drive.read", () => {
  it("exports native Docs as text and truncates with flag", async () => {
    process.env.DRY_RUN = "false";
    const seen: string[] = [];
    vi.stubGlobal("fetch", (async (url: string) => {
      seen.push(url);
      if (url.includes("/export?")) return new Response("x".repeat(100), { status: 200 });
      return json({ id: "d1", name: "doc", mimeType: "application/vnd.google-apps.document" });
    }) as typeof fetch);
    const res = await read.run({ fileId: "d1", maxChars: 10 });
    expect(res.ok).toBe(true);
    expect(seen.some((u) => u.includes("/export?") && u.includes("mimeType=text%2Fplain"))).toBe(true);
    const data = res.data as { untrustedText: string; truncated: boolean };
    expect(data.untrustedText).toHaveLength(10);
    expect(data.truncated).toBe(true);
  });
  it("downloads non-native files via alt=media", async () => {
    process.env.DRY_RUN = "false";
    let mediaHit = false;
    vi.stubGlobal("fetch", (async (url: string) => {
      if (url.includes("alt=media")) {
        mediaHit = true;
        return new Response("plain", { status: 200 });
      }
      return json({ id: "f2", name: "n.txt", mimeType: "text/plain" });
    }) as typeof fetch);
    const res = await read.run({ fileId: "f2" });
    expect(res.ok).toBe(true);
    expect(mediaHit).toBe(true);
    expect((res.data as { truncated: boolean }).truncated).toBe(false);
  });
  it("maps 404 to not-found", async () => {
    process.env.DRY_RUN = "false";
    vi.stubGlobal("fetch", (async () => json({ error: { message: "not found" } }, 404)) as typeof fetch);
    const res = await read.run({ fileId: "missing" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });
});

describe("drive.upload / drive.createDoc (writes)", () => {
  it("DRY_RUN uploads nothing", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await upload.run({ name: "n.txt", mimeType: "text/plain", text: "hi" });
    expect(res).toMatchObject({ ok: true, data: { dryRun: true } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("live upload POSTs multipart and returns fileId", async () => {
    process.env.DRY_RUN = "false";
    let seenCt = "";
    vi.stubGlobal("fetch", (async (_url: string, init?: RequestInit) => {
      seenCt = String(new Headers(init?.headers).get("content-type"));
      return json({ id: "new1", name: "n.txt" });
    }) as typeof fetch);
    const res = await upload.run({ name: "n.txt", mimeType: "text/plain", text: "hi", folderId: "fld" });
    expect(res.ok).toBe(true);
    expect(seenCt).toContain("multipart/related");
    expect((res.data as { fileId: string }).fileId).toBe("new1");
  });
  it("createDoc DRY_RUN creates nothing; live sends Docs conversion", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const dry = await createDoc.run({ title: "T", markdown: "# hi" });
    expect(dry).toMatchObject({ ok: true, data: { dryRun: true } });
    process.env.DRY_RUN = "false";
    let seenBody = "";
    vi.stubGlobal("fetch", (async (_url: string, init?: RequestInit) => {
      seenBody = Buffer.from(init?.body as Uint8Array).toString("utf8");
      return json({ id: "doc9" });
    }) as typeof fetch);
    const live = await createDoc.run({ title: "T", markdown: "# hi" });
    expect(live.ok).toBe(true);
    expect(seenBody).toContain("application/vnd.google-apps.document");
    expect(seenBody).toContain("<h1>hi</h1>");
  });
});

describe("drive.share (approval-gated)", () => {
  it("DRY_RUN shares nothing", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await share.run({ fileId: "f1", email: "a@x.com", role: "viewer" });
    expect(res).toMatchObject({ ok: true, data: { dryRun: true } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("denied approval blocks the share", async () => {
    process.env.DRY_RUN = "false";
    requireApprovalMock.mockResolvedValueOnce({ approved: false, reason: "denied", approvalId: "a1" });
    const fetchSpy = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await share.run({ fileId: "f1", email: "a@x.com", role: "editor" });
    expect(res.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("approved share POSTs a single-user permission (never anyone-link)", async () => {
    process.env.DRY_RUN = "false";
    let seenBody = "";
    vi.stubGlobal("fetch", (async (_url: string, init?: RequestInit) => {
      seenBody = String(init?.body);
      return json({ id: "perm1" });
    }) as typeof fetch);
    const res = await share.run(
      { fileId: "f1", email: "a@x.com", role: "commenter" },
      { approvedToolCallKey: "k", caller: "tool" },
    );
    expect(res.ok).toBe(true);
    expect(seenBody).toContain('"type":"user"');
    expect(seenBody).not.toContain("anyone");
  });
});
