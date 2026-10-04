import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptTokens } from "../../server/lib/google-auth.js";
import { requireApproval } from "../../server/lib/approvals.js";
import createEvent, { extractMeetLink } from "../calendar.createEvent.js";
import findFreeSlots, { freeSlots } from "../calendar.findFreeSlots.js";

vi.mock("../../server/lib/approvals.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/lib/approvals.js")>();
  return {
    ...original,
    requireApproval: vi.fn(async () => ({ approved: true, approvalId: "test" })),
  };
});

const requireApprovalMock = vi.mocked(requireApproval);

const KEY = "ef".repeat(32);
let tmp: string;
const KEYS = ["GOOGLE_TOKEN_STORE_PATH", "TOKEN_ENCRYPTION_KEY", "DATA_DIR", "DRY_RUN"] as const;
const prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of KEYS) prev[k] = process.env[k];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cal-test-"));
  process.env.DATA_DIR = tmp;
  process.env.DRY_RUN = "true";
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

describe("calendar.createEvent", () => {
  it("DRY_RUN returns the full plan without HTTP", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await createEvent.run({
      title: "Sync",
      start: "2026-10-02T16:00:00+05:30",
      end: "2026-10-02T16:30:00+05:30",
      timeZone: "Asia/Kolkata",
      attendees: ["ravi@example.com"],
      addMeet: true,
    });
    expect(res).toEqual({
      ok: true,
      data: {
        ok: true,
        dryRun: true,
        title: "Sync",
        start: "2026-10-02T16:00:00+05:30",
        end: "2026-10-02T16:30:00+05:30",
        timeZone: "Asia/Kolkata",
        attendees: ["ravi@example.com"],
        addMeet: true,
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("live trigger run (no chat) with attendees goes through the file gate", async () => {
    process.env.DRY_RUN = "false";
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ id: "evt-1", hangoutLink: "https://meet.google.com/a" }), {
          status: 200,
        })) as typeof fetch,
    );
    const res = await createEvent.run({
      title: "Sync",
      start: "2026-10-02T16:00:00+05:30",
      end: "2026-10-02T16:30:00+05:30",
      timeZone: "Asia/Kolkata",
      attendees: ["ravi@example.com"],
      addMeet: true,
    });
    expect(requireApprovalMock).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  it("live chat-approved run skips the file gate (framework card already gated it)", async () => {
    process.env.DRY_RUN = "false";
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ id: "evt-1", hangoutLink: "https://meet.google.com/a" }), {
          status: 200,
        })) as typeof fetch,
    );
    const res = await createEvent.run(
      {
        title: "Sync",
        start: "2026-10-02T16:00:00+05:30",
        end: "2026-10-02T16:30:00+05:30",
        timeZone: "Asia/Kolkata",
        attendees: ["ravi@example.com"],
        addMeet: true,
      },
      { approvedToolCallKey: "key-1", caller: "tool" },
    );
    expect(requireApprovalMock).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it("live run without attendees needs no gate on either path", async () => {
    process.env.DRY_RUN = "false";
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ id: "evt-1" }), { status: 200 })) as typeof fetch,
    );
    const res = await createEvent.run({
      title: "Focus",
      start: "2026-10-02T16:00:00+05:30",
      end: "2026-10-02T16:30:00+05:30",
      timeZone: "Asia/Kolkata",
      attendees: [],
      addMeet: false,
    });
    expect(requireApprovalMock).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it("extractMeetLink prefers hangoutLink, falls back to video entryPoint", () => {
    expect(extractMeetLink({ hangoutLink: "https://meet.google.com/a" })).toBe("https://meet.google.com/a");
    expect(
      extractMeetLink({ conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/b" }] } }),
    ).toBe("https://meet.google.com/b");
    expect(extractMeetLink({})).toBeUndefined();
  });
});

describe("calendar.findFreeSlots", () => {
  it("carves slots around busy periods and notes attendee visibility", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(
          JSON.stringify({ calendars: { primary: { busy: [{ start: "2026-10-02T10:00:00Z", end: "2026-10-02T11:00:00Z" }] } } }),
          { status: 200 },
        )) as typeof fetch,
    );
    const res = await findFreeSlots.run({
      attendees: ["ravi@example.com"],
      durationMinutes: 30,
      windowStart: "2026-10-02T10:00:00Z",
      windowEnd: "2026-10-02T12:00:00Z",
    });
    const data = res.data as { slots: Array<{ start: string }>; note: string };
    expect(data.slots[0].start).toBe("2026-10-02T11:00:00.000Z");
    expect(data.note).toMatch(/not visible/);
  });
});

describe("freeSlots", () => {
  it("returns empty when the window is fully busy", () => {
    expect(
      freeSlots(
        [{ start: "2026-10-02T10:00:00Z", end: "2026-10-02T12:00:00Z" }],
        "2026-10-02T10:00:00Z",
        "2026-10-02T12:00:00Z",
        30,
      ),
    ).toEqual([]);
  });
});
