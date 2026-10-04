import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireApproval } from "../../server/lib/approvals.js";
import { encryptTokens } from "../../server/lib/google-auth.js";
import sendAction from "../gmail.send.js";
import { replySubject } from "../gmail.reply.js";

vi.mock("../../server/lib/approvals.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/lib/approvals.js")>();
  return {
    ...original,
    requireApproval: vi.fn(async () => ({ approved: true, approvalId: "test" })),
  };
});

const requireApprovalMock = vi.mocked(requireApproval);

let tmp: string;
const KEY = "ef".repeat(32);
const KEYS = ["DRY_RUN", "DATA_DIR", "GOOGLE_TOKEN_STORE_PATH", "TOKEN_ENCRYPTION_KEY"] as const;
const prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of KEYS) prev[k] = process.env[k];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-send-test-"));
  process.env.DATA_DIR = tmp;
  delete process.env.DRY_RUN; // default is dry-run
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  process.env.GOOGLE_TOKEN_STORE_PATH = path.join(tmp, "token.json");
  await fs.writeFile(
    process.env.GOOGLE_TOKEN_STORE_PATH,
    encryptTokens({ access_token: "at", expiry_date: Date.now() + 3600_000 }, process.env),
  );
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

describe("gmail.send", () => {
  it("DRY_RUN logs the MIME and returns ok without HTTP", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await sendAction.run({
      to: ["ravi@example.com"],
      subject: "hello",
      body: "meet at 4pm",
    });
    expect(res).toEqual({ ok: true, data: { ok: true, dryRun: true, to: ["ravi@example.com"], subject: "hello" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("To: ravi@example.com");
    expect(logged).toContain("meet at 4pm");
    logSpy.mockRestore();
  });

  it("rejects invalid recipients", async () => {
    // @ts-expect-error — intentionally invalid input
    await expect(sendAction.run({ to: ["not-an-email"], subject: "s", body: "b" })).rejects.toThrow();
  });

  it("live trigger run (no chat) goes through the file gate", async () => {
    process.env.DRY_RUN = "false";
    vi.stubGlobal(
      "fetch",
      (async () => new Response(JSON.stringify({ id: "msg-1", threadId: "thr-1" }), { status: 200 })) as typeof fetch,
    );
    const res = await sendAction.run({ to: ["ravi@example.com"], subject: "hello", body: "meet at 4pm" });
    expect(requireApprovalMock).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, data: { messageId: "msg-1", threadId: "thr-1" } });
  });

  it("live chat-approved run skips the file gate (framework card already gated it)", async () => {
    process.env.DRY_RUN = "false";
    vi.stubGlobal(
      "fetch",
      (async () => new Response(JSON.stringify({ id: "msg-1", threadId: "thr-1" }), { status: 200 })) as typeof fetch,
    );
    const res = await sendAction.run(
      { to: ["ravi@example.com"], subject: "hello", body: "meet at 4pm" },
      { approvedToolCallKey: "key-1", caller: "tool" },
    );
    expect(requireApprovalMock).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, data: { messageId: "msg-1", threadId: "thr-1" } });
  });

  it("live trigger run denied by the file gate does not send", async () => {
    process.env.DRY_RUN = "false";
    requireApprovalMock.mockResolvedValueOnce({ approved: false, reason: "denied", approvalId: "test" });
    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await sendAction.run({ to: ["ravi@example.com"], subject: "hello", body: "meet at 4pm" });
    expect(res.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("replySubject", () => {
  it("prefixes Re: once", () => {
    expect(replySubject("hello")).toBe("Re: hello");
    expect(replySubject("RE: hello")).toBe("RE: hello");
  });
});
