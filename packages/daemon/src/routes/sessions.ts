/**
 * `/sessions/*` REST routes.
 *
 * Session endpoints (REST.md §3.3):
 *
 *   POST   /sessions                  body: SessionCreate    data: Session
 *   GET    /sessions                  query: ListSessions    data: Page<Session>
 *   GET    /sessions/{id}             -                      data: Session
 *   GET    /sessions/{id}/profile     -                      data: Session
 *   POST   /sessions/{id}/profile     body: SessionUpdate    data: Session
 *   POST   /sessions/{id}:fork        body: SessionFork      data: Session
 *   GET    /sessions/{id}/children    query: ListSessions    data: Page<Session>
 *   POST   /sessions/{id}/children    body: SessionChild     data: Session
 *   GET    /sessions/{id}/status      -                      data: SessionStatus
 *   POST   /sessions/{id}:compact     body: CompactSession   data: {}
 *   DELETE /sessions/{id}             -                      data: { deleted: true }
 *
 * Each handler invokes `accessor.get(ISessionService).<method>(...)`, and emits
 * an `okEnvelope`.
 *
 * **Runtime controls on /profile**: `agent_config` on the write side is the
 * canonical mutation point for the four shadowed runtime fields —
 * `model`, `thinking`, `permission_mode`, `plan_mode`. The services
 * layer routes them through `IPromptService.applyAgentState(id, patch,
 * 'meta')`, which diff-dispatches the matching `core.rpc.*` setter and
 * writes a dispatch-log entry. Reading the live state stays on
 * `GET /sessions/{id}/status`; the read-side `agent_config` does NOT
 * echo the four runtime fields because the list adapter can't source
 * them cheaply. Prompt-body overrides on `POST /sessions/{id}/prompts`
 * use the same applyAgentState helper with `source='prompt'`.
 *
 * **Error mapping**: `SessionNotFoundError` → envelope `code: 40401`. Other
 * errors fall through to the global `installErrorHandler` (→ 50001).
 *
 * **Wiring**: takes an `IInstantiationService` so each request can resolve
 * `ISessionService` via the same DI container the daemon constructs in
 * `start.ts`. The handler closures don't capture the service directly — that
 * would break the per-request request_id flow and the dispose-cascade story.
 *
 * **Anti-corruption**: this file is part of `packages/daemon/src/`. No direct
 * SDK package imports — sessions go through `accessor.get(ISessionService)`
 * whose impl lives in `@moonshot-ai/services`.
 */

import {
  ErrorCode,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionChildRequestSchema,
  createSessionChildResponseSchema,
  createSessionRequestSchema,
  deleteSessionResponseSchema,
  forkSessionRequestSchema,
  listSessionChildrenResponseSchema,
  pageResponseSchema,
  sessionSchema,
  sessionStatusResponseSchema,
  sessionStatusSchema,
  updateSessionProfileRequestSchema,
  workspaceIdSchema,
} from '@moonshot-ai/protocol';
import {
  ISessionService,
  SessionNotFoundError,
} from '@moonshot-ai/services';
import { z } from 'zod';

import {
  ErrorCodes,
  KimiError,
  type IInstantiationService,
} from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';
import {
  IWorkspaceRegistry,
  WorkspaceNotFoundError,
} from '#/services/workspace';

/**
 * Per-request structural typing — we never need the full FastifyRequest type;
 * the fields below are the only ones the handlers touch.
 */
interface SessionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  // Fastify exposes `patch` and `delete` as instance methods.
  patch(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

// --- Query coercion ---------------------------------------------------------

/**
 * HTTP query strings arrive as `Record<string, string>`. The protocol's
 * `cursorQuerySchema` expects `page_size: number`. We coerce at the daemon
 * boundary so the protocol schema stays HTTP-agnostic (re-usable on the
 * client side where JSON-RPC payloads already carry typed numbers).
 *
 * `page_size` parses as a positive integer 1..100; anything else fails 40001.
 */
const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    status: sessionStatusSchema.optional(),
    /**
     * When set, the daemon resolves the workspace_id to its registered root
     * and forwards the root as `workDir` to `ISessionService.list()`. That
     * takes the agent-core readdir fast path under the wd-key bucket.
     */
    workspace_id: workspaceIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const sessionChildrenListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    status: sessionStatusSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

// --- Params -----------------------------------------------------------------

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const sessionActionRequestSchema = z.preprocess(
  (value) => value === undefined ? {} : value,
  z.object({
    title: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    instruction: z.string().optional(),
  }),
);

// --- Registration -----------------------------------------------------------

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerSessionsRoutes(
  app: SessionRouteHost,
  ix: IInstantiationService,
): void {
  // POST /sessions ------------------------------------------------------
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions',
      body: createSessionRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'Create a new session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const body = req.body;
        // The protocol schema accepts either `workspace_id` or `metadata.cwd`
        // (or both). The route layer:
        //   1. requires at-least-one (→ 40001 if neither is set)
        //   2. resolves workspace_id → workspace.root via IWorkspaceRegistry
        //      and touches `last_opened_at` on that record
        //   3. if BOTH workspace_id + metadata.cwd are set, verifies they
        //      agree on the same root (→ 40001 mismatch)
        //   4. forwards a normalized `{title, metadata: {cwd, ...}, ...}` to
        //      `ISessionService.create` — the services layer does NOT learn
        //      about workspaces.
        const callerCwd = typeof body.metadata?.cwd === 'string' ? body.metadata.cwd : undefined;
        const workspaceId = body.workspace_id;
        if (workspaceId === undefined && callerCwd === undefined) {
          reply.send(
            buildValidationEnvelope(
              [
                {
                  path: 'metadata.cwd',
                  message: 'either workspace_id or metadata.cwd is required',
                },
              ],
              req.id,
            ),
          );
          return;
        }

        let normalized: Omit<typeof body, 'workspace_id'>;
        if (workspaceId !== undefined) {
          const registry = ix.invokeFunction((a) => a.get(IWorkspaceRegistry));
          let workspaceRoot: string;
          try {
            workspaceRoot = await registry.resolveRoot(workspaceId);
          } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
              reply.send(
                errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, err.message, req.id),
              );
              return;
            }
            throw err;
          }
          if (callerCwd !== undefined && callerCwd !== workspaceRoot) {
            reply.send(
              buildValidationEnvelope(
                [
                  {
                    path: 'metadata.cwd',
                    message: `metadata.cwd (${callerCwd}) must equal workspace root (${workspaceRoot})`,
                  },
                ],
                req.id,
              ),
            );
            return;
          }
          // Touch last_opened_at — same as POST /workspaces { root }.
          await registry.createOrTouch(workspaceRoot);
          const { workspace_id: _drop, ...rest } = body;
          const otherMetadata = body.metadata ?? { cwd: workspaceRoot };
          normalized = {
            ...rest,
            metadata: { ...otherMetadata, cwd: workspaceRoot },
          };
        } else {
          const { workspace_id: _drop, ...rest } = body;
          normalized = rest;
        }

        const session = await ix.invokeFunction((a) =>
          a.get(ISessionService).create(normalized),
        );
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(createRoute.path, createRoute.options, createRoute.handler as Parameters<SessionRouteHost['post']>[2]);

  // GET /sessions -------------------------------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions',
      querystring: sessionsListQueryCoercion,
      success: { data: pageResponseSchema(sessionSchema) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'List sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const raw = req.query;
        let query;
        if (raw.workspace_id !== undefined) {
          const registry = ix.invokeFunction((a) => a.get(IWorkspaceRegistry));
          let root: string;
          try {
            root = await registry.resolveRoot(raw.workspace_id);
          } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
              reply.send(
                errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, err.message, req.id),
              );
              return;
            }
            throw err;
          }
          const { workspace_id: _drop, ...rest } = raw;
          query = { ...rest, workDir: root };
        } else {
          const { workspace_id: _drop, ...rest } = raw;
          query = rest;
        }
        const page = await ix.invokeFunction((a) => a.get(ISessionService).list(query));
        reply.send(okEnvelope(page, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<SessionRouteHost['get']>[2]);

  // GET /sessions/{session_id} ------------------------------------------
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get a session by ID',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const session = await ix.invokeFunction((a) => a.get(ISessionService).get(session_id));
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<SessionRouteHost['get']>[2]);

  // GET /sessions/{session_id}/profile ---------------------------------
  const getProfileRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session profile',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const session = await ix.invokeFunction((a) => a.get(ISessionService).get(session_id));
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    getProfileRoute.path,
    getProfileRoute.options,
    getProfileRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  // POST /sessions/{session_id}/profile --------------------------------
  const updateProfileRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      body: updateSessionProfileRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Update session profile (title, metadata, agent_config)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const body = req.body;
        const session = await ix.invokeFunction((a) =>
          a.get(ISessionService).update(session_id, body),
        );
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    updateProfileRoute.path,
    updateProfileRoute.options,
    updateProfileRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  // POST /sessions/{session_id}:fork|compact ---------------------------
  const sessionActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{tail}',
      params: sessionActionTailParamSchema,
      body: sessionActionRequestSchema,
      success: { data: z.union([sessionSchema, compactSessionResponseSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.COMPACTION_UNABLE]: {},
      },
      description: 'Run a session action',
      tags: ['sessions'],
      operationId: 'runSessionAction',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['fork', 'compact'] as const,
          resourceLabel: 'session',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid'
            ? parsed.reason
            : `unsupported action: ${tail}`;
          reply.send(
            buildValidationEnvelope(
              [{ path: 'session_id', message }],
              req.id,
            ),
          );
          return;
        }

        if (parsed.action === 'fork') {
          const body = forkSessionRequestSchema.parse(req.body);
          const session = await ix.invokeFunction((a) =>
            a.get(ISessionService).fork(parsed.id, body),
          );
          reply.send(okEnvelope(session, req.id));
          return;
        }

        const body = compactSessionRequestSchema.parse(req.body);
        const result = await ix.invokeFunction((a) =>
          a.get(ISessionService).compact(parsed.id, body),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    sessionActionRoute.path,
    sessionActionRoute.options,
    sessionActionRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  // GET /sessions/{session_id}/children ----------------------------------
  const listChildrenRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      querystring: sessionChildrenListQueryCoercion,
      success: { data: listSessionChildrenResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List child sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const page = await ix.invokeFunction((a) =>
          a.get(ISessionService).listChildren(session_id, req.query),
        );
        reply.send(okEnvelope(page, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.get(
    listChildrenRoute.path,
    listChildrenRoute.options,
    listChildrenRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  // POST /sessions/{session_id}/children ---------------------------------
  const createChildRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      body: createSessionChildRequestSchema,
      success: { data: createSessionChildResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
      },
      description: 'Create a child session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const child = await ix.invokeFunction((a) =>
          a.get(ISessionService).createChild(session_id, req.body),
        );
        reply.send(okEnvelope(child, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    createChildRoute.path,
    createChildRoute.options,
    createChildRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  // GET /sessions/{session_id}/status -----------------------------------
  const statusRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/status',
      params: sessionIdParamSchema,
      success: { data: sessionStatusResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get realtime session status',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const status = await ix.invokeFunction((a) =>
          a.get(ISessionService).getStatus(session_id),
        );
        reply.send(okEnvelope(status, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(statusRoute.path, statusRoute.options, statusRoute.handler as Parameters<SessionRouteHost['get']>[2]);

  // DELETE /sessions/{session_id} ---------------------------------------
  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/sessions/{session_id}',
      params: sessionIdParamSchema,
      success: { data: deleteSessionResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Delete a session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const result = await ix.invokeFunction((a) => a.get(ISessionService).delete(session_id));
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.delete(deleteRoute.path, deleteRoute.options, deleteRoute.handler as Parameters<SessionRouteHost['delete']>[2]);
}

/**
 * Map a thrown error to the right envelope:
 *   - `SessionNotFoundError` → `code: 40401`
 *   - `WorkspaceNotFoundError` → `code: 40410`
 *   - Anything else → re-throw so the global `installErrorHandler` catches it
 *     and emits `50001`.
 *
 * We don't catch generic `Error` here because the global hook is the single
 * place stack traces reach the operator log (`error-handler.ts:42-43`).
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof WorkspaceNotFoundError) {
    reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, err.message, requestId));
    return;
  }
  if (isForkActiveTurnError(err)) {
    reply.send(errEnvelope(ErrorCode.SESSION_BUSY, formatErrorMessage(err), requestId));
    return;
  }
  if (err instanceof KimiError && err.code === ErrorCodes.COMPACTION_UNABLE) {
    reply.send(errEnvelope(ErrorCode.COMPACTION_UNABLE, err.message, requestId));
    return;
  }
  // Re-throw so Fastify's error hook handles it.
  throw err;
}

function isForkActiveTurnError(err: unknown): boolean {
  if (err instanceof KimiError && err.code === ErrorCodes.SESSION_FORK_ACTIVE_TURN) {
    return true;
  }
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { readonly code?: unknown }).code === ErrorCodes.SESSION_FORK_ACTIVE_TURN
  );
}

function formatErrorMessage(err: unknown): string {
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { readonly message?: unknown }).message === 'string'
  ) {
    return (err as { readonly message: string }).message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build a 40001 validation envelope inline (the daemon's middleware/validate.ts
 * helper isn't reachable from a handler — it lives behind a preHandler hook).
 * Used for at-least-one-of (`workspace_id` / `metadata.cwd`) + mismatch
 * checks the protocol schema can't express on its own.
 */
function buildValidationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg = first === undefined
    ? 'validation failed'
    : first.path === ''
      ? first.message
      : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}
