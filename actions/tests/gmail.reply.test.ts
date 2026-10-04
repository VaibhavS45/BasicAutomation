import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireApproval } from "../../server/lib/approvals.js";
import { encryptTokens } from "../../server/lib/google-auth.js";
import replyAction from "../gmail.reply.js";

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

const originalMessage = {
  id: "msg-0",
  threadId: "thr-0",
  payload: {
    headers: [
      { name: "Message-ID", value: "<orig@example.com>" },
      { name: "From", value: "ravi@example.com" },
      { name: "Subject", value: "hello" },
    ],
  },
};

function stubFetchLive() {
  vi.stubGlobal(
    "fetch",
    (async (url: unknown) =>
      String(url).includes("/messages/send")
        ? new Response(JSON.stringify({ id: "reply-1" }), { status: 200 })
        : new Response(JSON.stringify(originalMessage), { status: 200 })) as typeof fetch,
  );
}

beforeEach(async () => {
  for (const k of KEYS) prev[k] = process.env[k];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-reply-test-"));
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

describe("gmail.reply", () => {
  it("DRY_RUN returns the plan without calling the file gate", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(originalMessage), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await replyAction.run({ messageId: "msg-0", body: "sounds good" });
    expect(res.ok).toBe(true);
    expect(requireApprovalMock).not.toHaveBeenCalled();
  });

  it("live trigger run (no chat) goes through the file gate", async () => {
    process.env.DRY_RUN = "false";
    stubFetchLive();
    const res = await replyAction.run({ messageId: "msg-0", body: "sounds good" });
    expect(requireApprovalMock).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, data: { messageId: "reply-1", threadId: "thr-0" } });
  });

  it("live chat-approved run skips the file gate (framework card already gated it)", async () => {
    process.env.DRY_RUN = "false";
    stubFetchLive();
    const res = await replyAction.run(
      { messageId: "msg-0", body: "sounds good" },
      { approvedToolCallKey: "key-1", caller: "tool" },
    );
    expect(requireApprovalMock).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, data: { messageId: "reply-1", threadId: "thr-0" } });
  });
});
