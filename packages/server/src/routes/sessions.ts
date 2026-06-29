

import {
  ErrorCode,
  archiveSessionResponseSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionChildRequestSchema,
  createSessionChildResponseSchema,
  createSessionRequestSchema,
  forkSessionRequestSchema,
  listSessionChildrenResponseSchema,
  pageResponseSchema,
  sessionAbortResponseSchema,
  sessionSchema,
  sessionWarningsResponseSchema,
  sessionStatusResponseSchema,
  sessionStatusSchema,
  startBtwSessionResponseSchema,
  updateSessionProfileRequestSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  workspaceIdSchema,
  type Event,
} from '@moonshot-ai/protocol';
import { IPromptService, ISessionService, SessionNotFoundError, SessionUndoUnavailableError, ErrorCodes, KimiError, IWorkspaceRegistry, WorkspaceNotFoundError, IEventService, type IInstantiationService, type SessionClientTelemetry } from '@moonshot-ai/agent-core';
import { z } from 'zod';


import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

interface SessionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown; headers: Record<string, unknown> },
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

const booleanQueryParam = z.preprocess(
  (value) => {
    if (value === 'true' || value === '1' || value === 1 || value === true) return true;
    if (value === 'false' || value === '0' || value === 0 || value === false) return false;
    return value;
  },
  z.boolean().optional(),
);

const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    status: sessionStatusSchema.optional(),
    include_archive: booleanQueryParam,
    exclude_empty: booleanQueryParam,

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
    count: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  }),
);

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

function clientTelemetryFromHeaders(
  headers: Record<string, unknown>,
): SessionClientTelemetry | undefined {
  const client: SessionClientTelemetry = {
    id: headerString(headers, 'x-kimi-client-id'),
    name: headerString(headers, 'x-kimi-client-name'),
    version: headerString(headers, 'x-kimi-client-version'),
    uiMode: headerString(headers, 'x-kimi-client-ui-mode'),
  };
  return Object.values(client).some((value) => value !== undefined) ? client : undefined;
}

function headerString(headers: Record<string, unknown>, key: string): string | undefined {
  const value = headers[key];
  const raw = Array.isArray(value) ? value.find((item) => typeof item === 'string') : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function registerSessionsRoutes(
  app: SessionRouteHost,
  ix: IInstantiationService,
): void {

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
          a.get(ISessionService).create(normalized, {
            client: clientTelemetryFromHeaders(req.headers),
          }),
        );
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(createRoute.path, createRoute.options, createRoute.handler as Parameters<SessionRouteHost['post']>[2]);

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
        const baseQuery = {
          before_id: raw.before_id,
          after_id: raw.after_id,
          page_size: raw.page_size,
          status: raw.status,
          includeArchive: raw.include_archive,
          excludeEmpty: raw.exclude_empty,
        };
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
          query = { ...baseQuery, workDir: root };
        } else {
          query = baseQuery;
        }
        const page = await ix.invokeFunction((a) => a.get(ISessionService).list(query));
        reply.send(okEnvelope(page, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<SessionRouteHost['get']>[2]);

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
        // Broadcast the title change to every connection (including clients not
        // subscribed to this session, and covering inactive sessions whose rename
        // does not go through the live Session path), so session lists stay in sync.
        if (typeof body.title === 'string' && body.title.trim().length > 0) {
          ix.invokeFunction((a) =>
            a.get(IEventService).publish({
              type: 'session.meta.updated',
              agentId: 'main',
              sessionId: session_id,
              title: session.title,
              patch: { title: session.title, isCustomTitle: true },
            } as Event),
          );
        }
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

  const sessionActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{tail}',
      params: sessionActionTailParamSchema,
      body: sessionActionRequestSchema,
      success: { data: z.union([sessionSchema, compactSessionResponseSchema, undoSessionResponseSchema, sessionAbortResponseSchema, startBtwSessionResponseSchema, archiveSessionResponseSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.COMPACTION_UNABLE]: {},
        [ErrorCode.SESSION_UNDO_UNAVAILABLE]: {},
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
          allowedActions: ['fork', 'compact', 'undo', 'abort', 'btw', 'archive'] as const,
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

        if (parsed.action === 'compact') {
          const body = compactSessionRequestSchema.parse(req.body);
          const result = await ix.invokeFunction((a) =>
            a.get(ISessionService).compact(parsed.id, body),
          );
          reply.send(okEnvelope(result, req.id));
          return;
        }

        if (parsed.action === 'abort') {
          const result = await ix.invokeFunction((a) =>
            a.get(IPromptService).abortBySession(parsed.id),
          );
          reply.send(okEnvelope(result, req.id));
          return;
        }

        if (parsed.action === 'btw') {
          const agentId = await ix.invokeFunction((a) =>
            a.get(IPromptService).startBtw(parsed.id),
          );
          reply.send(okEnvelope({ agent_id: agentId }, req.id));
          return;
        }

        if (parsed.action === 'archive') {
          const result = await ix.invokeFunction((a) =>
            a.get(ISessionService).archive(parsed.id),
          );
          reply.send(okEnvelope(result, req.id));
          return;
        }

        const body = undoSessionRequestSchema.parse(req.body);
        const result = await ix.invokeFunction((a) =>
          a.get(ISessionService).undo(parsed.id, body),
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

  const sessionWarningsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/warnings',
      params: sessionIdParamSchema,
      success: { data: sessionWarningsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session-level warnings (e.g. oversized AGENTS.md)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const warnings = await ix.invokeFunction((a) =>
          a.get(ISessionService).getSessionWarnings(session_id),
        );
        reply.send(okEnvelope({ warnings }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    sessionWarningsRoute.path,
    sessionWarningsRoute.options,
    sessionWarningsRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

}

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
  if (err instanceof SessionUndoUnavailableError) {
    reply.send(errEnvelope(ErrorCode.SESSION_UNDO_UNAVAILABLE, err.message, requestId));
    return;
  }
  if (err instanceof KimiError) {
    const goalErrorCode = GOAL_ERROR_CODE_MAP[err.code];
    if (goalErrorCode !== undefined) {
      reply.send(errEnvelope(goalErrorCode, err.message, requestId));
      return;
    }
  }

  throw err;
}

/** agent-core `ErrorCodes` string → protocol `ErrorCode` number for goal errors. */
const GOAL_ERROR_CODE_MAP: Record<string, ErrorCode> = {
  [ErrorCodes.GOAL_ALREADY_EXISTS]: ErrorCode.GOAL_ALREADY_EXISTS,
  [ErrorCodes.GOAL_NOT_FOUND]: ErrorCode.GOAL_NOT_FOUND,
  [ErrorCodes.GOAL_STATUS_INVALID]: ErrorCode.GOAL_STATUS_INVALID,
  [ErrorCodes.GOAL_NOT_RESUMABLE]: ErrorCode.GOAL_NOT_RESUMABLE,
  [ErrorCodes.GOAL_OBJECTIVE_EMPTY]: ErrorCode.GOAL_OBJECTIVE_EMPTY,
  [ErrorCodes.GOAL_OBJECTIVE_TOO_LONG]: ErrorCode.GOAL_OBJECTIVE_TOO_LONG,
};

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
