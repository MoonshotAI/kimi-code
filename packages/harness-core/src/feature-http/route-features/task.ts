import type { Request, Response } from 'express';

import { MAIN_AGENT_ID, useApp } from '@moonshot-ai/agent-core';

import { TaskRef, type TaskFace, type TaskRecord, type TaskStatus } from '#/features/task/index';

import { useHttpRoute } from '../feature';
import { parseActionSuffix } from '../route/action-suffix';
import { ErrorCode, param, requestId, sendErr, sendOk } from '../route/http';

export type TaskWireKind = 'subagent' | 'bash' | 'tool';
export type TaskWireStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskView {
  readonly id: string;
  readonly session_id: string;
  readonly kind: TaskWireKind;
  readonly description: string;
  readonly status: TaskWireStatus;
  readonly created_at: string;
  readonly started_at: string;
  readonly completed_at?: string;
  readonly output_preview?: string;
  readonly output_bytes?: number;
  readonly run_in_background: boolean;
}

const DEFAULT_TASK_OUTPUT_PREVIEW_BYTES = 32 * 1024;
const TASK_ACTIONS = ['stop'] as const;
const TERMINAL_WIRE_STATUSES: ReadonlySet<TaskWireStatus> = new Set(['completed', 'failed', 'cancelled']);

export function useTaskRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.tasks.list',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/tasks`,
    handler: (request, response) => {
      const resolved = taskFacade(request, response);
      if (resolved === undefined) return;
      const status = readStatusQuery(request);
      if (status === null) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          'status must be one of running, completed, failed, cancelled',
        );
        return;
      }
      const all = [...resolved.facade.records.value.values()].map((record) =>
        taskView(resolved.sessionId, record),
      );
      const items = status === undefined ? all : all.filter((task) => task.status === status);
      sendOk(request, response, { items });
    },
  });

  useHttpRoute({
    id: 'sessions.tasks.get',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/tasks/:task_id`,
    handler: (request, response) => {
      const resolved = taskFacade(request, response);
      if (resolved === undefined) return;
      const taskId = param(request, 'task_id');
      if (taskId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'task_id is required');
        return;
      }
      const record = resolved.facade.records.value.get(taskId);
      if (record === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.TASK_NOT_FOUND,
          `task ${taskId} does not exist in session ${resolved.sessionId}`,
        );
        return;
      }
      sendOk(request, response, taskView(resolved.sessionId, record, readOutput(request, record)));
    },
  });

  useHttpRoute({
    id: 'sessions.tasks.action',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/tasks/:tail`,
    handler: async (request, response) => {
      const tail = param(request, 'tail');
      if (tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'task_id is required');
        return;
      }
      const parsed = parseActionSuffix({ tail, allowedActions: TASK_ACTIONS, resourceLabel: 'task' });
      if (parsed.kind !== 'action') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`,
        );
        return;
      }
      const resolved = taskFacade(request, response);
      if (resolved === undefined) return;
      const record = resolved.facade.records.value.get(parsed.id);
      if (record === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.TASK_NOT_FOUND,
          `task ${parsed.id} does not exist in session ${resolved.sessionId}`,
        );
        return;
      }
      const status = wireStatus(record.status);
      if (TERMINAL_WIRE_STATUSES.has(status)) {
        response.status(200).json({
          code: ErrorCode.TASK_ALREADY_FINISHED,
          msg: `task ${parsed.id} already finished (status: ${status})`,
          data: { cancelled: false },
          request_id: requestId(request),
          details: { current_status: status },
        });
        return;
      }
      await resolved.facade.stop(parsed.id, 'Aborted by the user');
      sendOk(request, response, { cancelled: true });
    },
  });
}

function taskFacade(
  request: Request,
  response: Response,
): { readonly sessionId: string; readonly facade: TaskFace } | undefined {
  const sessionId = param(request, 'session_id');
  if (sessionId === undefined) {
    sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
    return undefined;
  }
  const session = useApp().get(sessionId);
  if (session === undefined) {
    sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    return undefined;
  }
  const agent = session.get(MAIN_AGENT_ID);
  if (agent === undefined) {
    sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${MAIN_AGENT_ID} does not exist`);
    return undefined;
  }
  const facade = agent.resolve(TaskRef);
  if (facade === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.TASK_UNAVAILABLE,
      'task tracking is unavailable (task feature is not installed)',
    );
    return undefined;
  }
  return { sessionId, facade };
}

function readStatusQuery(request: Request): TaskWireStatus | undefined | null {
  const value = request.query['status'];
  if (value === undefined) return undefined;
  if (value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled') {
    return value;
  }
  return null;
}

function readOutput(
  request: Request,
  record: TaskRecord,
): { readonly preview: string; readonly bytes: number } | undefined {
  const flag = request.query['with_output'];
  if (flag !== 'true' && flag !== '1') return undefined;
  const output = record.output;
  if (output === undefined || output.length === 0) return undefined;
  const rawBytes = request.query['output_bytes'];
  const parsed = typeof rawBytes === 'string' ? Number.parseInt(rawBytes, 10) : Number.NaN;
  const tailBytes = Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_TASK_OUTPUT_PREVIEW_BYTES;
  const preview = tailBytes === 0 ? '' : output.slice(-tailBytes);
  if (preview.length === 0) return undefined;
  return { preview, bytes: Buffer.byteLength(preview, 'utf-8') };
}

function wireStatus(status: TaskStatus): TaskWireStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
      return 'cancelled';
    case 'lost':
      return 'failed';
  }
}

function taskView(
  sessionId: string,
  record: TaskRecord,
  output?: { readonly preview: string; readonly bytes: number },
): TaskView {
  const createdIso = new Date(record.startedAt).toISOString();
  return {
    id: record.taskId,
    session_id: sessionId,
    kind: 'tool',
    description: record.description ?? '',
    status: wireStatus(record.status),
    created_at: createdIso,
    started_at: createdIso,
    completed_at: record.endedAt === undefined ? undefined : new Date(record.endedAt).toISOString(),
    output_preview: output?.preview,
    output_bytes: output?.bytes,
    run_in_background: true,
  };
}
