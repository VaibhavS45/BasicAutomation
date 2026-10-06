import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  budgetAllowsSpawn,
  dailyTokenTotal,
  getBudget,
  isDomainFetchable,
  recordTokenUsage,
  resetBudgetForTests,
  updateBudget,
} from "./budget.js";

let tmp: string;
let prevDataDir: string | undefined;
let prevDryRun: string | undefined;

beforeEach(async () => {
  prevDataDir = process.env.DATA_DIR; // guard:allow-env-credential — test isolation
  prevDryRun = process.env.DRY_RUN; // guard:allow-env-credential — test isolation
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "budget-test-"));
  process.env.DATA_DIR = tmp; // guard:allow-env-credential — test isolation
  resetBudgetForTests();
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR; // guard:allow-env-credential — test isolation
  else process.env.DATA_DIR = prevDataDir; // guard:allow-env-credential — test isolation
  if (prevDryRun === undefined) delete process.env.DRY_RUN; // guard:allow-env-credential — test isolation
  else process.env.DRY_RUN = prevDryRun; // guard:allow-env-credential — test isolation
  resetBudgetForTests();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("budget", () => {
  it("defaults to dry-run on, 3 workers, no kill, no domain restriction", () => {
    expect(getBudget()).toMatchObject({
      dryRun: true,
      maxConcurrentWorkers: 3,
      killSwitch: false,
      allowedDomains: [],
    });
    expect(budgetAllowsSpawn(0)).toEqual({ ok: true });
    expect(budgetAllowsSpawn(3).ok).toBe(false);
    expect(isDomainFetchable("anything.example")).toBe(true);
  });

  it("kill switch refuses spawns until flipped off", async () => {
    await updateBudget({ killSwitch: true });
    expect(budgetAllowsSpawn(0).ok).toBe(false);
    await updateBudget({ killSwitch: false });
    expect(budgetAllowsSpawn(0)).toEqual({ ok: true });
  });

  it("allowed domains gate fetches, including subdomains", async () => {
    await updateBudget({ allowedDomains: ["example.com"] });
    expect(isDomainFetchable("example.com")).toBe(true);
    expect(isDomainFetchable("docs.example.com")).toBe(true);
    expect(isDomainFetchable("evil.com")).toBe(false);
    expect(isDomainFetchable("notexample.com")).toBe(false);
  });

  it("records usage and reports overages", async () => {
    await updateBudget({ perRunTokenCap: 100, dailyTokenCap: 150 });
    const r = await recordTokenUsage(60, 60);
    expect(r).toMatchObject({ runTotal: 120, dailyTotal: 120, overPerRunCap: true, overDailyCap: false });
    expect(dailyTokenTotal()).toBe(120);
    const r2 = await recordTokenUsage(20, 20);
    expect(r2.overDailyCap).toBe(true);
    expect(budgetAllowsSpawn(0).ok).toBe(false); // daily cap reached
  });

  it("DRY_RUN toggle takes effect immediately via process.env", async () => {
    const { isDryRun } = await import("./approvals.js");
    await updateBudget({ dryRun: false });
    expect(isDryRun()).toBe(false);
    await updateBudget({ dryRun: true });
    expect(isDryRun()).toBe(true);
  });

  it("rejects invalid patches", async () => {
    await expect(updateBudget({ maxConcurrentWorkers: 0 })).rejects.toThrow();
    await expect(updateBudget({ allowedDomains: ["not a host!!"] })).rejects.toThrow();
  });
});
