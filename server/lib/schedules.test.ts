import { isValidCron } from "@agent-native/core/jobs";
import { describe, expect, it } from "vitest";
import {
  buildScheduleFile,
  parseSchedulePhrase,
  setDryRunOnContent,
  validateScheduleName,
} from "./schedules.js";

describe("parseSchedulePhrase", () => {
  it("maps weekday/morning phrases to cron", async () => {
    await expect(parseSchedulePhrase("run this prompt every weekday 8am", isValidCron)).resolves.toEqual({
      cron: "0 8 * * 1-5",
      description: "weekdays at 8:00",
    });
    await expect(parseSchedulePhrase("every day 7am", isValidCron)).resolves.toEqual({
      cron: "0 7 * * *",
      description: "daily at 7:00",
    });
    await expect(parseSchedulePhrase("every monday 9:30am", isValidCron)).resolves.toEqual({
      cron: "30 9 * * 1",
      description: "every monday at 9:30",
    });
    await expect(parseSchedulePhrase("every hour", isValidCron)).resolves.toEqual({
      cron: "0 * * * *",
      description: "every hour",
    });
    await expect(parseSchedulePhrase("0 8 * * 1-5", isValidCron)).resolves.toEqual({
      cron: "0 8 * * 1-5",
      description: "cron 0 8 * * 1-5",
    });
  });

  it("rejects unknown phrases with examples", async () => {
    await expect(parseSchedulePhrase("whenever", isValidCron)).rejects.toThrow(/every weekday 8am/);
    await expect(parseSchedulePhrase("every weekday", isValidCron)).rejects.toThrow(/needs a time/);
  });

  it("rejects bad names and empty prompts", () => {
    expect(() => validateScheduleName("Weekday")).toThrow();
    expect(() => buildScheduleFile({ cron: "0 8 * * 1-5", prompt: "  ", dryRun: true })).toThrow();
  });
});

describe("DRY_RUN default + toggle", () => {
  const prompt = "Summarise overnight email.";
  it("new schedules carry dryRun:true and the banner", () => {
    const file = buildScheduleFile({ cron: "0 8 * * 1-5", prompt, dryRun: true });
    expect(file).toContain("dryRun: true");
    expect(file).toContain("DRY_RUN is ON");
  });

  it("the toggle flips flag and banner together, both ways", () => {
    const on = buildScheduleFile({ cron: "0 8 * * 1-5", prompt, dryRun: true });
    const off = setDryRunOnContent(on, false);
    expect(off).toContain("dryRun: false");
    expect(off).not.toContain("DRY_RUN is ON");
    expect(off).toContain(prompt);
    const backOn = setDryRunOnContent(off, true);
    expect(backOn).toContain("dryRun: true");
    expect(backOn).toContain("DRY_RUN is ON");
  });
});
