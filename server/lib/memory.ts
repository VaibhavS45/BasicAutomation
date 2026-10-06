// server/lib/memory.ts  Owner: Vaibhav (H7b)
// Lindy-style plain-file memory: durable user context the head agent reads
// at the start of a turn (memory.list + memory.read) and appends to only
// with approval (memory.append). Files live at DATA_DIR/memory/<name>.md —
// plain markdown, editable in the settings view (/memory) or by hand.
//
// Secrets never persist: every write passes redactSecretsInText first, so a
// pasted token lands as «redacted N chars», never the value.

import { promises as fs } from "node:fs";
import path from "node:path";
import { isChatApproved, requireApproval } from "./approvals.js";
import { audit } from "./audit.js";
import { env } from "./env.js";
import { redactSecretsInText } from "./redact.js";
import type { ActionResult } from "./types.js";

export const MEMORY_NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
export const MEMORY_MAX_CHARS = 100_000;

export interface MemorySummary {
  name: string;
  chars: number;
  updatedAt: string;
}

function memoryDir(): string {
  const base = process.env.DATA_DIR ?? env.DATA_DIR; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  return path.join(base, "memory");
}

export function validateMemoryName(name: string): void {
  if (!MEMORY_NAME_RE.test(name)) {
    throw new Error(
      `Invalid memory name "${name}": lowercase letters, digits, dashes, 2-61 chars.`,
    );
  }
}

function fileFor(name: string): string {
  validateMemoryName(name);
  return path.join(memoryDir(), `${name}.md`);
}

async function writeScrubbed(file: string, content: string): Promise<void> {
  if (content.length > MEMORY_MAX_CHARS) {
    throw new Error(`Memory file too large (max ${MEMORY_MAX_CHARS} chars).`);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, redactSecretsInText(content), { mode: 0o600 });
}

export async function listMemory(): Promise<MemorySummary[]> {
  let files: string[];
  try {
    files = await fs.readdir(memoryDir());
  } catch {
    return [];
  }
  const out: MemorySummary[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    try {
      const stat = await fs.stat(path.join(memoryDir(), file));
      const raw = await fs.readFile(path.join(memoryDir(), file), "utf8");
      out.push({
        name: file.slice(0, -3),
        chars: raw.length,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Half-written file: skip, never fatal.
    }
  }
  return out;
}

export async function readMemory(name: string): Promise<string> {
  try {
    return await fs.readFile(fileFor(name), "utf8");
  } catch {
    throw new Error(`No memory named "${name}".`);
  }
}

/** Create or replace a memory file (settings edit path). Secrets scrubbed. */
export async function writeMemory(name: string, content: string): Promise<MemorySummary> {
  const file = fileFor(name);
  await writeScrubbed(file, content);
  const stat = await fs.stat(file);
  return { name, chars: content.length, updatedAt: stat.mtime.toISOString() };
}

/** Append one timestamped entry (head-agent learning path). Secrets scrubbed. */
export async function appendMemory(name: string, text: string): Promise<MemorySummary> {
  if (!text.trim()) throw new Error("Nothing to remember: text is empty.");
  const file = fileFor(name);
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    existing = `# ${name}\n`;
  }
  const entry = `\n\n--- ${new Date().toISOString()}\n\n${text.trim()}\n`;
  const next = `${existing.trimEnd()}\n${entry}`;
  if (next.length > MEMORY_MAX_CHARS) {
    throw new Error(
      `Memory "${name}" is full (max ${MEMORY_MAX_CHARS} chars) — delete or trim entries first.`,
    );
  }
  await writeScrubbed(file, next);
  const stat = await fs.stat(file);
  const raw = await fs.readFile(file, "utf8");
  return { name, chars: raw.length, updatedAt: stat.mtime.toISOString() };
}

export async function deleteMemory(name: string): Promise<void> {
  try {
    await fs.unlink(fileFor(name));
  } catch {
    throw new Error(`No memory named "${name}".`);
  }
}

// --- approval-gated writes (agent path) --------------------------------------
// Same contract as gmail.send: the framework's chat approval card gates the
// turn (ctx.approvedToolCallKey); file-based requireApproval covers
// trigger/script runs. Memory rewrites are agent-state mutation, so they
// always pause — payload text can never silently rewrite what the user kept.

export async function gatedMemoryWrite(opts: {
  kind: "memory.write" | "memory.append" | "memory.delete";
  name: string;
  summary: string;
  payload?: unknown;
  ctx?: { approvedToolCallKey?: string };
  apply: () => Promise<unknown>;
}): Promise<ActionResult> {
  if (!isChatApproved(opts.ctx)) {
    const decision = await requireApproval({
      action: opts.kind,
      summary: opts.summary,
      payload: opts.payload ?? { name: opts.name },
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Memory unchanged.`;
      await audit({ actor: "agent", action: opts.kind, input: { name: opts.name }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
  }
  try {
    const data = await opts.apply();
    const outcome = { ok: true, ...(data as Record<string, unknown>) };
    await audit({ actor: "agent", action: opts.kind, input: { name: opts.name }, outcome });
    return { ok: true, data };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }
}
