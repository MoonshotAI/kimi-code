/**
 * Background task persistence helpers.
 *
 * Each task lives at `<sessionDir>/tasks/<taskId>.json` so a CLI
 * restart can list previously-running tasks (now lost) and emit terminal
 * notifications.
 *
 * The per-id JSON layer (write / read / list) is delegated to
 * `createPerIdJsonStore`, which centralises atomic-write +
 * path-traversal-guarded readdir for cron / background / anything else
 * that needs session-scoped per-id JSON. This module keeps the
 * background-specific shape, the output.log helpers, and the named
 * exports (`writeTask`, …) the rest of `background/` already imports.
 */

import { statSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { createPerIdJsonStore, type PerIdJsonStore } from '../../utils/per-id-json-store';
import type { BackgroundTaskInfo } from './task';

/**
 * Task id format: `{bash|agent}-{8 chars of [0-9a-z]}`.
 *
 * Strictly enforced by `taskFile()` so neither path-traversal (`../`)
 * nor a legacy `bg_<hex>` format can escape through the persistence
 * layer.
 */
export const VALID_TASK_ID: RegExp = /^(bash|agent)-[0-9a-z]{8}$/;

export type PersistedTask = BackgroundTaskInfo;

function tasksDirOf(sessionDir: string): string {
  return join(sessionDir, 'tasks');
}

function taskOutputDir(sessionDir: string, taskId: string): string {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new Error(`Invalid task id: "${taskId}"`);
  }
  return join(tasksDirOf(sessionDir), taskId);
}

export function taskOutputFile(sessionDir: string, taskId: string): string {
  return join(taskOutputDir(sessionDir, taskId), 'output.log');
}

/**
 * Cache of `createPerIdJsonStore` instances keyed by sessionDir.
 *
 * Per-id stores hold no state beyond their options object, so reusing
 * the same instance across calls into this module is purely an allocation
 * micro-optimisation. The cache is unbounded; the number of distinct
 * session directories per process is small (typically 1) and the
 * lifetime matches the process.
 */
const storeCache = new Map<string, PerIdJsonStore<PersistedTask>>();
function storeFor(sessionDir: string): PerIdJsonStore<PersistedTask> {
  const cached = storeCache.get(sessionDir);
  if (cached !== undefined) return cached;
  const store = createPerIdJsonStore<PersistedTask>({
    rootDir: sessionDir,
    subdir: 'tasks',
    idRegex: VALID_TASK_ID,
    entityName: 'task id',
  });
  storeCache.set(sessionDir, store);
  return store;
}

/** Atomically write a task's persisted state. Creates dirs as needed. */
export async function writeTask(sessionDir: string, task: PersistedTask): Promise<void> {
  await storeFor(sessionDir).write(task.taskId, task);
}

/** Read a single task file. Returns undefined when missing/corrupt. */
export async function readTask(
  sessionDir: string,
  taskId: string,
): Promise<PersistedTask | undefined> {
  return storeFor(sessionDir).read(taskId);
}

export async function appendTaskOutput(
  sessionDir: string,
  taskId: string,
  chunk: string,
): Promise<void> {
  const path = taskOutputFile(sessionDir, taskId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, chunk, 'utf-8');
}

export async function readTaskOutput(sessionDir: string, taskId: string): Promise<string> {
  try {
    return await readFile(taskOutputFile(sessionDir, taskId), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Total byte size of a task's `output.log`. Returns 0 when the log does
 * not exist yet (the task has produced no output, or is unknown).
 *
 * This is the authoritative full-output size — unlike the in-memory ring
 * buffer it is never truncated, so callers can report how much output a
 * task has actually produced.
 */
export async function taskOutputSizeBytes(sessionDir: string, taskId: string): Promise<number> {
  try {
    const st = await stat(taskOutputFile(sessionDir, taskId));
    return st.size;
  } catch {
    return 0;
  }
}

export async function taskOutputExists(sessionDir: string, taskId: string): Promise<boolean> {
  try {
    return (await stat(taskOutputFile(sessionDir, taskId))).isFile();
  } catch {
    return false;
  }
}

export function taskOutputExistsSync(sessionDir: string, taskId: string): boolean {
  try {
    return statSync(taskOutputFile(sessionDir, taskId)).isFile();
  } catch {
    return false;
  }
}

/**
 * Read a byte window of a task's `output.log`.
 *
 * Reads at most `maxBytes` bytes starting at byte `offset`. A window that
 * runs past EOF is clamped to whatever remains; an `offset` at/after EOF
 * yields an empty string. Returns an empty string when the log is absent.
 *
 * Byte-level (not line-level) paging mirrors how the full log is stored
 * on disk, so callers can page arbitrarily large logs without loading the
 * whole file into memory.
 */
export async function readTaskOutputBytes(
  sessionDir: string,
  taskId: string,
  offset: number,
  maxBytes: number,
): Promise<string> {
  const start = Math.max(0, Math.trunc(offset));
  const limit = Math.max(0, Math.trunc(maxBytes));
  if (limit === 0) return '';
  let handle;
  try {
    handle = await open(taskOutputFile(sessionDir, taskId), 'r');
  } catch {
    return '';
  }
  try {
    const size = (await handle.stat()).size;
    if (start >= size) return '';
    const length = Math.min(limit, size - start);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.toString('utf-8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    await handle.close();
  }
}

/**
 * Enumerate all persisted tasks for a session.
 *
 * Skips, silently:
 *   - basenames that don't match `VALID_TASK_ID` (stray files, legacy
 *     `bg_*` leftovers, partially-written temp files);
 *   - files that fail to read / parse;
 *   - files that are not valid JSON.
 *
 * `writeTask` uses atomic temp+rename so a genuinely truncated file in
 * production is rare; if it happens we accept the loss rather than
 * emit a ghost with no recoverable metadata beyond the filename.
 */
export async function listTasks(sessionDir: string): Promise<readonly PersistedTask[]> {
  return storeFor(sessionDir).list();
}
