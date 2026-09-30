import { assign, emit, setup } from '#/xstate2';

import { INTERACTION_TAG_SESSION_ID, type Interaction } from './interaction';

export interface InteractionRecord extends Interaction {
  readonly resolved: boolean;
  readonly response?: unknown;
}

export type InteractionEvent =
  | { type: 'interaction.request'; record: InteractionRecord }
  | { type: 'interaction.resolve'; id: string; response: unknown }
  | { type: 'interaction.evict'; id: string }
  | { type: 'interaction.purge'; sessionId: string };

export type InteractionEmitted =
  | { type: 'interaction.requested'; record: InteractionRecord }
  | { type: 'interaction.resolved'; id: string; response: unknown; record: InteractionRecord };

export interface InteractionMachineContext {
  records: Map<string, InteractionRecord>;
}

export function createInteractionMachine() {
  return setup({
    types: {
      context: {} as InteractionMachineContext,
      events: {} as InteractionEvent,
      emitted: {} as InteractionEmitted,
    },
  }).createMachine({
    id: 'interaction',
    context: { records: new Map() },
    on: {
      'interaction.request': {
        guard: ({ context, event }) => context.records.get(event.record.id)?.resolved !== false,
        actions: [
          assign(({ context, event }) => {
            const records = new Map(context.records);
            records.set(event.record.id, event.record);
            return { records };
          }),
          emit(({ event }) => ({ type: 'interaction.requested' as const, record: event.record })),
        ],
      },
      'interaction.resolve': {
        guard: ({ context, event }) => context.records.get(event.id)?.resolved === false,
        actions: [
          assign(({ context, event }) => {
            const records = new Map(context.records);
            const record = records.get(event.id) as InteractionRecord;
            records.set(event.id, { ...record, resolved: true, response: event.response });
            return { records };
          }),
          emit(({ context, event }) => ({
            type: 'interaction.resolved' as const,
            id: event.id,
            response: event.response,
            record: context.records.get(event.id) as InteractionRecord,
          })),
        ],
      },
      'interaction.purge': {
        actions: [
          assign(({ context, event }) => {
            const records = new Map<string, InteractionRecord>();
            for (const [id, record] of context.records) {
              if (record.tags[INTERACTION_TAG_SESSION_ID] !== event.sessionId) {
                records.set(id, record);
              }
            }
            return { records };
          }),
        ],
      },
      'interaction.evict': {
        guard: ({ context, event }) => context.records.get(event.id)?.resolved === true,
        actions: [
          assign(({ context, event }) => {
            const records = new Map(context.records);
            records.delete(event.id);
            return { records };
          }),
        ],
      },
    },
  });
}
