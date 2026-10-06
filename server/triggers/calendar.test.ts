// server/triggers/calendar.test.ts — V-6: only [research] events emit.
import { describe, expect, it } from "vitest";
import { mapCalendarEventToTrigger, pollCalendarResearchOnce } from "./calendar.js";
import type { TriggerEvent } from "../lib/types.js";

describe("mapCalendarEventToTrigger", () => {
  it("emits a research event for [research] titles", () => {
    const mapped = mapCalendarEventToTrigger({ id: "evt1", summary: "[research] pgvector vs qdrant" });
    expect(mapped.emit).toBe(true);
    expect(mapped.event?.id).toBe("calendar:evt1");
    expect(mapped.event?.type).toBe("calendar.research.requested");
    expect(mapped.event?.untrusted).toBe(true);
  });

  it("drops events without a marker, with a reason", () => {
    expect(mapCalendarEventToTrigger({ id: "evt2", summary: "standup" }).emit).toBe(false);
    expect(mapCalendarEventToTrigger({ id: "", summary: "[research] x" }).emit).toBe(false);
  });
});

describe("pollCalendarResearchOnce", () => {
  it("emits once per research event and skips the rest", async () => {
    const emitted: TriggerEvent[] = [];
    const summary = await pollCalendarResearchOnce(
      async (e) => { emitted.push(e); },
      {
        listFn: async () => ({
          items: [
            { id: "a", summary: "[research] topic A" },
            { id: "b", summary: "lunch" },
          ],
        }),
      },
    );
    expect(summary).toMatchObject({ scanned: 2, emitted: 1 });
    expect(emitted.map((e) => e.id)).toEqual(["calendar:a"]);
  });
});
