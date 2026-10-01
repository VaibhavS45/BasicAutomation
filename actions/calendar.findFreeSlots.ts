import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { audit } from "../server/lib/audit.js";
import { CALENDAR_BASE, googleFetch } from "../server/lib/google-auth.js";
import type { ActionResult } from "../server/lib/types.js";

export const calendarAttendees = z.array(z.string().email()).default([]);

function defaultTimeZone(e: NodeJS.ProcessEnv = process.env): string {
  return e.DEFAULT_TIMEZONE ?? "Asia/Kolkata";
}

/** Carve durationMinutes slots out of the gaps in sorted busy periods. Pure — tested. */
export function freeSlots(
  busy: Array<{ start: string; end: string }>,
  windowStart: string,
  windowEnd: string,
  durationMinutes: number,
  limit = 20,
): Array<{ start: string; end: string }> {
  const start = new Date(windowStart).getTime();
  const end = new Date(windowEnd).getTime();
  const span = durationMinutes * 60_000;
  const sorted = [...busy]
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end))
    .sort((a, b) => a.start - b.start);
  const slots: Array<{ start: string; end: string }> = [];
  let cursor = start;
  for (const b of sorted) {
    while (cursor + span <= Math.min(b.start, end) && slots.length < limit) {
      slots.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + span).toISOString() });
      cursor += span;
    }
    cursor = Math.max(cursor, b.end);
    if (cursor >= end || slots.length >= limit) break;
  }
  while (cursor + span <= end && slots.length < limit) {
    slots.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + span).toISOString() });
    cursor += span;
  }
  return slots;
}

const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), {
  message: "Must be an ISO date/time, e.g. 2026-10-02T16:00:00+05:30",
});

export default defineAction({
  description:
    "Find free time slots on YOUR calendar in a window. Use before calendar.createEvent to propose times. Only your own calendar is checked — attendees' calendars are not visible, so confirm with them before booking.",
  mcpTool: true,
  schema: z.object({
    attendees: calendarAttendees.describe("Invitee emails (noted in output; their calendars are NOT checked)"),
    durationMinutes: z.number().int().min(15).max(480).describe("Meeting length in minutes"),
    windowStart: isoDate.describe("Window start (ISO with offset)"),
    windowEnd: isoDate.describe("Window end (ISO with offset)"),
    timeZone: z.string().min(1).optional().describe("IANA zone, e.g. Asia/Kolkata"),
  }),
  http: { method: "GET" },
  run: async ({ attendees, durationMinutes, windowStart, windowEnd, timeZone }): Promise<ActionResult> => {
    const tz = timeZone ?? defaultTimeZone();
    const res = (await googleFetch(`${CALENDAR_BASE}/freeBusy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timeMin: windowStart,
        timeMax: windowEnd,
        timeZone: tz,
        items: [{ id: "primary" }],
      }),
    })) as { calendars?: { primary?: { busy?: Array<{ start: string; end: string }> } } };
    const busy = res.calendars?.primary?.busy ?? [];
    const slots = freeSlots(busy, windowStart, windowEnd, durationMinutes);
    const data = {
      slots,
      timeZone: tz,
      note:
        attendees.length > 0
          ? `Checked only your calendar (primary); ${attendees.join(", ")}'s calendars are not visible — confirm with them.`
          : "Checked only your calendar (primary).",
    };
    await audit({ actor: "agent", action: "calendar.findFreeSlots", input: { durationMinutes, windowStart, windowEnd }, outcome: { slotCount: slots.length } });
    return { ok: true, data };
  },
});
