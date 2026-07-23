/**
 * `plan` domain (L4) — persists plan-mode conversation state.
 *
 * Keeps plan mode aligned with conversation undo through `contextMemory`'s
 * checkpoint protocol and exposes the state consumed by the Agent-scope plan
 * service.
 */

import { z } from 'zod';

import {
  defineCheckpointedModel,
  type Checkpointed,
} from '#/agent/contextMemory/conversationTime';

export interface PlanState {
  readonly active: boolean;
  readonly id?: string;
}

export type PlanModelState = Checkpointed<PlanState>;

export const PlanModel = defineCheckpointedModel('plan', (): PlanState => ({ active: false }));

export const planModeEnter = PlanModel.defineOp('plan_mode.enter', {
  schema: z.object({ id: z.string() }),
  apply: (s, p) =>
    s.current.active && s.current.id === p.id
      ? s
      : { ...s, current: { active: true, id: p.id } },
  toEvent: () => ({ type: 'agent.status.updated' as const, planMode: true }),
});

declare module '#/wire/types' {
  interface PersistedOpMap {
    'plan_mode.enter': typeof planModeEnter;
    'plan_mode.cancel': typeof planModeCancel;
    'plan_mode.exit': typeof planModeExit;
  }
}

export const planModeCancel = PlanModel.defineOp('plan_mode.cancel', {
  schema: z.object({ id: z.string().optional() }),
  apply: (s) =>
    s.current.active ? { ...s, current: { active: false } } : s,
  toEvent: () => ({ type: 'agent.status.updated' as const, planMode: false }),
});

export const planModeExit = PlanModel.defineOp('plan_mode.exit', {
  schema: z.object({ id: z.string().optional() }),
  apply: (s) =>
    s.current.active ? { ...s, current: { active: false } } : s,
  toEvent: () => ({ type: 'agent.status.updated' as const, planMode: false }),
});
