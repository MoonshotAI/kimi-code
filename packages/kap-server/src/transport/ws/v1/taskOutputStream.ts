import {
  IAgentTaskService,
  resumeSessionById,
  type AgentTaskOutputChunk,
  type AgentTaskOutputTail,
  type IDisposable,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { ErrorCode } from '../../../protocol/error-codes';
import {
  taskAttachMessageSchema,
  taskDetachMessageSchema,
  type TaskAttachMessage,
  type TaskOutputMessage,
  type TaskResponseMessage,
} from '../../../protocol/ws-task';
import { ensureMainAgent } from '../../mainAgent';

export const TASK_OUTPUT_TAIL_BYTES = 32 * 1024;

const CODE_OK = 0;

export type TaskOutputSourceResult =
  | { readonly kind: 'session_not_found' }
  | { readonly kind: 'task_not_found' }
  | { readonly kind: 'found'; readonly tasks: IAgentTaskService };

export type TaskOutputSource = (sessionId: string, taskId: string) => Promise<TaskOutputSourceResult>;

export function createTaskOutputSource(core: Scope): TaskOutputSource {
  return async (sessionId, taskId) => {
    const session = await resumeSessionById(core.accessor, sessionId);
    if (session === undefined) return { kind: 'session_not_found' };
    const agent = await ensureMainAgent(session);
    const tasks = agent.accessor.get(IAgentTaskService);
    if (tasks.getTask(taskId) === undefined) return { kind: 'task_not_found' };
    return { kind: 'found', tasks };
  };
}

export interface TaskOutputSink {
  respond(frame: TaskResponseMessage): void;
  output(frame: TaskOutputMessage): void;
  rejectUnreadable(): void;
}

interface Attachment {
  subscription?: IDisposable;
}

export function isTaskOutputMessageType(type: string): boolean {
  return type === 'task.attach' || type === 'task.detach';
}

export class TaskOutputAttachments {
  private readonly attachments = new Map<string, Attachment>();
  private disposed = false;

  constructor(
    private readonly source: TaskOutputSource,
    private readonly sink: TaskOutputSink,
  ) {}

  async handle(frame: unknown): Promise<void> {
    const attach = taskAttachMessageSchema.safeParse(frame);
    if (attach.success) {
      await this.attach(attach.data);
      return;
    }
    const detach = taskDetachMessageSchema.safeParse(frame);
    if (detach.success) {
      this.detach(detach.data.session_id, detach.data.task_id);
      this.sink.respond({ type: 'response', request_id: detach.data.request_id, code: CODE_OK });
      return;
    }
    const requestId = readRequestId(frame);
    if (requestId === undefined) {
      this.sink.rejectUnreadable();
      return;
    }
    this.sink.respond({
      type: 'response',
      request_id: requestId,
      code: ErrorCode.VALIDATION_FAILED,
      msg: 'invalid task output message',
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const attachment of this.attachments.values()) attachment.subscription?.dispose();
    this.attachments.clear();
  }

  private async attach(request: TaskAttachMessage): Promise<void> {
    const { request_id: requestId, session_id: sessionId, task_id: taskId } = request;
    const key = attachmentKey(sessionId, taskId);
    this.detach(sessionId, taskId);
    const attachment: Attachment = {};
    this.attachments.set(key, attachment);
    const isCurrent = (): boolean => !this.disposed && this.attachments.get(key) === attachment;
    const fail = (code: number, msg: string): void => {
      attachment.subscription?.dispose();
      if (this.attachments.get(key) === attachment) this.attachments.delete(key);
      this.sink.respond({ type: 'response', request_id: requestId, code, msg });
    };

    let resolved: TaskOutputSourceResult;
    try {
      resolved = await this.source(sessionId, taskId);
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
    if (!isCurrent()) {
      this.sink.respond({ type: 'response', request_id: requestId, code: CODE_OK });
      return;
    }

    const pending: AgentTaskOutputChunk[] = [];
    let live = false;
    const forward = (chunk: AgentTaskOutputChunk): void => {
      this.sink.output({
        type: 'task.output',
        session_id: sessionId,
        task_id: taskId,
        offset: chunk.offset,
        text: chunk.text,
      });
    };
    attachment.subscription = resolved.tasks.onDidAppendOutput((chunk) => {
      if (chunk.taskId !== taskId || !isCurrent()) return;
      if (live) forward(chunk);
      else pending.push(chunk);
    });

    let tail: AgentTaskOutputTail;
    try {
      tail = await resolved.tasks.readOutputTail(taskId, TASK_OUTPUT_TAIL_BYTES);
    } catch {
      fail(ErrorCode.PERSISTENCE_FAILURE, 'task output unavailable');
      return;
    }
    if (!isCurrent()) {
      attachment.subscription.dispose();
      this.sink.respond({ type: 'response', request_id: requestId, code: CODE_OK });
      return;
    }

    this.sink.respond({ type: 'response', request_id: requestId, code: CODE_OK });
    const end = tail.offset + tail.data.byteLength;
    const first = firstChunk(tail.offset, tail.data, request.since_offset);
    this.sink.output({
      type: 'task.output',
      session_id: sessionId,
      task_id: taskId,
      offset: first.offset,
      text: first.text,
    });
    for (const chunk of pending) {
      if (chunk.offset >= end) forward(chunk);
    }
    live = true;
  }

  private detach(sessionId: string, taskId: string): void {
    const key = attachmentKey(sessionId, taskId);
    const existing = this.attachments.get(key);
    if (existing === undefined) return;
    existing.subscription?.dispose();
    this.attachments.delete(key);
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

function attachmentKey(sessionId: string, taskId: string): string {
  return `${sessionId}\u0000${taskId}`;
}

function readRequestId(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined;
  const requestId = (frame as { request_id?: unknown }).request_id;
  return typeof requestId === 'string' ? requestId : undefined;
}
