import { beforeEach, describe, expect, it } from "vitest";
import { finishNode, registerNode, resetFleetForTests, updateNode } from "../../../lib/fleet.js";
import { snapshotSse } from "./stream.get.js";

beforeEach(() => {
  resetFleetForTests();
});

describe("snapshotSse", () => {
  it("emits one redacted snapshot line per node (newest first)", () => {
    registerNode({ id: "a", profile: "email.received", title: "first" });
    registerNode({ id: "b", profile: "gmail-agent", title: "second" });
    updateNode("b", { currentStep: "working with api_key=supersecretvalue123" });
    finishNode("a", "done", "ok");
    const snap = snapshotSse();
    expect(snap).toHaveLength(2);
    expect(snap[0].event).toBe("snapshot");
    expect(JSON.stringify(snap)).not.toContain("supersecretvalue123");
    expect(JSON.parse(snap[0].data).id).toBe("b");
  });

  it("is empty with no nodes", () => {
    expect(snapshotSse()).toEqual([]);
  });
});
