// server/triggers/engine.ts  Owner: Vaibhav
// Receives TriggerEvents, dedupes, drops own-actor loops, audits, routes to
// a playbook, and runs the agent restricted to the playbook allowlist.
//
// Framework wiring (verified against @agent-native/core 0.196 dist + docs):
// the agent turn runs through runAgentLoop (@agent-native/core/server,
// re-exported from agent/production-agent) with a caller-supplied `actions`
// map + `tools` array built by actionsToEngineTools — per-run restriction by
// construction. The engine resolves via registerBuiltinEngines +
// detectEngineFromEnv (./agent/engine), model override via env.AGENT_MODEL.
// Why not the alternatives: event-bus emit() is fire-and-forget pub/sub for
// user-created automations (no turn result comes back); queueAutomationRunNow
// needs a persisted jobs/*.md automation plus an ownerEmail identity, and
// trigger events carry no owner; the automations dispatcher is that heavier
// path — the smallest safe alternative if per-run filtering ever regresses
// is one dedicated automation per playbook with an explicit mcpTools list.
// All framework imports below are lazy (dynamic import inside the runner) so
// this module costs nothing at import time and never needs model credentials
// until a run actually fires. With no engine credential the run returns
// ok:false with an explicit error (audited) instead of a fake success.
// Concurrency uses a small internal semaphore with
// TRIGGER_MAX_CONCURRENT_RUNS semantics (no extra p-queue dependency).

import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";
import { audit } from "../lib/audit.js";
import { finishNode, registerNode, updateNode } from "../lib/fleet.js";
import type { TriggerEvent } from "../lib/types.js";
import { assertToolAllowed, allowedToolsFor } from "./grants.js";
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
  error?: string;
}

export type AgentRunner = (req: AgentRunRequest) => Promise<AgentRunResult>;

// --- default runner: a real restricted agent turn ---------------------------
// Only the app's own custom actions are loadable here (search.web,
// search.fetchPage, meetings.scheduleAndNotify). Raw Composio/MCP slugs in a
// playbook grant are NOT locally runnable — they resolve through connected
// MCP grants on the automation path — so they are reported as unresolved in
// the run-start audit instead of failing silently.
const TRIGGER_ACTION_MODULES: Record<string, () => Promise<unknown>> = {
  "search.web": () => import("../../actions/search.web.js"),
  "search.fetchPage": () => import("../../actions/search.fetchPage.js"),
  "meetings.scheduleAndNotify": () => import("../../actions/meetings/scheduleAndNotify.js"),
  "github.getIssue": () => import("../../actions/github.getIssue.js"),
  "github.listIssues": () => import("../../actions/github.listIssues.js"),
  "github.getPullRequest": () => import("../../actions/github.getPullRequest.js"),
  "github.listPRFiles": () => import("../../actions/github.listPRFiles.js"),
  "github.getPRDiff": () => import("../../actions/github.getPRDiff.js"),
  "github.createIssue": () => import("../../actions/github.createIssue.js"),
  "github.commentOnIssue": () => import("../../actions/github.commentOnIssue.js"),
  "github.submitReview": () => import("../../actions/github.submitReview.js"),
  "research.generate": () => import("../../actions/research.generate.js"),
};

/** Wall-clock ceiling for one trigger agent turn (abort, audited, no hang). */
const TRIGGER_RUN_TIMEOUT_MS = 120_000;

export interface DefaultRunnerDeps {
  loadTriggerActions: (names: string[]) => Promise<Record<string, unknown>>;
  detectTriggerEngine: () => Promise<{ name: string; create: (config: Record<string, unknown>) => unknown; defaultModel: string } | null>;
  runTriggerLoop: (opts: {
    engine: unknown;
    model: string;
    systemPrompt: string;
    messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }> }>;
    actions: Record<string, { tool: unknown; run: (args: unknown, ctx?: unknown) => Promise<unknown> }>;
    send: (event: { type: string; text?: string }) => void;
    signal: AbortSignal;
    onApprovalRequired: (binding: { toolName: string; input: unknown; callId: string }) => Promise<string>;
  }) => Promise<{ inputTokens: number; outputTokens: number; model: string }>;
  createTriggerApproval: (input: { action: string; summary: string; payload?: unknown }) => Promise<{ approvalId: string }>;
}

async function defaultLoadTriggerActions(names: string[]): Promise<Record<string, unknown>> {
  const modules: Record<string, unknown> = {};
  for (const name of names) {
    const loader = TRIGGER_ACTION_MODULES[name];
    if (!loader) continue;
    modules[name] = await loader();
  }
  const { loadActionsFromStaticRegistry } = await import("@agent-native/core/server");
  return loadActionsFromStaticRegistry(modules) as Record<string, unknown>;
}

async function defaultDetectTriggerEngine(): Promise<{
  name: string;
  create: (config: Record<string, unknown>) => unknown;
  defaultModel: string;
} | null> {
  const { registerBuiltinEngines, detectEngineFromEnv } = await import(
    "@agent-native/core/agent/engine"
  );
  registerBuiltinEngines();
  const entry = detectEngineFromEnv();
  if (!entry) return null;
  return { name: entry.name, create: entry.create, defaultModel: entry.defaultModel };
}

async function defaultRunTriggerLoop(opts: Parameters<DefaultRunnerDeps["runTriggerLoop"]>[0]): Promise<{ inputTokens: number; outputTokens: number; model: string }> {
  const { runAgentLoop, actionsToEngineTools } = await import("@agent-native/core/server");
  const tools = actionsToEngineTools(opts.actions as never) as never[];
  const usage = await runAgentLoop({
    engine: opts.engine as never,
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    tools,
    messages: opts.messages as never,
    actions: opts.actions as never,
    send: opts.send as never,
    signal: opts.signal,
    onApprovalRequired: opts.onApprovalRequired as never,
  });
  return usage as unknown as { inputTokens: number; outputTokens: number; model: string };
}

let runnerDeps: DefaultRunnerDeps = {
  loadTriggerActions: defaultLoadTriggerActions,
  detectTriggerEngine: defaultDetectTriggerEngine,
  runTriggerLoop: defaultRunTriggerLoop,
  createTriggerApproval: async (input) => {
    const { createPendingApproval } = await import("../lib/approvals.js");
    return createPendingApproval(input);
  },
};

/** Override framework seams (tests inject fakes; prod uses lazy defaults). */
export function setRunnerDeps(next: Partial<DefaultRunnerDeps>): void {
  runnerDeps = { ...runnerDeps, ...next };
}

function resetRunnerDeps(): void {
  runnerDeps = {
    loadTriggerActions: defaultLoadTriggerActions,
    detectTriggerEngine: defaultDetectTriggerEngine,
    runTriggerLoop: defaultRunTriggerLoop,
    createTriggerApproval: async (input) => {
      const { createPendingApproval } = await import("../lib/approvals.js");
      return createPendingApproval(input);
    },
  };
}

/**
 * The default agent runner: a REAL restricted turn, not a log line.
 * 1. Re-derives the allowlist from the static grant table (grants.ts) and
 *    intersects it with the request — payload text can never add tools.
 * 2. Loads only those app actions, wraps every run() with assertToolAllowed
 *    (second enforcement layer) and records tools actually used.
 * 3. Resolves the model engine from deploy env; with no credential it
 *    returns ok:false + explicit error (audited), never a fake success.
 * 4. Runs the fenced prompt through the framework agent loop. Write tools
 *    pause into file-based pending approvals (never auto-executed).
 * Audits trigger.run-start and trigger.run-end around the turn.
 */
async function defaultRunner(req: AgentRunRequest): Promise<AgentRunResult> {
  const runId = `run-${req.event.id}`;
  const actor = req.event.actor ?? req.event.source;

  // (1) Static table wins: intersect, then assert each survivor.
  const staticAllowed = allowedToolsFor(req.playbook);
  const requested = new Set(req.allowedActions);
  const effective = staticAllowed.filter((t) => requested.has(t));
  for (const tool of effective) assertToolAllowed(req.playbook, tool);
  const unresolved = effective.filter((t) => TRIGGER_ACTION_MODULES[t] === undefined);

  await audit({
    actor,
    action: "trigger.run-start",
    input: { id: req.event.id, playbook: req.playbook, allowed: effective, unresolved },
    outcome: null,
  });

  // (2) Load + wrap only the allowlisted actions.
  const loaded = await runnerDeps.loadTriggerActions(effective);
  const toolsUsed: string[] = [];
  const controller = new AbortController();
  // H4 fleet: one live node per trigger run — cancel via fleet.cancel(l).
  registerNode({
    id: runId,
    profile: req.playbook,
    title: req.event.summary.slice(0, 200),
    runId,
    abort: () => controller.abort(),
  });
  updateNode(runId, { status: "running", currentStep: "agent turn started" });
  const actions: Record<string, { tool: unknown; run: (args: unknown, ctx?: unknown) => Promise<unknown> }> = {};
  for (const [name, entry] of Object.entries(loaded)) {
    assertToolAllowed(req.playbook, name);
    const record = entry as { tool: unknown; run: (args: unknown, ctx?: unknown) => Promise<unknown> };
    if (typeof record?.run !== "function") continue;
    const inner = record.run.bind(record);
    actions[name] = {
      tool: record.tool,
      run: async (args: unknown, ctx?: unknown) => {
        assertToolAllowed(req.playbook, name);
        toolsUsed.push(name);
        updateNode(runId, { toolsUsed: [...toolsUsed], currentStep: `called ${name}` });
        return inner(args, ctx);
      },
    };
  }

  // (3) Engine from deploy env (ANTHROPIC_API_KEY etc.), model override first.
  const detected = await runnerDeps.detectTriggerEngine();
  const model = env.AGENT_MODEL ?? detected?.defaultModel;
  if (!detected || !model) {
    const error =
      "No model engine configured for trigger runs: set a provider key " +
      "(e.g. ANTHROPIC_API_KEY) and optionally AGENT_MODEL. Not a fake run — nothing executed.";
    await audit({
      actor,
      action: "trigger.run-end",
      input: { id: req.event.id, playbook: req.playbook },
      outcome: { ok: false, error, toolsUsed, runId },
    });
    finishNode(runId, "failed", error.slice(0, 2000));
    return { ok: false, error, runId };
  }
  const engine = detected.create({});

  // (4) The turn. Approval hook pauses writes into pending approvals.
  const pendingApprovals: string[] = [];
  let responseText = "";
  const timer = setTimeout(() => controller.abort(), TRIGGER_RUN_TIMEOUT_MS);
  try {
    const usage = await runnerDeps.runTriggerLoop({
      engine,
      model,
      systemPrompt: req.systemInstructions,
      messages: [{ role: "user", content: [{ type: "text", text: req.prompt }] }],
      actions,
      send: (event) => {
        // Tolerant collector: framework text events carry the chunk under
        // different keys across versions (text / delta / content).
        const ev = event as unknown as Record<string, unknown>;
        const chunk =
          (typeof ev.text === "string" && ev.text) ||
          (typeof ev.delta === "string" && ev.delta) ||
          (typeof ev.content === "string" && ev.content) ||
          "";
        responseText += chunk;
      },
      signal: controller.signal,
      onApprovalRequired: async (binding) => {
        const { approvalId } = await runnerDeps.createTriggerApproval({
          action: `${req.playbook}:${binding.toolName}`,
          summary: `Trigger ${req.event.id} needs approval to run ${binding.toolName}`,
          payload: { playbook: req.playbook, tool: binding.toolName, input: binding.input },
        });
        pendingApprovals.push(approvalId);
        updateNode(runId, { status: "waiting_approval", currentStep: `waiting approval for ${binding.toolName}` });
        return approvalId;
      },
    });
    const summary =
      (responseText.trim() || `completed with ${toolsUsed.length} tool call(s)`) +
      (pendingApprovals.length > 0 ? ` [approval pending: ${pendingApprovals.join(", ")}]` : "");
    finishNode(runId, "done", summary.slice(0, 2000));
    await audit({
      actor,
      action: "trigger.run-end",
      input: { id: req.event.id, playbook: req.playbook },
      outcome: {
        ok: true,
        toolsUsed,
        pendingApprovals,
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: usage.model },
        responseChars: responseText.length,
        runId,
      },
    });
    return { ok: true, summary: summary.slice(0, 2000), runId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishNode(runId, "failed", error.slice(0, 2000));
    await audit({
      actor,
      action: "trigger.run-end",
      input: { id: req.event.id, playbook: req.playbook },
      outcome: { ok: false, error, toolsUsed, pendingApprovals, runId },
    });
    return { ok: false, error, runId };
  } finally {
    clearTimeout(timer);
  }
}

let runner: AgentRunner = defaultRunner;

/** Override the agent runner (tests / future framework integration). */
export function setAgentRunner(next: AgentRunner): void {
  runner = next;
}

/** Restore the default real runner (restricted agent turn). */
export function resetAgentRunner(): void {
  runner = defaultRunner;
}

// --- tiny semaphore (TRIGGER_MAX_CONCURRENT_RUNS) ---
let active = 0;
const waiting: Array<() => void> = [];

function maxConcurrent(): number {
  const raw = process.env.TRIGGER_MAX_CONCURRENT_RUNS; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
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
  inflight.clear();
  resetAgentRunner();
  resetRunnerDeps();
}

// In-flight ids: closes the read-then-write race when two deliveries with
// the same id arrive concurrently (the file check alone can't see the
// other call before it writes). Synchronous add — no await between the
// check and the insert, so the second caller always observes the first.
const inflight = new Set<string>();

// --- persistent dedupe store ---
function dataDir(): string {
  return process.env.DATA_DIR ?? env.DATA_DIR; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
}

function dedupeFile(): string {
  return path.join(dataDir(), "triggers", "dedupe.json");
}

function dedupeTtlMs(): number {
  const raw = process.env.TRIGGER_DEDUPE_TTL_HOURS; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
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
  return (process.env.GITHUB_BOT_LOGIN ?? env.GITHUB_BOT_LOGIN ?? "").trim().toLowerCase(); // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
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
  // The in-flight set covers concurrent same-id arrivals; the file covers
  // redeliveries across restarts. Both report the same duplicate status.
  if (inflight.has(event.id)) {
    await audit({
      actor: event.actor ?? event.source,
      action: "trigger.duplicate",
      input: { id: event.id, type: event.type },
      outcome: { status: "duplicate" },
    });
    return { status: "duplicate", detail: `duplicate id ${event.id}` };
  }
  inflight.add(event.id);
  try {
    return await emitInner(event);
  } finally {
    inflight.delete(event.id);
  }
}

/** Post-dedupe emit pipeline (own-actor drop, audit, route, run, audit). */
async function emitInner(event: TriggerEvent): Promise<EmitOutcome> {
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
    return { status: "processed", playbook: event.type, runId: result.runId, detail: result.summary ?? result.error };
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
