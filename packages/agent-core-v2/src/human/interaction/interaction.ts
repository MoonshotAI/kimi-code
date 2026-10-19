export type InteractionKind = 'approval' | 'question' | 'user_tool';

export type InteractionTagValue = string | number;

export type InteractionTags = Record<string, InteractionTagValue>;

export const INTERACTION_TAG_AGENT_ID = 'agentId';
export const INTERACTION_TAG_SESSION_ID = 'sessionId';
export const INTERACTION_TAG_TURN_ID = 'turnId';
export const INTERACTION_TAG_TOOL_CALL_ID = 'toolCallId';

export interface InteractionRequest<TPayload = unknown> {
  readonly id?: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly tags?: InteractionTags;
}

export interface Interaction<TPayload = unknown> {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly tags: InteractionTags;
  readonly createdAt: number;
}

export type InteractionCancellationReason = 'turn_ended' | 'agent_closed';

export interface InteractionCancellation {
  readonly cancelled: true;
  readonly reason: InteractionCancellationReason;
}

export function isInteractionCancellation(response: unknown): response is InteractionCancellation {
  if (typeof response !== 'object' || response === null) return false;
  const value = response as { readonly cancelled?: unknown; readonly reason?: unknown };
  return value.cancelled === true && (value.reason === 'turn_ended' || value.reason === 'agent_closed');
}

export interface InteractionResolution {
  readonly id: string;
  readonly response: unknown;
}

export interface InteractionPendingChangedEvent {
  readonly pending: readonly string[];
}

export interface InteractionQuery {
  readonly id?: string;
  readonly kind?: InteractionKind;
  readonly resolved?: boolean;
  readonly tags?: InteractionTags;
}
