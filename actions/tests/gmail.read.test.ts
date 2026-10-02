import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptTokens } from "../../server/lib/google-auth.js";
import readAction, { attachmentNames, extractBody } from "../gmail.read.js";

const KEY = "cd".repeat(32);
let tmp: string;
const KEYS = ["GOOGLE_TOKEN_STORE_PATH", "TOKEN_ENCRYPTION_KEY", "DATA_DIR", "DRY_RUN"] as const;
const prev: Record<string, string | undefined> = {};

const b64 = (s: string) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fullMessage(payload: unknown) {
  return {
    id: "m1",
    threadId: "t1",
    snippet: "snip",
    payload: {
      headers: [
        { name: "From", value: "boss@example.com" },
        { name: "Subject", value: "Q3 plan" },
        { name: "Date", value: "Mon, 01 Jan 2024 10:00:00 +0530" },
        { name: "Message-ID", value: "<m1@mail>" },
      ],
      ...payload,
    },
  };
}

beforeEach(async () => {
  for (const k of KEYS) prev[k] = process.env[k];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-read-test-"));
  process.env.DATA_DIR = tmp;
  process.env.DRY_RUN = "true";
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  process.env.GOOGLE_TOKEN_STORE_PATH = path.join(tmp, "token.json");
  await fs.writeFile(
    process.env.GOOGLE_TOKEN_STORE_PATH,
    encryptTokens({ access_token: "at", expiry_date: Date.now() + 3600_000 }, process.env),
  );
});

afterEach(async () => {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

function stubMessage(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    (async () => new Response(JSON.stringify(fullMessage(payload)), { status: 200 })) as typeof fetch,
  );
}

describe("gmail.read", () => {
  it("prefers text/plain and returns it as untrustedBody", async () => {
    stubMessage({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("plain wins") } },
        { mimeType: "text/html", body: { data: b64("<b>html loses</b>") } },
      ],
    });
    const res = await readAction.run({ messageId: "m1" });
    expect(res.ok).toBe(true);
    expect((res.data as { untrustedBody: string }).untrustedBody).toBe("plain wins");
  });

  it("strips HTML when no plain part exists and lists attachments", async () => {
    stubMessage({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", body: { data: b64("<p>hi <b>there</b></p>") } },
        { mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "a1" } },
      ],
    });
    const res = await readAction.run({ messageId: "m1" });
    const data = res.data as { untrustedBody: string; attachments: string[]; rfcMessageId: string };
    expect(data.untrustedBody).toBe("hi there");
    expect(data.attachments).toEqual(["deck.pdf"]);
    expect(data.rfcMessageId).toBe("<m1@mail>");
  });
});

describe("extractBody/attachmentNames", () => {
  it("handles missing payload", () => {
    expect(extractBody(undefined)).toBe("");
    expect(attachmentNames(undefined)).toEqual([]);
  });
});
