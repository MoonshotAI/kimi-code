import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import type { CronTask } from './cronTask';

/**
 * Read-only access to the pre-wire cron task files (`<home>/cron/<workspaceId>/<id>.json`),
 * kept solely for the one-time migration into wire.jsonl durable records.
 * TODO: remove together with the migration call site once legacy files are phased out.
 */
export const LEGACY_CRON_TASKS_SCOPE = 'cron';

const JSON_SUFFIX = '.json';
const CRON_ID_REGEX: RegExp = /^(?:[0-9a-f]{8}|[0-9A-HJKMNP-TV-Z]{26})$/i;

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

export async function listLegacyCronTasks(
  store: IAtomicDocumentStore,
  workspaceId: string,
): Promise<readonly CronTask[]> {
  const scope = `${LEGACY_CRON_TASKS_SCOPE}/${workspaceId}`;
  const keys = await store.list(scope);
  const tasks: CronTask[] = [];
  for (const key of keys) {
    if (!key.endsWith(JSON_SUFFIX)) continue;
    const id = key.slice(0, -JSON_SUFFIX.length);
    if (!CRON_ID_REGEX.test(id)) continue;
    const value = await store.get<CronTask>(scope, key);
    if (value === undefined || !isValidCronTask(value)) continue;
    tasks.push(value);
  }
  return tasks;
}

export async function deleteLegacyCronTask(
  store: IAtomicDocumentStore,
  workspaceId: string,
  taskId: string,
): Promise<void> {
  await store.delete(`${LEGACY_CRON_TASKS_SCOPE}/${workspaceId}`, `${taskId}${JSON_SUFFIX}`);
}
