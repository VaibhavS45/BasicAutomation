// server/triggers/grants.ts  Owner: Vaibhav
// Per-trigger tool grants. Deny by default: a playbook may call ONLY the
// tools listed here. Adapted from openmausbot-extract/tool-grants.ts
// (OpenMausBot per-bot grant idea); Composio slugs marked VERIFY until
// confirmed via connectors.listTools.

export const READ_ONLY = {
  gmail: ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"], // VERIFY
  drive: ["GOOGLEDRIVE_FIND_FILE"], // VERIFY
  calendar: ["GOOGLECALENDAR_FIND_FREE_SLOTS", "GOOGLECALENDAR_EVENTS_LIST"], // VERIFY
  github: [
    "GITHUB_GET_AN_ISSUE",
    "GITHUB_GET_A_PULL_REQUEST",
    "GITHUB_LIST_PULL_REQUESTS_FILES",
  ], // VERIFY
} as const;

export const WRITE_NEEDS_APPROVAL = {
  gmailSend: ["GMAIL_SEND_EMAIL"], // confirmed name
  gmailDraft: ["GMAIL_CREATE_EMAIL_DRAFT"], // VERIFY
  calendarCreate: ["GOOGLECALENDAR_CREATE_EVENT"], // VERIFY (must support Meet link creation)
  githubComment: ["GITHUB_CREATE_AN_ISSUE_COMMENT"], // VERIFY
  githubReview: ["GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST"], // VERIFY - never APPROVE
} as const;

// Custom (non-Composio) actions we write ourselves. These are defineAction
// names as the agent sees them.
export const CUSTOM_ACTIONS = {
  searchWeb: "search.web",
  searchFetchPage: "search.fetchPage",
  meetingsScheduleAndNotify: "meetings.scheduleAndNotify",
} as const;

export interface PlaybookGrant {
  composio: string[];
  custom: string[];
}

/**
 * Which tools each trigger playbook may call. Least privilege:
 * - A GitHub-triggered run NEVER gets gmail/whatsapp send.
 * - An email-triggered run NEVER gets GitHub write actions.
 * - Raw Composio write slugs are NOT granted to playbooks; only our
 *   approval-gated wrappers are reachable (wrappers themselves call Composio).
 *   The raw slug lists below stay for reference/verification and for the
 *   boundary check in tests; playbooks resolve to `custom` + read slugs.
 */
export const PLAYBOOK_GRANTS: Record<string, PlaybookGrant> = {
  "email.received": {
    composio: [
      ...READ_ONLY.gmail,
      ...READ_ONLY.drive,
      ...READ_ONLY.calendar,
      ...WRITE_NEEDS_APPROVAL.gmailDraft,
    ],
    custom: [
      CUSTOM_ACTIONS.searchWeb,
      CUSTOM_ACTIONS.searchFetchPage,
      CUSTOM_ACTIONS.meetingsScheduleAndNotify,
    ],
  },
  "github.issue.opened": {
    composio: [...READ_ONLY.github, ...WRITE_NEEDS_APPROVAL.githubComment],
    custom: [CUSTOM_ACTIONS.searchWeb, CUSTOM_ACTIONS.searchFetchPage],
  },
  "github.pr.opened": {
    composio: [...READ_ONLY.github, ...WRITE_NEEDS_APPROVAL.githubReview],
    custom: [],
  },
  "github.pr.review_requested": {
    composio: [...READ_ONLY.github, ...WRITE_NEEDS_APPROVAL.githubReview],
    custom: [],
  },
  "github.issue_comment.created": {
    composio: [...READ_ONLY.github, ...WRITE_NEEDS_APPROVAL.githubComment],
    custom: [CUSTOM_ACTIONS.searchWeb],
  },
};

/** Flat allowlist for a playbook (composio slugs + custom action names). */
export function allowedToolsFor(playbook: string): string[] {
  const g = PLAYBOOK_GRANTS[playbook];
  if (!g) return [];
  return [...g.composio, ...g.custom];
}

/** Boundary check: is `tool` callable from `playbook`? Deny by default. */
export function isAllowed(playbook: string, tool: string): boolean {
  const g = PLAYBOOK_GRANTS[playbook];
  if (!g) return false;
  return g.composio.includes(tool) || g.custom.includes(tool);
}

/**
 * Enforce the boundary. Throws when the tool is outside the playbook grant,
 * even if the request originated from untrusted event payload text
 * (prompt-injection strings never widen access — only this static table does).
 */
export function assertToolAllowed(playbook: string, tool: string): void {
  if (!isAllowed(playbook, tool)) {
    throw new Error(
      `Tool "${tool}" is not granted to playbook "${playbook}" (deny by default).`,
    );
  }
}
