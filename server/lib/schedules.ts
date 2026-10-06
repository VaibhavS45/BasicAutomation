// server/lib/schedules.ts  Owner: Vaibhav (H7c)
// "Run this prompt every weekday 8am" on the framework's recurring-jobs:
// schedules are jobs/<name>.md resources (cron + body prompt) that the
// framework scheduler picks up — no parallel runner here.
//
// Scheduled runs default to DRY_RUN until the user flips a per-schedule
// toggle (schedules.setDryRun): the file carries `dryRun:` frontmatter plus
// a DRY_RUN banner at the top of the body. The banner IS the enforcement —
// the scheduler runs the body as a prompt, so a dryRun:true run proposes
// writes instead of performing them. List / pause / delete UI is the
// framework's Automations surface (AgentJobsTab); no new UI here.

export const SCHEDULE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
export const DRY_RUN_BANNER =
  "> DRY_RUN is ON for this schedule: investigate, draft, and propose. Do not send, post, book, or mutate anything.";

const DAY_NUM: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function parseHour(hour: string, minute: string | undefined, mer: string | undefined): { h: number; m: number } {
  let h = Number.parseInt(hour, 10);
  const m = minute === undefined ? 0 : Number.parseInt(minute, 10);
  if (!Number.isInteger(h) || h > 23 || !Number.isInteger(m) || m > 59) {
    throw new Error(`Bad time in schedule phrase (hour 0-23, minute 0-59).`);
  }
  if (mer) {
    if (h < 1 || h > 12) throw new Error(`Bad time in schedule phrase (1-12 with am/pm).`);
    if (mer === "pm" && h !== 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
  }
  return { h, m };
}

/**
 * "every weekday 8am" -> { cron: "0 8 * * 1-5", description }. Also accepts
 * a raw 5-field cron (validated by the framework's isValidCron). Throws with
 * examples when the phrase is not understood.
 */
export async function parseSchedulePhrase(
  phrase: string,
  isValidCron: (cron: string) => boolean,
): Promise<{ cron: string; description: string }> {
  const raw = phrase.trim().toLowerCase();
  if (isValidCron(raw)) return { cron: raw, description: `cron ${raw}` };

  const timeAfter = (idx: number) => {
    const tail = raw.slice(idx).match(/^\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (!tail) return null;
    return parseHour(tail[1], tail[2], tail[3]);
  };
  const fmt = (h: number, m: number) => `${h}:${String(m).padStart(2, "0")}`;

  if (/every hour/.test(raw)) return { cron: "0 * * * *", description: "every hour" };

  const weekdayAt = raw.search(/every weekday|weekdays/);
  if (weekdayAt >= 0) {
    const end = raw.match(/every weekday|weekdays/)![0].length + weekdayAt;
    const t = timeAfter(end);
    if (!t) throw new Error(`"every weekday 8am" needs a time, e.g. "every weekday 8am".`);
    return { cron: `${t.m} ${t.h} * * 1-5`, description: `weekdays at ${fmt(t.h, t.m)}` };
  }

  const dailyAt = raw.search(/every day|daily|every morning/);
  if (dailyAt >= 0) {
    const end = raw.match(/every day|daily|every morning/)![0].length + dailyAt;
    const t = timeAfter(end);
    if (!t) throw new Error(`"daily" needs a time, e.g. "every day 7am".`);
    return { cron: `${t.m} ${t.h} * * *`, description: `daily at ${fmt(t.h, t.m)}` };
  }

  const dayName = raw.match(/every (sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (dayName) {
    const t = timeAfter((dayName.index ?? 0) + dayName[0].length);
    if (!t) throw new Error(`"every ${dayName[1]}" needs a time, e.g. "every monday 9am".`);
    return {
      cron: `${t.m} ${t.h} * * ${DAY_NUM[dayName[1]]}`,
      description: `every ${dayName[1]} at ${fmt(t.h, t.m)}`,
    };
  }

  throw new Error(
    `I don't understand "${phrase}" as a schedule. Try "every weekday 8am", "every day 7am", "every monday 9am", "every hour", or a cron like "0 8 * * 1-5".`,
  );
}

export function validateScheduleName(name: string): void {
  if (!SCHEDULE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid schedule name "${name}": lowercase letters, digits, dashes, 2-61 chars.`,
    );
  }
}

export function schedulePath(name: string): string {
  validateScheduleName(name);
  return `jobs/${name}.md`;
}

/** Render the jobs/*.md file: frontmatter schedule + dryRun flag + bannered body. */
export function buildScheduleFile(input: { cron: string; prompt: string; dryRun: boolean }): string {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("A schedule needs a prompt.");
  const body = input.dryRun ? `${DRY_RUN_BANNER}\n\n${prompt}` : prompt;
  return `---\nschedule: "${input.cron}"\nenabled: true\ndryRun: ${input.dryRun}\n---\n\n${body}\n`;
}

/** Flip the per-schedule DRY_RUN toggle: frontmatter flag + body banner, together. */
export function setDryRunOnContent(content: string, dryRun: boolean): string {
  if (!/^---\n[\s\S]*?\n---/.test(content)) {
    throw new Error("Not a schedule file (missing frontmatter).");
  }
  let next = content.replace(/^dryRun:.*$/m, `dryRun: ${dryRun}`);
  if (!/^dryRun:/m.test(next)) {
    next = next.replace(/^---\n/, `---\ndryRun: ${dryRun}\n`);
  }
  const bannerRe = /^> DRY_RUN is ON for this schedule.*\n\n?/m;
  next = next.replace(bannerRe, "");
  if (dryRun) {
    next = next.replace(/^(---\n[\s\S]*?\n---\n\n?)/, `$1${DRY_RUN_BANNER}\n\n`);
  }
  return next;
}
