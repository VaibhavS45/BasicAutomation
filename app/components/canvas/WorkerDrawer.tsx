// app/components/canvas/WorkerDrawer.tsx
// Read-only worker transcript + approval card for the fleet canvas (H5).
// Deliberately NO message box: the head-agent chat is the only conversation
// surface. Props carry no send/message callback, so a worker can never gain
// one without a type error. XYFlow-free so it renders anywhere (tested via
// renderToStaticMarkup).
import { IconCheck, IconPlayerStop, IconX } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";

import type { ApprovalSummary } from "../../../server/lib/approvals.js";
import type { FleetEvent, FleetNode } from "../../../server/lib/types.js";
import {
  formatElapsed,
  elapsedMs,
  profileToken,
  transcriptLines,
} from "./canvas-layout.js";

export interface WorkerDrawerProps {
  node: FleetNode;
  events: FleetEvent[];
  /** Pending approval matched to this node (if any). */
  pendingApproval?: ApprovalSummary | null;
  /** Exactly-once guarded by the caller (createOnceRunner). */
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
  onCancel: (nodeId: string) => void;
  onClose: () => void;
  busy: boolean;
}

export function WorkerDrawer({
  node,
  events,
  pendingApproval,
  onApprove,
  onDeny,
  onCancel,
  onClose,
  busy,
}: WorkerDrawerProps) {
  const lines = transcriptLines(node, events);
  const terminal =
    node.status === "done" ||
    node.status === "failed" ||
    node.status === "cancelled";
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-card text-card-foreground"
      data-testid="worker-drawer"
    >
      <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">
            {profileToken(node.profile, node.toolsUsed)} · {node.profile}
          </p>
          <h2 className="truncate text-sm font-semibold">{node.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {node.status} · {formatElapsed(elapsedMs(node))}
            {node.toolsUsed.length > 0 ? ` · ${node.toolsUsed.join(", ")}` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close worker details"
        >
          <IconX className="size-4" />
        </Button>
      </header>

      {pendingApproval ? (
        <section
          aria-label="Approval required"
          data-testid="approval-card"
          className="shrink-0 border-b border-border bg-muted/50 px-4 py-3"
        >
          <p className="text-xs font-semibold">Waiting for approval</p>
          <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
            {pendingApproval.summary}
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => onApprove(pendingApproval.id)}
            >
              <IconCheck className="size-3.5" aria-hidden="true" />
              Approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onDeny(pendingApproval.id)}
            >
              <IconX className="size-3.5" aria-hidden="true" />
              Deny
            </Button>
          </div>
        </section>
      ) : null}

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        aria-label="Worker transcript (read-only)"
      >
        <p className="text-xs font-medium text-muted-foreground">
          Transcript · read-only — external text below is untrusted data
        </p>
        {lines.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No steps recorded yet.
          </p>
        ) : (
          <ol className="mt-2 space-y-1.5">
            {lines.map((line, i) => (
              // data fence: worker/external output rendered as inert text, never executed.
              <li
                key={i}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs leading-relaxed"
              >
                {line}
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">
          Talk to the head agent instead — workers take no messages.
        </p>
        {!terminal ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => onCancel(node.id)}
          >
            <IconPlayerStop className="size-3.5" aria-hidden="true" />
            Cancel
          </Button>
        ) : null}
      </footer>
    </div>
  );
}
