import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "./env.js";
import { redactSecrets } from "./audit.js";

export interface RequireApprovalInput {
  action: string;
  summary: string;
  payload?: unknown;
  /** Override the 15 min expiry (tests use a small value). */
  ttlMs?: number;
  /** Fixed id (tests / callers that pre-resolve). */
  approvalId?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  approvalId: string;
}

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

interface ApprovalRecord {
  id: string;
  action: string;
  summary: string;
  payload: unknown;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: number;
  reason?: string;
}

// Framework note: Agent-Native already ships a human-in-the-loop primitive —
// `needsApproval` on defineAction + SQL-backed tool-approval store
// (dist/agent/tool-approval-store.js, set-tool-approval-policy action).
// That covers agent tool calls inside a thread/turn. This file is the
// trigger/script-side gate from CONTRACT.md: file-based pending approvals in
// DATA_DIR so Yashwanth's wrappers and server/triggers can use it without a
// thread context. Risky actions should ALSO set `needsApproval: true` on
// their defineAction (Phase 2+ wrappers will do that).

function dataDir(): string {
  return process.env.DATA_DIR ?? env.DATA_DIR;
}

function isDryRun(): boolean {
  const raw = process.env.DRY_RUN;
  if (raw !== undefined) {
    const s = raw.toLowerCase().trim();
    return !["0", "false", "no", "off"].includes(s);
  }
  return env.DRY_RUN;
}

function approvalsDir(): string {
  return path.join(dataDir(), "approvals");
}

function fileFor(id: string): string {
  return path.join(approvalsDir(), `${id}.json`);
}

async function readRecord(id: string): Promise<ApprovalRecord | null> {
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8")) as ApprovalRecord;
  } catch {
    return null;
  }
}

async function writeRecord(record: ApprovalRecord): Promise<void> {
  await fs.mkdir(approvalsDir(), { recursive: true });
  await fs.writeFile(fileFor(record.id), JSON.stringify(record, null, 2), {
    mode: 0o600,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gate a risky action. DRY_RUN short-circuits BEFORE any network call:
 * logs the redacted payload and auto-approves the gate (the caller must
 * still skip the send and log instead of sending).
 *
 * Otherwise persists a pending approval, polls for a decision until the
 * 15 min expiry, and returns { approved: false } on deny/expire.
 * Approve from chat UI / CLI via approveApproval(id) / denyApproval(id).
 */
export async function requireApproval(
  input: RequireApprovalInput,
): Promise<ApprovalDecision> {
  if (isDryRun()) {
    console.log(
      `[approvals:dry-run] ${input.action} — ${input.summary} ${JSON.stringify(
        redactSecrets(input.payload ?? {}),
      )}`,
    );
    return { approved: true, reason: "dry-run", approvalId: "dry-run" };
  }

  const id = input.approvalId ?? randomUUID();
  const ttl = input.ttlMs ?? APPROVAL_TTL_MS;
  const now = Date.now();

  let record = await readRecord(id);
  if (!record) {
    record = {
      id,
      action: input.action,
      summary: input.summary,
      payload: redactSecrets(input.payload ?? null),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: now + ttl,
    };
    await writeRecord(record);
    console.log(
      `[approvals] pending ${id}: ${input.action} — ${input.summary} (expires in ${Math.round(ttl / 1000)}s; approve via approveApproval("${id}"))`,
    );
  }

  const pollMs = ttl <= 2000 ? 25 : 250;
  const deadline = record.expiresAt;
  for (;;) {
    const current = await readRecord(id);
    if (!current) {
      return { approved: false, reason: "approval record missing", approvalId: id };
    }
    if (current.status === "approved") {
      return { approved: true, approvalId: id };
    }
    if (current.status === "denied") {
      return {
        approved: false,
        reason: current.reason ?? "denied",
        approvalId: id,
      };
    }
    if (Date.now() >= current.expiresAt) {
      const expired: ApprovalRecord = {
        ...current,
        status: "expired",
        reason: "expired",
      };
      await writeRecord(expired);
      return { approved: false, reason: "expired", approvalId: id };
    }
    if (Date.now() >= deadline + 30_000) {
      return { approved: false, reason: "expired", approvalId: id };
    }
    await sleep(pollMs);
  }
}

export async function resolveApproval(
  id: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  const record = await readRecord(id);
  if (!record) throw new Error(`approval not found: ${id}`);
  if (record.status !== "pending") return;
  await writeRecord({
    ...record,
    status: approved ? "approved" : "denied",
    reason: reason ?? (approved ? "approved" : "denied"),
  });
}

export async function approveApproval(id: string): Promise<void> {
  await resolveApproval(id, true, "approved");
}

export async function denyApproval(
  id: string,
  reason = "denied",
): Promise<void> {
  await resolveApproval(id, false, reason);
}
