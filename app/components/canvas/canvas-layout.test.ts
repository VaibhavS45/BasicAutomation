// app/components/canvas/canvas-layout.test.ts — H5 canvas layout helpers.
import { describe, expect, it } from "vitest";

import type { ApprovalSummary } from "../../../server/lib/approvals.js";
import type { FleetNode } from "../../../server/lib/types.js";
import {
  buildEdges,
  createOnceRunner,
  defaultPositions,
  elapsedMs,
  formatElapsed,
  layoutStorageKey,
  matchNodeApproval,
  mergePositions,
  parseLayout,
  profileToken,
  pruneLayout,
  serializeLayout,
  transcriptLines,
} from "./canvas-layout.js";

function node(over: Partial<FleetNode> & { id: string }): FleetNode {
  return {
    parentId: null,
    profile: "worker",
    title: `work ${over.id}`,
    status: "running",
    startedAt: 1_000,
    toolsUsed: [],
    ...over,
  };
}

describe("layout persistence round-trip", () => {
  it("serializes and parses back identically", () => {
    const layout = { a: { x: 16, y: -32 }, b: { x: 0, y: 0 } };
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it("falls back to {} on invalid persisted data", () => {
    expect(parseLayout(null)).toEqual({});
    expect(parseLayout({ a: { x: "far", y: 0 } })).toEqual({});
    expect(parseLayout("junk")).toEqual({});
  });

  it("scopes the storage key per project", () => {
    expect(layoutStorageKey("default")).toBe("canvas.layout.default");
    expect(layoutStorageKey(" Inbox ")).toBe("canvas.layout.inbox");
    expect(layoutStorageKey("")).toBe("canvas.layout.default");
  });

  it("prunes positions for nodes that no longer exist", () => {
    const nodes = [node({ id: "a" })];
    expect(
      pruneLayout({ a: { x: 1, y: 2 }, gone: { x: 3, y: 4 } }, nodes),
    ).toEqual({
      a: { x: 1, y: 2 },
    });
  });

  it("merge keeps persisted spots and places newcomers at defaults", () => {
    const nodes = [
      node({ id: "head", startedAt: 1 }),
      node({ id: "new", parentId: "head", startedAt: 2 }),
    ];
    const merged = mergePositions(nodes, { head: { x: 5, y: 6 } });
    expect(merged.head).toEqual({ x: 5, y: 6 });
    expect(merged.new).toEqual(defaultPositions(nodes).new);
  });
});

describe("placement", () => {
  it("pins the head (oldest root) at the center with workers around it", () => {
    const nodes = [
      node({ id: "w1", parentId: "head", startedAt: 2 }),
      node({ id: "head", startedAt: 1 }),
      node({ id: "w2", parentId: "head", startedAt: 3 }),
    ];
    const layout = defaultPositions(nodes);
    expect(layout.head).toEqual({ x: 0, y: 0 });
    expect(layout.w1).not.toEqual({ x: 0, y: 0 });
    expect(layout.w2).not.toEqual(layout.w1);
  });

  it("builds animated parent -> child edges only for on-screen parents", () => {
    expect(
      buildEdges([
        node({ id: "h" }),
        node({ id: "w", parentId: "h" }),
        node({ id: "o", parentId: "missing" }),
      ]),
    ).toEqual([{ id: "e:h->w", source: "h", target: "w" }]);
  });
});

describe("display helpers", () => {
  it("maps profiles to capability tokens", () => {
    expect(profileToken("gmail-agent", [])).toBe("@gmail");
    expect(profileToken("worker", ["notion.search"])).toBe("@notion");
    expect(profileToken("worker", ["browser_navigate"])).toBe("@browser");
    expect(profileToken("worker", [])).toBe("@worker");
  });

  it("formats elapsed time", () => {
    expect(
      elapsedMs(node({ id: "a", startedAt: 1_000, endedAt: 61_000 })),
    ).toBe(60_000);
    expect(formatElapsed(5_000)).toBe("5s");
    expect(formatElapsed(125_000)).toBe("2m 5s");
    expect(formatElapsed(3_700_000)).toBe("1h 1m");
  });

  it("matches a node to its pending approval by id, title, or payload", () => {
    const n = node({ id: "fleet-1", title: "Draft outreach email" });
    const pending: ApprovalSummary = {
      id: "ap-1",
      action: "gmail.send",
      summary: "Send email (fleet-1)",
      payload: {},
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 60_000,
    };
    expect(matchNodeApproval(n, [pending])?.id).toBe("ap-1");
    expect(
      matchNodeApproval(n, [{ ...pending, status: "approved" }]),
    ).toBeUndefined();
    expect(
      matchNodeApproval(n, [{ ...pending, summary: "unrelated" }]),
    ).toBeUndefined();
  });

  it("builds a read-only transcript from events plus result", () => {
    const n = node({ id: "a", resultSummary: "done writing" });
    expect(
      transcriptLines(n, [
        {
          seq: 1,
          at: 2,
          nodeId: "a",
          type: "step",
          message: "searching inbox",
        },
      ]),
    ).toEqual(["searching inbox", "Result: done writing"]);
    expect(transcriptLines(node({ id: "b" }), [])).toEqual([]);
  });
});

describe("createOnceRunner", () => {
  it("runs the approval exactly once across repeated clicks", () => {
    let calls = 0;
    const once = createOnceRunner();
    const approve = () => {
      calls += 1;
    };
    once(approve);
    once(approve);
    once(approve);
    expect(calls).toBe(1);
  });
});
