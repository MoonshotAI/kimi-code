import { join } from 'node:path';

import {
  AgentTaskPersistence,
  Error2,
  ErrorCodes,
  IAtomicDocumentStore,
  IBootstrapService,
  IFileSystemStorageService,
  ISessionIndex,
  ISessionManager,
  agentScopeOf,
  getLiveSessionById,
  getOrRestoreAgent,
  isError2,
  isValidTaskId,
  reconcilePersistedTask,
  resumeSessionById,
  sessionDirOf,
  sessionScopeOf,
  workspacePersistenceScope,
  type AgentTaskInfo,
  type AgentTaskOutputChunk,
  type AgentTaskOutputTail,
  IAgentTaskService,
  type IDisposable,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { isPlainAgentId } from '@moonshot-ai/transcript';

import { ErrorCode } from '../../../protocol/error-codes';
import {
  TASK_OUTPUT_DEFAULT_TAIL_BYTES,
  taskBackgroundMessageSchema,
  taskStopMessageSchema,
  taskUnwatchMessageSchema,
  taskWatchMessageSchema,
  type TaskOutputMessage,
  type TaskState,
  type TaskWatchMessage,
} from '../../../protocol/ws-task';
import { ensureMainAgent, MAIN_AGENT_ID } from '../../mainAgent';
import { toTaskState } from './taskState';

type TaskService = Pick<
  IAgentTaskService,
  'getTask' | 'readOutputTail' | 'onDidAppendOutput' | 'stopByUser' | 'detach'
>;

export type TaskSourceResult =
  | { readonly kind: 'session_not_found' }
  | { readonly kind: 'task_not_found' }
  | { readonly kind: 'found'; readonly tasks: TaskService };

export type TaskSource = (
  sessionId: string,
  agentId: string,
  taskId: string,
  mode?: 'read' | 'command',
) => Promise<TaskSourceResult>;

export function createTaskSource(core: Scope): TaskSource {
  return async (sessionId, agentId, taskId, mode = 'command') => {
    if (!isPlainAgentId(agentId) || (mode === 'read' && !isValidTaskId(taskId))) {
      return { kind: 'task_not_found' };
    }
    let live = mode === 'read' ? getLiveSessionById(core.accessor, sessionId) : undefined;
    if (mode === 'read' && live === undefined) {
      const cold = await readColdTask(core, sessionId, agentId, taskId);
      live = getLiveSessionById(core.accessor, sessionId);
      if (live === undefined) return cold;
    }
    const session = live ?? await resumeSessionById(core.accessor, sessionId);
    if (session === undefined) return { kind: 'session_not_found' };
    const agent =
      agentId === MAIN_AGENT_ID
        ? await ensureMainAgent(session)
        : await getOrRestoreAgent(session, agentId);
    const tasks = agent?.accessor.get(IAgentTaskService);
    if (tasks?.getTask(taskId) === undefined) return { kind: 'task_not_found' };
    return { kind: 'found', tasks };
  };
}

function coldTaskPersistence(
  core: Scope,
  workspaceId: string,
  sessionId: string,
  agentId: string,
): AgentTaskPersistence {
  const bootstrap = core.accessor.get(IBootstrapService);
  const handlerScope = workspacePersistenceScope(bootstrap.scope('sessions'), workspaceId);
  const sessionDir = sessionDirOf(bootstrap.homeDir, handlerScope, sessionId);
  return new AgentTaskPersistence(
    join(sessionDir, 'agents', agentId),
    agentScopeOf(sessionScopeOf(handlerScope, sessionId), agentId),
    core.accessor.get(IAtomicDocumentStore),
    core.accessor.get(IFileSystemStorageService),
    agentId === MAIN_AGENT_ID
      ? { dir: sessionDir, scope: sessionScopeOf(handlerScope, sessionId) }
      : undefined,
  );
}

export async function readColdTaskList(
  core: Scope,
  sessionId: string,
  agentId: string,
): Promise<readonly AgentTaskInfo[] | undefined> {
  if (!isPlainAgentId(agentId)) return undefined;
  const summary = await core.accessor.get(ISessionManager).status?.(sessionId);
  if (summary === undefined) return undefined;
  const tasks = await coldTaskPersistence(core, summary.workspaceId, sessionId, agentId).listTasks();
  return tasks.map(reconcilePersistedTask).filter((task) => task.status === 'running');
}

async function readColdTask(
  core: Scope,
  sessionId: string,
  agentId: string,
  taskId: string,
): Promise<TaskSourceResult> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) return { kind: 'session_not_found' };
  const persistence = coldTaskPersistence(core, summary.workspaceId, sessionId, agentId);
  const task = await persistence.readTask(taskId);
  if (task === undefined) return { kind: 'task_not_found' };
  const reconciled = reconcilePersistedTask(task);
  const unavailable = (): never => {
    throw new Error2(
      ErrorCodes.SESSION_WORKSPACE_UNAVAILABLE,
      `session ${sessionId} workspace is unavailable`,
      { details: { cause_code: ErrorCodes.WORKSPACE_NOT_FOUND, retryable: false } },
    );
  };
  return {
    kind: 'found',
    tasks: {
      getTask: () => reconciled,
      readOutputTail: async (id, maxBytes) =>
        (await persistence.readTaskOutputTail(id, maxBytes)) ?? { offset: 0, data: new Uint8Array() },
      onDidAppendOutput: () => ({ dispose: () => {} }),
      stopByUser: unavailable,
      detach: unavailable,
    },
  };
}

export interface TaskRequestSink {
  respond(requestId: string, code: number, msg?: string, task?: TaskState): void;
  output(frame: TaskOutputMessage): void;
}

type TaskAddress = Pick<TaskWatchMessage, 'session_id' | 'agent_id' | 'task_id'>;

export class TaskRequests {
  private readonly watches = new Map<string, IDisposable>();
  private readonly queues = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly source: TaskSource,
    private readonly sink: TaskRequestSink,
  ) {}

  handle(requestId: string, frame: unknown): void {
    const watch = taskWatchMessageSchema.safeParse(frame);
    if (watch.success) {
      this.enqueue(watchKey(watch.data), () => this.watch(watch.data));
      return;
    }
    const unwatch = taskUnwatchMessageSchema.safeParse(frame);
    if (unwatch.success) {
      const key = watchKey(unwatch.data);
      this.enqueue(key, async () => {
        this.unwatch(key);
        this.sink.respond(requestId, ErrorCode.SUCCESS);
      });
      return;
    }
    const stop = taskStopMessageSchema.safeParse(frame);
    if (stop.success) {
      this.enqueue(watchKey(stop.data), () =>
        this.command(requestId, stop.data, async (tasks, taskId) => tasks.stopByUser(taskId)),
      );
      return;
    }
    const background = taskBackgroundMessageSchema.safeParse(frame);
    if (background.success) {
      this.enqueue(watchKey(background.data), () =>
        this.command(
          requestId,
          background.data,
          async (tasks, taskId) => tasks.detach(taskId),
          (info) =>
            info.status === 'running' && info.detached === false
              ? { code: ErrorCode.TASK_NOT_DETACHABLE, msg: 'task cannot be moved to the background' }
              : undefined,
        ),
      );
      return;
    }
    this.sink.respond(requestId, ErrorCode.VALIDATION_FAILED, 'invalid task message');
  }

  dispose(): void {
    this.disposed = true;
    for (const watch of this.watches.values()) watch.dispose();
    this.watches.clear();
  }

  private enqueue(key: string, run: () => Promise<void>): void {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(run).catch(() => undefined);
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  private async watch(request: TaskWatchMessage): Promise<void> {
    if (this.disposed) return;
    const { request_id: requestId, session_id: sessionId, agent_id: agentId, task_id: taskId } = request;
    const key = watchKey(request);
    this.unwatch(key);
    const fail = (code: number, msg: string): void => {
      this.unwatch(key);
      this.sink.respond(requestId, code, msg);
    };

    let resolved: TaskSourceResult;
    try {
      resolved = await this.source(sessionId, agentId, taskId, 'read');
    } catch (error) {
      fail(taskRequestErrorCode(error), taskRequestErrorMessage(error));
      return;
    }
    if (resolved.kind === 'session_not_found') {
      fail(ErrorCode.SESSION_NOT_FOUND, 'session not found');
      return;
    }
    if (resolved.kind === 'task_not_found') {
      fail(ErrorCode.TASK_NOT_FOUND, 'task not found');
      return;
    }
    if (this.disposed) return;

    try {
      const pending: AgentTaskOutputChunk[] = [];
      let live = false;
      const forward = (chunk: { readonly offset: number; readonly text: string }): void => {
        this.sink.output({
          type: 'task.output',
          session_id: sessionId,
          agent_id: agentId,
          task_id: taskId,
          offset: chunk.offset,
          text: chunk.text,
        });
      };
      this.watches.set(
        key,
        resolved.tasks.onDidAppendOutput((chunk) => {
          if (chunk.taskId !== taskId) return;
          if (live) forward(chunk);
          else pending.push(chunk);
        }),
      );

      let tail: AgentTaskOutputTail;
      try {
        tail = await resolved.tasks.readOutputTail(
          taskId,
          request.tail_bytes ?? TASK_OUTPUT_DEFAULT_TAIL_BYTES,
        );
      } catch {
        fail(ErrorCode.PERSISTENCE_FAILURE, 'task output unavailable');
        return;
      }
      if (this.disposed) return;

      const first = firstChunk(tail.offset, tail.data, request.since_offset);
      const info = resolved.tasks.getTask(taskId);
      this.sink.respond(requestId, ErrorCode.SUCCESS, undefined, info === undefined ? undefined : toTaskState(info));
      forward(first);
      for (const chunk of pending) {
        const rest = chunkAfter(chunk, first.end);
        if (rest !== undefined) forward(rest);
      }
      live = true;
    } catch {
      fail(ErrorCode.INTERNAL_ERROR, 'internal error');
    }
  }

  private async command(
    requestId: string,
    request: TaskAddress,
    run: (tasks: TaskService, taskId: string) => Promise<AgentTaskInfo | undefined>,
    refuse?: (info: AgentTaskInfo) => { readonly code: number; readonly msg: string } | undefined,
  ): Promise<void> {
    if (this.disposed) return;
    try {
      const resolved = await this.source(request.session_id, request.agent_id, request.task_id, 'command');
      if (resolved.kind === 'session_not_found') {
        this.sink.respond(requestId, ErrorCode.SESSION_NOT_FOUND, 'session not found');
        return;
      }
      if (resolved.kind === 'task_not_found') {
        this.sink.respond(requestId, ErrorCode.TASK_NOT_FOUND, 'task not found');
        return;
      }
      const info = (await run(resolved.tasks, request.task_id)) ?? resolved.tasks.getTask(request.task_id);
      const state = info === undefined ? undefined : toTaskState(info);
      const refusal = info === undefined ? undefined : refuse?.(info);
      if (refusal !== undefined) {
        this.sink.respond(requestId, refusal.code, refusal.msg, state);
        return;
      }
      this.sink.respond(requestId, ErrorCode.SUCCESS, undefined, state);
    } catch (error) {
      this.sink.respond(requestId, taskRequestErrorCode(error), taskRequestErrorMessage(error));
    }
  }

  private unwatch(key: string): void {
    this.watches.get(key)?.dispose();
    this.watches.delete(key);
  }
}

function taskRequestErrorCode(error: unknown): number {
  return isError2(error) && error.code === ErrorCodes.SESSION_WORKSPACE_UNAVAILABLE
    ? ErrorCode.SESSION_WORKSPACE_UNAVAILABLE
    : ErrorCode.INTERNAL_ERROR;
}

function taskRequestErrorMessage(error: unknown): string {
  return isError2(error) && error.code === ErrorCodes.SESSION_WORKSPACE_UNAVAILABLE
    ? error.message
    : 'internal error';
}

function firstChunk(
  tailOffset: number,
  data: Uint8Array,
  sinceOffset: number | undefined,
): { readonly offset: number; readonly text: string; readonly end: number } {
  const stop = completeUtf8Length(data);
  let start = 0;
  if (
    sinceOffset !== undefined &&
    sinceOffset >= tailOffset &&
    sinceOffset <= tailOffset + stop &&
    isCharBoundary(data, sinceOffset - tailOffset)
  ) {
    start = sinceOffset - tailOffset;
  } else {
    while (start < stop && isUtf8Continuation(data[start]!)) start += 1;
  }
  return {
    offset: tailOffset + start,
    text: Buffer.from(data.buffer, data.byteOffset + start, stop - start).toString('utf-8'),
    end: tailOffset + stop,
  };
}

function chunkAfter(
  chunk: AgentTaskOutputChunk,
  end: number,
): { readonly offset: number; readonly text: string } | undefined {
  if (chunk.offset >= end) return chunk;
  const bytes = Buffer.from(chunk.text, 'utf-8');
  if (chunk.offset + bytes.byteLength <= end) return undefined;
  return { offset: end, text: bytes.subarray(end - chunk.offset).toString('utf-8') };
}

function completeUtf8Length(data: Uint8Array): number {
  let lead = data.byteLength - 1;
  while (lead >= 0 && data.byteLength - lead < 4 && isUtf8Continuation(data[lead]!)) lead -= 1;
  if (lead < 0) return data.byteLength;
  return lead + utf8SequenceLength(data[lead]!) <= data.byteLength ? data.byteLength : lead;
}

function utf8SequenceLength(leadByte: number): number {
  if (leadByte >= 0xf0) return 4;
  if (leadByte >= 0xe0) return 3;
  if (leadByte >= 0xc0) return 2;
  return 1;
}

function isCharBoundary(data: Uint8Array, index: number): boolean {
  return index >= data.byteLength || !isUtf8Continuation(data[index]!);
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function watchKey(address: TaskAddress): string {
  return `${address.session_id}\u0000${address.agent_id}\u0000${address.task_id}`;
}
