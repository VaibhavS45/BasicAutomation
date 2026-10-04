import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerEvent } from "../lib/types.js";

const googleFetch = vi.fn();
// env.ts parses process.env once at import, so set the allowlist through a mock.
let allowlist: string[] = [];
vi.mock("../lib/env.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/env.js")>();
  return { ...original, triggerEmailAllowlist: () => allowlist };
});
vi.mock("../lib/google-auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/google-auth.js")>();
  return { ...original, googleFetch: (url: string, opts?: RequestInit) => googleFetch(url, opts) };
});

const { pollGmailOnce, senderAddress } = await import("./gmail.js");

const KEYS = [
  "DATA_DIR",
  "DRY_RUN",
  "GMAIL_TRIGGER_LABEL",
] as const;
const prev: Record<string, string | undefined> = {};

let tmp: string;
const events: TriggerEvent[] = [];
const emit = async (e: TriggerEvent) => {
  events.push(e);
};

beforeEach(async () => {
  for (const k of KEYS) prev[k] = process.env[k];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-trigger-test-"));
  process.env.DATA_DIR = tmp;
  allowlist = ["alice@example.com"];
  process.env.GMAIL_TRIGGER_LABEL = "agent-trigger";
  delete process.env.DRY_RUN;
  googleFetch.mockReset();
  events.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

function metadata(over: Record<string, unknown> = {}) {
  return {
    threadId: "t-1",
    snippet: "lunch at 1?",
    internalDate: "1750000000000",
    labelIds: ["INBOX", "agent-trigger"],
    payload: {
      headers: [
        { name: "From", value: '"Alice" <alice@example.com>' },
        { name: "Subject", value: "Lunch?" },
      ],
    },
    ...over,
  };
}

async function seedHistoryId(id = "100") {
  await fs.mkdir(path.join(tmp, "triggers"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, "triggers", "gmail-state.json"),
    JSON.stringify({ historyId: id }),
  );
}

describe("gmail trigger", () => {
  it("seeds the cursor from the profile on first run and emits nothing", async () => {
    googleFetch.mockResolvedValue({ historyId: "500", emailAddress: "me@x.com" });
    const res = await pollGmailOnce(emit);

    expect(googleFetch).toHaveBeenCalledTimes(1);
    expect(String(googleFetch.mock.calls[0][0])).toContain("/users/me/profile");
    expect(res).toMatchObject({ historyId: "500", emitted: 0 });
    expect(events).toHaveLength(0);
    expect(
      JSON.parse(await fs.readFile(path.join(tmp, "triggers", "gmail-state.json"), "utf8")),
    ).toEqual({ historyId: "500" });
  });

  it("emits email.received with metadata only, never the body", async () => {
    await seedHistoryId();
    googleFetch.mockImplementation((url: string) => {
      if (url.includes("/history?")) {
        return Promise.resolve({
          historyId: "101",
          history: [{ messagesAdded: [{ message: { id: "m1" } }] }],
        });
      }
      return Promise.resolve({ id: "m1", ...metadata() });
    });

    const res = await pollGmailOnce(emit);

    expect(res).toMatchObject({ emitted: 1, scanned: 1, historyIdReset: false });
    expect(events[0]).toEqual({
      id: "gmail:m1",
      source: "gmail",
      type: "email.received",
      receivedAt: new Date(1750000000000).toISOString(),
      actor: "alice@example.com",
      summary: "Lunch?",
      payload: {
        messageId: "m1",
        threadId: "t-1",
        from: '"Alice" <alice@example.com>',
        subject: "Lunch?",
        snippet: "lunch at 1?",
      },
      untrusted: true,
    });
    expect(JSON.stringify(events[0])).not.toContain("data:"); // no MIME body
    expect(
      JSON.parse(await fs.readFile(path.join(tmp, "triggers", "gmail-state.json"), "utf8")),
    ).toEqual({ historyId: "101" });
  });

  it("skips a sender outside the allowlist", async () => {
    await seedHistoryId();
    googleFetch.mockImplementation((url: string) =>
      url.includes("/history?")
        ? Promise.resolve({ historyId: "101", history: [{ messagesAdded: [{ message: { id: "m1" } }] }] })
        : Promise.resolve({
            ...metadata(),
            payload: { headers: [{ name: "From", value: "eve@evil.com" }] },
          }),
    );

    const res = await pollGmailOnce(emit);

    expect(res.emitted).toBe(0);
    expect(res.skipped[0]).toContain("not in TRIGGER_EMAIL_ALLOWLIST");
    expect(events).toHaveLength(0);
  });

  it("skips an allowlisted sender without the trigger label", async () => {
    await seedHistoryId();
    googleFetch.mockImplementation((url: string) =>
      url.includes("/history?")
        ? Promise.resolve({ historyId: "101", history: [{ messagesAdded: [{ message: { id: "m1" } }] }] })
        : Promise.resolve({ ...metadata(), labelIds: ["INBOX"] }),
    );

    const res = await pollGmailOnce(emit);

    expect(res.emitted).toBe(0);
    expect(res.skipped[0]).toContain("missing label agent-trigger");
  });

  it("emits nothing at all when GMAIL_TRIGGER_LABEL is unset", async () => {
    delete process.env.GMAIL_TRIGGER_LABEL;
    await seedHistoryId();
    const res = await pollGmailOnce(emit);

    expect(googleFetch).not.toHaveBeenCalled();
    expect(res.errors[0]).toContain("GMAIL_TRIGGER_LABEL");
  });

  it("resets the cursor and warns when the historyId expired (404)", async () => {
    await seedHistoryId("9");
    const { GoogleApiError } = await import("../lib/google-auth.js");
    googleFetch.mockImplementation((url: string) => {
      if (url.includes("/history?")) {
        throw new GoogleApiError(404, "Requested entity was not found.");
      }
      return Promise.resolve({ historyId: "900" });
    });

    const res = await pollGmailOnce(emit);

    expect(res.historyIdReset).toBe(true);
    expect(res.historyId).toBe("900");
    expect(res.errors[0]).toContain("expired");
    expect(events).toHaveLength(0);
    expect(
      JSON.parse(await fs.readFile(path.join(tmp, "triggers", "gmail-state.json"), "utf8")),
    ).toEqual({ historyId: "900" });
  });

  it("keeps polling after one message fails to fetch", async () => {
    await seedHistoryId();
    googleFetch.mockImplementation((url: string) => {
      if (url.includes("/history?")) {
        return Promise.resolve({
          historyId: "101",
          history: [{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m2" } }] }],
        });
      }
      if (url.includes("/m1?")) throw new Error("boom");
      return Promise.resolve({ id: "m2", ...metadata() });
    });

    const res = await pollGmailOnce(emit);

    expect(res.errors[0]).toContain("m1: boom");
    expect(res.emitted).toBe(1);
    expect(events[0].id).toBe("gmail:m2");
  });
});

describe("senderAddress", () => {
  it("unwraps the angled address and lowercases", () => {
    expect(senderAddress('"Alice B" <Alice@Example.com>')).toBe("alice@example.com");
    expect(senderAddress("  bob@x.com ")).toBe("bob@x.com");
  });
});