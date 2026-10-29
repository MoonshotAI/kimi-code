import {
  getOrRestoreAgent,
  IAgentTaskService,
  resumeSessionById,
  type AgentTaskOutputChunk,
  type AgentTaskOutputTail,
  type IDisposable,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { ErrorCode } from '../../../protocol/error-codes';
import {
  TASK_OUTPUT_DEFAULT_TAIL_BYTES,
  taskUnwatchMessageSchema,
  taskWatchMessageSchema,
  type TaskOutputMessage,
  type TaskWatchMessage,
} from '../../../protocol/ws-task';
import { ensureMainAgent, MAIN_AGENT_ID } from '../../mainAgent';

export type TaskOutputSourceResult =
  | { readonly kind: 'session_not_found' }
  | { readonly kind: 'task_not_found' }
  | { readonly kind: 'found'; readonly tasks: IAgentTaskService };

export type TaskOutputSource = (
  sessionId: string,
  agentId: string,
  taskId: string,
) => Promise<TaskOutputSourceResult>;

export function createTaskOutputSource(core: Scope): TaskOutputSource {
  return async (sessionId, agentId, taskId) => {
    const session = await resumeSessionById(core.accessor, sessionId);
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

export interface TaskOutputSink {
  respond(requestId: string, code: number, msg?: string): void;
  output(frame: TaskOutputMessage): void;
}

type TaskAddress = Pick<TaskWatchMessage, 'session_id' | 'agent_id' | 'task_id'>;

export class TaskOutputWatches {
  private readonly watches = new Map<string, IDisposable>();
  private readonly queues = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly source: TaskOutputSource,
    private readonly sink: TaskOutputSink,
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
    this.sink.respond(requestId, ErrorCode.VALIDATION_FAILED, 'invalid task output message');
  }

  dispose(): void {
    this.disposed = true;
    for (const watch of this.watches.values()) watch.dispose();
    this.watches.clear();
  }

  private enqueue(key: string, run: () => Promise<void>): void {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(run).catch(() => {
    });
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  private async watch(request: TaskWatchMessage): Promise<void> {
    const { request_id: requestId, session_id: sessionId, agent_id: agentId, task_id: taskId } = request;
    const key = watchKey(request);
    this.unwatch(key);
    const fail = (code: number, msg: string): void => {
      this.sink.respond(requestId, code, msg);
    };

    let resolved: TaskOutputSourceResult;
    try {
      resolved = await this.source(sessionId, agentId, taskId);
    } catch {
      fail(ErrorCode.INTERNAL_ERROR, 'internal error');
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
      this.unwatch(key);
      fail(ErrorCode.PERSISTENCE_FAILURE, 'task output unavailable');
      return;
    }
    if (this.disposed) return;

    this.sink.respond(requestId, ErrorCode.SUCCESS);
    const end = tail.offset + tail.data.byteLength;
    forward(firstChunk(tail.offset, tail.data, request.since_offset));
    for (const chunk of pending) {
      if (chunk.offset >= end) forward(chunk);
    }
    live = true;
  }

  private unwatch(key: string): void {
    this.watches.get(key)?.dispose();
    this.watches.delete(key);
  }
}

function firstChunk(
  tailOffset: number,
  data: Uint8Array,
  sinceOffset: number | undefined,
): { readonly offset: number; readonly text: string } {
  const end = tailOffset + data.byteLength;
  let start = 0;
  if (
    sinceOffset !== undefined &&
    sinceOffset >= tailOffset &&
    sinceOffset <= end &&
    isCharBoundary(data, sinceOffset - tailOffset)
  ) {
    start = sinceOffset - tailOffset;
  } else {
    while (start < data.byteLength && isUtf8Continuation(data[start]!)) start += 1;
  }
  return {
    offset: tailOffset + start,
    text: Buffer.from(data.buffer, data.byteOffset + start, data.byteLength - start).toString('utf-8'),
  };
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
