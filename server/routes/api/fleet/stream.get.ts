// server/routes/api/fleet/stream.get.ts  Owner: Vaibhav (H4 fleet + approvals API)
// GET /api/fleet/stream — SSE live fleet events. Emits a `snapshot` with the
// current nodes first, then one `fleet` message per registry event, plus
// `:heartbeat` comments every 15 s to keep proxies from idling out.
// Fallback when SSE is unavailable: poll fleet.get {id, afterSeq} every 1-2 s.
import { defineEventHandler, EventStream } from "h3";
import { fleetEventMessage, listNodes, subscribeFleet } from "../../../lib/fleet.js";
import { redactSecrets } from "../../../lib/audit.js";

const HEARTBEAT_MS = 15_000;

/** Snapshot lines sent first on connect. Pure — tested. */
export function snapshotSse(): Array<{ event: string; data: string }> {
  return listNodes()
    .slice(0, 20)
    .map((node) => ({ event: "snapshot", data: JSON.stringify(redactSecrets(node)) }));
}

export default defineEventHandler((event) => {
  const stream = new EventStream(event);
  for (const line of snapshotSse()) {
    void stream.push(line);
  }
  const unsubscribe = subscribeFleet((fleetEvent) => {
    void stream.push(fleetEventMessage(fleetEvent));
  });
  const heartbeat = setInterval(() => {
    void stream.pushComment("heartbeat");
  }, HEARTBEAT_MS);
  stream.onClosed(() => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  return stream;
});
