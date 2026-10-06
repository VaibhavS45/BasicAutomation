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
