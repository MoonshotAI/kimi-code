/**
 * Background task persistence helpers.
 *
 * Each task lives at `<sessionDir>/tasks/<task_id>.json` so a CLI
 * restart can list previously-running tasks (now lost) and emit terminal
 * notifications.
 *
 * Writes use `atomicWrite` (write-tmp-fsync-rename) so a crash mid-write
 * never leaves a half-truncated file.
 */

import { statSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { atomicWrite } from '../../utils/fs';
import type { BackgroundTaskStatus } from './manager';

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
   * True when an agent task was forcibly terminated by its external
   * deadline (`registerAgentTask(..., { timeoutMs })`). An internal
   * `TimeoutError` raised by the agent promise itself is a generic
   * failure and does NOT set this flag.
   */
  readonly timed_out?: boolean | undefined;
  /** Reason recorded when a task is explicitly stopped. */
  readonly stop_reason?: string | undefined;
  /**
   * Shell origin metadata (name / path / cwd) captured when
   * `BackgroundProcessManager.register` attached a `shellInfo` option.
   * Persisted so restart can reconstruct the spawn environment.
   */
  readonly shell_info?:
    | {
        readonly name: string;
        readonly path?: string | undefined;
        readonly cwd?: string | undefined;
      }
    | undefined;
}

function tasksDirOf(sessionDir: string): string {
  return join(sessionDir, 'tasks');
}

function taskFile(sessionDir: string, taskId: string): string {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new Error(`Invalid task id: "${taskId}"`);
  }
  return join(tasksDirOf(sessionDir), `${taskId}.json`);
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

/** Atomically write a task's persisted state. Creates dirs as needed. */
export async function writeTask(sessionDir: string, task: PersistedTask): Promise<void> {
  await mkdir(tasksDirOf(sessionDir), { recursive: true, mode: 0o700 });
  const target = taskFile(sessionDir, task.task_id);
  await atomicWrite(target, JSON.stringify(task, null, 2));
}

/** Read a single task file. Returns undefined when missing/corrupt. */
export async function readTask(
  sessionDir: string,
  taskId: string,
): Promise<PersistedTask | undefined> {
  // Path-traversal validation runs before the try/catch so callers see
  // an explicit error instead of a misleading "missing" return.
  const path = taskFile(sessionDir, taskId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as unknown as PersistedTask;
  } catch {
    return undefined;
  }
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

/** Enumerate all persisted tasks for a session. Skips corrupt entries. */
export async function listTasks(sessionDir: string): Promise<PersistedTask[]> {
  let entries: string[];
  try {
    entries = await readdir(tasksDirOf(sessionDir));
  } catch {
    return [];
  }
  const out: PersistedTask[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const taskId = entry.slice(0, -'.json'.length);
    // Silently drop: filename basename is not a valid task id (stray files,
    // legacy bg_* leftovers, etc.).
    if (!VALID_TASK_ID.test(taskId)) continue;
    const task = await readTask(sessionDir, taskId);
    // Silently drop: JSON parse failed or file disappeared between readdir
    // and readTask. writeTask uses an atomic temp+rename pattern so a
    // genuinely truncated file in production is rare; if it happens we
    // accept the loss rather than emit a ghost with no recoverable
    // metadata beyond the filename.
    if (task === undefined) continue;
    // Silently drop: parsed JSON is missing one or more required fields
    // for a PersistedTask. Treated the same as a missing file.
    if (!isValidPersistedTask(task)) continue;
    out.push(task);
  }
  return out;
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
    typeof o['command'] === 'string' &&
    typeof o['description'] === 'string' &&
    typeof o['pid'] === 'number' &&
    typeof o['started_at'] === 'number' &&
    (o['ended_at'] === null || typeof o['ended_at'] === 'number') &&
    (o['exit_code'] === null || typeof o['exit_code'] === 'number') &&
    typeof o['status'] === 'string'
  );
}

/** Remove a task file (idempotent). */
export async function removeTask(sessionDir: string, taskId: string): Promise<void> {
  // Path-traversal validation outside try/catch.
  const path = taskFile(sessionDir, taskId);
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await rm(taskOutputDir(sessionDir, taskId), { recursive: true, force: true });
}
