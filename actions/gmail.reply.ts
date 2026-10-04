import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { isChatApproved, requireApproval } from "../server/lib/approvals.js";
import { audit } from "../server/lib/audit.js";
import { buildMimeMessage, GMAIL_BASE, googleFetch, isDryRun } from "../server/lib/google-auth.js";
import type { ActionResult } from "../server/lib/types.js";

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

export default defineAction({
  description:
    "Reply to a Gmail thread (sets In-Reply-To/References so it lands in the same thread). Use to answer a message found via gmail.search/read. Requires human approval; honors DRY_RUN.",
  mcpTool: true,
  schema: z.object({
    messageId: z.string().min(1).describe("Gmail message id to reply to"),
    body: z.string().min(1).describe("Plain-text reply body"),
  }),
  needsApproval: true,
  run: async ({ messageId, body }, ctx?: ActionRunContext): Promise<ActionResult> => {
    const m = (await googleFetch(`${GMAIL_BASE}/messages/${messageId}?format=full`)) as {
      id: string;
      threadId: string;
      payload?: {
        headers?: Array<{ name: string; value: string }>;
      };
    };
    const headers = m.payload?.headers ?? [];
    const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    const rfcId = get("message-id");
    if (!rfcId) return { ok: false, error: "Original message has no Message-ID; cannot thread the reply." };
    const to = [get("from")].filter(Boolean);
    const subject = replySubject(get("subject"));
    const references = [get("references"), rfcId].filter(Boolean).join(" ");
    const { raw } = buildMimeMessage({ to, subject, body, inReplyTo: rfcId, references });
    if (isDryRun()) {
      console.log(`[gmail:dry-run] reply in thread ${m.threadId} to=${to.join(",")}`);
      const outcome = { ok: true, dryRun: true, threadId: m.threadId, to, subject };
      await audit({ actor: "agent", action: "gmail.reply", input: { messageId }, outcome });
      return { ok: true, data: outcome };
    }
    // Chat path: the framework's needsApproval card already gated this call
    // (ctx.approvedToolCallKey). File gate remains for trigger/script runs.
    if (!isChatApproved(ctx)) {
      const decision = await requireApproval({
        action: "gmail.reply",
        summary: `Reply in thread ${m.threadId} to ${to.join(", ")} — ${subject}`,
        payload: { messageId, to, subject, body },
      });
      if (!decision.approved) {
        const error = `Not approved (${decision.reason ?? "denied"}). Reply not sent.`;
        await audit({ actor: "agent", action: "gmail.reply", input: { messageId }, outcome: { ok: false, error } });
        return { ok: false, error };
      }
    }
    const res = (await googleFetch(`${GMAIL_BASE}/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw, threadId: m.threadId }),
    })) as { id?: string };
    const outcome = { messageId: res.id ?? "unknown", threadId: m.threadId };
    await audit({ actor: "agent", action: "gmail.reply", input: { messageId }, outcome });
    return { ok: true, data: outcome };
  },
});
