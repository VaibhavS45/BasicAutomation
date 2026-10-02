import { randomUUID } from "node:crypto";
import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { requireApproval } from "../server/lib/approvals.js";
import { audit } from "../server/lib/audit.js";
import { CALENDAR_BASE, googleFetch, isDryRun } from "../server/lib/google-auth.js";
import type { ActionResult } from "../server/lib/types.js";
import { calendarAttendees } from "./calendar.findFreeSlots.js";

function defaultTimeZone(e: NodeJS.ProcessEnv = process.env): string {
  return e.DEFAULT_TIMEZONE ?? "Asia/Kolkata";
}

const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), {
  message: "Must be an ISO date/time, e.g. 2026-10-02T16:00:00+05:30",
});

/** Pull the Meet URL out of an events.insert response. Pure — tested. */
export function extractMeetLink(event: {
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
}): string | undefined {
  if (event.hangoutLink) return event.hangoutLink;
  return event.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video" && e.uri,
  )?.uri;
}

export default defineAction({
  description:
    "Create a calendar event, optionally with a Google Meet link (addMeet). Use to schedule meetings; call calendar.findFreeSlots first to pick a time. Adding attendees emails them invites, so it requires human approval. Honors DRY_RUN.",
  mcpTool: true,
  schema: z.object({
    title: z.string().min(1).describe("Event title"),
    description: z.string().optional().describe("Event description"),
    start: isoDate.describe("Start (ISO with offset, e.g. 2026-10-02T16:00:00+05:30)"),
    end: isoDate.describe("End (ISO with offset)"),
    timeZone: z.string().min(1).optional().describe("IANA zone, e.g. Asia/Kolkata"),
    attendees: calendarAttendees.describe("Invitee emails — they get emailed invites"),
    addMeet: z.boolean().default(true).describe("Generate a Google Meet link"),
  }),
  needsApproval: (args: { attendees?: string[] }) => (args.attendees?.length ?? 0) > 0,
  run: async ({ title, description, start, end, timeZone, attendees, addMeet }): Promise<ActionResult> => {
    const tz = timeZone ?? defaultTimeZone();
    const body: Record<string, unknown> = {
      summary: title,
      ...(description ? { description } : {}),
      start: { dateTime: start, timeZone: tz },
      end: { dateTime: end, timeZone: tz },
      attendees: attendees.map((email) => ({ email })),
      ...(addMeet
        ? {
            conferenceData: {
              createRequest: {
                requestId: randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }
        : {}),
    };
    if (isDryRun()) {
      console.log(`[calendar:dry-run] create "${title}" ${start} -> ${end} (${tz}) attendees=${attendees.join(",") || "none"} addMeet=${addMeet}`);
      const outcome = { ok: true, dryRun: true, title, start, end, timeZone: tz, attendees, addMeet };
      await audit({ actor: "agent", action: "calendar.createEvent", input: { title, start, end, attendees }, outcome });
      return { ok: true, data: outcome };
    }
    if (attendees.length > 0) {
      const decision = await requireApproval({
        action: "calendar.createEvent",
        summary: `Create "${title}" ${start} -> ${end} (${tz}) with Meet link, inviting ${attendees.join(", ")}`,
        payload: { title, start, end, timeZone: tz, attendees, addMeet },
      });
      if (!decision.approved) {
        const error = `Not approved (${decision.reason ?? "denied"}). Event not created.`;
        await audit({ actor: "agent", action: "calendar.createEvent", input: { title, start, end }, outcome: { ok: false, error } });
        return { ok: false, error };
      }
    }
    const event = (await googleFetch(
      `${CALENDAR_BASE}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    )) as { id?: string; htmlLink?: string; hangoutLink?: string; conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> } };
    const data = { eventId: event.id ?? "unknown", htmlLink: event.htmlLink, meetLink: extractMeetLink(event) };
    await audit({ actor: "agent", action: "calendar.createEvent", input: { title, start, end, attendees }, outcome: data });
    return { ok: true, data };
  },
});
