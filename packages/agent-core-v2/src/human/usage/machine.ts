import { assign, emit, setup } from '#/xstate2';

import { accumulateUsage, emptyUsageSummary, type UsageRecord, type UsageSummary } from './usage';

export type UsageEvent = { type: 'usage.record'; record: UsageRecord };

export type UsageEmitted = { type: 'usage.updated'; record: UsageRecord; summary: UsageSummary };

export interface UsageMachineContext {
  records: UsageRecord[];
  summary: UsageSummary;
}

export function createUsageMachine() {
  return setup({
    types: {
      context: {} as UsageMachineContext,
      events: {} as UsageEvent,
      emitted: {} as UsageEmitted,
    },
  }).createMachine({
    id: 'usage',
    context: {
      records: [],
      summary: emptyUsageSummary(),
    },
    on: {
      'usage.record': {
        actions: [
          assign(({ context, event }) => ({
            records: [...context.records, event.record],
            summary: accumulateUsage(context.summary, event.record),
          })),
          emit(({ context }) => ({
            type: 'usage.updated' as const,
            record: context.records[context.records.length - 1] as UsageRecord,
            summary: context.summary,
          })),
        ],
      },
    },
  });
}
