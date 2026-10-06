import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "./env.js";
import { redactSecretsInText } from "./redact.js";

export interface AuditInput {
  actor: string;
  action: string;
  input?: unknown;
  outcome?: unknown;
}

export const SECRET_KEY_PATTERN = /token|secret|key|password|authorization/i;

/**
 * Two-layer redaction (approvals.ts inherits both layers through this call):
 * secret-NAMED keys become "[REDACTED]" as before, and every other string
 * additionally passes the content scrub (redactSecretsInText), which masks
 * credential-SHAPED values (key prefixes, Bearer tokens, PEM blocks,
 * key=value pairs, URL userinfo) wherever they hide.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactSecretsInText(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[REDACTED]" : redactSecrets(v);
    }
    return out;
  }
  return value;
}

function dataDir(): string {
  return process.env.DATA_DIR ?? env.DATA_DIR; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
}

/**
 * Append-only JSONL audit log at DATA_DIR/audit.jsonl.
 * Secrets (keys matching /token|secret|key|password|authorization/i) are
 * redacted before writing. Never throws — logs to console on failure.
 *
 * Framework note: Agent-Native also has a SQL audit table
 * (dist/audit/*, `audit` field on defineAction). This JSONL file is the
 * CONTRACT.md log Yashwanth imports directly; risky wrappers should enable
 * both (framework `audit:` config + this call) from Phase 2 on.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    const dir = dataDir();
    await fs.mkdir(dir, { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      actor: input.actor,
      action: input.action,
      input: redactSecrets(input.input ?? null),
      outcome: redactSecrets(input.outcome ?? null),
    };
    await fs.appendFile(
      path.join(dir, "audit.jsonl"),
      `${JSON.stringify(entry)}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    console.error("[audit] failed to append:", err);
  }
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  input: unknown;
  outcome: unknown;
}

export interface AuditQuery {
  /** Substring search over the whole entry (actor, action, payloads). */
  q?: string;
  /** Substring match on the action name, e.g. "gmail" or "trigger". */
  action?: string;
  /** Substring match on the actor. */
  actor?: string;
  /** Filter by outcome.ok (entries without an ok flag never match). */
  ok?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Searchable read of the JSONL log, newest first. Skips malformed lines;
 * never throws (returns what parsed).
 */
export async function queryAudit(query: AuditQuery = {}): Promise<{ entries: AuditEntry[]; total: number }> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  let lines: string[];
  try {
    const raw = await fs.readFile(path.join(dataDir(), "audit.jsonl"), "utf8");
    lines = raw.split("\n");
  } catch {
    return { entries: [], total: 0 };
  }
  const q = query.q?.toLowerCase();
  const action = query.action?.toLowerCase();
  const actor = query.actor?.toLowerCase();
  const matched: AuditEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      continue;
    }
    if (action && !String(entry.action ?? "").toLowerCase().includes(action)) continue;
    if (actor && !String(entry.actor ?? "").toLowerCase().includes(actor)) continue;
    if (query.ok !== undefined) {
      const ok = (entry.outcome as { ok?: unknown } | null)?.ok;
      if (ok !== query.ok) continue;
    }
    if (q && !JSON.stringify(entry).toLowerCase().includes(q)) continue;
    matched.push(entry);
  }
  return { entries: matched.slice(offset, offset + limit), total: matched.length };
}
