// server/triggers/calendar.ts  Owner: Vaibhav (Phase V-6)
// Calendar research poller: lists upcoming events, emits ONE TriggerEvent per
// calendar event whose title/description carries a [research] marker.
// Idempotency is two-layered: the engine dedupes by event.id
// ("calendar:<eventId>") and runResearchPort dedupes the file/Notion output,
// so reruns and crash replays never duplicate.
//
// No I/O in mapCalendarEventToTrigger (unit-tested with plain objects); the
// poller itself takes an injectable listFn so tests never touch Google.
import { CALENDAR_BASE, googleFetch } from "../lib/google-auth.js";
import { parseResearchTopic, RESEARCH_EVENT_TYPE } from "../lib/research.js";
import type { EmitTrigger, TriggerEvent } from "../lib/types.js";

export interface CalendarEventInput {
  id: string;
  summary?: string;
  description?: string;
  start?: string;
  htmlLink?: string;
  creator?: string;
}

export interface CalendarPollSummary {
  scanned: number;
  emitted: number;
  skipped: string[];
  errors: string[];
}

/** Pure mapper: research-marked events become TriggerEvents, the rest drop. */
export function mapCalendarEventToTrigger(
  cal: CalendarEventInput,
  receivedAt = new Date().toISOString(),
): { emit: boolean; event?: TriggerEvent; topic?: string; reason?: string } {
  if (!cal.id) return { emit: false, reason: "missing calendar event id" };
  const summary = cal.summary ?? "(no title)";
  const topic = parseResearchTopic({ summary, description: cal.description });
  if (!topic) return { emit: false, reason: `no [research] marker in ${cal.id}` };
  const event: TriggerEvent = {
    id: `calendar:${cal.id}`,
    source: "calendar",
    type: RESEARCH_EVENT_TYPE,
    receivedAt,
    actor: cal.creator,
    summary: summary.slice(0, 200),
    payload: {
      calendarEventId: cal.id,
      topic,
      title: summary,
      description: cal.description ?? "",
      start: cal.start ?? "",
      htmlLink: cal.htmlLink ?? "",
    },
    untrusted: true,
  };
  return { emit: true, event, topic };
}

export interface CalendarPollDeps {
  listFn?: () => Promise<{ items?: CalendarEventInput[] }>;
}

function pollSeconds(): number {
  const raw = Number.parseInt(process.env.CALENDAR_RESEARCH_POLL_SECONDS ?? "", 10); // guard:allow-env-credential — deploy default from env.ts; process.env read is the test-isolation override
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

/** One poll cycle. Exported so tests drive it without a timer. */
export async function pollCalendarResearchOnce(
  emit: EmitTrigger,
  deps: CalendarPollDeps = {},
): Promise<CalendarPollSummary> {
  const summary: CalendarPollSummary = { scanned: 0, emitted: 0, skipped: [], errors: [] };
  let listing: { items?: CalendarEventInput[] };
  try {
    if (deps.listFn) {
      listing = await deps.listFn();
    } else {
      listing = (await googleFetch(
        `${CALENDAR_BASE}/calendars/primary/events?timeMin=${encodeURIComponent(new Date().toISOString())}` +
          `&maxResults=50&singleEvents=true&orderBy=startTime`,
      )) as { items?: CalendarEventInput[] };
    }
  } catch (err) {
    summary.errors.push(err instanceof Error ? err.message : String(err));
    return summary;
  }
  for (const item of listing.items ?? []) {
    summary.scanned += 1;
    const mapped = mapCalendarEventToTrigger(item);
    if (!mapped.emit || !mapped.event) {
      summary.skipped.push(`${item.id || "?"}: ${mapped.reason ?? "not research"}`);
      continue;
    }
    try {
      await emit(mapped.event);
      summary.emitted += 1;
      console.log(`[calendar-trigger] emitted ${mapped.event.id} (research: ${mapped.topic})`);
    } catch (err) {
      summary.errors.push(`${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}

export interface CalendarTriggerHandle {
  pollNow: () => Promise<CalendarPollSummary>;
  stop: () => void;
}

/** Interval poller (mirrors the gmail trigger handle shape). */
export async function startCalendarResearchTrigger(
  emit: EmitTrigger,
): Promise<CalendarTriggerHandle> {
  let running = false;
  let stopped = false;
  const pollNow = async (): Promise<CalendarPollSummary> => {
    if (running || stopped) {
      return { scanned: 0, emitted: 0, skipped: ["skipped: a poll is already running"], errors: [] };
    }
    running = true;
    try {
      return await pollCalendarResearchOnce(emit);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void pollNow().catch((err: unknown) => {
      console.error(
        `[calendar-trigger] poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, pollSeconds() * 1000);
  timer.unref();
  return { pollNow, stop: () => { stopped = true; clearInterval(timer); } };
}
