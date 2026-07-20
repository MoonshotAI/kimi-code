/**
 * `cron` domain (L5) — `ICronTaskPersistence` implementation.
 *
 * Persists cron tasks as atomic JSON documents under the `cron` persistence
 * scope (`bootstrap.scope('cron')`), laid out as `<workspaceId>/<id>.json`.
 * Pure CRUD — no scheduling logic. Bound at App scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

import { ICronTaskPersistence, type CronTaskQuery } from './cronTaskPersistence';
import type { CronTask } from './cronTask';

export const CRON_ID_REGEX: RegExp = /^(?:[0-9a-f]{8}|[0-9A-HJKMNP-TV-Z]{26})$/i;
const JSON_SUFFIX = '.json';

export function isValidCronTask(obj: unknown): obj is CronTask {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || !CRON_ID_REGEX.test(o['id'])) return false;
  if (typeof o['cron'] !== 'string') return false;
  if (typeof o['prompt'] !== 'string') return false;
  if (typeof o['createdAt'] !== 'number') return false;
  if (o['recurring'] !== undefined && typeof o['recurring'] !== 'boolean') return false;
  if (
    o['lastFiredAt'] !== undefined &&
    (typeof o['lastFiredAt'] !== 'number' || !Number.isFinite(o['lastFiredAt']))
  ) {
    return false;
  }
  if (o['tags'] !== undefined) {
    if (typeof o['tags'] !== 'object' || o['tags'] === null) return false;
    for (const v of Object.values(o['tags'] as Record<string, unknown>)) {
      if (typeof v !== 'string') return false;
    }
  }
  return true;
}

export class CronTaskPersistenceService extends Disposable implements ICronTaskPersistence {
  declare readonly _serviceBrand: undefined;

  private readonly cronScope: string;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAtomicDocumentStore private readonly atomicDocs: IAtomicDocumentStore,
  ) {
    super();
    this.cronScope = this.bootstrap.scope('cron');
  }

  private workspaceScope(workspaceId: string): string {
    return `${this.cronScope}/${workspaceId}`;
  }

  async get(workspaceId: string, taskId: string): Promise<CronTask | undefined> {
    const scope = this.workspaceScope(workspaceId);
    const value = await this.atomicDocs.get<CronTask>(scope, `${taskId}${JSON_SUFFIX}`);
    if (value === undefined || !isValidCronTask(value)) return undefined;
    return value;
  }

  async list(query: CronTaskQuery): Promise<readonly CronTask[]> {
    const scope = this.workspaceScope(query.workspaceId);
    const keys = await this.atomicDocs.list(scope);
    const tasks: CronTask[] = [];
    for (const key of keys) {
      if (!key.endsWith(JSON_SUFFIX)) continue;
      const id = key.slice(0, -JSON_SUFFIX.length);
      if (!CRON_ID_REGEX.test(id)) continue;
      const value = await this.atomicDocs.get<CronTask>(scope, key);
      if (value === undefined || !isValidCronTask(value)) continue;
      tasks.push(value);
    }
    return tasks;
  }

  async save(workspaceId: string, task: CronTask): Promise<void> {
    const scope = this.workspaceScope(workspaceId);
    await this.atomicDocs.set(scope, `${task.id}${JSON_SUFFIX}`, task);
  }

  async delete(workspaceId: string, taskId: string): Promise<void> {
    const scope = this.workspaceScope(workspaceId);
    await this.atomicDocs.delete(scope, `${taskId}${JSON_SUFFIX}`);
  }
}

registerScopedService(
  LifecycleScope.App,
  ICronTaskPersistence,
  CronTaskPersistenceService,
  InstantiationType.Eager,
  'cron',
);
