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
  readonly toolCallId?: string;
  readonly state: InteractionState;
  readonly request?: unknown;
  readonly response?: unknown;
}
