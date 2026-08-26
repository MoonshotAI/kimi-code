/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { ContentPart } from '#/kosong/contract/message';

import { AgentEvent2 } from '#/app/event/event2';

export interface PromptCompletedPayload {
  readonly agentId: string;
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason: 'completed' | 'failed' | 'blocked';
}

export class PromptCompleted extends AgentEvent2<PromptCompletedPayload> {
  static override readonly type = 'prompt.completed';
  static override readonly observable = true;
}
export interface PromptCompleted extends PromptCompletedPayload {}

export interface PromptAbortedPayload {
  readonly agentId: string;
  readonly promptId: string;
  readonly abortedAt: string;
}

export class PromptAborted extends AgentEvent2<PromptAbortedPayload> {
  static override readonly type = 'prompt.aborted';
  static override readonly observable = true;
}
export interface PromptAborted extends PromptAbortedPayload {}

export interface PromptSteeredPayload {
  readonly agentId: string;
  readonly activePromptId: string;
  readonly promptIds: string[];
  readonly content: ContentPart[];
  readonly steeredAt: string;
}

export class PromptSteered extends AgentEvent2<PromptSteeredPayload> {
  static override readonly type = 'prompt.steered';
  static override readonly observable = true;
}
export interface PromptSteered extends PromptSteeredPayload {}

export interface PromptQueuedPayload {
  readonly agentId: string;
  readonly promptId: string;
  readonly content: ContentPart[];
  readonly queueLength: number;
}

export class PromptQueued extends AgentEvent2<PromptQueuedPayload> {
  static override readonly type = 'prompt.queued';
  static override readonly observable = true;
}
export interface PromptQueued extends PromptQueuedPayload {}
