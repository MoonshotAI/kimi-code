/**
 * `/sessions/{session_id}/messages*` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions/{sid}/messages` wire contract on top of
 * `IMessageLegacyService` (`packages/agent-core-v2/src/messageLegacy`), which
 * reads the persisted wire transcript for cold sessions and the live context
 * for live ones. This route is a thin adapter: it resolves the Core-scoped
 * legacy service, projects the result into the protocol envelope, and maps the
 * domain error codes to the v1 wire codes.
 *
 *   GET    /sessions/{session_id}/messages              query: ListMessages   data: Page<Message>
 *   GET    /sessions/{session_id}/messages/{message_id} -                     data: Message
 *
 * **Error mapping**:
 *   - unknown session   → `40401` (session.not_found)
 *   - unknown message   → `40403` (message.not_found, get endpoint only)
 *   - invalid query     → `40001` (validation.failed, via defineRoute)
 */

import { IMessageLegacyService, isError2, type Scope } from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  getMessageResponseSchema,
  listMessagesResponseSchema,
  messageRoleSchema,
} from '@moonshot-ai/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface MessageRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

// --- Query coercion ---------------------------------------------------------

/**
 * HTTP query strings arrive as `Record<string, string>`. Coerce `page_size`
 * here so the protocol's cursor schema stays HTTP-agnostic — mirrors
 * `sessions.ts:sessionsListQueryCoercion` and v1's messages route.
 */
const messagesListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    role: messageRoleSchema.optional(),
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

const messageIdParamSchema = z.object({
  session_id: z.string().min(1),
  message_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

// --- Registration -----------------------------------------------------------

export function registerMessagesRoutes(app: MessageRouteHost, core: Scope): void {
  // GET /sessions/{session_id}/messages --------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/messages',
      params: sessionIdParamSchema,
      querystring: messagesListQueryCoercion,
      success: { data: listMessagesResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List messages for a session',
      tags: ['messages'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const page = await core.accessor.get(IMessageLegacyService).list(session_id, req.query);
        reply.send(okEnvelope(page, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<MessageRouteHost['get']>[2],
  );

  // GET /sessions/{session_id}/messages/{message_id} -------------------
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/messages/{message_id}',
      params: messageIdParamSchema,
      success: { data: getMessageResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.MESSAGE_NOT_FOUND]: {},
      },
      description: 'Get a message by ID',
      tags: ['messages'],
    },
    async (req, reply) => {
      try {
        const { session_id, message_id } = req.params;
        const message = await core.accessor.get(IMessageLegacyService).get(session_id, message_id);
        reply.send(okEnvelope(message, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<MessageRouteHost['get']>[2],
  );
}

/**
 * Map a thrown `Error2` to the right envelope:
 *   - `session.not_found` → `code: 40401`
 *   - `message.not_found` → `code: 40403`
 *   - anything else → `code: 50001`.
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isError2(err)) {
    switch (err.code) {
      case 'session.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'message.not_found':
        reply.send(errEnvelope(ErrorCode.MESSAGE_NOT_FOUND, err.message, requestId, err.stack));
        return;
    }
  }
  reply.send(
    errEnvelope(ErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : String(err), requestId, err instanceof Error ? err.stack : undefined),
  );
}
