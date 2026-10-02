import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { buildMimeMessage, GMAIL_BASE, googleFetch, isDryRun } from "../server/lib/google-auth.js";
import type { ActionResult } from "../server/lib/types.js";

export const gmailRecipients = z
  .array(z.string().email())
  .min(1)
  .max(20)
  .describe("Recipient emails");

export default defineAction({
  description:
    "Create a Gmail draft (does NOT send). Use when the user wants to review before sending, or as a safe alternative to gmail.send. Call gmail.send only after the user approves the draft.",
  mcpTool: true,
  schema: z.object({
    to: gmailRecipients,
    subject: z.string().min(1).describe("Subject line"),
    body: z.string().min(1).describe("Plain-text body"),
  }),
  run: async ({ to, subject, body }): Promise<ActionResult> => {
    const { raw } = buildMimeMessage({ to, subject, body });
    if (isDryRun()) {
      console.log(`[gmail:dry-run] draft to=${to.join(",")} subject=${subject}`);
      const outcome = { ok: true, dryRun: true, to, subject };
      await audit({ actor: "agent", action: "gmail.draft", input: { to, subject }, outcome });
      return { ok: true, data: outcome };
    }
    const res = (await googleFetch(`${GMAIL_BASE}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    })) as { id?: string };
    const outcome = { draftId: res.id ?? "unknown" };
    await audit({ actor: "agent", action: "gmail.draft", input: { to, subject }, outcome });
    return { ok: true, data: outcome };
  },
});
