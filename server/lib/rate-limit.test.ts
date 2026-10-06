// server/lib/rate-limit.test.ts — V-7 sliding window.
import { describe, expect, it, beforeEach } from "vitest";
import { checkRateLimit, resetRateLimitsForTests } from "./rate-limit.js";

describe("checkRateLimit", () => {
  beforeEach(() => resetRateLimitsForTests());

  it("allows up to the limit, then denies with a reset hint", () => {
    expect(checkRateLimit("k", { limit: 2, windowMs: 1000, now: 0 }).allowed).toBe(true);
    expect(checkRateLimit("k", { limit: 2, windowMs: 1000, now: 10 }).allowed).toBe(true);
    const third = checkRateLimit("k", { limit: 2, windowMs: 1000, now: 20 });
    expect(third.allowed).toBe(false);
    expect(third.resetMs).toBeGreaterThan(0);
  });

  it("slides: old hits age out and keys are isolated", () => {
    checkRateLimit("a", { limit: 1, windowMs: 100, now: 0 });
    expect(checkRateLimit("a", { limit: 1, windowMs: 100, now: 50 }).allowed).toBe(false);
    expect(checkRateLimit("a", { limit: 1, windowMs: 100, now: 101 }).allowed).toBe(true);
    expect(checkRateLimit("b", { limit: 1, windowMs: 100, now: 50 }).allowed).toBe(true);
  });
});
