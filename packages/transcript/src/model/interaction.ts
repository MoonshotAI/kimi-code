/**
 * TranscriptInteraction — a session-global interaction entity (approval /
 * question).
 *
 * Every interaction is an agent's request issued from inside a step, mediated
 * by a tool call: an approval is the permission gate of the tool call it
 * blocks; a question is emitted mid-run by the AskUserQuestion tool call
 * itself. So `toolCallId` is always present and is the timeline anchor — the
 * interaction renders inline at the linked tool frame
 * (`ToolCallFrame.approvalId` ↔ `toolCallId`), and the owning step is derived
 * transitively through that frame (never denormalized onto the entity).
 *
 * Interactions are still NOT step content: they are resolved asynchronously by
 * user action, possibly long after the originating step flushed, so they live
 * beside `tasks` — global per agent transcript, never paginated. When the
 * anchor frame pages out of the loaded window the entity remains in the
 * global set; it just has no inline position within that window.
 *
 * Plan-mode review is deliberately not special: `ExitPlanMode` flows through
 * the ordinary approval path and the plan card renders from the linked tool
 * frame's `display` payload.
 */

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
   * Always present: approvals gate a tool call; questions are emitted by the
   * AskUserQuestion tool call itself.
   */
  readonly toolCallId: string;
  readonly state: InteractionState;
  /** Open content: engine ApprovalRequest / QuestionRequest payload. */
  readonly request?: unknown;
  /** Open content: engine ApprovalResponse / QuestionResult payload. */
  readonly response?: unknown;
}
