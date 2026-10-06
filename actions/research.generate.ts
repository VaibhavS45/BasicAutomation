// actions/research.generate.ts — V-6 manual/agent entry to the research port.
// Deterministic (no model call): same event id -> same file, never a copy.
// The trigger engine allowlists this for the calendar.research.requested
// playbook; chat users can also run it directly to materialize a brief.
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { runResearchPort } from "../server/lib/research.js";
import { audit } from "../server/lib/audit.js";
import type { ActionResult, TriggerEvent } from "../server/lib/types.js";

export default defineAction({
  description:
    "Generate the research brief for a [research] calendar event (idempotent markdown file, optional Notion page). Reruns with the same calendarEventId reuse the existing file — nothing is duplicated.",
  mcpTool: true,
  schema: z.object({
    calendarEventId: z.string().min(1).describe("Google Calendar event id, e.g. abc123"),
    topic: z.string().min(1).max(200).describe("Research topic (without the [research] marker)"),
    title: z.string().max(200).optional().describe("Event title for the brief header"),
    description: z.string().max(4000).optional().describe("Event description / extra context"),
    start: z.string().optional().describe("Event start (ISO) for the brief header"),
  }),
  run: async ({ calendarEventId, topic, title, description, start }): Promise<ActionResult> => {
    const event: TriggerEvent = {
      id: `calendar:${calendarEventId}`,
      source: "calendar",
      type: "calendar.research.requested",
      receivedAt: new Date().toISOString(),
      summary: title ?? `[research] ${topic}`,
      payload: { calendarEventId, topic, title: title ?? topic, description: description ?? "", start: start ?? "" },
      untrusted: true,
    };
    const res = await runResearchPort(event);
    await audit({
      actor: "agent",
      action: "research.generate",
      input: { calendarEventId, topic },
      outcome: { path: res.path, deduplicated: res.deduplicated },
    });
    return { ok: res.ok, data: res, ...(res.error ? { error: res.error } : {}) };
  },
});
