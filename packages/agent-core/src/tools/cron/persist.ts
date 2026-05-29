/**
 * Cron task persistence.
 *
 * Thin wrapper over `createPerIdJsonStore` that pins the on-disk layout
 * (`<sessionDir>/cron/<task_id>.json`), the cron-id shape (8 lowercase
 * hex chars — same shape `SessionCronStore` generates), and a shape
 * guard for `CronTask`.
 *
 * No `PersistedCronTask` type: a `CronTask` is already pure plain data,
 * so the on-disk record is the in-memory record verbatim. Optional
 * `recurring` is honoured: an absent field round-trips as `undefined`,
 * which the rest of the cron stack treats as "recurring" by convention.
 *
 * The store is crash-safe (atomic write under the hood) and silently
 * ignores stray files, corrupt JSON, and records that fail the shape
 * guard — the cron stack would rather lose a malformed task than refuse
 * to boot.
 */

import { createPerIdJsonStore, type PerIdJsonStore } from '../../utils/per-id-json-store';
import type { CronTask } from './types';

/**
 * On-disk id shape. Mirrors the regex `SessionCronStore` uses when
 * generating ids and doubles as the path-traversal guard inside the
 * generic per-id store.
 */
export const CRON_ID_REGEX: RegExp = /^[0-9a-f]{8}$/;

/**
 * Cheap shape guard. Run on every parsed JSON value before it is
 * surfaced from `list()` / `read()`; failing values are silently
 * dropped.
 */
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
  return true;
}

/**
 * Construct a per-id JSON store for cron tasks under `sessionDir`. The
 * store is stateless — callers can create it on demand.
 */
export function createCronPersistStore(sessionDir: string): PerIdJsonStore<CronTask> {
  return createPerIdJsonStore<CronTask>({
    rootDir: sessionDir,
    subdir: 'cron',
    idRegex: CRON_ID_REGEX,
    isValid: isValidCronTask,
    entityName: 'cron job id',
  });
}
