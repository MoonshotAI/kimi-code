// apps/vis/server/src/lib/task-store.ts
//
// Read-only reader for background tasks, persisted by the engine under each
// spawning agent's homedir at `<agentDir>/tasks/<taskId>.json`
// (+ `tasks/<taskId>/output.log`). Main-agent reads may also receive the
// legacy session root as a fallback.
//
// The visualizer never writes these files; it mirrors the engine's on-disk
// layout (`packages/agent-core-v2/src/agent/task/persist.ts`) for reading only:
//   - the same `VALID_TASK_ID` guard, so a corrupt / hand-edited filename
//     cannot turn a log path into a traversal primitive;
//   - the same legacy snake_case → current camelCase normalization, so old
//     sessions list identically to how the CLI would list them.

import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from './agent-record-types';

/** Task id format: `{prefix}-{8 chars of [0-9a-z]}`. Mirror of the engine's
 *  `VALID_TASK_ID` (`agent/task/persist.ts`). Enforced before deriving any
 *  output path so neither `../` nor a legacy `bg_<hex>` id can escape. */
const VALID_TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;

export function isSafeTaskId(id: string): boolean {
  return VALID_TASK_ID.test(id);
}

function tasksDirOf(agentDir: string): string {
  return join(agentDir, 'tasks');
}

function taskOutputFile(agentDir: string, taskId: string): string {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new Error(`Invalid task id: "${taskId}"`);
  }
  return join(tasksDirOf(agentDir), taskId, 'output.log');
}

/**
 * Enumerate all persisted background tasks for a session, normalized to the
 * current `BackgroundTaskInfo` shape and sorted newest-first by start time.
 *
 * Silently skips: filenames that don't match `VALID_TASK_ID`, files that fail
 * to read/parse, and records that are neither the current nor the legacy
 * task shape — matching the engine's tolerant `listTasks`.
 */
export async function listBackgroundTasks(
  agentDir: string,
  fallbackDir?: string,
): Promise<BackgroundTaskInfo[]> {
  const primary = await listBackgroundTasksAt(agentDir);
  const out = [...primary.tasks];
  if (fallbackDir !== undefined) {
    const fallback = await listBackgroundTasksAt(fallbackDir);
    for (const task of fallback.tasks) {
      if (!primary.reservedIds.has(task.keyId)) out.push(task);
    }
  }
  // Newest first; tasks with no start time sort last.
  out.sort((a, b) => (b.task.startedAt ?? 0) - (a.task.startedAt ?? 0));
  return out.map((entry) => entry.task);
}

interface ListedTask {
  keyId: string;
  task: BackgroundTaskInfo;
}

async function listBackgroundTasksAt(
  agentDir: string,
): Promise<{ reservedIds: Set<string>; tasks: ListedTask[] }> {
  const dir = tasksDirOf(agentDir);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { reservedIds: new Set(), tasks: [] };
  }
  const reservedIds = new Set<string>();
  const tasks: ListedTask[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    if (!VALID_TASK_ID.test(id)) continue;
    reservedIds.add(id);
    if (!entry.isFile()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, entry.name), 'utf8'));
    } catch {
      continue;
    }
    if (!isReadablePersistedTask(parsed)) continue;
    try {
      tasks.push({ keyId: id, task: normalizePersistedTask(parsed) });
    } catch {
      // A record can pass the shape guard but still hold type-corrupt fields
      // (e.g. a legacy `stop_reason` that is a number). Honour the
      // silently-skips contract instead of failing the whole listing.
      continue;
    }
  }
  return { reservedIds, tasks };
}

export interface TaskOutputMetadata {
  exists: boolean;
  size: number;
}

/** Presence and byte size of a task's `output.log`. */
export async function taskOutputMetadata(
  agentDir: string,
  taskId: string,
  fallbackDir?: string,
): Promise<TaskOutputMetadata> {
  const handle = await openTaskOutput(agentDir, taskId, fallbackDir);
  if (handle === undefined) return { exists: false, size: 0 };
  try {
    return { exists: true, size: (await handle.stat()).size };
  } catch {
    return { exists: false, size: 0 };
  } finally {
    await handle.close();
  }
}

/** Byte size of a task's `output.log` (0 when absent, empty, or unreadable). */
export async function taskOutputSizeBytes(
  agentDir: string,
  taskId: string,
  fallbackDir?: string,
): Promise<number> {
  return (await taskOutputMetadata(agentDir, taskId, fallbackDir)).size;
}

export interface TaskOutputWindow {
  /** Byte offset this window starts at (clamped to >= 0). */
  offset: number;
  /** Byte offset immediately after this window — pass it as the next
   *  `offset` to page forward. Exact (server-computed bytesRead), so paging
   *  never drifts even if a window boundary splits a multi-byte char. */
  nextOffset: number;
  /** Total byte size of the log on disk. */
  size: number;
  /** UTF-8 decoded window content. */
  content: string;
  /** True when this window reaches EOF. */
  eof: boolean;
}

/**
 * Read a byte window of a task's `output.log`.
 *
 * Reads at most `maxBytes` bytes starting at byte `offset`. A window past EOF
 * is clamped to whatever remains; an offset at/after EOF yields empty content.
 * Mirrors the engine's `readTaskOutputBytes` so large logs page identically.
 */
export async function readTaskOutput(
  agentDir: string,
  taskId: string,
  offset: number,
  maxBytes: number,
  fallbackDir?: string,
): Promise<TaskOutputWindow> {
  const start = Math.max(0, Math.trunc(offset));
  const limit = Math.max(0, Math.trunc(maxBytes));
  const handle = await openTaskOutput(agentDir, taskId, fallbackDir);
  if (handle === undefined) {
    return { offset: start, nextOffset: start, size: 0, content: '', eof: true };
  }
  try {
    const size = (await handle.stat()).size;
    if (limit === 0 || start >= size) {
      return { offset: start, nextOffset: start, size, content: '', eof: start >= size };
    }
    const length = Math.min(limit, size - start);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const content = buffer.toString('utf-8', 0, bytesRead);
    const nextOffset = start + bytesRead;
    return { offset: start, nextOffset, size, content, eof: nextOffset >= size };
  } catch {
    return { offset: start, nextOffset: start, size: 0, content: '', eof: true };
  } finally {
    await handle.close();
  }
}

async function openTaskOutput(
  agentDir: string,
  taskId: string,
  fallbackDir?: string,
): Promise<Awaited<ReturnType<typeof open>> | undefined> {
  try {
    return await open(taskOutputFile(agentDir, taskId), 'r');
  } catch (error) {
    if (!isMissingPath(error) || fallbackDir === undefined) return undefined;
  }
  try {
    return await open(taskOutputFile(fallbackDir, taskId), 'r');
  } catch {
    return undefined;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

// ── normalization (ported from agent-core-v2/agent/task/persist.ts) ────────

type LegacyBackgroundTaskStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'lost';

interface LegacyPersistedTask {
  readonly task_id: string;
  readonly command: string;
  readonly description: string;
  readonly pid: number;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly exit_code: number | null;
  readonly status: LegacyBackgroundTaskStatus;
  readonly timed_out?: boolean;
  readonly stop_reason?: string;
  readonly timeout_ms?: number;
  readonly agent_id?: string;
  readonly subagent_type?: string;
}

type DiskPersistedTask = BackgroundTaskInfo | LegacyPersistedTask;

function normalizePersistedTask(task: DiskPersistedTask): BackgroundTaskInfo {
  if (isLegacyPersistedTask(task)) return legacyPersistedTaskToInfo(task);
  return { ...task, detached: task.detached ?? true };
}

function legacyPersistedTaskToInfo(task: LegacyPersistedTask): BackgroundTaskInfo {
  const status = legacyStatusToCurrent(task);
  const base = {
    taskId: task.task_id,
    description: task.description,
    status,
    detached: true,
    startedAt: task.started_at,
    endedAt: task.ended_at,
    stopReason: optionalNonEmptyString(task.stop_reason),
    timeoutMs: typeof task.timeout_ms === 'number' ? task.timeout_ms : undefined,
  };
  if (task.task_id.startsWith('agent-')) {
    return {
      ...base,
      kind: 'agent',
      agentId: optionalNonEmptyString(task.agent_id),
      subagentType: optionalNonEmptyString(task.subagent_type),
    };
  }
  return {
    ...base,
    kind: 'process',
    command: task.command,
    pid: task.pid,
    exitCode: task.exit_code,
  };
}

function legacyStatusToCurrent(task: LegacyPersistedTask): BackgroundTaskStatus {
  if (task.status === 'awaiting_approval') return 'running';
  if (task.status === 'failed' && task.timed_out === true) return 'timed_out';
  return task.status;
}

function isReadablePersistedTask(obj: unknown): obj is DiskPersistedTask {
  return (
    isRecord(obj) &&
    (typeof obj['taskId'] === 'string' || typeof obj['task_id'] === 'string')
  );
}

function isLegacyPersistedTask(task: DiskPersistedTask): task is LegacyPersistedTask {
  return 'task_id' in task;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
