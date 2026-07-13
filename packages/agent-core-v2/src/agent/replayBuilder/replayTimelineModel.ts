/**
 * `replayBuilder` domain — `ReplayTimelineModel`, a derived wire model that
 * folds heterogeneous Ops from multiple domains into a single ordered timeline.
 *
 * This is the v2 replacement for v1's imperative `ReplayBuilder` class: instead
 * of each domain service pushing records into a mutable accumulator, the model
 * declares which Op types it reduces and the wire engine folds them
 * automatically — during both `replay` (silent) and `dispatch` (live).
 *
 * The timeline entries are op-native: they carry the raw op payloads, not the
 * v1 `AgentReplayRecordPayload` DTO shape. The projection to the SDK/edge DTO
 * (e.g. computing `GoalSnapshot` from `GoalState`) is a read-time concern, not
 * a reduce-time concern.
 */

import {
  contextAppendMessage,
  contextApplyCompaction,
} from '#/agent/contextMemory/contextOps';
import {
  fullCompactionBegin,
  fullCompactionCancel,
  fullCompactionComplete,
} from '#/agent/fullCompaction/compactionOps';
import { clearGoal, createGoal, updateGoal } from '#/agent/goal/goalOps';
import { planModeCancel, planModeEnter, planModeExit } from '#/agent/plan/planOps';
import { configUpdate } from '#/agent/profile/profileOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { setMode } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionApprovalResultRecord } from '#/agent/permissionRules/permissionRules';
import { recordApprovalResult } from '#/agent/permissionRules/permissionRulesOps';
import { type DerivedModelDef, defineDerivedModel } from '#/wire/model';
import type { ModelReducers, OpPayload, OpType, PayloadOf } from '#/wire/types';

type TimelineMapperMap = {
  [K in OpType]?: (payload: OpPayload<K>) => unknown;
};

type TimelineEntry<M> = {
  [K in keyof M]: M[K] extends (...args: never[]) => infer E ? E : never;
}[keyof M];

type ErasedTimelineMapper<E> = (payload: unknown) => E;

function defineDerivedTimeline<const M extends TimelineMapperMap>(
  name: string,
  mappers: M & Record<Exclude<keyof M, OpType>, never>,
): DerivedModelDef<readonly TimelineEntry<M>[]> {
  type E = TimelineEntry<M>;
  const entries = Object.entries(mappers) as [OpType, ErasedTimelineMapper<E>][];
  const reducers = Object.fromEntries(
    entries.map(
      ([opType, mapper]) =>
        [opType, (state: readonly E[], payload: unknown) => [...state, mapper(payload)]] as const,
    ),
  ) as ModelReducers<readonly E[]>;
  return defineDerivedModel(name, () => [], reducers);
}

export const ReplayTimelineModel = defineDerivedTimeline('agent.replayTimeline', {
  [contextAppendMessage.type]: (p: PayloadOf<typeof contextAppendMessage>) =>
    ({ type: contextAppendMessage.type, payload: p }) as const,

  [contextApplyCompaction.type]: (p: PayloadOf<typeof contextApplyCompaction>) =>
    ({ type: contextApplyCompaction.type, payload: p }) as const,

  [fullCompactionBegin.type]: (p: PayloadOf<typeof fullCompactionBegin>) =>
    ({ type: fullCompactionBegin.type, payload: p }) as const,

  [fullCompactionCancel.type]: () =>
    ({ type: fullCompactionCancel.type }) as const,

  [fullCompactionComplete.type]: (p: PayloadOf<typeof fullCompactionComplete>) =>
    ({ type: fullCompactionComplete.type, payload: p }) as const,

  [createGoal.type]: (p: PayloadOf<typeof createGoal>) =>
    ({ type: createGoal.type, payload: p }) as const,

  [updateGoal.type]: (p: PayloadOf<typeof updateGoal>) =>
    ({ type: updateGoal.type, payload: p }) as const,

  [clearGoal.type]: () =>
    ({ type: clearGoal.type }) as const,

  [planModeEnter.type]: (p: PayloadOf<typeof planModeEnter>) =>
    ({ type: planModeEnter.type, payload: p }) as const,

  [planModeCancel.type]: (p: PayloadOf<typeof planModeCancel>) =>
    ({ type: planModeCancel.type, payload: p }) as const,

  [planModeExit.type]: (p: PayloadOf<typeof planModeExit>) =>
    ({ type: planModeExit.type, payload: p }) as const,

  [configUpdate.type]: (p: PayloadOf<typeof configUpdate>) =>
    ({ type: configUpdate.type, payload: p }) as const,

  [setMode.type]: (p: { mode: PermissionMode }) =>
    ({ type: setMode.type, payload: p }) as const,

  [recordApprovalResult.type]: (p: PermissionApprovalResultRecord) =>
    ({ type: recordApprovalResult.type, payload: p }) as const,
});

type InferTimelineEntry<D> = D extends DerivedModelDef<readonly (infer E)[]> ? E : never;

export type ReplayTimelineEntry = InferTimelineEntry<typeof ReplayTimelineModel>;
export type ReplayTimeline = readonly ReplayTimelineEntry[];
