/**
 * `cron` domain (L5) — `ISessionCronService` contract.
 *
 * Session-level scheduling engine for cron tasks. Owns the live task set
 * (filtered from `ICronTaskPersistence` by `sessionId` tag), the polling timer,
 * and the fire/coalesce/jitter logic. On fire, borrows the main agent's
 * `IAgentPromptService` via `IAgentLifecycleService` handle to steer a new
 * turn. Bound at Session scope.
 */

import type { ContentPart } from '#/app/llmProtocol';

import { createDecorator } from '#/_base/di';
import type { Turn } from '#/agent/turn';
import type { CronTask, CronTaskInit } from '#/app/cron';

export interface CronLoadOptions {
  readonly replace?: boolean;
}

export interface ISessionCronService {
  readonly _serviceBrand: undefined;

  readonly isEnabled: boolean;
  addTask(init: CronTaskInit): CronTask;
  removeTasks(ids: readonly string[]): readonly string[];
  getTask(id: string): CronTask | undefined;
  list(): readonly CronTask[];
  now(): number;
  isStale(task: CronTask): boolean;
  getNextFireTime(): number | null;
  getNextFireForTask(taskId: string): number | null;
  loadFromStore(options?: CronLoadOptions): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  tick(): void;
  flushPersist(): Promise<void>;
  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (tasks: readonly CronTask[]) => readonly ContentPart[],
  ): Turn | undefined;
  emitScheduled(task: CronTask): void;
  emitDeleted(taskId: string): void;
}

export const ISessionCronService = createDecorator<ISessionCronService>('sessionCronService');
