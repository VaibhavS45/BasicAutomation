// server/mentions/capabilities.ts  Owner: Vaibhav
// H1: @-mention provider listing the head agent's capability tokens.
// Display only — picking one inserts a reference line; the actual grant for
// the turn is enforced server-side (server/lib/head-agent.ts + grants.ts),
// never by client text. Unknown tokens are rejected politely by planHeadTurn.

import type { MentionProvider } from "@agent-native/core/server";

const CAPABILITIES = [
  {
    id: "cap:gmail",
    label: "@gmail",
    description: "Let the head agent search, read, and draft Gmail this turn (never send)",
    refId: "gmail",
  },
  {
    id: "cap:browser",
    label: "@browser",
    description: "Let the head agent research public web pages this turn (read-only)",
    refId: "browser",
  },
  {
    id: "cap:notion",
    label: "@notion",
    description: "Let the head agent write the report into Notion (proposed first in DRY_RUN)",
    refId: "notion",
  },
] as const;

export const capabilitiesProvider: MentionProvider = {
  label: "Capabilities",
  async search(query: string) {
    const q = query.replace(/^@/, "").toLowerCase();
    return CAPABILITIES.filter(
      (c) => c.label.toLowerCase().includes(q) || c.refId.includes(q),
    ).map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      refType: "capability",
      refId: c.refId,
    }));
  },
};
