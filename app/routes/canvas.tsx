// app/routes/canvas.tsx — H5: fleet canvas (Yashwanth).
// Pannable/zoomable view of live agent work: the head agent pinned near the
// center, workers fanned around it. Live data from fleet.list (+ the fleet
// SSE stream as a refetch hint); layout persisted per project in SQL app
// state (never localStorage). The head-agent chat docked bottom-left is the
// ONLY conversation surface — worker drawers are read-only.
import "@xyflow/react/dist/style.css";
import {
  readClientAppState,
  useActionMutation,
  useActionQuery,
  writeClientAppState,
} from "@agent-native/core/client/hooks";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowsMaximize,
  IconBrandNotion,
  IconBrowser,
  IconCpu,
  IconMail,
  IconMessageCircle,
  IconPlayerStop,
  IconRobot,
  IconX,
} from "@tabler/icons-react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import {
  buildEdges,
  CANVAS_GRID_SIZE,
  createOnceRunner,
  defaultPositions,
  elapsedMs,
  formatElapsed,
  LAYOUT_HISTORY_LIMIT,
  layoutStorageKey,
  matchNodeApproval,
  mergePositions,
  parseLayout,
  profileToken,
  pruneLayout,
  type CapabilityToken,
  type CanvasLayout,
} from "@/components/canvas/canvas-layout";
import { WorkerDrawer } from "@/components/canvas/WorkerDrawer";
import ChatRouteContent from "@/components/chat/ChatRouteContent";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { getChatHomeThreadId } from "@/lib/chat-home-thread";
import { cn } from "@/lib/utils";

import type { FleetEvent, FleetNode } from "../../server/lib/types.js";

export function meta() {
  return [{ title: "Canvas" }];
}

type FleetDatum = { fleet: FleetNode; now: number; synthetic?: boolean };
type FleetFlowNode = FlowNode<FleetDatum, "fleet">;

const TOKEN_ICON: Record<CapabilityToken, typeof IconMail> = {
  "@gmail": IconMail,
  "@browser": IconBrowser,
  "@notion": IconBrandNotion,
  "@worker": IconRobot,
};

const STATUS_DOT: Record<FleetNode["status"], string> = {
  queued: "bg-muted-foreground",
  running: "bg-emerald-500",
  waiting_approval: "bg-amber-500 animate-pulse",
  done: "bg-zinc-400",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
};

function FleetCanvasNode({
  data,
  selected,
  id,
}: NodeProps<FleetFlowNode> & { id: string }) {
  const { fleet } = data;
  const token = profileToken(fleet.profile, fleet.toolsUsed);
  const ProfileIcon = data.synthetic ? IconCpu : TOKEN_ICON[token];
  const waiting = fleet.status === "waiting_approval";
  return (
    <div
      className={cn(
        "w-60 rounded-lg border bg-card text-card-foreground shadow-sm transition-[box-shadow,border-color]",
        selected ? "border-primary shadow-md" : "border-border",
        waiting && "animate-pulse border-amber-500",
      )}
      data-node-id={id}
      data-status={fleet.status}
    >
      <button
        type="button"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("canvas:open-node", { detail: { id } }),
          )
        }
        aria-label={`${fleet.title}, status ${fleet.status}. Open details.`}
        className="flex w-full cursor-pointer items-start gap-2 rounded-lg p-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted"
          aria-hidden="true"
        >
          <ProfileIcon className="size-4" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                STATUS_DOT[fleet.status],
              )}
              aria-hidden="true"
            />
            <span className="truncate text-xs font-semibold">
              {fleet.title}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {data.synthetic ? "head agent" : token} ·{" "}
            {fleet.currentStep?.slice(0, 60) || fleet.status}
          </span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            {formatElapsed(elapsedMs(fleet, data.now))}
            {fleet.toolsUsed.length > 0
              ? ` · ${fleet.toolsUsed.slice(0, 3).join(", ")}`
              : ""}
          </span>
        </span>
      </button>
      {waiting ? (
        <div
          className="border-t border-border px-2.5 py-1.5"
          data-testid="node-approval-card"
        >
          <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
            Needs approval — open for Approve / Deny
          </p>
        </div>
      ) : null}
    </div>
  );
}

const nodeTypes = { fleet: FleetCanvasNode };

function HeadChatDockView() {
  const [threadId] = useState(getChatHomeThreadId);
  return <ChatRouteContent initialThreadId={threadId} />;
}

function syntheticHead(): FleetNode {
  return {
    id: "__head__",
    parentId: null,
    profile: "head-agent",
    title: "Head agent — idle",
    status: "queued",
    startedAt: Date.now(),
    toolsUsed: [],
  };
}

export default function CanvasRoute() {
  const [searchParams] = useSearchParams();
  const project = searchParams.get("project")?.trim() || "default";
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [positions, setPositions] = useState<CanvasLayout>({});
  const [persisted, setPersisted] = useState<CanvasLayout | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [history, setHistory] = useState<{
    past: CanvasLayout[];
    future: CanvasLayout[];
  }>({ past: [], future: [] });
  const [snap, setSnap] = useState(true);
  const [dockOpen, setDockOpen] = useState(true);
  const [stopArmed, setStopArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const flowRef = useRef<ReactFlowInstance<FleetFlowNode, Edge> | null>(null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const dragStartRef = useRef<CanvasLayout | null>(null);
  const stopTimer = useRef<number | null>(null);

  useEffect(() => {
    setMounted(true);
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    const onOpen = (e: Event) =>
      setSelectedId((e as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener("canvas:open-node", onOpen);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("canvas:open-node", onOpen);
    };
  }, []);

  const fleetQuery = useActionQuery(
    "fleet.list",
    {},
    { refetchInterval: 2000 },
  );
  const approvalsQuery = useActionQuery(
    "approvals.list",
    { status: "pending" },
    { refetchInterval: 3000 },
  );
  const selectedEvents = useActionQuery(
    "fleet.get",
    { id: selectedId ?? "", afterSeq: 0 },
    {
      enabled: mounted && selectedId !== null && selectedId !== "__head__",
      refetchInterval: 1500,
    },
  );

  // SSE stream is a refetch hint; fleet.list stays the data source.
  useEffect(() => {
    if (
      !mounted ||
      typeof window === "undefined" ||
      typeof EventSource === "undefined"
    )
      return;
    const src = new EventSource("/api/fleet/stream");
    const hint = () => {
      void fleetQuery.refetch();
    };
    src.addEventListener("fleet", hint);
    src.addEventListener("snapshot", hint);
    return () => src.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  const liveNodes: FleetNode[] = useMemo(() => {
    const data = fleetQuery.data as
      | { ok?: boolean; data?: { nodes?: FleetNode[] } }
      | undefined;
    return data?.ok === false ? [] : (data?.data?.nodes ?? []);
  }, [fleetQuery.data]);

  const nodes: FleetNode[] =
    liveNodes.length > 0 ? liveNodes : [syntheticHead()];
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const pendingApprovals = useMemo(() => {
    const data = approvalsQuery.data as
      | { ok?: boolean; data?: { approvals?: never[] } }
      | undefined;
    return (data?.data?.approvals ?? []) as Parameters<
      typeof matchNodeApproval
    >[1];
  }, [approvalsQuery.data]);
  const pendingForSelected = selected
    ? matchNodeApproval(selected, pendingApprovals)
    : undefined;

  // Load persisted layout once per project (SQL app state).
  useEffect(() => {
    setPersisted(null);
    setInitialized(false);
    let cancelled = false;
    void readClientAppState<unknown>(layoutStorageKey(project))
      .then((raw) => {
        if (!cancelled) setPersisted(parseLayout(raw));
      })
      .catch(() => {
        if (!cancelled) setPersisted({});
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  // First merge: persisted wins, new nodes take defaults.
  useEffect(() => {
    if (initialized || persisted === null || !fleetQuery.data) return;
    setPositions(mergePositions(nodes, persisted));
    setHistory({ past: [], future: [] });
    setInitialized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, persisted, fleetQuery.data]);

  // Later arrivals: place only unknown nodes, never move existing ones.
  useEffect(() => {
    if (!initialized) return;
    setPositions((prev) => {
      const defaults = defaultPositions(nodes);
      let changed = false;
      const next = { ...prev };
      for (const n of nodes) {
        if (!next[n.id]) {
          next[n.id] = defaults[n.id] ?? { x: 0, y: 0 };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [nodes, initialized]);

  // Debounced persist (pruned to live nodes).
  useEffect(() => {
    if (!initialized || !mounted) return;
    const t = window.setTimeout(() => {
      void writeClientAppState(
        layoutStorageKey(project),
        pruneLayout(positionsRef.current, nodes),
      ).catch(() => {});
    }, 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, initialized, project]);

  const snapPos = useCallback(
    (x: number, y: number) =>
      snap
        ? {
            x: Math.round(x / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE,
            y: Math.round(y / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE,
          }
        : { x, y },
    [snap],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FleetFlowNode>[]) => {
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          const p = snapPos(c.position.x, c.position.y);
          setPositions((prev) =>
            prev[c.id]?.x === p.x && prev[c.id]?.y === p.y
              ? prev
              : { ...prev, [c.id]: p },
          );
        }
      }
    },
    [snapPos],
  );

  const pushHistory = useCallback((snapshot: CanvasLayout) => {
    setHistory((h) => ({
      past: [...h.past.slice(-(LAYOUT_HISTORY_LIMIT - 1)), snapshot],
      future: [],
    }));
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const prev = h.past[h.past.length - 1];
      setPositions(prev);
      return {
        past: h.past.slice(0, -1),
        future: [positionsRef.current, ...h.future].slice(
          0,
          LAYOUT_HISTORY_LIMIT,
        ),
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const [next, ...rest] = h.future;
      setPositions(next as CanvasLayout);
      return {
        past: [...h.past, positionsRef.current].slice(-LAYOUT_HISTORY_LIMIT),
        future: rest,
      };
    });
  }, []);

  const flowNodes: FleetFlowNode[] = useMemo(
    () =>
      nodes.map((fleet) => ({
        id: fleet.id,
        type: "fleet" as const,
        position: positions[fleet.id] ??
          defaultPositions(nodes)[fleet.id] ?? { x: 0, y: 0 },
        data: { fleet, now, synthetic: fleet.id === "__head__" },
        selected: fleet.id === selectedId,
        draggable: true,
      })),
    [nodes, positions, now, selectedId],
  );

  const flowEdges: Edge[] = useMemo(
    () => buildEdges(nodes).map((e) => ({ ...e, animated: true })),
    [nodes],
  );

  const approveMutation = useActionMutation("approvals.approve");
  const denyMutation = useActionMutation("approvals.deny");
  const cancelMutation = useActionMutation("fleet.cancel");
  const cancelAllMutation = useActionMutation("fleet.cancelAll");

  // Exactly-once per approval card mount: double clicks still decide once.
  const fireOnce = useMemo(
    () => createOnceRunner(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingForSelected?.id, selectedId],
  );

  function afterWrite() {
    setBusy(false);
    void fleetQuery.refetch();
    void approvalsQuery.refetch();
  }

  function handleApprove(approvalId: string) {
    fireOnce(() => {
      setBusy(true);
      approveMutation.mutate({ id: approvalId }, { onSettled: afterWrite });
    });
  }

  function handleDeny(approvalId: string) {
    fireOnce(() => {
      setBusy(true);
      denyMutation.mutate({ id: approvalId }, { onSettled: afterWrite });
    });
  }

  function handleCancel(nodeId: string) {
    if (nodeId === "__head__") return;
    setBusy(true);
    cancelMutation.mutate({ id: nodeId }, { onSettled: afterWrite });
  }

  function handleStopAll() {
    if (!stopArmed) {
      setStopArmed(true);
      if (stopTimer.current) window.clearTimeout(stopTimer.current);
      stopTimer.current = window.setTimeout(() => setStopArmed(false), 5000);
      return;
    }
    setStopArmed(false);
    setBusy(true);
    cancelAllMutation.mutate({}, { onSettled: afterWrite });
  }

  function onCanvasKeyDown(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    )
      return;
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }

  return (
    <div
      className="relative flex h-[calc(100dvh-4rem)] min-h-[480px] flex-col bg-background"
      onKeyDown={onCanvasKeyDown}
    >
      <div
        className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5"
        role="toolbar"
        aria-label="Canvas controls"
      >
        <span className="mr-1 hidden text-xs font-medium text-muted-foreground sm:inline">
          {liveNodes.length === 0 ? "No live work" : `${liveNodes.length} live`}
        </span>
        <Button
          type="button"
          variant={snap ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setSnap((s) => !s)}
          aria-pressed={snap}
          title="Snap nodes to grid"
        >
          Grid
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={undo}
          disabled={history.past.length === 0}
          aria-label="Undo layout move"
        >
          <IconArrowBackUp className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={redo}
          disabled={history.future.length === 0}
          aria-label="Redo layout move"
        >
          <IconArrowForwardUp className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            flowRef.current?.fitView({ padding: 0.2, duration: 200 })
          }
        >
          <IconArrowsMaximize className="size-4" aria-hidden="true" />
          Fit
        </Button>
        <span className="flex-1" />
        <Button
          type="button"
          variant={stopArmed ? "destructive" : "ghost"}
          size="sm"
          onClick={handleStopAll}
          disabled={busy || liveNodes.length === 0}
          className={stopArmed ? "" : "text-destructive hover:text-destructive"}
        >
          <IconPlayerStop className="size-4" aria-hidden="true" />
          {stopArmed ? "Confirm stop all?" : "Stop all"}
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {!mounted ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading canvas…
          </div>
        ) : (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onNodeDragStart={() => {
              dragStartRef.current = positionsRef.current;
            }}
            onNodeDragStop={() => {
              if (dragStartRef.current) pushHistory(dragStartRef.current);
              dragStartRef.current = null;
            }}
            onInit={(instance) => {
              flowRef.current = instance;
            }}
            colorMode="system"
            minZoom={0.2}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: false }}
            aria-label="Fleet canvas: head agent and worker nodes"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={CANVAS_GRID_SIZE}
            />
            <MiniMap pannable zoomable aria-label="Canvas minimap" />
            <Controls showFitView={false} />
          </ReactFlow>
        )}

        {fleetQuery.isError ? (
          <p
            role="alert"
            className="absolute left-3 top-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-destructive"
          >
            Couldn&apos;t load live work. Retrying…
          </p>
        ) : null}

        <div className="absolute bottom-3 left-3 z-10 w-[min(24rem,calc(100%-1.5rem))]">
          {!dockOpen ? (
            <Button type="button" size="sm" onClick={() => setDockOpen(true)}>
              <IconMessageCircle className="size-4" aria-hidden="true" />
              Head agent
            </Button>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card shadow-lg">
              <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                <p className="text-xs font-semibold">
                  Head agent — the only chat
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDockOpen(false)}
                  aria-label="Collapse head agent chat"
                >
                  <IconX className="size-4" />
                </Button>
              </div>
              <div className="h-72">
                <HeadChatDockView />
              </div>
            </div>
          )}
        </div>
      </div>

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => !open && setSelectedId(null)}
      >
        <SheetContent
          side="right"
          className="w-[min(28rem,100vw)] p-0"
          aria-label="Worker details"
        >
          <SheetTitle className="sr-only">Worker details</SheetTitle>
          {selected ? (
            <WorkerDrawer
              node={selected}
              events={
                (
                  selectedEvents.data as
                    | { ok?: boolean; data?: { events?: FleetEvent[] } }
                    | undefined
                )?.data?.events ?? []
              }
              pendingApproval={pendingForSelected}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onCancel={handleCancel}
              onClose={() => setSelectedId(null)}
              busy={busy}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
