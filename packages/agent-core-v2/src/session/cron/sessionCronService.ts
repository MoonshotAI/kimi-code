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
  emitScheduled(task: CronTask, agentId?: string): void;
  emitDeleted(taskId: string, agentId?: string): void;
}

export const ISessionCronService = createDecorator<ISessionCronService>('sessionCronService');
