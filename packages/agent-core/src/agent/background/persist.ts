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
 * that needs session-scoped per-id JSON. This class keeps the
 * background-specific shape and the output.log helpers together.
 */

import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { createPerIdJsonStore, type PerIdJsonStore } from '../../utils/per-id-json-store';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from './task';

/**
 * Task id format: `{prefix}-{8 chars of [0-9a-z]}`.
 *
 * Strictly enforced before deriving task paths so neither path-traversal
 * (`../`) nor a legacy `bg_<hex>` format can escape through the
 * persistence layer. The prefix is intentionally open-ended so new task
 * kinds do not need persistence-layer changes.
 */
const VALID_TASK_ID: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;

type PersistedTask = BackgroundTaskInfo;

type DiskPersistedTask = PersistedTask | LegacyPersistedTask;

function tasksDirOf(sessionDir: string): string {
  return join(sessionDir, 'tasks');
}

function taskOutputDir(sessionDir: string, taskId: string): string {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new Error(`Invalid task id: "${taskId}"`);
  }
  return join(tasksDirOf(sessionDir), taskId);
}

function taskOutputFile(sessionDir: string, taskId: string): string {
  return join(taskOutputDir(sessionDir, taskId), 'output.log');
}

export class BackgroundTaskPersistence {
  private readonly store: PerIdJsonStore<DiskPersistedTask>;

  constructor(private readonly sessionDir: string) {
    this.store = createPerIdJsonStore<DiskPersistedTask>({
      rootDir: sessionDir,
      subdir: 'tasks',
      idRegex: VALID_TASK_ID,
      isValid: isReadablePersistedTask,
      entityName: 'task id',
    });
  }

  taskOutputFile(taskId: string): string {
    return taskOutputFile(this.sessionDir, taskId);
  }

  /** Atomically write a task's persisted state. Creates dirs as needed. */
  async writeTask(task: PersistedTask): Promise<void> {
    await this.store.write(task.taskId, task);
  }

  /** Read a single task file. Returns undefined when missing/corrupt/unrecognized. */
  async readTask(taskId: string): Promise<PersistedTask | undefined> {
    const task = await this.store.read(taskId);
    return task === undefined ? undefined : normalizePersistedTask(task);
  }

  async appendTaskOutput(taskId: string, chunk: string): Promise<void> {
    const path = this.taskOutputFile(taskId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, chunk, 'utf-8');
  }

  /**
   * Total byte size of a task's `output.log`. Returns 0 when the log does
   * not exist yet (the task has produced no output, or is unknown).
   *
   * This is the authoritative full-output size — unlike the in-memory ring
   * buffer it is never truncated, so callers can report how much output a
   * task has actually produced.
   */
  async taskOutputSizeBytes(taskId: string): Promise<number> {
    try {
      const st = await stat(this.taskOutputFile(taskId));
      return st.size;
    } catch {
      return 0;
    }
  }

  async taskOutputExists(taskId: string): Promise<boolean> {
    try {
      return (await stat(this.taskOutputFile(taskId))).isFile();
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
  async readTaskOutputBytes(taskId: string, offset: number, maxBytes: number): Promise<string> {
    const start = Math.max(0, Math.trunc(offset));
    const limit = Math.max(0, Math.trunc(maxBytes));
    if (limit === 0) return '';
    let handle;
    try {
      handle = await open(this.taskOutputFile(taskId), 'r');
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
   *   - records that are neither identifiable as the current camelCase
   *     shape nor the previous snake_case task shape.
   *
   * Legacy snake_case records are normalized to current `BackgroundTaskInfo`
   * in memory. The next lifecycle/reconcile write stores them back in the
   * current format, so compatibility is read-only and opportunistically
   * migrates without a separate migration step.
   *
   * `writeTask` uses atomic temp+rename so a genuinely truncated file in
   * production is rare; if it happens we accept the loss rather than
   * emit a ghost with no recoverable metadata beyond the filename.
   */
  async listTasks(): Promise<readonly PersistedTask[]> {
    const tasks = await this.store.list();
    return tasks.map(normalizePersistedTask);
  }
}

function normalizePersistedTask(task: DiskPersistedTask): PersistedTask {
  if (isLegacyPersistedTask(task)) return legacyPersistedTaskToInfo(task);
  return {
    ...task,
    detached: task.detached ?? true,
  };
}

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

function legacyPersistedTaskToInfo(task: LegacyPersistedTask): PersistedTask {
  const status = legacyStatusToCurrent(task);
  const stopReason = optionalNonEmptyString(task.stop_reason);
  const timeoutMs = typeof task.timeout_ms === 'number' ? task.timeout_ms : undefined;
  const base = {
    taskId: task.task_id,
    description: task.description,
    status,
    detached: true,
    startedAt: task.started_at,
    endedAt: task.ended_at,
    stopReason,
    timeoutMs,
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

function optionalNonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
