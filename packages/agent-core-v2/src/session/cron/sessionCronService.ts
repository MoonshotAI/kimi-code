/**
 * `cron` domain (L5) — `ISessionCronService` contract.
 *
 * Session-level scheduling engine for cron tasks. Owns the live task set
 * (filtered from `ICronTaskPersistence` by `sessionId` tag), the polling timer,
 * and the fire/coalesce/jitter logic. On fire, borrows the main agent's
 * `IAgentPromptService` via `IAgentLifecycleService` handle to steer a new
 * turn. Bound at Session scope.
 */

import type { ContentPart } from '#/kosong/contract/message';

import { createDecorator } from '#/_base/di/instantiation';
import type { Turn } from '#/agent/loop/loop';
import type { CronTask, CronTaskInit } from '#/app/cron/cronTask';
import type { ParsedCronExpression } from '#/app/cron/cron-expr';

export interface CronLoadOptions {
  readonly replace?: boolean;
}

export interface ISessionCronService {
  readonly _serviceBrand: undefined;

  readonly isEnabled: boolean;
  isDisabled(): boolean;
  addTask(init: CronTaskInit): CronTask;
  removeTasks(ids: readonly string[]): readonly string[];
  getTask(id: string): CronTask | undefined;
  list(): readonly CronTask[];
  now(): number;
  isStale(task: CronTask): boolean;
  getNextFireTime(): number | null;
  getNextFireForTask(taskId: string): number | null;
  computeDisplayNextFire(
    task: CronTask,
    parsed: ParsedCronExpression,
    idealMs: number,
  ): number | null;
  loadFromStore(options?: CronLoadOptions): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  flushPersist(): Promise<void>;
  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (tasks: readonly CronTask[]) => readonly ContentPart[],
  ): Turn | undefined;
  emitScheduled(task: CronTask): void;
  emitDeleted(taskId: string): void;
}

export const ISessionCronService = createDecorator<ISessionCronService>('sessionCronService');
