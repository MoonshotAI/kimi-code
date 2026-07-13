/**
 * `cron` domain (L5) — `ICronTaskPersistence` contract.
 *
 * Project-level persistence for cron tasks. Persists tasks under
 * `bootstrap.scope('cron')` as atomic documents keyed by
 * `<workspaceId>/<taskId>.json`. Provides CRUD and query-by-workspace.
 * A pure data layer — scheduling, timers, and fire delivery are owned by
 * `ISessionCronService` at Session scope. Bound at App scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

import type { CronTask } from './cronTask';

export interface CronTaskQuery {
  readonly workspaceId: string;
}

export interface ICronTaskPersistence {
  readonly _serviceBrand: undefined;

  get(workspaceId: string, taskId: string): Promise<CronTask | undefined>;
  list(query: CronTaskQuery): Promise<readonly CronTask[]>;
  save(workspaceId: string, task: CronTask): Promise<void>;
  delete(workspaceId: string, taskId: string): Promise<void>;
}

export const ICronTaskPersistence = createDecorator<ICronTaskPersistence>('cronTaskPersistence');
