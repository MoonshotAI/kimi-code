/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';
import type { ContentPart } from '#human/llm/message';
import type { MessageContent } from '#/agent/prompt/messageContent';

export interface PromptCompletedPayload {
  readonly agentId: string;
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason: 'completed' | 'failed' | 'blocked';
}

const promptCompletedSchema = z.object({
  agentId: z.string(),
  promptId: z.string().min(1),
  finishedAt: z.string(),
  reason: z.union([z.literal('completed'), z.literal('failed'), z.literal('blocked')]),
});

export class PromptCompleted extends AgentEvent2<z.infer<typeof promptCompletedSchema>> {
  static override readonly type = 'prompt.completed';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = promptCompletedSchema;
}
export interface PromptCompleted extends PromptCompletedPayload {}

export interface PromptCompletedEvent {
  readonly type: 'prompt.completed';
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason?: 'completed' | 'failed' | 'blocked';
}

export interface PromptAbortedPayload {
  readonly agentId: string;
  readonly promptId: string;
  readonly abortedAt: string;
}

const promptAbortedSchema = z.object({
  agentId: z.string(),
  promptId: z.string().min(1),
  abortedAt: z.string(),
});

export class PromptAborted extends AgentEvent2<z.infer<typeof promptAbortedSchema>> {
  static override readonly type = 'prompt.aborted';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = promptAbortedSchema;
}
export interface PromptAborted extends PromptAbortedPayload {}

export interface PromptAbortedEvent extends Omit<PromptAbortedPayload, 'agentId'> {
  readonly type: 'prompt.aborted';
}

export interface PromptSubmittedEvent {
  readonly type: 'prompt.submitted';
  readonly promptId: string;
  readonly userMessageId: string;
  readonly status: 'running' | 'queued' | 'blocked';
  readonly content: readonly MessageContent[];
  readonly createdAt: string;
}

export interface PromptSteeredEvent {
  readonly type: 'prompt.steered';
  readonly activePromptId: string;
  readonly promptIds: readonly string[];
  readonly content: readonly MessageContent[];
  readonly steeredAt: string;
}

export interface PromptSteeredPayload {
  readonly agentId: string;
  readonly activePromptId: string;
  readonly promptIds: string[];
  readonly content: ContentPart[];
  readonly steeredAt: string;
}

const promptSteeredSchema = z.object({
  agentId: z.string(),
  activePromptId: z.string(),
  promptIds: z.array(z.string()),
  content: z.custom<ContentPart[]>(),
  steeredAt: z.string(),
});

export class PromptSteered extends AgentEvent2<z.infer<typeof promptSteeredSchema>> {
  static override readonly type = 'prompt.steered';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = promptSteeredSchema;
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

export interface PromptSubmittedPayload {
  readonly agentId: string;
  readonly promptId: string;
  readonly userMessageId: string;
  readonly status: 'running' | 'queued';
  readonly content: ContentPart[];
  readonly createdAt: string;
}

export class PromptSubmitted extends AgentEvent2<PromptSubmittedPayload> {
  static override readonly type = 'prompt.submitted';
  static override readonly observable = true;
}
export interface PromptSubmitted extends PromptSubmittedPayload {}

export interface PromptStartedPayload {
  readonly agentId: string;
  readonly promptId: string;
}

export class PromptStarted extends AgentEvent2<PromptStartedPayload> {
  static override readonly type = 'prompt.started';
  static override readonly observable = true;
}
export interface PromptStarted extends PromptStartedPayload {}

registerEvent2Class(PromptCompleted);
registerEvent2Class(PromptAborted);
registerEvent2Class(PromptSteered);
