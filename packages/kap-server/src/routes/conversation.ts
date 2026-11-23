import {
  Error2,
  ErrorCodes,
  ISessionBtwService,
  reloadOnStale,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { conversationTurnsPageSchema } from '../protocol/conversation';
import { ErrorCode } from '../protocol/error-codes';
import type { ConversationService } from '../services/conversation/conversationService';
import { type ActionTable, resolveActionTarget, runAction } from './action-dispatch';
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
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const agentParamsSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1).regex(/^[^/\\]+$/),
});

const actionTailParamsSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

const turnsQuerySchema = z.object({
  before_ordinal: z.coerce.number().int().nonnegative().optional(),
  page_size: z.coerce.number().int().min(1).max(200).optional(),
});

const agentCloseResponseSchema = z.object({
  closed: z.literal(true),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const DEFAULT_PAGE_TURNS = 50;

export function registerConversationRoutes(
  app: ConversationRouteHost,
  core: Scope,
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
        'One page of an agent\'s turns, oldest first: the latest page, or the turns whose ordinal is below before_ordinal. A page stays within 1 MiB, so it can hold fewer than page_size turns',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id, agent_id } = req.params;
      try {
        const feed = await conversations.feed(session_id, agent_id);
        const page = await feed.page(req.query.before_ordinal, req.query.page_size ?? DEFAULT_PAGE_TURNS);
        reply.send(okEnvelope(page, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(turnsRoute.path, turnsRoute.options, turnsRoute.handler as Parameters<ConversationRouteHost['get']>[2]);

  const agentActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/agents/{tail}',
      params: actionTailParamsSchema,
      success: { data: agentCloseResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.AGENT_NOT_CLOSABLE]: {},
        ...sessionConflictErrors,
      },
      description: 'Close a side-channel (btw) agent',
      tags: ['sessions'],
      operationId: 'agentAction',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params;
      try {
        const target = resolveActionTarget({
          tail,
          actions: agentActions,
          resourceLabel: 'agent',
        });
        if ('message' in target) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, target.message, req.id));
          return;
        }
        await runAction({
          action: target.action,
          id: target.id,
          actions: agentActions,
          extra: { core, session_id, req, reply },
        });
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    agentActionRoute.path,
    agentActionRoute.options,
    agentActionRoute.handler as Parameters<ConversationRouteHost['post']>[2],
  );
}

type AgentActionExtra = {
  readonly core: Scope;
  readonly session_id: string;
  readonly req: { readonly id: string };
  readonly reply: { send(payload: unknown): unknown };
};

const agentActions: ActionTable<'close', AgentActionExtra> = {
  close: {
    handle: async ({ core, session_id, id, req, reply }) => {
      await reloadOnStale(
        core.accessor,
        session_id,
        async () => {
          const session = await resumeSessionById(core.accessor, session_id);
          if (session === undefined) {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
          }
          await session.accessor.get(ISessionBtwService).close(id);
        },
      );
      reply.send(okEnvelope({ closed: true }, req.id));
    },
  },
};
