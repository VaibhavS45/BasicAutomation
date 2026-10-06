// server/lib/shutdown.test.ts — V-7: LIFO, error-tolerant, latched.
import { describe, expect, it, beforeEach } from "vitest";
import { onShutdown, resetShutdownForTests, shutdown } from "./shutdown.js";

describe("shutdown registry", () => {
  beforeEach(() => resetShutdownForTests());

  it("runs callbacks LIFO and tolerates failures", async () => {
    const order: string[] = [];
    onShutdown("first", () => { order.push("first"); });
    onShutdown("bad", () => { throw new Error("boom"); });
    onShutdown("last", async () => { order.push("last"); });
    const res = await shutdown(1000, "test");
    expect(order).toEqual(["last", "first"]);
    expect(res.stopped).toEqual(["last", "first"]);
    expect(res.errors.map((e) => e.name)).toEqual(["bad"]);
  });

  it("latches: a second shutdown is a no-op", async () => {
    let calls = 0;
    onShutdown("once", () => { calls += 1; });
    await shutdown(1000, "test");
    const second = await shutdown(1000, "test");
    expect(calls).toBe(1);
    expect(second.stopped).toEqual([]);
  });
});
