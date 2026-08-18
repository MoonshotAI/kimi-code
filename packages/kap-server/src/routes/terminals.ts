import {
  ErrorCodes,
  ISessionTerminalService,
  resumeSessionById,
  isError2,
  Error2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { createTerminalRequestSchema } from '@moonshot-ai/agent-core-v2/os/interface/terminal';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  closeTerminalResponseSchema,
  getTerminalResponseSchema,
  listTerminalsResponseSchema,
} from '../protocol/rest-terminal';
import { parseActionSuffix } from './action-suffix';

const createTerminalCompatRequestSchema = createTerminalRequestSchema.extend({
  runtime_id: z.string().min(1).optional(),
});

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

async function resolveTerminal(core: Scope, sessionId: string): Promise<ISessionTerminalService> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  return session.accessor.get(ISessionTerminalService);
}

export function registerTerminalsRoutes(app: TerminalsRouteHost, core: Scope): void {
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
        const items = await (await resolveTerminal(core, session_id)).list();
        reply.send(okEnvelope({ items }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<TerminalsRouteHost['get']>[2],
  );

  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/terminals',
      params: sessionIdParamSchema,
      body: createTerminalCompatRequestSchema,
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
        const session = await resumeSessionById(core.accessor, session_id);
        if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
        const terminal = await session.accessor.get(ISessionTerminalService).create({ ...req.body, runtime_id: req.body.runtime_id ?? 'local' });
        requestLog(req)?.info({ session_id, terminal_id: terminal.id }, 'terminal created');
        reply.send(okEnvelope(terminal, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<TerminalsRouteHost['post']>[2],
  );

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
        const terminal = await (await resolveTerminal(core, session_id)).get(terminal_id);
        reply.send(okEnvelope(terminal, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<TerminalsRouteHost['get']>[2],
  );

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
          const message =
            parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const result = await (await resolveTerminal(core, session_id)).close(parsed.id);
        requestLog(req)?.info({ session_id, terminal_id: parsed.id }, 'terminal closed');
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    closeRoute.path,
    closeRoute.options,
    closeRoute.handler as Parameters<TerminalsRouteHost['post']>[2],
  );
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.SESSION_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.TERMINAL_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.TERMINAL_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_PATH_ESCAPES:
        reply.send(errEnvelope(ErrorCode.FS_PATH_ESCAPES_SESSION, err.message, requestId, err.stack));
        return;
    }
  }
  if (err instanceof Error && err.message.startsWith('Path outside workspace')) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_ESCAPES_SESSION, err.message, requestId, err.stack));
    return;
  }
  throw err;
}
