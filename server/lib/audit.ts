import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "./env.js";

export interface AuditInput {
  actor: string;
  action: string;
  input?: unknown;
  outcome?: unknown;
}

export const SECRET_KEY_PATTERN = /token|secret|key|password|authorization/i;

export function redactSecrets(value: unknown): unknown {
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
  return process.env.DATA_DIR ?? env.DATA_DIR;
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
