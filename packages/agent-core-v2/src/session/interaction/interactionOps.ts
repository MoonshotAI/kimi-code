/**
 * `interaction` domain — the `interactionKey` state and the durable
 * `interaction.request` (`InteractionRequestEvent`) / `interaction.resolved`
 * (`InteractionResolvedEvent`) events that journal the session's
 * human-in-the-loop lifecycle onto the owning agent's wire.
 *
 * The state is the replayable map of `interactionId -> InteractionRecord`
 * (initial empty): `interaction.request` opens an entry, `interaction.resolved`
 * folds the terminal response into it (a resolution without a known request is
 * a no-op so the state's reference-equality stays quiet). The records exist so
 * a cold transcript fold can rebuild interaction entities (kind, the
 * `toolCallId` timeline anchor lifted from the request payload, the raw
 * request, and the terminal response) straight from the journal; the kernel
 * itself does NOT restore pending promises from them — a request left without
 * a resolution means the process died with it pending and folds as cancelled
 * downstream. The durable classes are the wire-protocol record vocabulary:
 * their `serialize()` output is the on-disk record (flat payload, epoch-ms
 * `time`), byte-compatible with the retired op encoding. These events are
 * dispatched to the ORIGIN agent's dispatcher (`origin.agentId ?? 'main'`), so
 * each record lives in the journal of the agent the interaction belongs to.
 */

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
