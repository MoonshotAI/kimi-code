/**
 * `modelFailover` domain (L4) — persisted model-switch audit records.
 *
 * Defines the replayable `ModelFailoverModel`, its `model.failover` Op, and
 * the `turn.step.failover` event projected from each live dispatch through
 * `wire`. The Model keeps only the latest switch; the append-only wire record
 * remains the complete audit trail.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import { ModelFailoverTriggerSchema } from './configSection';

export interface TurnStepFailoverEvent {
  readonly type: 'turn.step.failover';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly fromModel: string;
  readonly toModel: string;
  readonly fromProvider: string;
  readonly toProvider: string;
  readonly fromEffort: string;
  readonly toEffort: string;
  readonly reason: 'retry_exhausted' | 'quota_exhausted';
  readonly switchIndex: number;
  readonly maxSwitches: number;
}

export type ModelFailoverSwitch = Omit<TurnStepFailoverEvent, 'type'>;

export interface ModelFailoverState {
  readonly last?: ModelFailoverSwitch;
}

export const ModelFailoverModel = defineModel<ModelFailoverState>('modelFailover', () => ({}));

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.step.failover': TurnStepFailoverEvent;
  }
}

declare module '#/wire/types' {
  interface PersistedOpMap {
    'model.failover': typeof modelFailoverSwitch;
  }
}

export const modelFailoverSwitch = ModelFailoverModel.defineOp('model.failover', {
  schema: z.object({
    turnId: z.number().int().min(0),
    step: z.number().int().min(1),
    stepId: z.string().optional(),
    fromModel: z.string().min(1),
    toModel: z.string().min(1),
    fromProvider: z.string().min(1),
    toProvider: z.string().min(1),
    fromEffort: z.string(),
    toEffort: z.string(),
    reason: ModelFailoverTriggerSchema,
    switchIndex: z.number().int().min(1),
    maxSwitches: z.number().int().min(1),
  }),
  apply: (_state, payload) => ({ last: payload }),
  toEvent: (payload) => ({ type: 'turn.step.failover' as const, ...payload }),
});
