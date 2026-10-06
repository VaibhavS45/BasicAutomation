import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPendingApproval,
  decideApproval,
  getApproval,
  listApprovals,
  requireApproval,
} from "./approvals.js";

let tmp: string;
let prevDataDir: string | undefined;
let prevDryRun: string | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  prevDataDir = process.env.DATA_DIR; // guard:allow-env-credential — test isolation
  prevDryRun = process.env.DRY_RUN; // guard:allow-env-credential — test isolation
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "approvals-decide-test-"));
  process.env.DATA_DIR = tmp; // guard:allow-env-credential — test isolation
  process.env.DRY_RUN = "false"; // guard:allow-env-credential — test isolation
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR; // guard:allow-env-credential — test isolation
  else process.env.DATA_DIR = prevDataDir; // guard:allow-env-credential — test isolation
  if (prevDryRun === undefined) delete process.env.DRY_RUN; // guard:allow-env-credential — test isolation
  else process.env.DRY_RUN = prevDryRun; // guard:allow-env-credential — test isolation
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function auditLines(): Promise<string[]> {
  const raw = await fs.readFile(path.join(tmp, "audit.jsonl"), "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean);
}

describe("decideApproval: approve resumes exactly once", () => {
  it("unblocks the paused waiter, then rejects the second decide", async () => {
    const { approvalId } = await createPendingApproval({
      action: "gmail.send",
      summary: "send test",
      payload: { to: "a@example.com" },
      ttlMs: 10_000,
    });
    const paused = requireApproval({
      action: "gmail.send",
      summary: "send test",
      payload: { to: "a@example.com" },
      approvalId,
      ttlMs: 10_000,
    });
    await sleep(50);
    const first = await decideApproval(approvalId, true, { actor: "test-human" });
    expect(first).toEqual({ ok: true, status: "approved" });
    const decision = await paused;
    expect(decision).toMatchObject({ approved: true, approvalId });

    const second = await decideApproval(approvalId, true, { actor: "test-human" });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already approved/);

    const lines = await auditLines();
    expect(lines.filter((l) => l.includes('"action":"approvals.approved"'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('"action":"approvals.decide-rejected"'))).toHaveLength(1);
  });
});

describe("decideApproval: deny rejects the paused action", () => {
  it("returns approved:false with the reason, nothing executes", async () => {
    const { approvalId } = await createPendingApproval({
      action: "github.createIssue",
      summary: "issue test",
      ttlMs: 10_000,
    });
    const paused = requireApproval({
      action: "github.createIssue",
      summary: "issue test",
      approvalId,
      ttlMs: 10_000,
    });
    await sleep(50);
    const out = await decideApproval(approvalId, false, { reason: "no budget", actor: "test-human" });
    expect(out).toEqual({ ok: true, status: "denied" });
    const decision = await paused;
    expect(decision).toMatchObject({ approved: false, reason: "no budget" });
    const lines = await auditLines();
    expect(lines.filter((l) => l.includes('"action":"approvals.denied"'))).toHaveLength(1);
  });
});

describe("decideApproval: unknown ids", () => {
  it("rejects with not found and audits the attempt", async () => {
    const out = await decideApproval("does-not-exist", true, { actor: "test-human" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not found/);
    expect((await auditLines()).filter((l) => l.includes("approvals.decide-rejected"))).toHaveLength(1);
  });
});

describe("listApprovals / getApproval", () => {
  it("lists pending with redacted payloads, newest first", async () => {
    const first = await createPendingApproval({
      action: "gmail.send",
      summary: "one",
      payload: { api_key: "supersecretvalue123" },
    });
    await sleep(5);
    await createPendingApproval({ action: "gmail.send", summary: "two", payload: {} });
    const pending = await listApprovals();
    expect(pending).toHaveLength(2);
    expect(pending[0].summary).toBe("two");
    const withSecret = pending.find((p) => p.id === first.approvalId)!;
    expect(JSON.stringify(withSecret.payload)).not.toContain("supersecretvalue123");
    expect(await getApproval(first.approvalId)).toMatchObject({ id: first.approvalId, status: "pending" });
    expect(await getApproval("missing")).toBeNull();
  });

  it("reports live expiry for lapsed pendings", async () => {
    const { approvalId } = await createPendingApproval({ action: "x", summary: "y", ttlMs: 1 });
    await sleep(10);
    expect((await getApproval(approvalId))?.status).toBe("expired");
    expect(await listApprovals()).toHaveLength(0);
    expect(await listApprovals("all")).toHaveLength(1);
    const late = await decideApproval(approvalId, true, { actor: "test-human" });
    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/already expired/);
  });
});
