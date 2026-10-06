// server/plugins/shutdown.ts  Owner: Vaibhav (Phase V-7)
// One place for process teardown: SIGTERM/SIGINT run the shared registry
// (server/lib/shutdown.ts) so gmail + calendar pollers stop before the
// process exits. Nitro's close hook reuses the same path. Import-time work
// is registration only; handlers install once even under HMR.
import { defineNitroPlugin } from "@agent-native/core/server";
import { shutdown } from "../lib/shutdown.js";

let installed = false;

export default defineNitroPlugin((nitroApp) => {
  if (!installed) {
    installed = true;
    const onSignal = (signal: string) => {
      void shutdown(5000, signal).catch((err: unknown) => {
        console.error(`[shutdown] ${signal} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("SIGINT", () => onSignal("SIGINT"));
  }
  try {
    const hooks = (nitroApp as { hooks?: { hook?: (event: string, fn: () => void) => void } })?.hooks;
    hooks?.hook?.("close", () => {
      void shutdown(5000, "nitro-close").catch(() => {});
    });
  } catch {
    // Hook registration is best-effort.
  }
  console.log("[shutdown] plugin ok: SIGTERM/SIGINT -> graceful stop");
});
