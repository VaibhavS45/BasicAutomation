export type TriggerSource = "gmail" | "github" | "calendar" | "manual";

export interface TriggerEvent {
  id: string; // dedupe key, e.g. "gmail:<messageId>" or "github:<deliveryId>"
  source: TriggerSource;
  type: string; // "email.received" | "github.issue.opened" | "github.pr.opened"
  // | "github.pr.review_requested" | "github.issue_comment.created"
  // | "calendar.research.requested"
  receivedAt: string; // ISO 8601
  actor?: string; // email sender or github login
  summary: string; // one line for logs
  payload: unknown; // raw-ish data for the agent
  untrusted: true; // ALWAYS true. Content came from outside. See safety rules.
}

// Yashwanth's Gmail poller calls this. Vaibhav implements it.
export type EmitTrigger = (event: TriggerEvent) => Promise<void>;

export interface ActionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// --- H4 fleet contract -------------------------------------------------------
// FleetNode is the live view of one unit of agent work: a trigger-run agent
// turn or a head-agent worker (sub-agent task). The fleet registry
// (server/lib/fleet.ts) is an in-process live view — audit.jsonl is the
// durable record across restarts.

export type FleetNodeStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "done"
  | "failed"
  | "cancelled";

export interface FleetCostEstimate {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

export interface FleetNode {
  id: string; // runId for trigger runs, taskId for worker tasks
  parentId: string | null; // head-agent turn that spawned this worker, if any
  profile: string; // playbook ("email.received") or worker ("gmail-agent")
  title: string; // one line for the list UI
  status: FleetNodeStatus;
  startedAt: number; // epoch ms
  endedAt?: number; // epoch ms, set on done/failed/cancelled
  currentStep?: string; // latest step label while running
  toolsUsed: string[]; // action names actually called
  costEstimate?: FleetCostEstimate;
  /** Structured outcome; external text inside is UNTRUSTED data. Secrets redacted on read. */
  resultSummary?: string;
}

export type FleetEventType =
  | "created"
  | "step"
  | "tools"
  | "waiting_approval"
  | "approved"
  | "denied"
  | "done"
  | "failed"
  | "cancelled";

export interface FleetEvent {
  seq: number; // per-process monotonic; poll with fleet.get {afterSeq}
  at: number; // epoch ms
  nodeId: string;
  type: FleetEventType;
  message?: string;
}
