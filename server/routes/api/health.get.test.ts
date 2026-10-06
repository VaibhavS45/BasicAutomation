// server/routes/api/health.get.test.ts — V-7: fast, secret-free, injectable.
import { describe, expect, it } from "vitest";
import { healthStatus } from "./health.get.js";

describe("healthStatus", () => {
  it("reports ok with trigger/notion presence flags (no secrets leaked)", async () => {
    const status = await healthStatus({ probeDataDir: async () => {} });
    expect(status.ok).toBe(true);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(status)).not.toMatch(/sk-|secret|token=[^,]/i);
    expect(status.checks.triggers).toHaveProperty("gmail");
    expect(status.checks.researchPort).toHaveProperty("notion");
  });

  it("marks ok:false when the data dir is not writable", async () => {
    const status = await healthStatus({
      probeDataDir: async () => { throw new Error("EACCES"); },
    });
    expect(status.ok).toBe(false);
    expect(status.checks.dataDir).toMatch(/EACCES/);
  });
});
