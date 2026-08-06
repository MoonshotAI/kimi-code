// apps/web/src/components/sessionRowStatus.ts
// Status derivation for SessionRow. Grouped/pinned rows use only the badge
// flags (their status lives in the leading slot, the time always renders);
// the flat variant (sidebar flat list) uses the full result: the right side
// of the first line shows status INSTEAD of the time, and the running spinner
// yields to the attention pills — a session waiting for approval/answer never
// shows a pill and the spinner side by side.

export interface SessionRowStatusInput {
  busy: boolean;
  unread: boolean;
  renaming: boolean;
  questionCount: number;
  approvalCount: number;
  pendingInteraction?: 'none' | 'approval' | 'question';
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export interface SessionRowStatus {
  showQuestionBadge: boolean;
  showApprovalBadge: boolean;
  showAbortedBadge: boolean;
  /** busy AND no attention pill up (approval/question) — the pill is the
   *  status then, so the spinner would be redundant. */
  showBusySpinner: boolean;
  /** Flat variant: anything to report on the right (suppresses the time). */
  hasStatus: boolean;
}

export function sessionRowStatus(input: SessionRowStatusInput): SessionRowStatus {
  const showQuestionBadge =
    !input.renaming &&
    (input.questionCount > 0 || input.pendingInteraction === 'question');
  const showApprovalBadge =
    !input.renaming &&
    (input.approvalCount > 0 || input.pendingInteraction === 'approval');
  // Aborted: quiet session whose last main turn died on an error; a manually
  // stopped turn is the user's own doing and never raises the tag. Hidden
  // while input is pending (the awaiting pills own the row then).
  const showAbortedBadge =
    !input.renaming &&
    !input.busy &&
    input.pendingInteraction !== 'question' &&
    input.pendingInteraction !== 'approval' &&
    input.questionCount === 0 &&
    input.approvalCount === 0 &&
    input.lastTurnReason === 'failed';
  const showBusySpinner = input.busy && !showQuestionBadge && !showApprovalBadge;
  const hasStatus =
    input.busy ||
    input.unread ||
    showQuestionBadge ||
    showApprovalBadge ||
    showAbortedBadge;
  return { showQuestionBadge, showApprovalBadge, showAbortedBadge, showBusySpinner, hasStatus };
}
