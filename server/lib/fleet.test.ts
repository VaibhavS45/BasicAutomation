import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  cancelAll,
  cancelNode,
  finishNode,
  fleetEventMessage,
  formatFleetSse,
  getNode,
  listNodes,
  nodeEvents,
  registerNode,
  resetFleetForTests,
  setFleetFrameworkHooks,
  subscribeFleet,
  updateNode,
} from "./fleet.js";

beforeEach(() => {
  resetFleetForTests();
  vi.restoreAllMocks();
});

describe("register/list/get", () => {
  it("registers queued nodes and lists newest first", () => {
    const a = registerNode({ id: "a", profile: "email.received", title: "first" });
    const b = registerNode({ id: "b", profile: "gmail-agent", title: "second", parentId: "turn-1" });
    expect(a.status).toBe("queued");
    expect(b.parentId).toBe("turn-1");
    expect(listNodes().map((n) => n.id)).toEqual(["b", "a"]);
    expect(getNode("a")?.title).toBe("first");
    expect(getNode("missing")).toBeUndefined();
  });

  it("redacts secrets in transcripts on read", () => {
    registerNode({ id: "s", profile: "gmail-agent", title: "t" });
    finishNode("s", "done", "sent with token=supersecretvalue123 and Bearer abcdefghijklmnop");
    const node = getNode("s")!;
    expect(node.resultSummary).not.toContain("supersecretvalue123");
    expect(node.resultSummary).not.toContain("abcdefghijklmnop");
    expect(node.resultSummary).toMatch(/redacted/i);
  });
});

describe("update/finish", () => {
  it("tracks steps and tools, then finishes", () => {
    registerNode({ id: "n", profile: "researcher", title: "t" });
    updateNode("n", { status: "running", currentStep: "searching" });
    updateNode("n", { toolsUsed: ["search.web"] });
    const done = finishNode("n", "done", "found it");
    expect(done?.status).toBe("done");
    expect(done?.endedAt).toBeGreaterThanOrEqual(done!.startedAt);
    expect(done?.toolsUsed).toEqual(["search.web"]);
  });

  it("leaves terminal nodes immutable", () => {
    registerNode({ id: "n", profile: "researcher", title: "t" });
    finishNode("n", "failed", "boom");
    expect(updateNode("n", { currentStep: "x" })).toBeUndefined();
    expect(finishNode("n", "done")).toBeUndefined();
    expect(getNode("n")?.status).toBe("failed");
  });
});

describe("events + live subscription", () => {
  it("emits ordered events and filters by afterSeq", () => {
    registerNode({ id: "n", profile: "researcher", title: "t" });
    updateNode("n", { currentStep: "one" });
    updateNode("n", { currentStep: "two" });
    const all = nodeEvents("n");
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((x, y) => x - y));
    const tail = nodeEvents("n", all[0].seq);
    expect(tail.every((e) => e.seq > all[0].seq)).toBe(true);
  });

  it("notifies subscribers; a throwing subscriber never breaks the registry", () => {
    const seen: string[] = [];
    const unsub = subscribeFleet((e) => seen.push(e.type));
    subscribeFleet(() => { throw new Error("broken"); });
    registerNode({ id: "n", profile: "researcher", title: "t" });
    unsub();
    expect(seen).toContain("created");
  });

  it("formats redacted SSE payloads", () => {
    registerNode({ id: "n", profile: "researcher", title: "t" });
    updateNode("n", { currentStep: "using api_key=supersecretvalue123 now" });
    const events = nodeEvents("n");
    const last = events[events.length - 1]!;
    expect(formatFleetSse(last)).toMatch(/^id: \d+\nevent: fleet\ndata: /);
    expect(formatFleetSse(last)).not.toContain("supersecretvalue123");
    expect(fleetEventMessage(last)).toMatchObject({ event: "fleet" });
  });
});

describe("cancelNode", () => {
  it("fires the local abort and marks the worker task errored, then marks cancelled", async () => {
    const local = vi.fn();
    const markTaskErrored = vi.fn(async () => undefined);
    setFleetFrameworkHooks({ markTaskErrored });
    registerNode({ id: "n", profile: "email.received", title: "t", runId: "run-1", taskId: "task-1", abort: local });
    const out = await cancelNode("n", "test reason");
    expect(out.ok).toBe(true);
    expect(local).toHaveBeenCalledOnce();
    expect(markTaskErrored).toHaveBeenCalledWith("task-1", expect.any(String));
    expect(out.node?.status).toBe("cancelled");
    expect(out.framework).toMatchObject({ markedTask: true, errors: [] });
  });

  it("still cancels when the framework hook fails (best-effort)", async () => {
    setFleetFrameworkHooks({
      markTaskErrored: async () => { throw new Error("no db"); },
    });
    registerNode({ id: "n", profile: "gmail-agent", title: "t", taskId: "task-x" });
    const out = await cancelNode("n");
    expect(out.ok).toBe(true);
    expect(out.node?.status).toBe("cancelled");
    expect(out.framework?.errors).toHaveLength(1);
  });

  it("rejects unknown and already-terminal nodes", async () => {
    expect((await cancelNode("nope")).ok).toBe(false);
    registerNode({ id: "n", profile: "researcher", title: "t" });
    finishNode("n", "done");
    const out = await cancelNode("n");
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/already done/);
  });
});

describe("cancelAll kill switch", () => {
  it("aborts running and waiting nodes, skips terminals", async () => {
    const markTaskErrored = vi.fn(async () => undefined);
    setFleetFrameworkHooks({ markTaskErrored });
    registerNode({ id: "run-1", profile: "email.received", title: "a", taskId: "task-1" });
    updateNode("run-1", { status: "running" });
    registerNode({ id: "run-2", profile: "github-agent", title: "b" });
    updateNode("run-2", { status: "waiting_approval" });
    registerNode({ id: "run-3", profile: "researcher", title: "c" });
    finishNode("run-3", "done");
    const out = await cancelAll("kill switch test");
    expect(out.cancelled.sort()).toEqual(["run-1", "run-2"]);
    expect(out.already).toEqual(["run-3"]);
    expect(markTaskErrored).toHaveBeenCalledWith("task-1", expect.any(String));
    expect(getNode("run-1")?.status).toBe("cancelled");
    expect(getNode("run-2")?.status).toBe("cancelled");
    expect(getNode("run-3")?.status).toBe("done");
  });
});
