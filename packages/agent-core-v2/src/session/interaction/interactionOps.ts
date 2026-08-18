/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { InteractionKind } from './interaction';

export interface InteractionRecord {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly toolCallId?: string;
  readonly agentId?: string;
  readonly request: unknown;
  readonly resolved: boolean;
  readonly response?: unknown;
}

export type InteractionModelState = Map<string, InteractionRecord>;

const interactionRequestSchema = z.object({
  id: z.string(),
  kind: z.enum(['approval', 'question', 'user_tool']),
  toolCallId: z.string().optional(),
  agentId: z.string().optional(),
  request: z.unknown(),
});

export class InteractionRequestEvent extends Event2<z.infer<typeof interactionRequestSchema>> {
  static override readonly type = 'interaction.request';
  static override readonly durable = true;
  static override readonly schema = interactionRequestSchema;
}
export interface InteractionRequestEvent extends z.infer<typeof interactionRequestSchema> {}

const interactionResolvedSchema = z.object({
  id: z.string(),
  response: z.unknown(),
});

export class InteractionResolvedEvent extends Event2<z.infer<typeof interactionResolvedSchema>> {
  static override readonly type = 'interaction.resolved';
  static override readonly durable = true;
  static override readonly schema = interactionResolvedSchema;
}
export interface InteractionResolvedEvent extends z.infer<typeof interactionResolvedSchema> {}

export const interactionKey = defineState(
  'interaction',
  (): InteractionModelState => new Map(),
).replayable({ schema: z.custom<InteractionModelState>() })
  .on(InteractionRequestEvent, (s, e) => {
    s.set(e.id, {
      id: e.id,
      kind: e.kind,
      toolCallId: e.toolCallId,
      agentId: e.agentId,
      request: e.request,
      resolved: false,
    });
  })
  .on(InteractionResolvedEvent, (s, e) => {
    const existing = s.get(e.id);
    if (existing === undefined) return;
    s.set(e.id, { ...existing, resolved: true, response: e.response });
  });
