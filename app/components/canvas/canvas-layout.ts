// app/components/canvas/canvas-layout.ts
// Pure layout + matching helpers for the fleet canvas (H5).
// No React, no CSS, no XYFlow imports — unit-tested in node.
import { z } from "zod";

import type { ApprovalSummary } from "../../../server/lib/approvals.js";
import type { FleetEvent, FleetNode } from "../../../server/lib/types.js";

export const CANVAS_GRID_SIZE = 16;
export const LAYOUT_HISTORY_LIMIT = 50;

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
const layoutSchema = z.record(z.string().min(1), positionSchema);

export type CanvasPosition = z.infer<typeof positionSchema>;
export type CanvasLayout = z.infer<typeof layoutSchema>;

/** App-state key for one project's persisted node positions (SQL, never localStorage). */
export function layoutStorageKey(project: string): string {
  const slug =
    project
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .slice(0, 80) || "default";
  return `canvas.layout.${slug}`;
}

/** Parse persisted layout; unknown/invalid data falls back to {}. */
export function parseLayout(raw: unknown): CanvasLayout {
  const parsed = layoutSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export function serializeLayout(
  layout: CanvasLayout,
): Record<string, CanvasPosition> {
  return { ...layout };
}

/** Drop positions for nodes that no longer exist (called before persisting). */
export function pruneLayout(
  layout: CanvasLayout,
  nodes: Pick<FleetNode, "id">[],
): CanvasLayout {
  const known = new Set(nodes.map((n) => n.id));
  return Object.fromEntries(
    Object.entries(layout).filter(([id]) => known.has(id)),
  );
}

export type CapabilityToken = "@gmail" | "@browser" | "@notion" | "@worker";

/** Capability token heuristic from profile + tools used (display only). */
export function profileToken(
  profile: string,
  toolsUsed: string[],
): CapabilityToken {
  const hay = `${profile} ${(toolsUsed ?? []).join(" ")}`.toLowerCase();
  if (hay.includes("gmail") || hay.includes("mail")) return "@gmail";
  if (hay.includes("notion")) return "@notion";
  if (
    hay.includes("browser") ||
    hay.includes("playwright") ||
    hay.includes("web")
  )
    return "@browser";
  return "@worker";
}

/**
 * Default placement: the head node (oldest root, else oldest node) at the
 * center; workers fanned on rings around it so edges read parent -> child.
 */
export function defaultPositions(nodes: FleetNode[]): CanvasLayout {
  if (nodes.length === 0) return {};
  const ordered = [...nodes].sort((a, b) => a.startedAt - b.startedAt);
  const head = ordered.find((n) => !n.parentId) ?? ordered[0];
  const rest = ordered.filter((n) => n.id !== head.id);
  const layout: CanvasLayout = { [head.id]: { x: 0, y: 0 } };
  rest.forEach((node, i) => {
    const ring = Math.floor(i / 8);
    const slot = i % 8;
    const angle = (slot / 8) * Math.PI * 2 - Math.PI / 2;
    const radius = 340 * (ring + 1);
    layout[node.id] = {
      x: Math.round(Math.cos(angle) * radius),
      y: Math.round(Math.sin(angle) * radius * 0.75),
    };
  });
  return layout;
}

/** Persisted positions win; new nodes fall back to defaults. */
export function mergePositions(
  nodes: FleetNode[],
  persisted: CanvasLayout,
): CanvasLayout {
  const defaults = defaultPositions(nodes);
  const layout: CanvasLayout = {};
  for (const node of nodes) {
    layout[node.id] = persisted[node.id] ?? defaults[node.id] ?? { x: 0, y: 0 };
  }
  return layout;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}

/** Animated parent -> child edges for nodes whose parent is on screen. */
export function buildEdges(
  nodes: Pick<FleetNode, "id" | "parentId">[],
): CanvasEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes
    .filter((n) => n.parentId && ids.has(n.parentId))
    .map((n) => ({
      id: `e:${n.parentId}->${n.id}`,
      source: n.parentId as string,
      target: n.id,
    }));
}

export function elapsedMs(
  node: Pick<FleetNode, "startedAt" | "endedAt">,
  now = Date.now(),
): number {
  return Math.max(0, (node.endedAt ?? now) - node.startedAt);
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Match a fleet node to its pending approval (H4 writes the node id or title
 * into the approval payload/summary). Display heuristic, tested.
 */
export function matchNodeApproval(
  node: Pick<FleetNode, "id" | "title" | "profile">,
  approvals: ApprovalSummary[],
): ApprovalSummary | undefined {
  return approvals.find((a) => {
    if (a.status !== "pending") return false;
    const payloadText = JSON.stringify(a.payload ?? null);
    return (
      payloadText.includes(node.id) ||
      a.summary.includes(node.id) ||
      (node.title.length > 3 && a.summary.includes(node.title))
    );
  });
}

/**
 * Exactly-once runner: the first invocation runs `fn`, later ones are
 * no-ops. The approval card routes Approve/Deny through this so a double
 * click (or key repeat) still calls approvals.approve/deny exactly once.
 */
export function createOnceRunner(): (fn: () => void) => void {
  let fired = false;
  return (fn: () => void) => {
    if (fired) return;
    fired = true;
    fn();
  };
}

/** Read-only transcript lines for the drawer: redacted steps + result summary. */
export function transcriptLines(
  node: Pick<FleetNode, "resultSummary" | "currentStep">,
  events: FleetEvent[],
): string[] {
  const lines = events
    .map((e) => e.message?.trim())
    .filter((m): m is string => Boolean(m))
    .slice(-100);
  if (node.resultSummary?.trim())
    lines.push(`Result: ${node.resultSummary.trim()}`);
  else if (
    node.currentStep?.trim() &&
    !lines.some((l) => l.includes(node.currentStep as string))
  ) {
    lines.push(`Current step: ${node.currentStep.trim()}`);
  }
  return lines;
}
