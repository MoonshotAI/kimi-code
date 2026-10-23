import {
  IAgentTaskService,
  resumeSessionById,
  type AgentTaskOutputChunk,
  type AgentTaskOutputTail,
  type IDisposable,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { ErrorCode } from '../../../protocol/error-codes';
import { ensureMainAgent } from '../../mainAgent';

export const TASK_OUTPUT_TAIL_BYTES = 4096;

const CODE_OK = 0;

const taskAttachSchema = z.object({
  type: z.literal('task.attach'),
  request_id: z.string(),
  session_id: z.string().min(1),
  task_id: z.string().min(1),
  since_offset: z.number().int().nonnegative().optional(),
});

const taskDetachSchema = z.object({
  type: z.literal('task.detach'),
  request_id: z.string(),
  session_id: z.string().min(1),
  task_id: z.string().min(1),
});

export interface TaskOutputFrame {
  readonly type: 'task.output';
  readonly session_id: string;
  readonly task_id: string;
  readonly offset: number;
  readonly text: string;
}

export interface TaskOutputResponseFrame {
  readonly type: 'response';
  readonly request_id: string;
  readonly code: number;
  readonly msg?: string;
}

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
  respond(frame: TaskOutputResponseFrame): void;
  output(frame: TaskOutputFrame): void;
  rejectUnreadable(): void;
}

interface Attachment {
  readonly generation: number;
  subscription?: IDisposable;
}

export function isTaskOutputMessageType(type: string): boolean {
  return type === 'task.attach' || type === 'task.detach';
}

export class TaskOutputAttachments {
  private readonly attachments = new Map<string, Attachment>();
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly source: TaskOutputSource,
    private readonly sink: TaskOutputSink,
  ) {}

  async handle(frame: unknown): Promise<void> {
    const attach = taskAttachSchema.safeParse(frame);
    if (attach.success) {
      await this.attach(attach.data);
      return;
    }
    const detach = taskDetachSchema.safeParse(frame);
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

  private async attach(request: z.infer<typeof taskAttachSchema>): Promise<void> {
    const { request_id: requestId, session_id: sessionId, task_id: taskId } = request;
    const key = attachmentKey(sessionId, taskId);
    this.detach(sessionId, taskId);
    const attachment: Attachment = { generation: ++this.generation };
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
    if (first !== undefined) {
      this.sink.output({
        type: 'task.output',
        session_id: sessionId,
        task_id: taskId,
        offset: first.offset,
        text: first.text,
      });
    }
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

export function firstChunk(
  tailOffset: number,
  data: Uint8Array,
  sinceOffset: number | undefined,
): { readonly offset: number; readonly text: string } | undefined {
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
  if (start >= data.byteLength) return undefined;
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
