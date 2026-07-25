/**
 * `interaction` domain (L6) — wire Model (`InteractionModel`) and the
 * persisted `interaction.request` (`interactionRequest`) /
 * `interaction.resolved` (`interactionResolved`) Ops that journal the
 * session's human-in-the-loop lifecycle onto the owning agent's wire.
 *
 * The Model is the replayable map of `interactionId -> InteractionRecord`
 * (initial empty): `interaction.request` opens an entry, `interaction.resolved`
 * folds the terminal response into it (a resolution without a known request is
 * a no-op so the wire's reference-equality gate stays quiet). The records exist
 * so a cold transcript fold can rebuild interaction entities (kind, the
 * `toolCallId` timeline anchor lifted from the request payload, the raw
 * request, and the terminal response) straight from the journal; the kernel
 * itself does NOT restore pending promises from them — a request left without
 * a resolution means the process died with it pending and folds as cancelled
 * downstream. The Session-scope `interactionService` dispatches these Ops to
 * the ORIGIN agent's wire (`origin.agentId ?? 'main'`), so each record lives
 * in the journal of the agent the interaction belongs to.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

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

export const InteractionModel = defineModel<InteractionModelState>(
  'interaction',
  () => new Map(),
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'interaction.request': typeof interactionRequest;
    'interaction.resolved': typeof interactionResolved;
  }
}

export const interactionRequest = InteractionModel.defineOp('interaction.request', {
  schema: z.object({
    id: z.string(),
    kind: z.enum(['approval', 'question', 'user_tool']),
    toolCallId: z.string().optional(),
    agentId: z.string().optional(),
    request: z.unknown(),
  }),
  apply: (s, p) => {
    const next = new Map(s);
    next.set(p.id, {
      id: p.id,
      kind: p.kind,
      toolCallId: p.toolCallId,
      agentId: p.agentId,
      request: p.request,
      resolved: false,
    });
    return next;
  },
});

export const interactionResolved = InteractionModel.defineOp('interaction.resolved', {
  schema: z.object({
    id: z.string(),
    response: z.unknown(),
  }),
  apply: (s, p) => {
    const existing = s.get(p.id);
    if (existing === undefined) return s;
    const next = new Map(s);
    next.set(p.id, { ...existing, resolved: true, response: p.response });
    return next;
  },
});
