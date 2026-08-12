// packages/app-core/src/lib/sessionDisplayStatus.ts
// The session's ONE display status, derived from the raw list/live fields.
// A row expresses a single status at any moment — precedence below decides
// which one; mutually-true facts collapse top-down (a second pending pill
// surfaces once the first resolves). Spec:
// docs/specs/2026-08-11-session-status-and-ordering.md §3.
//
// Consumers: SessionRow (badges / spinner / unread dot), the sidebar's
// attention tiering (flat list and pinned section: `!== 'idle'` floats).
// `renaming` is deliberately NOT an input — hiding the status during inline
// rename is a UI-local concern; callers pass `'idle'` while editing.

export type SessionDisplayStatus =
  /** Pending permission request — warning pill. Wins over question, matching
   *  the server's single-value `pendingInteraction` collapse (both engines:
   *  approval first). */
  | 'awaiting-approval'
  /** Pending askUserQuestion — info pill. */
  | 'awaiting-question'
  /** An active turn and nothing awaiting input — spinner. */
  | 'running'
  /** Quiet session whose last main turn died on an error — danger pill. A
   *  manually stopped turn is the user's own doing and never raises the tag;
   *  the tag is not seen-gated (it rides until a new turn supersedes it). */
  | 'aborted'
  /** A background turn finished here that the user hasn't opened — blue dot. */
  | 'unread'
  /** Nothing to report — the row shows the time. */
  | 'idle';

export interface SessionDisplayStatusInput {
  busy: boolean;
  unread: boolean;
  questionCount: number;
  approvalCount: number;
  /** List-level fallback for the attention pills (details not loaded). */
  pendingInteraction?: 'none' | 'approval' | 'question';
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export function sessionDisplayStatus(input: SessionDisplayStatusInput): SessionDisplayStatus {
  // Detailed counts first — once loaded they are the fresher facts (a locally
  // resolved approval clears its list immediately; the aggregate
  // pendingInteraction can lag or lose its update, and must not keep a dead
  // pill up). The list-level aggregate is only the fallback when neither
  // pending list has content, where it keeps the server's approval-first
  // collapse.
  if (input.approvalCount > 0) return 'awaiting-approval';
  if (input.questionCount > 0) return 'awaiting-question';
  if (input.pendingInteraction === 'approval') return 'awaiting-approval';
  if (input.pendingInteraction === 'question') return 'awaiting-question';
  if (input.busy) return 'running';
  // Below here the session is quiet. A fresh turn clears last_turn_reason
  // server-side, so busy + failed should not co-occur; if they ever do,
  // 'running' above is the truer report.
  if (input.lastTurnReason === 'failed') return 'aborted';
  if (input.unread) return 'unread';
  return 'idle';
}
