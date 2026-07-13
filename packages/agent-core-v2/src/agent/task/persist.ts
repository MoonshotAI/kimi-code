/**
 * `task` domain (L5) — `AgentTaskPersistence`, the per-session
 * persistence helper behind `AgentTaskService`.
 *
 * Persists task state (`<taskId>.json`) and raw task output (`output.log`)
 * through the `storage` access-pattern stores (`IAtomicDocumentStore` for
 * atomic whole-document state, `IFileSystemStorageService` byte primitives for ordered
 * output append), addressed under the session's storage scope so the domain
 * never touches the filesystem. Task ids are validated against the
 * `{prefix}-{8 hex}` shape before use as path segments (path-traversal and
 * legacy `bg_<hex>` guard), and legacy snake_case records are normalized to
 * the current shape on read. Not scope-bound; constructed by
 * `AgentTaskService`.
 */

import { join } from 'pathe';

import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { AgentTaskInfo, AgentTaskStatus } from './types';

const VALID_TASK_ID: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;

const TASKS_SCOPE = 'tasks';
const OUTPUT_LOG_KEY = 'output.log';
const JSON_SUFFIX = '.json';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type PersistedTask = AgentTaskInfo;

type DiskPersistedTask = PersistedTask | LegacyPersistedTask;

function validateTaskId(taskId: string): void {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new Error(`Invalid task id: "${taskId}"`);
  }
}

export class AgentTaskPersistence {
  constructor(
    private readonly sessionDir: string,
    private readonly sessionScope: string,
    private readonly docs: IAtomicDocumentStore,
    private readonly bytes: IFileSystemStorageService,
  ) {}

  private tasksScope(): string {
    return `${this.sessionScope}/${TASKS_SCOPE}`;
  }

  private taskOutputScope(taskId: string): string {
    validateTaskId(taskId);
    return `${this.sessionScope}/${TASKS_SCOPE}/${taskId}`;
  }

  taskOutputFile(taskId: string): string {
    validateTaskId(taskId);
    return join(this.sessionDir, TASKS_SCOPE, taskId, OUTPUT_LOG_KEY);
  }

  async writeTask(task: PersistedTask): Promise<void> {
    validateTaskId(task.taskId);
    await this.docs.set(this.tasksScope(), `${task.taskId}${JSON_SUFFIX}`, task);
  }

  async readTask(taskId: string): Promise<PersistedTask | undefined> {
    validateTaskId(taskId);
    const task = await this.docs.get<DiskPersistedTask>(
      this.tasksScope(),
      `${taskId}${JSON_SUFFIX}`,
    );
    if (task === undefined || !isReadablePersistedTask(task)) return undefined;
    return normalizePersistedTask(task);
  }

  async appendTaskOutput(taskId: string, chunk: string): Promise<void> {
    if (chunk.length === 0) return;
    await this.bytes.append(this.taskOutputScope(taskId), OUTPUT_LOG_KEY, textEncoder.encode(chunk));
  }

  async taskOutputSizeBytes(taskId: string): Promise<number> {
    const data = await this.bytes.read(this.taskOutputScope(taskId), OUTPUT_LOG_KEY);
    return data === undefined ? 0 : data.byteLength;
  }

  async taskOutputExists(taskId: string): Promise<boolean> {
    const entries = await this.bytes.list(this.taskOutputScope(taskId));
    return entries.includes(OUTPUT_LOG_KEY);
  }

  async readTaskOutputBytes(taskId: string, offset: number, maxBytes: number): Promise<string> {
    const start = Math.max(0, Math.trunc(offset));
    const limit = Math.max(0, Math.trunc(maxBytes));
    if (limit === 0) return '';
    const data = await this.bytes.read(this.taskOutputScope(taskId), OUTPUT_LOG_KEY);
    if (data === undefined || start >= data.byteLength) return '';
    const end = Math.min(data.byteLength, start + limit);
    return textDecoder.decode(data.subarray(start, end));
  }

  async listTasks(): Promise<readonly PersistedTask[]> {
    const keys = (await this.docs.list(this.tasksScope())).toSorted();
    const tasks: PersistedTask[] = [];
    for (const key of keys) {
      if (!key.endsWith(JSON_SUFFIX)) continue;
      const id = key.slice(0, -JSON_SUFFIX.length);
      if (!VALID_TASK_ID.test(id)) continue;
      let task: DiskPersistedTask | undefined;
      try {
        task = await this.docs.get<DiskPersistedTask>(this.tasksScope(), key);
      } catch {
        // Skip files that fail to read / parse (corrupt or partially written).
        continue;
      }
      if (task === undefined || !isReadablePersistedTask(task)) continue;
      tasks.push(normalizePersistedTask(task));
    }
    return tasks;
  }
}

function normalizePersistedTask(task: DiskPersistedTask): PersistedTask {
  if (isLegacyPersistedTask(task)) return legacyPersistedTaskToInfo(task);
  return {
    ...task,
    detached: task.detached ?? true,
  };
}

type LegacyAgentTaskStatus =
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
  readonly status: LegacyAgentTaskStatus;
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

function legacyStatusToCurrent(task: LegacyPersistedTask): AgentTaskStatus {
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
