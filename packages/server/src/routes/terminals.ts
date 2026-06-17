import {
  ErrorCode,
  closeTerminalResponseSchema,
  createTerminalRequestSchema,
  getTerminalResponseSchema,
  listTerminalsResponseSchema,
} from '@moonshot-ai/protocol';
import { FsPathEscapesError, ITerminalService, SessionNotFoundError, TerminalNotFoundError, type IInstantiationService } from '@moonshot-ai/agent-core';
import { z } from 'zod';


import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

interface TerminalsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: unknown },
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

const sessionAndTerminalIdParamSchema = z.object({
  session_id: z.string().min(1),
  terminal_id: z.string().min(1),
});

const sessionAndTailParamSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerTerminalsRoutes(
  app: TerminalsRouteHost,
  ix: IInstantiationService,
): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/terminals',
      params: sessionIdParamSchema,
      success: { data: listTerminalsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List terminals for a session',
      tags: ['terminals'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const items = await ix.invokeFunction((a) =>
          a.get(ITerminalService).list(session_id),
        );
        reply.send(okEnvelope({ items }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<TerminalsRouteHost['get']>[2]);

  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/terminals',
      params: sessionIdParamSchema,
      body: createTerminalRequestSchema,
      success: { data: getTerminalResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
      },
      description: 'Create a terminal for a session',
      tags: ['terminals'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const terminal = await ix.invokeFunction((a) =>
          a.get(ITerminalService).create(session_id, req.body),
        );
        reply.send(okEnvelope(terminal, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(createRoute.path, createRoute.options, createRoute.handler as Parameters<TerminalsRouteHost['post']>[2]);

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/terminals/{terminal_id}',
      params: sessionAndTerminalIdParamSchema,
      success: { data: getTerminalResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TERMINAL_NOT_FOUND]: {},
      },
      description: 'Get a terminal by ID',
      tags: ['terminals'],
    },
    async (req, reply) => {
      try {
        const { session_id, terminal_id } = req.params;
        const terminal = await ix.invokeFunction((a) =>
          a.get(ITerminalService).get(session_id, terminal_id),
        );
        reply.send(okEnvelope(terminal, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<TerminalsRouteHost['get']>[2]);

  const closeRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/terminals/{tail}',
      params: sessionAndTailParamSchema,
      success: { data: closeTerminalResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TERMINAL_NOT_FOUND]: {},
      },
      description: 'Close a terminal',
      tags: ['terminals'],
      operationId: 'closeTerminal',
    },
    async (req, reply) => {
      try {
        const { session_id, tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['close'] as const,
          resourceLabel: 'terminal',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid'
            ? parsed.reason
            : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const result = await ix.invokeFunction((a) =>
          a.get(ITerminalService).close(session_id, parsed.id),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(closeRoute.path, closeRoute.options, closeRoute.handler as Parameters<TerminalsRouteHost['post']>[2]);
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof TerminalNotFoundError) {
    reply.send(errEnvelope(ErrorCode.TERMINAL_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof FsPathEscapesError) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_ESCAPES_SESSION, err.message, requestId));
    return;
  }
  throw err;
}
