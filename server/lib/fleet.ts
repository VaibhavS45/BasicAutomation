// server/lib/fleet.ts  Owner: Vaibhav (H4 fleet + approvals API)
// In-process LIVE registry of agent work: trigger-run agent turns and
// head-agent worker (sub-agent) tasks. One FleetNode per unit of work with
// status, steps, tools used, and a redacted result summary.
//
// Liveness note: this registry is in-memory — a restart clears it and
// audit.jsonl remains the durable record. Reads (fleet.list/get) always pass
// through the secret scrub, so transcripts never leak credentials.
// Cancellation is best-effort and layered: the node's local abort handle
// first, then the framework run/task abort hooks (injected for tests, real
// lazy framework imports in prod). A node is marked cancelled even when a
// framework abort reports nothing to abort — the local run is over either way.

import { audit, redactSecrets } from "./audit.js";
import type {
  FleetCostEstimate,
  FleetEvent,
  FleetEventType,
  FleetNode,
  FleetNodeStatus,
} from "./types.js";

const MAX_EVENTS_PER_NODE = 100;

const TERMINAL: ReadonlySet<FleetNodeStatus> = new Set(["done", "failed", "cancelled"]);
const ACTIVE: ReadonlySet<FleetNodeStatus> = new Set(["queued", "running", "waiting_approval"]);

interface NodeRecord {
  node: FleetNode;
  /** Monotonic registration order — breaks startedAt ties in listNodes. */
  order: number;
  /** Framework sub-agent task id (agent-teams) — aborted via markTaskErrored. */
  taskId?: string;
  /** Framework run id (run-manager) — correlation only; trigger runs abort via `abort`. */
  runId?: string;
  /** Local abort (e.g. the trigger run's AbortController). */
  abort?: () => void;
  events: FleetEvent[];
}

const nodes = new Map<string, NodeRecord>();
let seq = 0;
let registerCounter = 0;

export type FleetListener = (event: FleetEvent) => void;
const listeners = new Set<FleetListener>();

/** Live-update subscription (the SSE route and tests use this). Returns unsubscribe. */
export function subscribeFleet(listener: FleetListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: clear all in-process fleet state. */
export function resetFleetForTests(): void {
  nodes.clear();
  listeners.clear();
  seq = 0;
  registerCounter = 0;
  frameworkHooks = defaultFrameworkHooks;
}

// --- framework abort hooks (injectable; real ones lazy-import framework) ---

export interface FrameworkAbortOutcome {
  markedTask: boolean;
  errors: string[];
}

async function realMarkTaskErrored(taskId: string, reason: string): Promise<void> {
  // Verified export: dist/server/index.d.ts re-exports markTaskErrored from
  // agent-teams. (run-manager abortRun is NOT package-exported — trigger runs
  // abort through their local AbortController handle instead.)
  const { markTaskErrored } = await import("@agent-native/core/server");
  await markTaskErrored(taskId, reason);
}

export interface FleetFrameworkHooks {
  markTaskErrored: (taskId: string, reason: string) => Promise<void>;
}

const defaultFrameworkHooks: FleetFrameworkHooks = {
  markTaskErrored: realMarkTaskErrored,
};

let frameworkHooks: FleetFrameworkHooks = defaultFrameworkHooks;

/** Override the framework abort path (tests inject fakes; prod uses lazy defaults). */
export function setFleetFrameworkHooks(next: Partial<FleetFrameworkHooks>): void {
  frameworkHooks = { ...frameworkHooks, ...next };
}

function redactedNode(node: FleetNode): FleetNode {
  // Secret scrub on the free-text fields; ids/status/counters pass through.
  return {
    ...node,
    currentStep:
      typeof node.currentStep === "string"
        ? (redactSecrets(node.currentStep) as string)
        : node.currentStep,
    resultSummary:
      typeof node.resultSummary === "string"
        ? (redactSecrets(node.resultSummary) as string)
        : node.resultSummary,
  };
}

function emit(record: NodeRecord, type: FleetEventType, message?: string): FleetEvent {
  seq += 1;
  const event: FleetEvent = { seq, at: Date.now(), nodeId: record.node.id, type, message };
  record.events.push(event);
  if (record.events.length > MAX_EVENTS_PER_NODE) {
    record.events.splice(0, record.events.length - MAX_EVENTS_PER_NODE);
  }
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A slow/broken subscriber must never break the registry.
    }
  }
  return event;
}

export interface RegisterNodeInput {
  id?: string;
  parentId?: string | null;
  profile: string;
  title: string;
  taskId?: string;
  runId?: string;
  abort?: () => void;
}

export function registerNode(input: RegisterNodeInput): FleetNode {
  const now = Date.now();
  const id = input.id ?? `fleet-${now}-${Math.floor(Math.random() * 1_000_000)}`;
  const node: FleetNode = {
    id,
    parentId: input.parentId ?? null,
    profile: input.profile,
    title: input.title.slice(0, 200),
    status: "queued",
    startedAt: now,
    toolsUsed: [],
  };
  nodes.set(id, { node, order: (registerCounter += 1), taskId: input.taskId, runId: input.runId, abort: input.abort, events: [] });
  const record = nodes.get(id)!;
  emit(record, "created", `${input.profile}: ${node.title}`);
  void audit({
    actor: "fleet",
    action: "fleet.register",
    input: { id, profile: input.profile, parentId: input.parentId ?? null },
    outcome: { status: node.status },
  });
  return redactedNode(node);
}

export function getNode(id: string): FleetNode | undefined {
  const record = nodes.get(id);
  return record ? redactedNode(record.node) : undefined;
}

export function listNodes(): FleetNode[] {
  return [...nodes.values()]
    .sort((a, b) => b.node.startedAt - a.node.startedAt || b.order - a.order)
    .map((record) => redactedNode(record.node));
}

/** Transcript slice for fleet.get: node events after `afterSeq` (1–2 s polling fallback). */
export function nodeEvents(id: string, afterSeq = 0): FleetEvent[] {
  const record = nodes.get(id);
  if (!record) return [];
  return (redactSecrets(record.events.filter((e) => e.seq > afterSeq)) as FleetEvent[]).slice(-MAX_EVENTS_PER_NODE);
}

export interface UpdateNodeInput {
  currentStep?: string;
  toolsUsed?: string[];
  costEstimate?: FleetCostEstimate;
  status?: "queued" | "running" | "waiting_approval";
}

export function updateNode(id: string, patch: UpdateNodeInput): FleetNode | undefined {
  const record = nodes.get(id);
  if (!record || TERMINAL.has(record.node.status)) return undefined;
  if (patch.currentStep !== undefined) {
    record.node.currentStep = patch.currentStep.slice(0, 500);
    emit(record, "step", record.node.currentStep);
  }
  if (patch.toolsUsed !== undefined) {
    record.node.toolsUsed = [...patch.toolsUsed];
    emit(record, "tools", record.node.toolsUsed.join(", "));
  }
  if (patch.costEstimate !== undefined) record.node.costEstimate = patch.costEstimate;
  if (patch.status !== undefined && patch.status !== record.node.status) {
    record.node.status = patch.status;
    emit(record, patch.status === "waiting_approval" ? "waiting_approval" : "step", patch.status);
  }
  return redactedNode(record.node);
}

export function finishNode(
  id: string,
  status: "done" | "failed",
  resultSummary?: string,
): FleetNode | undefined {
  const record = nodes.get(id);
  if (!record || TERMINAL.has(record.node.status)) return undefined;
  record.node.status = status;
  record.node.endedAt = Date.now();
  if (resultSummary !== undefined) record.node.resultSummary = resultSummary.slice(0, 2000);
  emit(record, status, record.node.resultSummary ?? status);
  void audit({
    actor: "fleet",
    action: status === "done" ? "fleet.done" : "fleet.failed",
    input: { id, profile: record.node.profile },
    outcome: { status, toolsUsed: record.node.toolsUsed },
  });
  return redactedNode(record.node);
}

export interface CancelOutcome {
  ok: boolean;
  node?: FleetNode;
  localAborted?: boolean;
  framework?: FrameworkAbortOutcome;
  error?: string;
}

/**
 * Cancel one node: fire the local abort handle (the trigger run's
 * AbortController — the real abort for agent turns), then best-effort
 * markTaskErrored for worker sub-agent tasks. The node is marked cancelled
 * regardless — a framework hook reporting "nothing to abort" (or throwing
 * with no DB) never leaves a locally-dead run looking alive.
 */
export async function cancelNode(id: string, reason = "cancelled from fleet", actor = "fleet"): Promise<CancelOutcome> {
  const record = nodes.get(id);
  if (!record) return { ok: false, error: `fleet node not found: ${id}` };
  if (TERMINAL.has(record.node.status)) {
    return { ok: false, error: `fleet node ${id} is already ${record.node.status}` };
  }
  let localAborted = false;
  if (record.abort) {
    try {
      record.abort();
      localAborted = true;
    } catch {
      localAborted = false;
    }
  }
  const framework: FrameworkAbortOutcome = { markedTask: false, errors: [] };
  if (record.taskId) {
    try {
      await frameworkHooks.markTaskErrored(record.taskId, `fleet.cancel: ${reason}`);
      framework.markedTask = true;
    } catch (err) {
      framework.errors.push(`markTaskErrored: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  record.node.status = "cancelled";
  record.node.endedAt = Date.now();
  emit(record, "cancelled", reason);
  await audit({
    actor,
    action: "fleet.cancel",
    input: { id, profile: record.node.profile },
    outcome: { status: "cancelled", reason, localAborted, framework },
  });
  return { ok: true, node: redactedNode(record.node), localAborted, framework };
}

export interface CancelAllOutcome {
  cancelled: string[];
  already: string[];
}

/** Kill switch: cancel every active node, skip terminals. Never throws. */
export async function cancelAll(reason = "fleet kill switch", actor = "fleet"): Promise<CancelAllOutcome> {
  const cancelled: string[] = [];
  const already: string[] = [];
  for (const [id, record] of nodes) {
    if (!ACTIVE.has(record.node.status)) {
      already.push(id);
      continue;
    }
    const out = await cancelNode(id, reason, actor);
    if (out.ok) cancelled.push(id);
    else already.push(id);
  }
  await audit({ actor, action: "fleet.cancelAll", input: { reason }, outcome: { cancelled, already } });
  return { cancelled, already };
}

/** SSE message object for one fleet event (redacted). Pure — tested. */
export function fleetEventMessage(event: FleetEvent): { id: string; event: string; data: string } {
  return { id: String(event.seq), event: "fleet", data: JSON.stringify(redactSecrets(event) as FleetEvent) };
}

/** SSE wire format for one fleet event. Pure — tested. */
export function formatFleetSse(event: FleetEvent): string {
  const m = fleetEventMessage(event);
  return `id: ${m.id}\nevent: ${m.event}\n` + `data: ${m.data}\n\n`;
}
