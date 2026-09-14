import { join } from 'pathe';

import { BugIndicatingError } from '#/errors';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { AgentTaskInfo } from './types';

const TASKS_SCOPE = 'tasks';
const OUTPUT_LOG_KEY = 'output.log';
const JSON_SUFFIX = '.json';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type PersistedTask = AgentTaskInfo;

export interface AgentTaskPersistenceRoot {
  readonly dir: string;
  readonly scope: string;
}

export interface AgentTaskStoredOutputSnapshot {
  readonly outputPath: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly preview: string;
}

interface ListedTask {
  readonly keyId: string;
  readonly task: PersistedTask;
}

interface TaskOutputData {
  readonly root: AgentTaskPersistenceRoot;
  readonly data: Uint8Array;
}

function isPathSafeTaskId(taskId: string): boolean {
  if (taskId.length === 0) return false;
  if (taskId === '.' || taskId === '..') return false;
  return !/[/\\\0]/.test(taskId);
}

function validateTaskId(taskId: string): void {
  if (!isPathSafeTaskId(taskId)) {
    throw new BugIndicatingError(`Invalid task id: "${taskId}"`);
  }
}

export class AgentTaskPersistence {
  constructor(
    private readonly agentDir: string,
    private readonly agentScope: string,
    private readonly docs: IAtomicDocumentStore,
    private readonly bytes: IFileSystemStorageService,
    private readonly fallbackRoot?: AgentTaskPersistenceRoot,
  ) {}

  private primaryRoot(): AgentTaskPersistenceRoot {
    return { dir: this.agentDir, scope: this.agentScope };
  }

  private tasksScope(root: AgentTaskPersistenceRoot = this.primaryRoot()): string {
    return `${root.scope}/${TASKS_SCOPE}`;
  }

  private taskOutputScope(
    taskId: string,
    root: AgentTaskPersistenceRoot = this.primaryRoot(),
  ): string {
    validateTaskId(taskId);
    return `${root.scope}/${TASKS_SCOPE}/${taskId}`;
  }

  private taskOutputFileAt(taskId: string, root: AgentTaskPersistenceRoot): string {
    validateTaskId(taskId);
    return join(root.dir, TASKS_SCOPE, taskId, OUTPUT_LOG_KEY);
  }

  taskOutputFile(taskId: string): string {
    return this.taskOutputFileAt(taskId, this.primaryRoot());
  }

  async writeTask(task: PersistedTask): Promise<void> {
    validateTaskId(task.taskId);
    await this.docs.set(this.tasksScope(), `${task.taskId}${JSON_SUFFIX}`, task);
  }

  async readTask(taskId: string): Promise<PersistedTask | undefined> {
    validateTaskId(taskId);
    const key = `${taskId}${JSON_SUFFIX}`;
    const task = await this.docs.get<PersistedTask>(this.tasksScope(), key);
    if (task !== undefined) {
      return isReadablePersistedTask(task) ? normalizePersistedTask(task) : undefined;
    }
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot === undefined) return undefined;
    const fallback = await this.docs.get<PersistedTask>(this.tasksScope(fallbackRoot), key);
    if (fallback === undefined || !isReadablePersistedTask(fallback)) return undefined;
    return normalizePersistedTask(fallback);
  }

  async appendTaskOutput(taskId: string, chunk: string): Promise<void> {
    if (chunk.length === 0) return;
    await this.bytes.append(this.taskOutputScope(taskId), OUTPUT_LOG_KEY, textEncoder.encode(chunk));
  }

  async taskOutputSizeBytes(taskId: string): Promise<number> {
    const output = await this.readTaskOutputData(taskId);
    return output?.data.byteLength ?? 0;
  }

  async taskOutputExists(taskId: string): Promise<boolean> {
    return (await this.readTaskOutputData(taskId)) !== undefined;
  }

  async readTaskOutputBytes(taskId: string, offset: number, maxBytes: number): Promise<string> {
    const start = Math.max(0, Math.trunc(offset));
    const limit = Math.max(0, Math.trunc(maxBytes));
    if (limit === 0) return '';
    const output = await this.readTaskOutputData(taskId);
    if (output === undefined || start >= output.data.byteLength) return '';
    const end = Math.min(output.data.byteLength, start + limit);
    return textDecoder.decode(output.data.subarray(start, end));
  }

  async readTaskOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<AgentTaskStoredOutputSnapshot | undefined> {
    const output = await this.readTaskOutputData(taskId);
    if (output === undefined) return undefined;
    const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
    const previewBytes = Math.min(previewLimit, output.data.byteLength);
    const previewOffset = output.data.byteLength - previewBytes;
    return {
      outputPath: this.taskOutputFileAt(taskId, output.root),
      outputSizeBytes: output.data.byteLength,
      previewBytes,
      truncated: previewOffset > 0,
      preview: textDecoder.decode(output.data.subarray(previewOffset)),
    };
  }

  async listTasks(): Promise<readonly PersistedTask[]> {
    const primary = await this.listTasksAt(this.primaryRoot());
    const tasks = [...primary.tasks];
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot !== undefined) {
      const fallback = await this.listTasksAt(fallbackRoot);
      for (const entry of fallback.tasks) {
        if (!primary.reservedIds.has(entry.keyId)) tasks.push(entry);
      }
    }
    return tasks.map((entry) => entry.task).toSorted((a, b) => a.taskId.localeCompare(b.taskId));
  }

  private async listTasksAt(root: AgentTaskPersistenceRoot): Promise<{
    readonly reservedIds: ReadonlySet<string>;
    readonly tasks: readonly ListedTask[];
  }> {
    const keys = (await this.docs.list(this.tasksScope(root))).toSorted();
    const reservedIds = new Set<string>();
    const tasks: ListedTask[] = [];
    for (const key of keys) {
      if (!key.endsWith(JSON_SUFFIX)) continue;
      const id = key.slice(0, -JSON_SUFFIX.length);
      if (!isPathSafeTaskId(id)) continue;
      reservedIds.add(id);
      let task: PersistedTask | undefined;
      try {
        task = await this.docs.get<PersistedTask>(this.tasksScope(root), key);
      } catch {
        continue;
      }
      if (task === undefined || !isReadablePersistedTask(task)) continue;
      tasks.push({ keyId: id, task: normalizePersistedTask(task) });
    }
    return { reservedIds, tasks };
  }

  private async readTaskOutputData(taskId: string): Promise<TaskOutputData | undefined> {
    const primaryRoot = this.primaryRoot();
    const primary = await this.bytes.read(this.taskOutputScope(taskId, primaryRoot), OUTPUT_LOG_KEY);
    if (primary !== undefined) return { root: primaryRoot, data: primary };
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot === undefined) return undefined;
    const fallback = await this.bytes.read(
      this.taskOutputScope(taskId, fallbackRoot),
      OUTPUT_LOG_KEY,
    );
    return fallback === undefined ? undefined : { root: fallbackRoot, data: fallback };
  }
}

function normalizePersistedTask(task: PersistedTask): PersistedTask {
  return {
    ...task,
    detached: task.detached ?? true,
  };
}

function isReadablePersistedTask(obj: unknown): obj is PersistedTask {
  return isRecord(obj) && typeof obj['taskId'] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
