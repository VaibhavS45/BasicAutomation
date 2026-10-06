// server/lib/budget.ts  Owner: Vaibhav (H7d)
// Budget + safety panel backend: per-run and daily token caps, max
// concurrent workers, the global DRY_RUN toggle, the kill switch, and the
// @browser allowed-domains list. Policy lives in DATA_DIR/budget.json;
// token usage accumulates per UTC day in DATA_DIR/budget-usage.json.
//
// Enforcement points (not theater):
// - budgetAllowsSpawn(): kill switch + max workers + daily cap, checked by
//   head-agent acquireWorkerSlot before every worker spawn.
// - recordTokenUsage(): called by the trigger engine after each agent turn;
//   reports per-run / daily overages into the audit trail.
// - isDomainFetchable(): checked on every fetchPageSafe hop when the
//   allowed-domains list is non-empty (empty = no extra restriction; the
//   SSRF guards always apply).
// - DRY_RUN flips mirror into process.env.DRY_RUN, which isDryRun() reads
//   live — effective immediately, no restart.

import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { audit } from "./audit.js";
import { env } from "./env.js";

export interface BudgetPolicy {
  perRunTokenCap: number;
  dailyTokenCap: number;
  maxConcurrentWorkers: number;
  dryRun: boolean;
  killSwitch: boolean;
  allowedDomains: string[];
}

export const DEFAULT_BUDGET: BudgetPolicy = {
  perRunTokenCap: 200_000,
  dailyTokenCap: 2_000_000,
  maxConcurrentWorkers: 3,
  dryRun: true,
  killSwitch: false,
  allowedDomains: [],
};

export const budgetPatchSchema = z.object({
  perRunTokenCap: z.number().int().min(1).max(100_000_000).optional(),
  dailyTokenCap: z.number().int().min(1).max(1_000_000_000).optional(),
  maxConcurrentWorkers: z.number().int().min(1).max(10).optional(),
  dryRun: z.boolean().optional(),
  killSwitch: z.boolean().optional(),
  allowedDomains: z
    .array(
      z
        .string()
        .toLowerCase()
        .regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/, "must be a hostname like example.com"),
    )
    .max(100)
    .optional(),
});

let cached: BudgetPolicy | null = null;

function budgetFile(): string {
  const base = process.env.DATA_DIR ?? env.DATA_DIR; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  return path.join(base, "budget.json");
}

function usageFile(): string {
  const base = process.env.DATA_DIR ?? env.DATA_DIR; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  return path.join(base, "budget-usage.json");
}

/** Test hook: drop the in-process cache (file stays). */
export function resetBudgetForTests(): void {
  cached = null;
}

/** Sync read (spawns and fetch hops are sync gates); loads the file once. */
export function getBudget(): BudgetPolicy {
  if (cached) return { ...cached, allowedDomains: [...cached.allowedDomains] };
  try {
    const raw = JSON.parse(readFileSync(budgetFile(), "utf8")) as Partial<BudgetPolicy>;
    cached = { ...DEFAULT_BUDGET, ...raw, allowedDomains: [...(raw.allowedDomains ?? [])] };
  } catch {
    cached = { ...DEFAULT_BUDGET, allowedDomains: [] };
  }
  return { ...cached, allowedDomains: [...cached.allowedDomains] };
}

export async function updateBudget(
  patch: z.infer<typeof budgetPatchSchema>,
  actor = "human",
): Promise<BudgetPolicy> {
  const parsed = budgetPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new Error(`Invalid budget update: ${parsed.error.issues[0]?.message ?? "bad input"}`);
  }
  const next: BudgetPolicy = { ...getBudget(), ...parsed.data };
  await fs.mkdir(path.dirname(budgetFile()), { recursive: true });
  await fs.writeFile(budgetFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  cached = next;
  if (parsed.data.dryRun !== undefined) {
    // guard:allow-env-mutation — DRY_RUN is a process-global safety default, same scope as the static env it mirrors
    process.env.DRY_RUN = parsed.data.dryRun ? "true" : "false"; // guard:allow-env-credential — deploy-level behavior flag, not a user credential; isDryRun() reads it live
  }
  await audit({ actor, action: "budget.update", input: parsed.data, outcome: next });
  return getBudget();
}

/** Gate for new worker spawns: kill switch, max workers, daily cap. */
export function budgetAllowsSpawn(activeWorkers: number): { ok: boolean; error?: string } {
  const b = getBudget();
  if (b.killSwitch) {
    return { ok: false, error: "Kill switch is ON — no new workers until a human flips it off." };
  }
  if (activeWorkers >= b.maxConcurrentWorkers) {
    return {
      ok: false,
      error: `Too many concurrent workers (max ${b.maxConcurrentWorkers}); queue the remaining spawns until a worker finishes.`,
    };
  }
  if (dailyTokenTotal() >= b.dailyTokenCap) {
    return { ok: false, error: `Daily token cap reached (${b.dailyTokenCap}); workers resume tomorrow.` };
  }
  return { ok: true };
}

/** Empty list = no extra restriction (SSRF guards still apply). */
export function isDomainFetchable(host: string): boolean {
  const allowed = getBudget().allowedDomains;
  if (allowed.length === 0) return true;
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((d) => {
    const base = d.startsWith("*.") ? d.slice(2) : d;
    return h === base || h.endsWith(`.${base}`);
  });
}

function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function readUsageSync(): Record<string, { input: number; output: number }> {
  try {
    return JSON.parse(readFileSync(usageFile(), "utf8")) as Record<string, { input: number; output: number }>;
  } catch {
    return {};
  }
}

export function dailyTokenTotal(d = new Date()): number {
  const entry = readUsageSync()[todayKey(d)];
  return (entry?.input ?? 0) + (entry?.output ?? 0);
}

export interface RecordedUsage {
  runTotal: number;
  dailyTotal: number;
  overPerRunCap: boolean;
  overDailyCap: boolean;
}

/** Add one finished run's tokens to today's ledger; report cap overages. */
export async function recordTokenUsage(inputTokens: number, outputTokens: number): Promise<RecordedUsage> {
  const b = getBudget();
  const usage = readUsageSync();
  const key = todayKey();
  const entry = usage[key] ?? { input: 0, output: 0 };
  entry.input += Math.max(0, Math.round(inputTokens));
  entry.output += Math.max(0, Math.round(outputTokens));
  usage[key] = entry;
  await fs.mkdir(path.dirname(usageFile()), { recursive: true });
  await fs.writeFile(usageFile(), JSON.stringify(usage), { mode: 0o600 });
  const run = Math.max(0, Math.round(inputTokens)) + Math.max(0, Math.round(outputTokens));
  const dailyTotal = entry.input + entry.output;
  return {
    runTotal: run,
    dailyTotal,
    overPerRunCap: run > b.perRunTokenCap,
    overDailyCap: dailyTotal > b.dailyTokenCap,
  };
}
