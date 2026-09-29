import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveApproval,
  denyApproval,
  requireApproval,
} from "./approvals.js";

let tmp: string;
let prevDataDir: string | undefined;
let prevDryRun: string | undefined;

beforeEach(async () => {
  prevDataDir = process.env.DATA_DIR;
  prevDryRun = process.env.DRY_RUN;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "approvals-test-"));
  process.env.DATA_DIR = tmp;
  process.env.DRY_RUN = "false";
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  if (prevDryRun === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = prevDryRun;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("requireApproval", () => {
  it("DRY_RUN short-circuits approved without touching the network or disk", async () => {
    process.env.DRY_RUN = "true";
    const decision = await requireApproval({
      action: "gmail.send",
      summary: "send test",
      payload: { to: "a@example.com" },
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe("dry-run");
    const files = await fs.readdir(path.join(tmp, "approvals")).catch(() => []);
    expect(files).toHaveLength(0);
  });

  it("expires a pending approval after ttlMs", async () => {
    const decision = await requireApproval({
      action: "github.commentOnIssue",
      summary: "comment test",
      payload: { body: "hi" },
      ttlMs: 120,
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("expired");
  });

  it("honors an explicit approve", async () => {
    const id = "test-approve-1";
    const pending = requireApproval({
      action: "whatsapp.send",
      summary: "notify",
      ttlMs: 5000,
      approvalId: id,
    });
    await new Promise((r) => setTimeout(r, 50));
    await approveApproval(id);
    const decision = await pending;
    expect(decision.approved).toBe(true);
  });

  it("honors an explicit deny", async () => {
    const id = "test-deny-1";
    const pending = requireApproval({
      action: "gmail.send",
      summary: "send",
      ttlMs: 5000,
      approvalId: id,
    });
    await new Promise((r) => setTimeout(r, 50));
    await denyApproval(id, "not now");
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("not now");
  });

  it("redacts secrets in the persisted payload", async () => {
    const id = "test-redact-1";
    const pending = requireApproval({
      action: "gmail.send",
      summary: "send",
      payload: { to: "a@example.com", GITHUB_TOKEN: "super-secret" },
      ttlMs: 5000,
      approvalId: id,
    });
    await new Promise((r) => setTimeout(r, 50));
    const raw = await fs.readFile(path.join(tmp, "approvals", `${id}.json`), "utf8");
    expect(raw).not.toContain("super-secret");
    expect(raw).toContain("[REDACTED]");
    await approveApproval(id);
    await pending;
  });
});
