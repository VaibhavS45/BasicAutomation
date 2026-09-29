interface AuditInput {
  actor: string;
  action: string;
  input?: unknown;
  outcome?: unknown;
}

const SECRET_KEY_PATTERN = /token|secret|key|password|authorization/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

// Phase 0 stub: console only. Phase 1 appends JSONL to DATA_DIR/audit.jsonl
// with the same redaction applied here.
export async function audit(input: AuditInput): Promise<void> {
  console.log(
    `[audit-stub] ${JSON.stringify(redact({ ...input, at: new Date().toISOString() }))}`,
  );
}
