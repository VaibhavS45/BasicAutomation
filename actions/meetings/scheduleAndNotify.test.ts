import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const googleFetch = vi.fn();
const sendTemplate = vi.fn();
const sendText = vi.fn();

vi.mock("../../server/lib/google-auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/lib/google-auth.js")>();
  return {
    ...original,
    googleFetch: (url: string, opts?: RequestInit) => googleFetch(url, opts),
    isDryRun: () => process.env.DRY_RUN !== "false",
  };
});
vi.mock("../../server/lib/whatsapp-client.js", () => ({
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  sendText: (...a: unknown[]) => sendText(...a),
}));
vi.mock("../../server/lib/approvals.js", () => ({
  requireApproval: vi.fn(async () => ({ approved: true, approvalId: "test" })),
}));

const { default: scheduleAndNotify, humanTime } = await import("./scheduleAndNotify.js");

const KEYS = ["DRY_RUN", "DATA_DIR"] as const;
const prev: Record<string, string | undefined> = {};
const args = {
  title: "Design sync",
  start: "2026-10-02T16:00:00+05:30",
  durationMinutes: 30,
  attendees: [
    { name: "Alice", email: "alice@example.com", whatsapp: "+14155551234" },
    { name: "Bob", email: "bob@example.com" },
    { name: "Cara", whatsapp: "+14155559999" },
  ],
  sendEmailInvite: true,
  message: "Agenda in the doc.",
};

beforeEach(() => {
  for (const k of KEYS) prev[k] = process.env[k];
  process.env.DATA_DIR = "/tmp/does-not-matter";
  delete process.env.DRY_RUN; // default: dry run
  googleFetch.mockReset();
  sendTemplate.mockReset().mockResolvedValue({ ok: true, data: { messageId: "wamid.1" } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  vi.restoreAllMocks();
});

function liveRun() {
  process.env.DRY_RUN = "false";
  googleFetch.mockImplementation((url: string) =>
    url.includes("/calendar/")
      ? Promise.resolve({
          id: "evt-1",
          htmlLink: "https://calendar.google.com/event?eid=1",
          hangoutLink: "https://meet.google.com/abc-defg-hij",
        })
      : Promise.resolve({ id: "gmail-1" }),
  );
}

describe("meetings.scheduleAndNotify", () => {
  it("DRY_RUN returns the full plan and calls nothing", async () => {
    const res = await scheduleAndNotify.run({ ...args, timeZone: "Asia/Kolkata" });

    expect(res.ok).toBe(true);
    expect(googleFetch).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    const plan = (res as { data: { plan: Record<string, unknown> } }).data.plan;
    expect(plan).toMatchObject({
      event: {
        title: "Design sync",
        start: "2026-10-02T10:30:00.000Z",
        end: "2026-10-02T11:00:00.000Z",
        timeZone: "Asia/Kolkata",
        addMeet: true,
      },
      invites: ["alice@example.com", "bob@example.com"],
      extraGmail: ["alice@example.com", "bob@example.com"],
      message: "Agenda in the doc.",
    });
    expect(plan.whatsapp).toEqual([
      { to: "+14155551234", attendee: "Alice", template: "meeting_invite" },
      { to: "+14155559999", attendee: "Cara", template: "meeting_invite" },
    ]);
  });

  it("live run creates the event and reports per-attendee WhatsApp results", async () => {
    liveRun();
    sendTemplate.mockImplementation((to: string) =>
      to === "+14155559999"
        ? Promise.resolve({ ok: false, error: "template not approved" })
        : Promise.resolve({ ok: true, data: { messageId: "wamid.1" } }),
    );

    const res = await scheduleAndNotify.run({ ...args, timeZone: "Asia/Kolkata" });

    expect(googleFetch.mock.calls.map((c) => String(c[0])).some((u) => u.includes("/events?"))).toBe(true);
    const insert = JSON.parse(String(googleFetch.mock.calls[0][1]?.body));
    expect(insert.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: "hangoutsMeet" });
    expect(String(googleFetch.mock.calls[0][0])).toContain("sendUpdates=all");

    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.event).toEqual({
      eventId: "evt-1",
      htmlLink: "https://calendar.google.com/event?eid=1",
      meetLink: "https://meet.google.com/abc-defg-hij",
    });
    expect(data.email).toEqual({ sent: true, messageId: "gmail-1" });
    expect(data.whatsappResults).toEqual([
      { to: "+14155551234", ok: true, messageId: "wamid.1" },
      { to: "+14155559999", ok: false, error: "template not approved" },
    ]);
    expect(data.partial).toBe(true);
    expect(res.ok).toBe(false); // failure is visible...
    expect(data.event).toBeDefined(); // ...without hiding the success
    expect(sendTemplate.mock.calls[0][3]).toEqual([
      "Alice",
      "Design sync",
      "Friday, 2 October 2026 at 16:00",
      "https://meet.google.com/abc-defg-hij",
    ]);
  });

  it("skips the extra Gmail when no message is set", async () => {
    liveRun();
    const { message: _m, ...noMessage } = args;
    const res = await scheduleAndNotify.run({ ...noMessage, timeZone: "UTC" });

    expect(googleFetch.mock.calls.map((c) => String(c[0]))).not.toContain(
      expect.stringContaining("/messages/send"),
    );
    expect((res as { data: { email: { sent: boolean } } }).data.email).toEqual({ sent: false });
  });

  it("stops before WhatsApp when the event insert fails", async () => {
    process.env.DRY_RUN = "false";
    googleFetch.mockRejectedValue(new Error("calendar quota exceeded"));
    const res = await scheduleAndNotify.run({ ...args, timeZone: "UTC" });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("calendar quota exceeded");
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("rejects a non-IANA time zone and a bad phone number", async () => {
    // @ts-expect-error — intentionally invalid input
    await expect(scheduleAndNotify.run({ ...args, timeZone: "Mars/Olympus" })).rejects.toThrow();
    await expect(
      // @ts-expect-error — intentionally invalid input
      scheduleAndNotify.run({ ...args, attendees: [{ name: "X", whatsapp: "123" }] }),
    ).rejects.toThrow();
  });
});

describe("humanTime", () => {
  it("renders the instant in the requested zone", () => {
    expect(humanTime("2026-10-02T10:30:00.000Z", "UTC")).toContain("2 October 2026");
    expect(humanTime("2026-10-02T10:30:00.000Z", "Asia/Kolkata")).toContain("16:00");
  });
});