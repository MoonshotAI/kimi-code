import { assign, emit, setup } from '#/xstate2';

import type { Interaction } from './interaction';

export interface InteractionRecord extends Interaction {
  readonly resolved: boolean;
  readonly response?: unknown;
}

export type InteractionEvent =
  | { type: 'interaction.request'; record: InteractionRecord }
  | { type: 'interaction.resolve'; id: string; response: unknown };

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
    },
  });
}
