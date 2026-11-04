import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { conversationTurnsPageSchema } from '../protocol/conversation';
import { ErrorCode } from '../protocol/error-codes';
import type { ConversationService } from '../services/conversation/conversationService';
import { sendMappedError, sessionConflictErrors } from './sessionErrors';

interface ConversationRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const agentParamsSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1).regex(/^[^/\\]+$/),
});

const turnsQuerySchema = z.object({
  before: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const DEFAULT_PAGE_TURNS = 20;

export function registerConversationRoutes(
  app: ConversationRouteHost,
  conversations: ConversationService,
): void {
  const turnsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/agents/{agent_id}/turns',
      params: agentParamsSchema,
      querystring: turnsQuerySchema,
      success: { data: conversationTurnsPageSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        ...sessionConflictErrors,
      },
      description:
        'One page of an agent\'s turns, oldest first: the latest page, or the turns whose ordinal is below before',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id, agent_id } = req.params;
      try {
        const feed = await conversations.feed(session_id, agent_id);
        reply.send(okEnvelope(await feed.page(req.query.before, req.query.limit ?? DEFAULT_PAGE_TURNS), req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(turnsRoute.path, turnsRoute.options, turnsRoute.handler as Parameters<ConversationRouteHost['get']>[2]);
}
