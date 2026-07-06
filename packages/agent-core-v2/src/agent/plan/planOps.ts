/**
 * `plan` domain (L4) — wire Model (`PlanModel`) and the `plan_mode.enter`
 * (`planModeEnter`) / `plan_mode.cancel` (`planModeCancel`) / `plan_mode.exit`
 * (`planModeExit`) Ops that mirror the plan-mode lifecycle into a persisted,
 * replayable `{ active, id, planFilePath }` state.
 *
 * The Model holds the persistent, replayable fields — whether plan mode is
 * active, the plan id, and the plan file path (computed at the call site from
 * the id + cwd and carried in the `plan_mode.enter` payload so `apply` stays
 * pure). Each `apply` returns the same reference on a no-op (re-entering the
 * same plan, or cancelling/exiting while already inactive) so the wire's
 * reference-equality gate stays quiet. The side effects — `telemetryContext`
 * mode, plan-directory/file fs I/O, and the `agent.status.updated` planMode
 * slice — are NOT part of `apply`: they run after `wire.dispatch` on the live
 * path, and `wire.replay` rebuilds the Model silently from the persisted
 * `plan_mode.*` records (seeded by `sessionLifecycle`). The legacy
 * `toReplay: plan_updated` projection is dropped (inert — nothing reads it).
 * Consumed by the Agent-scope `planService`.
 */

import { defineModel, defineOp } from '#/wire';

export interface PlanState {
  readonly active: boolean;
  readonly id?: string;
  readonly planFilePath?: string;
}

export const PlanModel = defineModel<PlanState>('plan', () => ({ active: false }));

export interface PlanModeEnterPayload {
  readonly id: string;
  readonly planFilePath: string;
}

export const planModeEnter = defineOp(PlanModel, 'plan_mode.enter', {
  apply: (s, p: PlanModeEnterPayload): PlanState =>
    s.active && s.id === p.id && s.planFilePath === p.planFilePath
      ? s
      : { active: true, id: p.id, planFilePath: p.planFilePath },
  toEvent: () => ({ type: 'agent.status.updated' as const, planMode: true }),
});

export interface PlanModeIdPayload {
  readonly id?: string;
}

export const planModeCancel = defineOp(PlanModel, 'plan_mode.cancel', {
  apply: (s, _p: PlanModeIdPayload): PlanState => (s.active === false ? s : { active: false }),
  toEvent: () => ({ type: 'agent.status.updated' as const, planMode: false }),
});

export const planModeExit = defineOp(PlanModel, 'plan_mode.exit', {
  apply: (s, _p: PlanModeIdPayload): PlanState => (s.active === false ? s : { active: false }),
  toEvent: () => ({ type: 'agent.status.updated' as const, planMode: false }),
});
