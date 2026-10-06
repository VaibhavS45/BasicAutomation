import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalsApproveImpl, resetApprovalsRateLimitsForTests } from "./approvals.approve.js";
import approvalsApproveDefault from "./approvals.approve.js";
import { approvalsDenyImpl } from "./approvals.deny.js";
import approvalsDenyDefault from "./approvals.deny.js";
import { approvalsListImpl } from "./approvals.list.js";
import { fleetCancelImpl } from "./fleet.cancel.js";
import fleetCancelDefault from "./fleet.cancel.js";
import { fleetCancelAllImpl } from "./fleet.cancelAll.js";
import fleetCancelAllDefault from "./fleet.cancelAll.js";
import { fleetGetImpl } from "./fleet.get.js";
import { fleetListImpl } from "./fleet.list.js";
import { createPendingApproval } from "../server/lib/approvals.js";
import {
  finishNode,
  registerNode,
  resetFleetForTests,
  setFleetFrameworkHooks,
  updateNode,
} from "../server/lib/fleet.js";
import { resetRateLimitsForTests } from "../server/lib/rate-limit.js";

let tmp: string;
let prevDataDir: string | undefined;
let prevDryRun: string | undefined;

const chatCtx = { approvedToolCallKey: "test-chat-approval" } as never;

beforeEach(async () => {
  prevDataDir = process.env.DATA_DIR; // guard:allow-env-credential — test isolation
  prevDryRun = process.env.DRY_RUN; // guard:allow-env-credential — test isolation
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-actions-test-"));
  process.env.DATA_DIR = tmp; // guard:allow-env-credential — test isolation
  process.env.DRY_RUN = "false"; // guard:allow-env-credential — test isolation
  resetFleetForTests();
  resetRateLimitsForTests();
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

describe("fleet.list / fleet.get", () => {
  it("lists nodes with counts and reads redacted transcripts with a seq cursor", async () => {
    registerNode({ id: "n1", profile: "email.received", title: "mail run" });
    updateNode("n1", { status: "running", currentStep: "reading" });
    updateNode("n1", { currentStep: " drafting with api_key=supersecretvalue123" });
    registerNode({ id: "n2", profile: "gmail-agent", title: "worker", parentId: "turn-1" });
    finishNode("n2", "done", "draft ready");

    const list = await fleetListImpl();
    expect(list.ok).toBe(true);
    expect(list.data?.counts).toMatchObject({ running: 1, done: 1 });

    const full = await fleetGetImpl({ id: "n1", afterSeq: 0 });
    expect(full.ok).toBe(true);
    expect(full.data?.node.id).toBe("n1");
    // Transcript redacted on read.
    expect(JSON.stringify(full.data)).not.toContain("supersecretvalue123");
    const firstSeq = full.data!.events[0].seq;
    const tail = await fleetGetImpl({ id: "n1", afterSeq: firstSeq });
    expect(tail.data?.events.every((e) => e.seq > firstSeq)).toBe(true);
    expect(tail.data?.nextSeq).toBeGreaterThan(firstSeq);
  });

  it("returns ok:false for unknown nodes and bad input", async () => {
    expect((await fleetGetImpl({ id: "nope", afterSeq: 0 })).ok).toBe(false);
    expect((await fleetGetImpl({ id: "", afterSeq: 0 })).ok).toBe(false);
  });
});

describe("fleet.cancel / fleet.cancelAll", () => {
  it("is a no-op proposal under DRY_RUN", async () => {
    process.env.DRY_RUN = "true"; // guard:allow-env-credential — test isolation
    registerNode({ id: "n", profile: "email.received", title: "t" });
    updateNode("n", { status: "running" });
    const out = await fleetCancelImpl({ id: "n" }, chatCtx);
    expect(out).toMatchObject({ ok: true, data: { dryRun: true } });
    expect((await fleetGetImpl({ id: "n", afterSeq: 0 })).data?.node.status).toBe("running");
  });

  it("cancels one node when chat-approved, rejects terminals", async () => {
    registerNode({ id: "n", profile: "email.received", title: "t" });
    updateNode("n", { status: "running" });
    const out = await fleetCancelImpl({ id: "n", reason: "test" }, chatCtx);
    expect(out.ok).toBe(true);
    const again = await fleetCancelImpl({ id: "n" }, chatCtx);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already cancelled/);
  });

  it("cancelAll aborts running sub-agent tasks via the framework hook", async () => {
    const markTaskErrored = vi.fn(async () => undefined);
    setFleetFrameworkHooks({ markTaskErrored });
    registerNode({ id: "w1", profile: "gmail-agent", title: "worker", parentId: "turn-1", taskId: "task-1" });
    updateNode("w1", { status: "running" });
    registerNode({ id: "r1", profile: "email.received", title: "run", runId: "run-1" });
    updateNode("r1", { status: "waiting_approval" });
    const out = await fleetCancelAllImpl({ reason: "kill switch test" }, chatCtx);
    expect(out.ok).toBe(true);
    expect(out.data?.cancelled.sort()).toEqual(["r1", "w1"]);
    expect(markTaskErrored).toHaveBeenCalledWith("task-1", expect.any(String));
  });

  it("marks destructive actions needsApproval", () => {
    expect(fleetCancelDefault.needsApproval).toBe(true);
    expect(fleetCancelAllDefault.needsApproval).toBe(true);
  });
});

describe("approvals.approve / deny / list", () => {
  it("approves once, then rejects the replay; denies reject the action", async () => {
    const { approvalId } = await createPendingApproval({ action: "gmail.send", summary: "t", payload: {} });
    expect(await approvalsApproveImpl({ id: approvalId })).toMatchObject({ ok: true, data: { status: "approved" } });
    const replay = await approvalsApproveImpl({ id: approvalId });
    expect(replay.ok).toBe(false);
    expect(replay.error).toMatch(/already approved/);

    const denied = await createPendingApproval({ action: "gmail.send", summary: "t2", payload: {} });
    expect(await approvalsDenyImpl({ id: denied.approvalId, reason: "no" })).toMatchObject({
      ok: true,
      data: { status: "denied" },
    });
    expect((await approvalsDenyImpl({ id: "missing" })).ok).toBe(false);

    const list = await approvalsListImpl({ status: "all" });
    expect(list.data?.approvals).toHaveLength(2);
    expect(await approvalsListImpl({ status: "pending" })).toMatchObject({ ok: true, data: { approvals: [] } });
  });

  it("rate-limits approve decisions", async () => {
    resetApprovalsRateLimitsForTests();
    let limited = 0;
    for (let i = 0; i < 31; i += 1) {
      const { approvalId } = await createPendingApproval({ action: "x", summary: `t${i}`, payload: {} });
      const out = await approvalsApproveImpl({ id: approvalId });
      if (!out.ok && out.error?.match(/Rate limited/)) limited += 1;
    }
    expect(limited).toBe(1);
  });

  it("approve/deny stay human-gated (no blanket needsApproval card)", () => {
    expect(approvalsApproveDefault.needsApproval ?? false).toBe(false);
    expect(approvalsDenyDefault.needsApproval ?? false).toBe(false);
  });
});
