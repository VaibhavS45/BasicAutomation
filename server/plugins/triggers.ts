// server/plugins/triggers.ts  Owner: Vaibhav
// Boots Yashwanth's Gmail poller (server/triggers/gmail.ts stays his).
// Lazy by design: nothing here runs at import time beyond defining the
// plugin. 5s after boot an async check runs — Google OAuth configured AND
// GMAIL_TRIGGER_LABEL set — and only then starts polling. Startup is never
// blocked; shutdown stops the poller. Every path logs exactly one line.
import { defineNitroPlugin } from "@agent-native/core/server";

const BOOT_DELAY_MS = 5000;

interface GmailHandle {
  stop: () => void;
}

export interface BootEnv {
  GMAIL_TRIGGER_LABEL?: string;
  GOOGLE_CLIENT_ID?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  GOOGLE_TOKEN_STORE_PATH?: string;
}

/** Pure boot decision (exported for tests): start only when fully configured. */
export function gmailTriggerBootPlan(env: BootEnv, tokenPresent: boolean): { start: boolean; reason: string } {
  if (!env.GMAIL_TRIGGER_LABEL) return { start: false, reason: "GMAIL_TRIGGER_LABEL is not set" };
  if (!env.GOOGLE_CLIENT_ID || !env.TOKEN_ENCRYPTION_KEY) {
    return { start: false, reason: "google oauth not configured (GOOGLE_CLIENT_ID/TOKEN_ENCRYPTION_KEY missing)" };
  }
  if (!tokenPresent) {
    const tokenPath = env.GOOGLE_TOKEN_STORE_PATH ?? "./.data/google-token.json";
    return { start: false, reason: `google token not provisioned at ${tokenPath} (open /oauth/google/start once)` };
  }
  return { start: true, reason: "configured" };
}

async function googleAuthConfigured(): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Dynamic import: env parse is the only import-time work allowed, and even
  // that stays inside the delayed callback, never at module load.
  const { env } = await import("../lib/env.js");
  // Token file provisioned by the one-time /oauth/google/start flow?
  const { promises: fs } = await import("node:fs");
  const tokenPath = env.GOOGLE_TOKEN_STORE_PATH ?? "./.data/google-token.json";
  let tokenPresent = false;
  try {
    await fs.access(tokenPath);
    tokenPresent = true;
  } catch {
    tokenPresent = false;
  }
  const plan = gmailTriggerBootPlan(env, tokenPresent);
  return plan.start ? { ok: true } : { ok: false, reason: plan.reason };
}

export default defineNitroPlugin((nitroApp) => {
  const bootStarted = Date.now();
  let handle: GmailHandle | null = null;
  let stopped = false;

  const timer = setTimeout(() => {
    void (async () => {
      try {
        if (stopped) return;
        const configured = await googleAuthConfigured();
        if (!configured.ok) {
          console.log(`[triggers] gmail trigger skipped: ${configured.reason}`);
          return;
        }
        const [{ startGmailTrigger }, { emit }] = await Promise.all([
          import("../triggers/gmail.js"),
          import("../triggers/engine.js"),
        ]);
        if (stopped) return;
        handle = await startGmailTrigger(async (event) => {
          await emit(event);
        });
        console.log("[triggers] gmail trigger started");
      } catch (err) {
        // Never let a trigger failure take down boot or crash the process.
        console.log(
          `[triggers] gmail trigger skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  }, BOOT_DELAY_MS);
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();

  try {
    const hooks = (nitroApp as { hooks?: { hook?: (event: string, fn: () => void) => void } })?.hooks;
    hooks?.hook?.("close", () => {
      stopped = true;
      clearTimeout(timer);
      try {
        handle?.stop();
      } catch {
        // Shutdown best-effort; already stopping.
      }
    });
  } catch {
    // Hook registration is best-effort; the timer is unref'd regardless.
  }

  console.log(`[triggers] plugin boot ok (${Date.now() - bootStarted}ms): gmail poll check in ${BOOT_DELAY_MS}ms`);
});
