import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { gmailTriggerBootPlan } from "./triggers.js";

describe("triggers nitro plugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("never throws at import/invocation time and logs one boot line", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const hooked: Array<{ event: string }> = [];
      (plugin as unknown as (app: unknown) => void)({
        hooks: { hook: (event: string, _fn: () => void) => hooked.push({ event }) },
      });
      expect(hooked.map((h) => h.event)).toContain("close");
      expect(logs.some((l) => l.includes("[triggers] plugin boot ok"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("boot plan starts only when label + oauth + token are all present", () => {
    expect(gmailTriggerBootPlan({}, false)).toEqual({
      start: false,
      reason: expect.stringContaining("GMAIL_TRIGGER_LABEL"),
    });
    expect(
      gmailTriggerBootPlan({ GMAIL_TRIGGER_LABEL: "NeedsReply" }, false).start,
    ).toBe(false);
    expect(
      gmailTriggerBootPlan(
        {
          GMAIL_TRIGGER_LABEL: "NeedsReply",
          GOOGLE_CLIENT_ID: "cid",
          TOKEN_ENCRYPTION_KEY: "k",
        },
        false,
      ).start,
    ).toBe(false);
    expect(
      gmailTriggerBootPlan(
        {
          GMAIL_TRIGGER_LABEL: "NeedsReply",
          GOOGLE_CLIENT_ID: "cid",
          TOKEN_ENCRYPTION_KEY: "k",
        },
        true,
      ),
    ).toEqual({ start: true, reason: "configured" });
  });
});
