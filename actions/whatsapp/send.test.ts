import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireApproval } from "../../server/lib/approvals.js";
import { sendTemplate } from "../../server/lib/whatsapp-client.js";
import sendAction, {
  WINDOW_24H_ERROR,
  whatsappSendSchema,
} from "./send.js";

vi.mock("../../server/lib/approvals.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/lib/approvals.js")>();
  return {
    ...original,
    requireApproval: vi.fn(async () => ({ approved: true, approvalId: "test" })),
  };
});

vi.mock("../../server/lib/whatsapp-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/lib/whatsapp-client.js")>();
  return {
    ...original,
    sendTemplate: vi.fn(async () => ({ ok: true, data: { messageId: "wamid.1" } })),
    sendText: vi.fn(async () => ({ ok: true, data: { messageId: "wamid.1" } })),
  };
});

const requireApprovalMock = vi.mocked(requireApproval);
const sendTemplateMock = vi.mocked(sendTemplate);

let tmp: string;
const prevEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const k of keys) prevEnv[k] = process.env[k];
}

function restoreEnv(...keys: string[]) {
  for (const k of keys) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
}

const ENV_KEYS = ["DRY_RUN", "WHATSAPP_PROVIDER", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "DATA_DIR"];

beforeEach(async () => {
  saveEnv(...ENV_KEYS);
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wa-send-test-"));
  process.env.DATA_DIR = tmp;
  requireApprovalMock.mockClear().mockResolvedValue({ approved: true, approvalId: "test" });
  sendTemplateMock.mockClear().mockResolvedValue({ ok: true, data: { messageId: "wamid.1" } });
});

afterEach(async () => {
  restoreEnv(...ENV_KEYS);
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("whatsappSendSchema", () => {
  it("normalizes valid numbers to E.164", () => {
    const out = whatsappSendSchema.parse({ to: "+14155551234", text: "hi" });
    expect(out.to).toBe("+14155551234");
  });

  it("rejects invalid numbers", () => {
    expect(() => whatsappSendSchema.parse({ to: "not-a-number", text: "hi" })).toThrow(/E\.164/);
    expect(() => whatsappSendSchema.parse({ to: "4155551234", text: "hi" })).toThrow();
  });

  it("requires text or template", () => {
    expect(() => whatsappSendSchema.parse({ to: "+14155551234" })).toThrow(/text or template/);
  });

  it("accepts template with defaults", () => {
    const out = whatsappSendSchema.parse({
      to: "+14155551234",
      template: { name: "hello_world" },
    });
    expect(out.template).toMatchObject({ name: "hello_world", language: "en_US", params: [] });
  });
});

describe("whatsapp.send run", () => {
  it("DRY_RUN logs payload and returns ok without HTTP", async () => {
    process.env.DRY_RUN = "true";
    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const res = await sendAction.run({
      to: "+14155551234",
      template: { name: "hello_world", language: "en_US", params: ["Alex"] },
    });

    expect(res.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => JSON.stringify(c).includes("[whatsapp:dry-run]"))).toBe(true);
    logSpy.mockRestore();
  });

  it("cloud_api text outside 24h window fails clear without HTTP or approval", async () => {
    process.env.DRY_RUN = "false";
    process.env.WHATSAPP_PROVIDER = "cloud_api";
    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await sendAction.run({ to: "+14155551234", text: "hello" });

    expect(res).toEqual({ ok: false, error: WINDOW_24H_ERROR });
    expect(res.error).toMatch(/24h/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requireApprovalMock).not.toHaveBeenCalled();
    // No approval file created — the guard returns before the gate.
    expect(await fs.readdir(tmp)).not.toContain("approvals");
  });

  it("live trigger run (no chat) goes through the file gate", async () => {
    process.env.DRY_RUN = "false";
    const res = await sendAction.run({
      to: "+14155551234",
      template: { name: "hello_world", language: "en_US", params: ["Alex"] },
    });
    expect(requireApprovalMock).toHaveBeenCalledTimes(1);
    expect(sendTemplateMock).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  it("live chat-approved run skips the file gate (framework card already gated it)", async () => {
    process.env.DRY_RUN = "false";
    const res = await sendAction.run(
      {
        to: "+14155551234",
        template: { name: "hello_world", language: "en_US", params: ["Alex"] },
      },
      { approvedToolCallKey: "key-1", caller: "tool" },
    );
    expect(requireApprovalMock).not.toHaveBeenCalled();
    expect(sendTemplateMock).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });
});
