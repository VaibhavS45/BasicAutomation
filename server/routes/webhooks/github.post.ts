// server/routes/webhooks/github.post.ts  Owner: Vaibhav
// POST /webhooks/github — GitHub webhook deliveries. Public (see publicPaths
// in server/plugins/auth.ts) because GitHub cannot sign in; every request is
// gated by OUR HMAC check below instead. Raw body first, verify, 202 fast,
// agent run in the background (GitHub times out deliveries after ~10s).
import { randomUUID } from "node:crypto";
import { defineEventHandler, getHeader, readRawBody, setResponseStatus } from "h3";
import { env } from "../../lib/env.js";
import { repoAllowlist } from "../../lib/connectors/github.js";
import { emit } from "../../triggers/engine.js";
import { mapWebhookToTrigger, verifySignature } from "../../triggers/github.js";
import type { TriggerEvent } from "../../lib/types.js";

export interface WebhookRequest {
  rawBody: Uint8Array | undefined;
  signature: string | null | undefined;
  githubEvent: string;
  delivery: string;
}

export interface WebhookDeps {
  emitFn: (event: TriggerEvent) => Promise<unknown>;
  webhookSecret: string | undefined;
  botLogin: string;
  repoAllowlist: string[];
}

export interface WebhookResult {
  status: number;
  body: { ok: boolean; data?: unknown; error?: string };
}

/**
 * Framework-free core: verify → map → 202 (emit in background). Pure enough
 * to unit-test without h3 or the network.
 */
export async function handleGitHubWebhook(req: WebhookRequest, deps: WebhookDeps): Promise<WebhookResult> {
  if (!deps.webhookSecret) {
    console.log("[github-webhook] 503: GITHUB_WEBHOOK_SECRET is not set — configure it to receive deliveries.");
    return { status: 503, body: { ok: false, error: "webhook not configured (GITHUB_WEBHOOK_SECRET missing)" } };
  }
  const raw = req.rawBody ?? new Uint8Array(0);
  if (!verifySignature(raw, req.signature, deps.webhookSecret)) {
    return { status: 401, body: { ok: false, error: "invalid or missing X-Hub-Signature-256" } };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return { status: 400, body: { ok: false, error: "invalid JSON body" } };
  }
  const decision = mapWebhookToTrigger({
    githubEvent: req.githubEvent,
    delivery: req.delivery,
    payload,
    botLogin: deps.botLogin,
    repoAllowlist: deps.repoAllowlist,
  });
  if (decision.kind === "ping") {
    return { status: 200, body: { ok: true, data: { pong: true } } };
  }
  if (decision.kind === "drop") {
    return { status: 202, body: { ok: true, data: { dropped: decision.reason } } };
  }
  // Background: never hold GitHub's delivery while the agent runs.
  void deps
    .emitFn(decision.event)
    .catch((err: unknown) =>
      console.error(`[github-webhook] background emit failed for ${decision.event.id}: ${err instanceof Error ? err.message : String(err)}`),
    );
  return { status: 202, body: { ok: true, data: { accepted: decision.event.id, type: decision.event.type } } };
}

function readDeployConfig(): { webhookSecret: string | undefined; botLogin: string } {
  return {
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? env.GITHUB_WEBHOOK_SECRET, // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
    botLogin: (process.env.GITHUB_BOT_LOGIN ?? env.GITHUB_BOT_LOGIN ?? "").trim(), // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  };
}

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event, false);
  const result = await handleGitHubWebhook(
    {
      rawBody,
      signature: getHeader(event, "x-hub-signature-256"),
      githubEvent: getHeader(event, "x-github-event") ?? "",
      delivery: getHeader(event, "x-github-delivery") ?? randomUUID(),
    },
    {
      emitFn: emit,
      ...readDeployConfig(),
      repoAllowlist: repoAllowlist(),
    },
  );
  setResponseStatus(event, result.status);
  return result.body;
});
