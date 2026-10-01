import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { requireApproval } from "../server/lib/approvals.js";
import { audit } from "../server/lib/audit.js";
import { buildMimeMessage, GMAIL_BASE, googleFetch, isDryRun } from "../server/lib/google-auth.js";
import type { ActionResult } from "../server/lib/types.js";
import { gmailRecipients } from "./gmail.draft.js";

export default defineAction({
  description:
    "Send a Gmail message. Use only when the user explicitly asked to send email. Requires human approval; in DRY_RUN it only logs the MIME payload without sending.",
  mcpTool: true,
  schema: z.object({
    to: gmailRecipients,
    subject: z.string().min(1).describe("Subject line"),
    body: z.string().min(1).describe("Plain-text body"),
  }),
  needsApproval: true,
  run: async ({ to, subject, body }): Promise<ActionResult> => {
    const { raw } = buildMimeMessage({ to, subject, body });
    if (isDryRun()) {
      console.log(`[gmail:dry-run] send MIME:\n${mimePreview(raw)}`);
      const outcome = { ok: true, dryRun: true, to, subject };
      await audit({ actor: "agent", action: "gmail.send", input: { to, subject }, outcome });
      return { ok: true, data: outcome };
    }
    const decision = await requireApproval({
      action: "gmail.send",
      summary: `Send email to ${to.join(", ")} — ${subject}`,
      payload: { to, subject, body },
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Email not sent.`;
      await audit({ actor: "agent", action: "gmail.send", input: { to, subject }, outcome: { ok: false, error } });
      return { ok: false, error };
    }
    const res = (await googleFetch(`${GMAIL_BASE}/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    })) as { id?: string; threadId?: string };
    const outcome = { messageId: res.id ?? "unknown", threadId: res.threadId };
    await audit({ actor: "agent", action: "gmail.send", input: { to, subject }, outcome });
    return { ok: true, data: outcome };
  },
});

function mimePreview(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
