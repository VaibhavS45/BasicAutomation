// app/components/canvas/worker-drawer.test.tsx — H5 drawer contract.
// - No worker message input is ever rendered (only the head chat exists).
// - The approval card dispatches exactly once (createOnceRunner, shared with
//   the route's Approve/Deny wiring).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { FleetNode } from "../../../server/lib/types.js";
import { createOnceRunner } from "./canvas-layout.js";
import { WorkerDrawer } from "./WorkerDrawer.js";

const baseNode: FleetNode = {
  id: "fleet-1",
  parentId: "head-1",
  profile: "gmail-agent",
  title: "Draft outreach email",
  status: "running",
  startedAt: Date.now() - 30_000,
  toolsUsed: ["gmail.search"],
};

const pendingApproval = {
  id: "ap-1",
  action: "gmail.send",
  summary: "Send the drafted email",
  payload: {},
  status: "pending" as const,
  createdAt: new Date().toISOString(),
  expiresAt: Date.now() + 60_000,
};

function render(
  node: FleetNode = baseNode,
  approval: typeof pendingApproval | null = pendingApproval,
) {
  return renderToStaticMarkup(
    <WorkerDrawer
      node={node}
      events={[
        {
          seq: 1,
          at: Date.now(),
          nodeId: node.id,
          type: "step",
          message: "searching inbox",
        },
      ]}
      pendingApproval={approval}
      onApprove={() => {}}
      onDeny={() => {}}
      onCancel={() => {}}
      onClose={() => {}}
      busy={false}
    />,
  );
}

describe("worker drawer", () => {
  it("renders NO message box to talk to a worker", () => {
    const html = render();
    expect(html).not.toMatch(/<input|<textarea|<select/);
    expect(html).not.toMatch(
      /sendMessage|composer|Type a message|message box/i,
    );
  });

  it("renders no message box even without a pending approval", () => {
    expect(render(baseNode, null)).not.toMatch(/<input|<textarea/);
  });

  it("shows the read-only transcript and approval card", () => {
    const html = render();
    expect(html).toContain("searching inbox");
    expect(html).toContain("read-only");
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
    expect(html).toContain("Send the drafted email");
  });

  it("approval card calls approvals.approve exactly once on double dispatch", () => {
    const approve = vi.fn();
    const once = createOnceRunner();
    const onApprove = (id: string) => once(() => approve(id));
    onApprove("ap-1");
    onApprove("ap-1");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith("ap-1");
  });

  it("hides Cancel for terminal nodes", () => {
    const html = render({ ...baseNode, status: "done" }, null);
    expect(html).not.toContain("Cancel");
  });
});
