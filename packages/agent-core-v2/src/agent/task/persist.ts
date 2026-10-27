import { join } from 'pathe';
import type { EnvironmentPath } from '#/environment/environment';

import { BugIndicatingError } from '#/errors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { AgentTaskInfo, AgentTaskStatus } from './types';

const VALID_TASK_ID: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;

const TASK_READ_CONCURRENCY = 16;

const TASKS_SCOPE = 'tasks';
const OUTPUT_LOG_KEY = 'output.log';
const JSON_SUFFIX = '.json';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type PersistedTask = AgentTaskInfo;

type DiskPersistedTask = PersistedTask | LegacyPersistedTask;

export interface AgentTaskPersistenceRoot {
  readonly dir: string;
  readonly scope: string;
}

export interface AgentTaskSpillTarget {
  readonly fs: IHostFileSystem;
  readonly dir: string;
  readonly path?: Pick<EnvironmentPath, 'join'>;
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

function validateTaskId(taskId: string): void {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new BugIndicatingError(`Invalid task id: "${taskId}"`);
  }
}

export function isTaskOutputFilePath(path: string, agentDir: string, pathApi: Pick<EnvironmentPath, 'isAbsolute' | 'relative'>): boolean {
  if (!pathApi.isAbsolute(path) || path.includes('\0')) return false;
  const parts = pathApi.relative(agentDir, path).replaceAll('\\', '/').split('/');
  return parts.length === 3 && parts[0] === TASKS_SCOPE && VALID_TASK_ID.test(parts[1]!) && parts[2] === OUTPUT_LOG_KEY;
}

export class AgentTaskPersistence {
  private readonly mirrors = new WeakMap<IHostFileSystem, Map<string, { readonly scope: string; readonly size: number }>>();
  private readonly outputSizes = new Map<string, number>();
  private readonly outputTails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly agentDir: string,
    private readonly agentScope: string,
    private readonly docs: IAtomicDocumentStore,
    private readonly bytes: IFileSystemStorageService,
    private readonly fallbackRoot?: AgentTaskPersistenceRoot,
    private readonly spillTarget?: () => AgentTaskSpillTarget | undefined,
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

  private async outputPathFor(taskId: string, output: TaskOutputData): Promise<string> {
    const target = this.spillTarget?.();
    if (target !== undefined && await this.mirrorOutput(taskId, output, target)) {
      return (target.path?.join ?? join)(target.dir, `${taskId}.log`);
    }
    return this.taskOutputFileAt(taskId, output.root);
  }

  private async mirrorOutput(taskId: string, output: TaskOutputData, target: AgentTaskSpillTarget): Promise<boolean> {
    const mirrors = this.mirrors.get(target.fs) ?? new Map<string, { readonly scope: string; readonly size: number }>();
    this.mirrors.set(target.fs, mirrors);
    const path = (target.path?.join ?? join)(target.dir, `${taskId}.log`);
    const mirrored = mirrors.get(path);
    if (mirrored?.scope === output.root.scope && mirrored.size === output.data.byteLength) return true;
    try {
      await target.fs.mkdir(target.dir, { recursive: true });
      await target.fs.writeText(path, textDecoder.decode(output.data));
      mirrors.set(path, { scope: output.root.scope, size: output.data.byteLength });
      return true;
    } catch {
      mirrors.delete(path);
      return false;
    }
  }

  private serializeOutput<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    validateTaskId(taskId);
    const run = (this.outputTails.get(taskId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.outputTails.set(taskId, run);
    return run.finally(() => {
      if (this.outputTails.get(taskId) === run) this.outputTails.delete(taskId);
    });
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
    const task = await this.docs.get<DiskPersistedTask>(this.tasksScope(), key);
    if (task !== undefined) {
      return isReadablePersistedTask(task) ? normalizePersistedTask(task) : undefined;
    }
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot === undefined) return undefined;
    const fallback = await this.docs.get<DiskPersistedTask>(this.tasksScope(fallbackRoot), key);
    if (fallback === undefined || !isReadablePersistedTask(fallback)) return undefined;
    return normalizePersistedTask(fallback);
  }

  async appendTaskOutput(taskId: string, chunk: string): Promise<void> {
    if (chunk.length === 0) return;
    await this.serializeOutput(taskId, async () => {
      const scope = this.taskOutputScope(taskId);
      const previousSize = this.outputSizes.get(taskId) ?? (await this.bytes.read(scope, OUTPUT_LOG_KEY))?.byteLength ?? 0;
      const data = textEncoder.encode(chunk);
      await this.bytes.append(scope, OUTPUT_LOG_KEY, data);
      const size = previousSize + data.byteLength;
      this.outputSizes.set(taskId, size);
      const target = this.spillTarget?.();
      if (target === undefined) return;
      const path = (target.path?.join ?? join)(target.dir, `${taskId}.log`);
      const mirrors = this.mirrors.get(target.fs);
      const mirrored = mirrors?.get(path);
      if (mirrored?.scope === this.agentScope && mirrored.size === previousSize) {
        try {
          await target.fs.appendText(path, chunk);
          mirrors!.set(path, { scope: this.agentScope, size });
        } catch {
          mirrors!.delete(path);
        }
        return;
      }
      const output = await this.readTaskOutputData(taskId);
      if (output !== undefined) await this.mirrorOutput(taskId, output, target);
    });
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
    return this.serializeOutput(taskId, async () => {
      const output = await this.readTaskOutputData(taskId);
      if (output === undefined) return undefined;
      const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
      const previewBytes = Math.min(previewLimit, output.data.byteLength);
      const previewOffset = output.data.byteLength - previewBytes;
      return {
        outputPath: await this.outputPathFor(taskId, output),
        outputSizeBytes: output.data.byteLength,
        previewBytes,
        truncated: previewOffset > 0,
        preview: textDecoder.decode(output.data.subarray(previewOffset)),
      };
    });
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
    const candidates: { readonly keyId: string; readonly key: string }[] = [];
    for (const key of keys) {
      if (!key.endsWith(JSON_SUFFIX)) continue;
      const id = key.slice(0, -JSON_SUFFIX.length);
      if (!VALID_TASK_ID.test(id)) continue;
      reservedIds.add(id);
      candidates.push({ keyId: id, key });
    }
    const fetched = Array.from<DiskPersistedTask | undefined>({ length: candidates.length });
    let next = 0;
    const workers = Array.from(
      { length: Math.min(TASK_READ_CONCURRENCY, candidates.length) },
      async () => {
        while (next < candidates.length) {
          const index = next++;
          const candidate = candidates[index]!;
          try {
            fetched[index] = await this.docs.get<DiskPersistedTask>(
              this.tasksScope(root),
              candidate.key,
            );
          } catch {
            fetched[index] = undefined;
          }
        }
      },
    );
    await Promise.all(workers);
    const tasks: ListedTask[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const task = fetched[index];
      if (task === undefined || !isReadablePersistedTask(task)) continue;
      tasks.push({ keyId: candidates[index]!.keyId, task: normalizePersistedTask(task) });
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
