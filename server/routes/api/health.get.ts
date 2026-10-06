// server/routes/api/health.get.ts  Owner: Vaibhav (Phase V-7)
// GET /api/health — public (see GITHUB_WEBHOOK_PUBLIC_PATH-style list in
// server/plugins/auth.ts). Fast by design: no network, no secrets, only a
// data-dir writability probe + config presence flags. Load balancers and the
// README's local-run checklist hit this first.
import { promises as fs } from "node:fs";
import path from "node:path";
import { defineEventHandler } from "h3";
import { env } from "../../lib/env.js";

const BOOTED_AT = Date.now();

export interface HealthStatus {
  ok: boolean;
  uptimeSeconds: number;
  checks: {
    dataDir: string;
    triggers: { gmail: boolean; calendarResearch: boolean; githubWebhook: boolean };
    researchPort: { notion: boolean };
  };
}

export async function healthStatus(deps: { probeDataDir?: () => Promise<void> } = {}): Promise<HealthStatus> {
  let dataDir: string = "ok";
  try {
    if (deps.probeDataDir) {
      await deps.probeDataDir();
    } else {
      const dir = process.env.DATA_DIR ?? env.DATA_DIR; // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
      await fs.mkdir(dir, { recursive: true });
      await fs.access(path.join(dir), fs.constants.W_OK);
    }
  } catch (err) {
    dataDir = err instanceof Error ? err.message : String(err);
  }
  const gmail =
    Boolean(process.env.GMAIL_TRIGGER_LABEL ?? env.GMAIL_TRIGGER_LABEL) && // guard:allow-env-credential — presence flag only, value never returned; process.env read is the test-isolation override
    Boolean(process.env.GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID); // guard:allow-env-credential — presence flag only, value never returned; process.env read is the test-isolation override
  const githubWebhook = Boolean(process.env.GITHUB_WEBHOOK_SECRET ?? env.GITHUB_WEBHOOK_SECRET); // guard:allow-env-credential — presence flag only, value never returned; process.env read is the test-isolation override
  const notion = Boolean(
    (process.env.NOTION_TOKEN ?? env.NOTION_TOKEN) && // guard:allow-env-credential — presence flag only, value never returned; process.env read is the test-isolation override
      (process.env.NOTION_PARENT_PAGE_ID ?? env.NOTION_PARENT_PAGE_ID), // guard:allow-env-credential — presence flag only, value never returned; process.env read is the test-isolation override
  );
  const ok = dataDir === "ok";
  return {
    ok,
    uptimeSeconds: Math.floor((Date.now() - BOOTED_AT) / 1000),
    checks: {
      dataDir,
      triggers: { gmail, calendarResearch: gmail, githubWebhook },
      researchPort: { notion },
    },
  };
}

export default defineEventHandler(async () => healthStatus());
