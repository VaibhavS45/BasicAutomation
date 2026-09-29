interface RequireApprovalInput {
  action: string;
  summary: string;
  payload?: unknown;
}

// Phase 0 stub: always approves when DRY_RUN would block real writes downstream.
// Phase 1 will persist pending approvals in DATA_DIR, surface a UI card,
// expire after 15 min, and honor deny/expire with { approved: false }.
export async function requireApproval(
  input: RequireApprovalInput,
): Promise<{ approved: boolean; reason?: string }> {
  console.log(`[approvals-stub] requireApproval: ${input.action} — ${input.summary}`);
  return { approved: true };
}
