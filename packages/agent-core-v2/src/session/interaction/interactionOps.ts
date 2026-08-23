/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';

import type { InteractionKind } from './interaction';

export interface InteractionRecord {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly toolCallId?: string;
  readonly agentId: string;
  readonly request: unknown;
  readonly resolved: boolean;
  readonly response?: unknown;
}

export type InteractionModelState = Map<string, InteractionRecord>;

const interactionRequestSchema = z.object({
  agentId: z.string(),
  id: z.string(),
  kind: z.enum(['approval', 'question', 'user_tool']),
  toolCallId: z.string().optional(),
  request: z.unknown(),
});

export class InteractionRequestEvent extends AgentEvent2<
  z.infer<typeof interactionRequestSchema>
> {
  static override readonly type = 'interaction.request';
  static override readonly durable = true;
  static override readonly schema = interactionRequestSchema;
}
export interface InteractionRequestEvent {
  readonly agentId: string;
  readonly id: string;
  readonly kind: InteractionKind;
  readonly toolCallId?: string;
  readonly request: unknown;
}

const interactionResolvedSchema = z.object({
  agentId: z.string(),
  id: z.string(),
  response: z.unknown(),
});

export class InteractionResolvedEvent extends AgentEvent2<
  z.infer<typeof interactionResolvedSchema>
> {
  static override readonly type = 'interaction.resolved';
  static override readonly durable = true;
  static override readonly schema = interactionResolvedSchema;
}
export interface InteractionResolvedEvent {
  readonly agentId: string;
  readonly id: string;
  readonly response: unknown;
}
