/**
 * `plan` domain (L4) — replayable plan-mode wire state.
 *
 * Owns the persisted plan lifecycle state consumed by the Agent-scoped
 * `planService` and keeps it consistent with conversation undo.
 */

import { z } from 'zod';

import { isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import { defineModel } from '#/wire/model';

export interface PlanState {
  readonly active: boolean;
  readonly id?: string;
}

export interface PlanModelState {
  readonly current: PlanState;
  readonly checkpoints: readonly PlanState[];
}

export const PlanModel = defineModel<PlanModelState>('plan', () => ({
  current: { active: false },
  checkpoints: [],
}), {
  reducers: {
    'context.append_message': (state, { message }) =>
      isRealUserInput(message)
        ? { ...state, checkpoints: [...state.checkpoints, state.current] }
        : state,
    'context.apply_compaction': (state) =>
      state.checkpoints.length === 0 ? state : { ...state, checkpoints: [] },
    'context.clear': (state) =>
      state.checkpoints.length === 0 ? state : { ...state, checkpoints: [] },
    'context.undo': (state, { count }) => {
      if (count <= 0 || state.checkpoints.length < count) return state;
      const checkpointIndex = state.checkpoints.length - count;
      return {
        current: state.checkpoints[checkpointIndex]!,
        checkpoints: state.checkpoints.slice(0, checkpointIndex),
      };
    },
  },
});

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
