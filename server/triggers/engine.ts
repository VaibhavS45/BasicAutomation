// server/triggers/engine.ts  Owner: Vaibhav
// Receives TriggerEvents, dedupes, drops own-actor loops, audits, routes to
// a playbook, and runs the agent restricted to the playbook allowlist.
//
// Framework note: Agent-Native currently EXPOSES actions over MCP/HTTP but
// does not document a stable programmatic "run the chat agent with N tools"
// API for server-side trigger code. So the agent-run step is an injectable
// AgentRunner (default: log + audit stub). When the framework gains one,
// swap defaultRunner to call it — the dedupe/allowlist/prompt contract and
// tests stay the same. Concurrency uses a small internal semaphore with
// TRIGGER_MAX_CONCURRENT_RUNS semantics (no extra p-queue dependency).

import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";
import { audit } from "../lib/audit.js";
import type { TriggerEvent } from "../lib/types.js";
import { assertToolAllowed } from "./grants.js";
import { getPlaybook } from "./playbooks.js";

export type EmitStatus =
  | "processed"
  | "duplicate"
  | "dropped-own-actor"
  | "dropped-unknown-type"
  | "dropped-invalid";

export interface EmitOutcome {
  status: EmitStatus;
  playbook?: string;
  runId?: string;
  detail?: string;
}

export interface AgentRunRequest {
  event: TriggerEvent;
  playbook: string;
  systemInstructions: string;
  allowedActions: string[];
  prompt: string;
}

export interface AgentRunResult {
  ok: boolean;
  summary?: string;
  runId?: string;
}

export type AgentRunner = (req: AgentRunRequest) => Promise<AgentRunResult>;

let runner: AgentRunner = async (req) => {
  // Default stub: no model call here. Records intent so triggers are
  // observable in logs/audit until a framework runner is wired in.
  console.log(
    `[triggers] run playbook=${req.playbook} allowed=${req.allowedActions.length} event=${req.event.id}`,
  );
  return { ok: true, summary: `stub run for ${req.event.id}`, runId: `run-${req.event.id}` };
};

/** Override the agent runner (tests / future framework integration). */
export function setAgentRunner(next: AgentRunner): void {
  runner = next;
}

/** Restore the default stub runner. */
export function resetAgentRunner(): void {
  runner = async (req) => {
    console.log(
      `[triggers] run playbook=${req.playbook} allowed=${req.allowedActions.length} event=${req.event.id}`,
    );
    return { ok: true, summary: `stub run for ${req.event.id}`, runId: `run-${req.event.id}` };
  };
}

// --- tiny semaphore (TRIGGER_MAX_CONCURRENT_RUNS) ---
let active = 0;
const waiting: Array<() => void> = [];

function maxConcurrent(): number {
  const raw = process.env.TRIGGER_MAX_CONCURRENT_RUNS;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return env.TRIGGER_MAX_CONCURRENT_RUNS;
}

async function acquire(): Promise<void> {
  if (active < maxConcurrent()) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = waiting.shift();
  if (next) next();
}

/** Test hook: reset in-process concurrency state. */
export function resetEngineForTests(): void {
  active = 0;
  waiting.length = 0;
  resetAgentRunner();
}

// --- persistent dedupe store ---
function dataDir(): string {
  return process.env.DATA_DIR ?? env.DATA_DIR;
}

function dedupeFile(): string {
  return path.join(dataDir(), "triggers", "dedupe.json");
}

function dedupeTtlMs(): number {
  const raw = process.env.TRIGGER_DEDUPE_TTL_HOURS;
  const hours =
    raw !== undefined ? Number.parseFloat(raw) : env.TRIGGER_DEDUPE_TTL_HOURS;
  if (!Number.isFinite(hours) || hours <= 0) return 72 * 3600 * 1000;
  return hours * 3600 * 1000;
}

async function readDedupe(): Promise<Record<string, number>> {
  try {
    const raw = await fs.readFile(dedupeFile(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, number>;
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}

async function writeDedupe(map: Record<string, number>): Promise<void> {
  await fs.mkdir(path.dirname(dedupeFile()), { recursive: true });
  await fs.writeFile(dedupeFile(), JSON.stringify(map), { mode: 0o600 });
}

function botLogin(): string {
  return (process.env.GITHUB_BOT_LOGIN ?? env.GITHUB_BOT_LOGIN ?? "").trim().toLowerCase();
}

function isValid(event: TriggerEvent): event is TriggerEvent & { untrusted: true } {
  if (!event || typeof event !== "object") return false;
  if (typeof event.id !== "string" || event.id.length === 0) return false;
  if (typeof event.source !== "string" || typeof event.type !== "string") return false;
  if (typeof event.receivedAt !== "string" || typeof event.summary !== "string") return false;
  // CONTRACT.md: untrusted is ALWAYS true for trigger events.
  if ((event as TriggerEvent).untrusted !== true) return false;
  return true;
}

/**
 * Enforce the playbook boundary for a single tool call. Payload text —
 * including prompt-injection strings — can never widen this: only the
 * static grant table decides.
 */
export async function invokePlaybookTool<T>(
  playbook: string,
  tool: string,
  fn: () => Promise<T>,
): Promise<T> {
  assertToolAllowed(playbook, tool);
  return fn();
}

/**
 * Main entry: Yashwanth's Gmail poller and the GitHub webhook call this.
 * Steps: (1) dedupe by event.id (persistent, TTL), (2) drop own-actor
 * events, (3) audit, (4) route to playbook, (5) queued agent run with
 * allowlisted tools only, (6) audit outcome.
 */
export async function emit(event: TriggerEvent): Promise<EmitOutcome> {
  if (!isValid(event)) {
    await audit({ actor: "trigger-engine", action: "trigger.invalid", input: { event }, outcome: { status: "dropped-invalid" } });
    return { status: "dropped-invalid", detail: "invalid TriggerEvent (id/source/type/receivedAt/summary/untrusted:true required)" };
  }

  // (1) dedupe — persistent so redelivered webhooks don't rerun the agent.
  const seen = await readDedupe();
  const now = Date.now();
  const ttl = dedupeTtlMs();
  let pruned = false;
  for (const [k, v] of Object.entries(seen)) {
    if (now - v > ttl) {
      delete seen[k];
      pruned = true;
    }
  }
  if (seen[event.id] !== undefined) {
    await audit({
      actor: event.actor ?? event.source,
      action: "trigger.duplicate",
      input: { id: event.id, type: event.type },
      outcome: { status: "duplicate" },
    });
    if (pruned) await writeDedupe(seen);
    return { status: "duplicate", detail: `duplicate id ${event.id}` };
  }
  seen[event.id] = now;
  await writeDedupe(seen);

  // (2) loop guard — never respond to our own bot account.
  const bot = botLogin();
  if (bot && (event.actor ?? "").trim().toLowerCase() === bot) {
    await audit({
      actor: event.actor ?? event.source,
      action: "trigger.dropped-own-actor",
      input: { id: event.id, type: event.type, actor: event.actor },
      outcome: { status: "dropped-own-actor" },
    });
    return { status: "dropped-own-actor", detail: `actor ${event.actor} is the bot itself` };
  }

  // (3) audit the accepted event.
  await audit({
    actor: event.actor ?? event.source,
    action: "trigger.received",
    input: { id: event.id, source: event.source, type: event.type, summary: event.summary },
    outcome: null,
  });

  // (4) route — unknown types are dropped (deny by default).
  const playbook = getPlaybook(event.type);
  if (!playbook) {
    await audit({
      actor: event.actor ?? event.source,
      action: "trigger.dropped-unknown-type",
      input: { id: event.id, type: event.type },
      outcome: { status: "dropped-unknown-type" },
    });
    return { status: "dropped-unknown-type", detail: `no playbook for ${event.type}` };
  }

  // (5)+(6) queued, allowlisted run.
  const prompt = playbook.buildPrompt(event);
  await acquire();
  try {
    const result = await runner({
      event,
      playbook: event.type,
      systemInstructions: playbook.systemInstructions,
      allowedActions: [...playbook.allowedActions],
      prompt,
    });
    // (7) audit outcome.
    await audit({
      actor: event.actor ?? event.source,
      action: "trigger.completed",
      input: { id: event.id, type: event.type, playbook: event.type },
      outcome: { ok: result.ok, summary: result.summary ?? null, runId: result.runId ?? null },
    });
    return { status: "processed", playbook: event.type, runId: result.runId, detail: result.summary };
  } catch (err) {
    await audit({
      actor: event.actor ?? event.source,
      action: "trigger.failed",
      input: { id: event.id, type: event.type },
      outcome: { ok: false, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  } finally {
    release();
  }
}
