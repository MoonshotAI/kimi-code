import type { InteractionId } from './ids';

export type InteractionKind = 'approval' | 'question';

export type InteractionState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'answered'
  | 'dismissed';

export interface TranscriptInteraction {
  readonly interactionId: InteractionId;
  readonly interactionKind: InteractionKind;
  /**
   * The tool call this interaction was issued from — the timeline anchor.
   * Present for the common case (approvals gate a tool call; questions are
   * emitted by the AskUserQuestion tool call itself). Absent means the
   * interaction is unanchored and renders floating rather than inline.
   */
  readonly toolCallId?: string;
  readonly state: InteractionState;
  /** Open content: engine ApprovalRequest / QuestionRequest payload. */
  readonly request?: unknown;
  /** Open content: engine ApprovalResponse / QuestionResult payload. */
  readonly response?: unknown;
}
