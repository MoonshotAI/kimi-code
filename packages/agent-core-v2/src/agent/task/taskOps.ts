/**
 * `task` domain (L5) — wire Model (`TaskModel`) and the persisted
 * `task.started` (`taskStarted`) / `task.terminated` (`taskTerminated`) Ops
 * that record the durable task-info registry, plus the `task.started` /
 * `task.terminated` edge events declared on `DomainEventMap` and derived from
 * the Ops via `toEvent`.
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
 * `wire.hooks.onDidRestore` hook before disk load + reconcile. The Ops persist
 * so the wire journal carries the full task lifecycle: replay rebuilds the
 * Model as the ghost seed, and a cold transcript fold can rebuild task
 * entities straight from the records. `task.terminated` additionally carries
 * an optional bounded `outputTail` snapshot of the task's retained output for
 * that fold; the tail is fold-only and never enters the Model.
 * `AgentTaskPersistence` (per-task JSON documents + output logs) stays the
 * full-fidelity registry and is reconciled on resume. Consumed by the
 * Agent-scope `taskService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { AgentTaskInfo } from './types';

export type TaskModelState = Map<string, AgentTaskInfo>;

export const TaskModel = defineModel<TaskModelState>('task', () => new Map());

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'task.started': { readonly info: AgentTaskInfo };
    'task.terminated': { readonly info: AgentTaskInfo };
  }
}

const taskStartedSchema = z.object({ info: z.custom<AgentTaskInfo>() });

const taskTerminatedSchema = z.object({
  info: z.custom<AgentTaskInfo>(),
  outputTail: z.string().optional(),
});

declare module '#/wire/types' {
  interface PersistedOpMap {
    'task.started': typeof taskStarted;
    'task.terminated': typeof taskTerminated;
  }
}

export const taskStarted = TaskModel.defineOp('task.started', {
  schema: taskStartedSchema,
  apply: (s, p) => {
    const next = new Map(s);
    next.set(p.info.taskId, p.info);
    return next;
  },
  toEvent: (p) => ({ type: 'task.started' as const, info: p.info }),
});

export const taskTerminated = TaskModel.defineOp('task.terminated', {
  schema: taskTerminatedSchema,
  apply: (s, p) => {
    const next = new Map(s);
    next.set(p.info.taskId, p.info);
    return next;
  },
  toEvent: (p) => ({ type: 'task.terminated' as const, info: p.info }),
});
