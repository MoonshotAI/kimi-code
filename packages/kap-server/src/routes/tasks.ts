import {
  IAgentTaskService,
  ISessionIndex,
  getLiveSessionById,
  type AgentTaskInfo,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import {
  cancelTaskResultSchema,
  getTaskQuerySchema,
  getTaskResponseSchema,
  listTasksQuerySchema,
  listTasksResponseSchema,
} from '../protocol/rest-task';
import type { Task, TaskKind, TaskStatus } from '../protocol/task';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { parseActionSuffix } from './action-suffix';

const DEFAULT_TASK_OUTPUT_PREVIEW_BYTES = 32 * 1024;

interface TasksRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionAndTaskIdParamSchema = z.object({
  session_id: z.string().min(1),
  task_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerTasksRoutes(app: TasksRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/tasks',
      params: sessionIdParamSchema,
      querystring: listTasksQuerySchema,
      success: { data: listTasksResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List tasks for a session',
      tags: ['tasks'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const resolved = await resolveSessionTasks(core, session_id);
      if (resolved.kind === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const all = (resolved.tasks?.list(false) ?? []).map((info) =>
        toWireTask(session_id, info),
      );
      const query = req.query as { status?: TaskStatus };
      const items =
        query.status !== undefined ? all.filter((t) => t.status === query.status) : all;
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<TasksRouteHost['get']>[2]);

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/tasks/{task_id}',
      params: sessionAndTaskIdParamSchema,
      querystring: getTaskQuerySchema,
      success: { data: getTaskResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TASK_NOT_FOUND]: {},
      },
      description: 'Get a task by ID',
      tags: ['tasks'],
    },
    async (req, reply) => {
      const { session_id, task_id } = req.params;
      const resolved = await resolveSessionTasks(core, session_id);
      if (resolved.kind === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const found = resolved.tasks?.getTask(task_id);
      if (found === undefined) {
        reply.send(taskNotFound(session_id, task_id, req.id));
        return;
      }

      const query = req.query as { with_output?: boolean; output_bytes?: number };
      let output: { preview: string; bytes: number } | undefined;
      if (query.with_output === true && resolved.tasks !== undefined) {
        const tailBytes = query.output_bytes ?? DEFAULT_TASK_OUTPUT_PREVIEW_BYTES;
        try {
          const preview = await resolved.tasks.readOutput(task_id, tailBytes);
          if (preview.length > 0) {
            output = { preview, bytes: Buffer.byteLength(preview, 'utf-8') };
          }
        } catch {
        }
      }

      reply.send(okEnvelope(toWireTask(session_id, found, output), req.id));
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<TasksRouteHost['get']>[2]);

  const cancelRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/tasks/{tail}',
      success: { data: cancelTaskResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TASK_NOT_FOUND]: {},
        [ErrorCode.TASK_ALREADY_FINISHED]: {
          dataSchema: z.object({ cancelled: z.literal(false) }),
          detailsSchema: z.object({ current_status: z.string() }),
        },
      },
      description: 'Cancel a task',
      tags: ['tasks'],
      operationId: 'cancelTask',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params as {
        session_id: string;
        tail: string;
      };
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['cancel'] as const,
        resourceLabel: 'task',
      });
      if (parsed.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id));
        return;
      }
      if (parsed.kind === 'bare') {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }
      const task_id = parsed.id;
      if (!session_id || !task_id) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'invalid path params', req.id));
        return;
      }

      const resolved = await resolveSessionTasks(core, session_id);
      if (resolved.kind === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const found = resolved.tasks?.getTask(task_id);
      if (found === undefined) {
        reply.send(taskNotFound(session_id, task_id, req.id));
        return;
      }
      const wireStatus = toWireTask(session_id, found).status;
      if (isTerminalStatus(wireStatus)) {
        reply.send(taskAlreadyFinished(session_id, task_id, wireStatus, req.id));
        return;
      }

      await resolved.tasks?.stopByUser(task_id);
      requestLog(req)?.info({ session_id, task_id }, 'task cancelled');
      reply.send(okEnvelope({ cancelled: true as const }, req.id));
    },
  );
  app.post(cancelRoute.path, cancelRoute.options, cancelRoute.handler as Parameters<TasksRouteHost['post']>[2]);
}

type ResolvedTasks =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'resolved'; readonly tasks: IAgentTaskService | undefined };

async function resolveSessionTasks(core: Scope, sid: string): Promise<ResolvedTasks> {
  const summary = await core.accessor.get(ISessionIndex).get(sid);
  if (summary === undefined) return { kind: 'not_found' };

  const session = getLiveSessionById(core.accessor, sid);
  if (session === undefined) return { kind: 'resolved', tasks: undefined };
  const agent = await ensureMainAgent(session);
  const tasks = agent.accessor.get(IAgentTaskService);
  return { kind: 'resolved', tasks };
}

function mapKind(k: AgentTaskInfo['kind']): TaskKind {
  switch (k) {
    case 'process':
      return 'bash';
    case 'agent':
      return 'subagent';
    case 'question':
      return 'tool';
  }
}

function mapStatus(s: AgentTaskInfo['status']): TaskStatus {
  switch (s) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'failed';
    case 'killed':
      return 'cancelled';
    case 'lost':
      return 'failed';
  }
}

const TERMINAL_WIRE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_WIRE_STATUSES.has(status);
}

function toWireTask(
  sessionId: string,
  info: AgentTaskInfo,
  output?: { preview: string; bytes: number },
): Task {
  const status = mapStatus(info.status);
  const createdIso = new Date(info.startedAt).toISOString();
  const base: Task = {
    id: info.taskId,
    session_id: sessionId,
    kind: mapKind(info.kind),
    description: info.description,
    status,
    created_at: createdIso,
    started_at: createdIso,
  };
  if (info.endedAt !== null && info.endedAt !== undefined) {
    base.completed_at = new Date(info.endedAt).toISOString();
  }
  if (info.kind === 'process' && 'command' in info && typeof info.command === 'string') {
    base.command = info.command;
  }
  if (info.kind === 'agent' && info.model !== undefined) {
    base.model = info.model;
  }
  if (info.kind === 'agent' && info.thinkingEffort !== undefined) {
    base.thinking_effort = info.thinkingEffort;
  }
  if (info.kind === 'agent' && info.agentId !== undefined) {
    base.agent_id = info.agentId;
  }
  if (info.kind === 'agent' && info.subagentType !== undefined) {
    base.subagent_type = info.subagentType;
  }
  if (info.kind === 'agent' && info.parentToolCallId !== undefined) {
    base.parent_tool_call_id = info.parentToolCallId;
  }
  if (output !== undefined) {
    base.output_preview = output.preview;
    base.output_bytes = output.bytes;
  }
  return base;
}

function sessionNotFound(sid: string, requestId: string): unknown {
  return errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${sid} does not exist`, requestId);
}

function taskNotFound(sid: string, tid: string, requestId: string): unknown {
  return errEnvelope(
    ErrorCode.TASK_NOT_FOUND,
    `task ${tid} does not exist in session ${sid}`,
    requestId,
  );
}

function taskAlreadyFinished(
  sid: string,
  tid: string,
  currentStatus: TaskStatus,
  requestId: string,
): unknown {
  return {
    code: ErrorCode.TASK_ALREADY_FINISHED,
    msg: `task ${tid} already finished (status: ${currentStatus})`,
    data: { cancelled: false },
    request_id: requestId,
    details: { current_status: currentStatus },
  };
}
