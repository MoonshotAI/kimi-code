/**
 * `/sessions/{sid}/tasks*` REST routes.
 *
 * 3 endpoints (REST.md §3.7):
 *
 *   GET  /sessions/{sid}/tasks                    query: {status?}        data: {items[]}
 *   GET  /sessions/{sid}/tasks/{tid}              query: {with_output?,
 *                                                            output_bytes?} data: BackgroundTask
 *   POST /sessions/{sid}/tasks/{tid}:cancel       body: empty             data: {cancelled:true}
 *
 * **Error mapping**:
 *   - `SessionNotFoundError`     → envelope `code: 40401`
 *   - `TaskNotFoundError`        → envelope `code: 40406`
 *   - `TaskAlreadyFinishedError` → envelope `code: 40904` with custom
 *     `data:{cancelled:false}` for idempotent cancellation conflicts.
 *   - Other errors → 50001 via the global `installErrorHandler`.
 *
 * **Action suffix**: `:cancel` uses the shared `parseActionSuffix` helper
 * (5th call site after prompts:abort, questions:resolve|dismiss, mcp:restart).
 *
 * **Anti-corruption**: route resolves `ITaskService` via the accessor; no
 * SDK imports.
 */

import {
  ErrorCode,
  cancelTaskResultSchema,
  getTaskQuerySchema,
  getTaskResponseSchema,
  listTasksQuerySchema,
  listTasksResponseSchema,
} from '@moonshot-ai/protocol';
import { ITaskService, SessionNotFoundError, TaskAlreadyFinishedError, TaskNotFoundError, type IInstantiationService } from '@moonshot-ai/agent-core';
import { z } from 'zod';


import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

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

export function registerTasksRoutes(
  app: TasksRouteHost,
  ix: IInstantiationService,
): void {
  // GET /sessions/{session_id}/tasks ------------------------------------
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
      description: 'List background tasks for a session',
      tags: ['tasks'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const query = req.query;
        const items = await ix.invokeFunction((a) =>
          a.get(ITaskService).list(session_id, query),
        );
        reply.send(okEnvelope({ items }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<TasksRouteHost['get']>[2]);

  // GET /sessions/{session_id}/tasks/{task_id} --------------------------
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
      description: 'Get a background task by ID',
      tags: ['tasks'],
    },
    async (req, reply) => {
      try {
        const { session_id, task_id } = req.params;
        const query = req.query as { with_output?: boolean; output_bytes?: number };
        const task = await ix.invokeFunction((a) =>
          a.get(ITaskService).get(session_id, task_id, {
            withOutput: query.with_output,
            outputBytes: query.output_bytes,
          }),
        );
        reply.send(okEnvelope(task, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<TasksRouteHost['get']>[2]);

  // POST /sessions/{session_id}/tasks/{task_id}:cancel ------------------
  //
  // Fastify routes the GET `/:task_id` and the POST `/:tail` against the
  // same Trie prefix. Using `/:task_id:cancel`-style would collide; we
  // capture `:tail` and demand the `:cancel` suffix via the shared parser.
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
      description: 'Cancel a background task',
      tags: ['tasks'],
      operationId: 'cancelTask',
    },
    async (req, reply) => {
      try {
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
          reply.send(
            errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id),
          );
          return;
        }
        if (parsed.kind === 'bare') {
          // POST without `:cancel` is not a defined action; the bare GET
          // form serves `/.../tasks/{tid}`.
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              `unsupported action: ${tail}`,
              req.id,
            ),
          );
          return;
        }
        const task_id = parsed.id;
        if (!session_id || !task_id) {
          reply.send(
            errEnvelope(ErrorCode.VALIDATION_FAILED, 'invalid path params', req.id),
          );
          return;
        }
        const result = await ix.invokeFunction((a) =>
          a.get(ITaskService).cancel(session_id, task_id),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(cancelRoute.path, cancelRoute.options, cancelRoute.handler as Parameters<TasksRouteHost['post']>[2]);
}

/**
 * Map a thrown error to the right envelope. See module header for the table.
 *
 * `TaskAlreadyFinishedError` is a SPECIAL case — REST.md §3.7 mandates
 * envelope `code: 40904` + `data: {cancelled: false}` for the idempotent
 * cancellation shape.
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof TaskAlreadyFinishedError) {
    reply.send({
      code: ErrorCode.TASK_ALREADY_FINISHED,
      msg: err.message,
      data: { cancelled: false },
      request_id: requestId,
      details: { current_status: err.currentStatus },
    });
    return;
  }
  if (err instanceof TaskNotFoundError) {
    reply.send(errEnvelope(ErrorCode.TASK_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
    return;
  }
  throw err;
}
