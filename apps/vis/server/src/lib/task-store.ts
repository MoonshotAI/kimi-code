import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from './agent-record-types';

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
    const task = normalizePersistedTask(parsed);
    if (task === undefined || task.taskId !== id) continue;
    tasks.push({ keyId: id, task });
  }
  return { reservedIds, tasks };
}

export interface TaskOutputMetadata {
  exists: boolean;
  size: number;
}

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

export async function taskOutputSizeBytes(
  agentDir: string,
  taskId: string,
  fallbackDir?: string,
): Promise<number> {
  return (await taskOutputMetadata(agentDir, taskId, fallbackDir)).size;
}

export interface TaskOutputWindow {
  offset: number;
  nextOffset: number;
  size: number;
  content: string;
  eof: boolean;
}

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

type ReadablePersistedTask = Record<string, unknown>;

interface CurrentTaskBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  readonly detached: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly resumeReminded?: boolean;
  readonly timeoutMs?: number;
}

const CURRENT_TASK_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);

function normalizePersistedTask(task: ReadablePersistedTask): BackgroundTaskInfo | undefined {
  const current = isLegacyPersistedTask(task) ? legacyPersistedTaskToCurrent(task) : task;
  return decodeCurrentPersistedTask(current);
}

function decodeCurrentPersistedTask(task: ReadablePersistedTask): BackgroundTaskInfo | undefined {
  const base = decodeCurrentTaskBase(task);
  if (base === undefined) return undefined;

  switch (task['kind']) {
    case 'process':
      if (
        typeof task['command'] !== 'string' ||
        !isFiniteNumber(task['pid']) ||
        !isNullableFiniteNumber(task['exitCode'])
      ) {
        return undefined;
      }
      return {
        ...base,
        kind: 'process',
        command: task['command'],
        pid: task['pid'],
        exitCode: task['exitCode'],
        parentToolCallId: optionalString(task['parentToolCallId']),
      };
    case 'agent':
      return {
        ...base,
        kind: 'agent',
        agentId: optionalString(task['agentId']),
        subagentType: optionalString(task['subagentType']),
        parentToolCallId: optionalString(task['parentToolCallId']),
        model: optionalString(task['model']),
        thinkingEffort: optionalString(task['thinkingEffort']),
        stopCode: optionalString(task['stopCode']),
      };
    case 'question':
      if (!isFiniteNumber(task['questionCount'])) return undefined;
      return {
        ...base,
        kind: 'question',
        questionCount: task['questionCount'],
        toolCallId: optionalString(task['toolCallId']),
      };
    default:
      return undefined;
  }
}

function decodeCurrentTaskBase(task: ReadablePersistedTask): CurrentTaskBase | undefined {
  if (
    typeof task['taskId'] !== 'string' ||
    !VALID_TASK_ID.test(task['taskId']) ||
    typeof task['description'] !== 'string' ||
    !isCurrentTaskStatus(task['status']) ||
    !isFiniteNumber(task['startedAt']) ||
    !isNullableFiniteNumber(task['endedAt'])
  ) {
    return undefined;
  }
  return {
    taskId: task['taskId'],
    description: task['description'],
    status: task['status'],
    detached: optionalBoolean(task['detached']) ?? true,
    startedAt: task['startedAt'],
    endedAt: task['endedAt'],
    stopReason: optionalString(task['stopReason']),
    terminalNotificationSuppressed: optionalBoolean(task['terminalNotificationSuppressed']),
    resumeReminded: optionalBoolean(task['resumeReminded']),
    timeoutMs: optionalNumber(task['timeoutMs']),
  };
}

function legacyPersistedTaskToCurrent(
  task: ReadablePersistedTask & { readonly task_id: string },
): ReadablePersistedTask {
  const base: ReadablePersistedTask = {
    taskId: task.task_id,
    description: task['description'],
    status: legacyStatusToCurrent(task),
    detached: true,
    startedAt: task['started_at'],
    endedAt: task['ended_at'],
    stopReason: optionalNonEmptyString(task['stop_reason']),
    timeoutMs: optionalNumber(task['timeout_ms']),
  };
  if (task.task_id.startsWith('agent-')) {
    return {
      ...base,
      kind: 'agent',
      agentId: optionalNonEmptyString(task['agent_id']),
      subagentType: optionalNonEmptyString(task['subagent_type']),
    };
  }
  return {
    ...base,
    kind: 'process',
    command: task['command'],
    pid: task['pid'],
    exitCode: task['exit_code'],
  };
}

function legacyStatusToCurrent(task: ReadablePersistedTask): unknown {
  if (task['status'] === 'awaiting_approval') return 'running';
  if (task['status'] === 'failed' && task['timed_out'] === true) return 'timed_out';
  return task['status'];
}

function isReadablePersistedTask(obj: unknown): obj is ReadablePersistedTask {
  return (
    isRecord(obj) &&
    (typeof obj['taskId'] === 'string' || typeof obj['task_id'] === 'string')
  );
}

function isLegacyPersistedTask(
  task: ReadablePersistedTask,
): task is ReadablePersistedTask & { readonly task_id: string } {
  return typeof task['task_id'] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isCurrentTaskStatus(value: unknown): value is BackgroundTaskStatus {
  return (
    typeof value === 'string' &&
    CURRENT_TASK_STATUSES.has(value as BackgroundTaskStatus)
  );
}
