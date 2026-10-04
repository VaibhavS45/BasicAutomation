import { defineAction } from "@agent-native/core/action";
import { parsePhoneNumber } from "libphonenumber-js";
import { z } from "zod";
import { requireApproval } from "../../server/lib/approvals.js";
import { audit, redactSecrets } from "../../server/lib/audit.js";
import type { ActionResult } from "../../server/lib/types.js";
import { sendTemplate, sendText } from "../../server/lib/whatsapp-client.js";

/** E.164 via libphonenumber-js: parse, validate, normalize. */
export const e164Phone = z.string().transform((v, ctx) => {
  let digits: string;
  try {
    const parsed = parsePhoneNumber(v);
    if (!parsed.isValid()) {
      ctx.addIssue({
        code: "custom",
        message: `"${v}" is not a valid phone number. Use E.164 (e.g. +14155551234).`,
      });
      return z.NEVER;
    }
    digits = parsed.format("E.164");
  } catch {
    ctx.addIssue({
      code: "custom",
      message: `"${v}" is not a valid phone number. Use E.164 (e.g. +14155551234).`,
    });
    return z.NEVER;
  }
  return digits;
});

export const whatsappSendSchema = z
  .object({
    to: e164Phone.describe("Recipient phone number in E.164 (e.g. +14155551234)"),
    text: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("Free-form message. Cloud API only delivers this inside the 24h customer-service window."),
    template: z
      .object({
        name: z.string().min(1).describe("Approved template name (Cloud API) or Content SID (Twilio)"),
        language: z.string().min(2).default("en_US").describe("Template language code"),
        params: z.array(z.string()).default([]).describe("Body {{1}}, {{2}}, ... values in order"),
      })
      .optional()
      .describe("Use to message outside the 24h window"),
  })
  .refine((d) => d.text !== undefined || d.template !== undefined, {
    message: "Provide either text or template.",
  });

export type WhatsAppSendInput = z.input<typeof whatsappSendSchema>;
export type WhatsAppSendOutput = z.output<typeof whatsappSendSchema>;

export const WINDOW_24H_ERROR =
  "Not sending: free-form text on WhatsApp Cloud API only delivers within 24h of the user's last message (customer-service window). Provide template { name, params } with an approved template to message outside the window.";

function isDryRun(e: NodeJS.ProcessEnv = process.env): boolean {
  const raw = e.DRY_RUN;
  if (raw !== undefined) return !["0", "false", "no", "off"].includes(raw.toLowerCase().trim());
  return true;
}

function provider(e: NodeJS.ProcessEnv = process.env): string {
  return (e.WHATSAPP_PROVIDER ?? "cloud_api").toLowerCase();
}

export default defineAction({
  description:
    "Send a WhatsApp message. Use to notify the user on WhatsApp. Template messages work anytime; free-form text only delivers inside the 24h customer-service window on Cloud API.",
  mcpTool: true,
  schema: whatsappSendSchema,
  http: { method: "POST" },
  needsApproval: true,
  run: async (args: WhatsAppSendOutput): Promise<ActionResult> => {
    const kind = args.template ? "template" : "text";
    const redactedInput = redactSecrets({
      to: args.to,
      ...(args.text !== undefined ? { text: args.text } : {}),
      ...(args.template ? { template: args.template } : {}),
    });

    // DRY_RUN: log the payload, return ok, never touch HTTP.
    if (isDryRun()) {
      console.log(`[whatsapp:dry-run] ${kind} to=${args.to} ${JSON.stringify(redactedInput)}`);
      const outcome = { ok: true, dryRun: true, to: args.to, kind };
      await audit({ actor: "agent", action: "whatsapp.send", input: redactedInput, outcome });
      return { ok: true, data: outcome };
    }

    // Cloud API drops free-form text outside the 24h window — fail fast with
    // a clear error instead of sending into the void. Twilio has no window.
    if (!args.template && provider() === "cloud_api") {
      await audit({
        actor: "agent",
        action: "whatsapp.send",
        input: redactedInput,
        outcome: { ok: false, error: WINDOW_24H_ERROR },
      });
      return { ok: false, error: WINDOW_24H_ERROR };
    }

    const decision = await requireApproval({
      action: "whatsapp.send",
      summary: `Send WhatsApp ${kind} to ${args.to}`,
      payload: redactedInput,
    });
    if (!decision.approved) {
      const error = `Not approved (${decision.reason ?? "denied"}). Message not sent.`;
      await audit({
        actor: "agent",
        action: "whatsapp.send",
        input: redactedInput,
        outcome: { ok: false, error },
      });
      return { ok: false, error };
    }

    const result = args.template
      ? await sendTemplate(args.to, args.template.name, args.template.language, args.template.params)
      : await sendText(args.to, args.text as string);
    await audit({ actor: "agent", action: "whatsapp.send", input: redactedInput, outcome: result });
    return result;
  },
});
