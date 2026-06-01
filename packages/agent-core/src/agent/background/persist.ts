/**
 * Background task persistence helpers.
 *
 * Each task lives at `<sessionDir>/tasks/<task_id>.json` so a CLI
 * restart can list previously-running tasks (now lost) and emit terminal
 * notifications.
 *
 * The per-id JSON layer (write / read / list / remove) is delegated to
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
import type { BackgroundTaskKind, BackgroundTaskStatus } from './task';

/**
 * Task id format: `{bash|agent}-{8 chars of [0-9a-z]}`.
 *
 * Strictly enforced by `taskFile()` so neither path-traversal (`../`)
 * nor a legacy `bg_<hex>` format can escape through the persistence
 * layer.
 */
export const VALID_TASK_ID: RegExp = /^(bash|agent)-[0-9a-z]{8}$/;

/** On-disk task representation (snake_case, Python-friendly). */
export interface PersistedTask {
  readonly task_id: string;
  readonly kind?: BackgroundTaskKind;
  readonly command: string;
  readonly description: string;
  readonly pid: number;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly exit_code: number | null;
  readonly status: BackgroundTaskStatus;
  /**
   * Reason supplied when the task is marked `awaiting_approval`.
   * Cleared (omitted) when the task leaves that state.
   */
  readonly approval_reason?: string | undefined;
  /**
   * Legacy timeout marker from older persisted task files. New task info
   * records timeout as `status: "timed_out"`; this field is retained only
   * so old session state can be read and normalized.
   */
  readonly timed_out?: boolean | undefined;
  /** Reason recorded when a task is explicitly stopped or aborted. */
  readonly stop_reason?: string | undefined;
  /**
   * Subagent identifier for agent-* tasks (the id `subagentHost.resume`
   * accepts). Persisted so a session restart can re-emit recovery
   * instructions in the next `<notification>` without forcing the LLM to
   * cross-reference the original spawn-success ToolResult. Omitted for
   * bash tasks. Optional in the schema for forward/backward compatibility:
   * pre-PR sessions reload without it and simply skip the recovery hint.
   */
  readonly agent_id?: string | undefined;
  /** Subagent profile name (agent-* tasks only). Persisted for symmetry
   *  with `agent_id` so resume surfaces match between disk and memory. */
  readonly subagent_type?: string | undefined;
}

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
    isValid: isValidPersistedTask,
    entityName: 'task id',
  });
  storeCache.set(sessionDir, store);
  return store;
}

/** Atomically write a task's persisted state. Creates dirs as needed. */
export async function writeTask(sessionDir: string, task: PersistedTask): Promise<void> {
  await storeFor(sessionDir).write(task.task_id, task);
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
 *   - records that fail `isValidPersistedTask` (canonical "spec with
 *     missing fields" failure mode).
 *
 * `writeTask` uses atomic temp+rename so a genuinely truncated file in
 * production is rare; if it happens we accept the loss rather than
 * emit a ghost with no recoverable metadata beyond the filename.
 */
export async function listTasks(sessionDir: string): Promise<readonly PersistedTask[]> {
  return storeFor(sessionDir).list();
}

/**
 * Validate that the parsed JSON actually shapes like a PersistedTask.
 * Cheap shape check (not a full zod schema) — rejects the canonical
 * "spec with missing fields" failure mode.
 */
function isValidPersistedTask(obj: unknown): obj is PersistedTask {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['task_id'] === 'string' &&
    (o['kind'] === undefined || o['kind'] === 'process' || o['kind'] === 'agent') &&
    typeof o['command'] === 'string' &&
    typeof o['description'] === 'string' &&
    typeof o['pid'] === 'number' &&
    typeof o['started_at'] === 'number' &&
    (o['ended_at'] === null || typeof o['ended_at'] === 'number') &&
    (o['exit_code'] === null || typeof o['exit_code'] === 'number') &&
    typeof o['status'] === 'string'
  );
}
