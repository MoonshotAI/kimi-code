/**
 * `task` domain (L5) — wire Model (`TaskModel`) and the `task.started`
 * (`taskStarted`) / `task.terminated` (`taskTerminated`) Ops that record the
 * durable task-info registry, plus the `task.started` / `task.terminated` edge
 * events declared on `DomainEventMap` and derived from the Ops via `toEvent`.
 *
 * The Model is the replayable map of `taskId -> AgentTaskInfo` (initial empty)
 * that rebuilds the restored "ghost" tasks from the persisted `task.*` records
 * on `wire.replay`. Each Op folds one lifecycle event into the map by task id
 * (a later `task.terminated` overwrites an earlier `task.started` for the same
 * id, so the final state is the last known info). `apply` returns a new `Map`
 * on every change — task records are inherently events (never a no-op) — and
 * carries no non-determinism. The live `ManagedTask` (the running process, its
 * `AbortController`, output ring, timers) stays OUT of the Model (live-only);
 * the Model is the restore seed for `ghosts`, applied by the service's single
 * `wire.onRestored` handler before disk load + reconcile. Consumed by the
 * Agent-scope `taskService`.
 */

import { defineModel, defineOp } from '#/wire';

import type { AgentTaskInfo } from './types';

export type TaskModelState = Map<string, AgentTaskInfo>;

export const TaskModel = defineModel<TaskModelState>('task', () => new Map());

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'task.started': { readonly info: AgentTaskInfo };
    'task.terminated': { readonly info: AgentTaskInfo };
  }
}

export interface TaskInfoPayload {
  readonly info: AgentTaskInfo;
}

export const taskStarted = defineOp(TaskModel, 'task.started', {
  apply: (s, p: TaskInfoPayload): TaskModelState => {
    const next = new Map(s);
    next.set(p.info.taskId, p.info);
    return next;
  },
  toEvent: (p) => ({ type: 'task.started' as const, info: p.info }),
});

export const taskTerminated = defineOp(TaskModel, 'task.terminated', {
  apply: (s, p: TaskInfoPayload): TaskModelState => {
    const next = new Map(s);
    next.set(p.info.taskId, p.info);
    return next;
  },
  toEvent: (p) => ({ type: 'task.terminated' as const, info: p.info }),
});
