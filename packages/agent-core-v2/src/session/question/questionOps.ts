/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { AgentEvent2 } from '#/app/event/event2';

export interface QuestionRequestedPayload {
  readonly agentId: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly action: string;
  readonly toolInput: unknown;
}

export class QuestionRequested extends AgentEvent2<QuestionRequestedPayload> {
  static override readonly type = 'question.requested';
  static override readonly observable = true;
}
export interface QuestionRequested extends QuestionRequestedPayload {}

export interface QuestionResolvedPayload extends QuestionRequestedPayload {
  readonly decision: 'answered' | 'dismissed' | 'error';
  readonly error?: string;
}

export class QuestionResolved extends AgentEvent2<QuestionResolvedPayload> {
  static override readonly type = 'question.resolved';
  static override readonly observable = true;
}
export interface QuestionResolved extends QuestionResolvedPayload {}
