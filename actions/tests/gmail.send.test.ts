import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sendAction from "../gmail.send.js";
import { replySubject } from "../gmail.reply.js";

let tmp: string;
const KEYS = ["DRY_RUN", "DATA_DIR"] as const;
const prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of KEYS) prev[k] = process.env[k];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-send-test-"));
  process.env.DATA_DIR = tmp;
  delete process.env.DRY_RUN; // default is dry-run
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
});

describe("replySubject", () => {
  it("prefixes Re: once", () => {
    expect(replySubject("hello")).toBe("Re: hello");
    expect(replySubject("RE: hello")).toBe("RE: hello");
  });
});
