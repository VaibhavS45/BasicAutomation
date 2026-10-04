// server/triggers/gmail.ts  Owner: Yashwanth
// Polls Gmail history for new INBOX mail and emits TriggerEvents. Vaibhav's
// engine.ts dedupes by event.id, so re-emitting after a crash is harmless.
// Only the allowlist + GMAIL_TRIGGER_LABEL pass; the message body is never put
// in the event (the agent calls gmail.read when it actually needs the text).
import { promises as fs } from "node:fs";
import path from "node:path";
import { env, triggerEmailAllowlist } from "../lib/env.js";
import { audit } from "../lib/audit.js";
import { GoogleApiError, GMAIL_BASE, googleFetch } from "../lib/google-auth.js";
import type { EmitTrigger, TriggerEvent } from "../lib/types.js";

export interface PollSummary {
  historyId: string | null;
  historyIdReset: boolean;
  scanned: number;
  emitted: number;
  skipped: string[];
  errors: string[];
}

export interface GmailTriggerHandle {
  pollNow: () => Promise<PollSummary>;
  stop: () => void;
}

// --- state (historyId survives restarts) ---

function stateFile(): string {
  return path.join(process.env.DATA_DIR ?? env.DATA_DIR, "triggers", "gmail-state.json");
}

async function loadState(): Promise<{ historyId: string | null }> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(), "utf8")) as {
      historyId?: string;
    };
    return { historyId: parsed.historyId ?? null };
  } catch {
    return { historyId: null };
  }
}

async function saveState(historyId: string): Promise<void> {
  const file = stateFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ historyId }), { mode: 0o600 });
}

function pollSeconds(): number {
  const raw = Number.parseInt(process.env.GMAIL_POLL_SECONDS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

/** Required label; unset means nothing matches rather than everything matching. */
function requiredLabel(): string | null {
  const label = process.env.GMAIL_TRIGGER_LABEL?.trim();
  return label ? label : null;
}

interface HistoryEntry {
  messagesAdded?: Array<{ message?: { id?: string } }>;
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

function header(msg: GmailMessage, name: string): string {
  const wanted = name.toLowerCase();
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === wanted)?.value ?? "";
}

/** "Bob" <bob@x.com> -> bob@x.com */
export function senderAddress(from: string): string {
  const angled = from.match(/<([^>]+)>/);
  return (angled?.[1] ?? from).trim().toLowerCase();
}

/** First run seeds the cursor from the profile; there is nothing to replay yet. */
async function profileHistoryId(): Promise<string> {
  const profile = (await googleFetch(`${GMAIL_BASE}/profile`)) as { historyId?: string };
  if (!profile.historyId) throw new Error("Gmail profile has no historyId.");
  return profile.historyId;
}

/** One poll cycle. Exported so tests can drive it without a timer. */
export async function pollGmailOnce(emit: EmitTrigger): Promise<PollSummary> {
  const label = requiredLabel();
  const allowlist = triggerEmailAllowlist();
  const summary: PollSummary = {
    historyId: null,
    historyIdReset: false,
    scanned: 0,
    emitted: 0,
    skipped: [],
    errors: [],
  };
  if (!label) {
    summary.errors.push("GMAIL_TRIGGER_LABEL is not set — no message can match.");
    return summary;
  }

  const { historyId } = await loadState();
  if (!historyId) {
    const fresh = await profileHistoryId();
    await saveState(fresh);
    console.log(
      `[gmail-trigger] seeded historyId=${fresh}; watching for new mail labelled ${label}`,
    );
    return { ...summary, historyId: fresh };
  }
  summary.historyId = historyId;

  let history: { historyId?: string; history?: HistoryEntry[] };
  try {
    history = (await googleFetch(
      `${GMAIL_BASE}/history?startHistoryId=${encodeURIComponent(historyId)}` +
        `&historyTypes=messageAdded&labelId=INBOX&maxResults=100`,
    )) as { historyId?: string; history?: HistoryEntry[] };
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) {
      // The cursor aged out of Gmail's history window. Start over from now and
      // say so loudly — anything older than the window is simply not replayed.
      const fresh = await profileHistoryId();
      await saveState(fresh);
      summary.historyIdReset = true;
      summary.historyId = fresh;
      summary.errors.push(
        `historyId ${historyId} expired (404). Reset to ${fresh}; mail older than the history window was not replayed.`,
      );
      await audit({
        actor: "gmail-trigger",
        action: "gmail.historyIdReset",
        input: { previousHistoryId: historyId },
        outcome: { historyId: fresh },
      });
      return summary;
    }
    throw err;
  }

  // Advance the cursor before emitting: a crash mid-loop then re-reads at most
  // this window, and the engine's persistent dedupe drops the repeats.
  const nextHistoryId = history.historyId;
  if (nextHistoryId && nextHistoryId !== historyId) await saveState(nextHistoryId);

  const seen = new Set<string>();
  for (const h of history.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      if (added.message?.id) seen.add(added.message.id);
    }
  }

  for (const messageId of seen) {
    summary.scanned += 1;
    try {
      const msg = (await googleFetch(
        `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=metadata` +
          `&metadataHeaders=From&metadataHeaders=Subject`,
      )) as GmailMessage;
      const from = header(msg, "From");
      const address = senderAddress(from);
      if (!allowlist.includes(address)) {
        summary.skipped.push(`${messageId}: sender ${address} not in TRIGGER_EMAIL_ALLOWLIST`);
        continue;
      }
      if (!(msg.labelIds ?? []).includes(label)) {
        summary.skipped.push(`${messageId}: missing label ${label}`);
        continue;
      }
      const subject = header(msg, "Subject");
      const event: TriggerEvent = {
        id: `gmail:${messageId}`,
        source: "gmail",
        type: "email.received",
        receivedAt: new Date(Number(msg.internalDate) || Date.now()).toISOString(),
        actor: address,
        summary: subject || "(no subject)",
        // Metadata only. The agent calls gmail.read for the body.
        payload: {
          messageId,
          threadId: msg.threadId,
          from,
          subject,
          snippet: msg.snippet ?? "",
        },
        untrusted: true,
      };
      await emit(event);
      summary.emitted += 1;
      console.log(`[gmail-trigger] emitted ${event.id} (${event.summary})`);
    } catch (err) {
      summary.errors.push(`${messageId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}

/**
 * Start polling every GMAIL_POLL_SECONDS. Returns a handle so callers (and
 * tests) can stop it; nothing is scheduled twice if a poll is still running.
 */
export async function startGmailTrigger(emit: EmitTrigger): Promise<GmailTriggerHandle> {
  let running = false;
  let stopped = false;

  const pollNow = async (): Promise<PollSummary> => {
    if (running || stopped) {
      return {
        historyId: null,
        historyIdReset: false,
        scanned: 0,
        emitted: 0,
        skipped: ["skipped: a poll is already running"],
        errors: [],
      };
    }
    running = true;
    try {
      return await pollGmailOnce(emit);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void pollNow().catch((err: unknown) => {
      console.error(
        `[gmail-trigger] poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, pollSeconds() * 1000);
  timer.unref();

  return {
    pollNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}