import {
  INTERACTION_TAG_SESSION_ID,
  interactions,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import { toWireQuestion } from '../protocol/question-wire';
import {
  listPendingQuestionsQuerySchema,
  listPendingQuestionsResponseSchema,
} from '../protocol/rest-question';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { interactionAgentId } from './approvals';

interface QuestionRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerQuestionsRoutes(app: QuestionRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/questions',
      params: sessionIdParamSchema,
      querystring: listPendingQuestionsQuerySchema,
      success: { data: listPendingQuestionsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List pending question requests for a session',
      tags: ['questions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const handle = await resumeSessionById(core.accessor, session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const pending = interactions.findAll({
        kind: 'question',
        resolved: false,
        tags: { [INTERACTION_TAG_SESSION_ID]: session_id },
      });
      const items = pending.map((i) => toWireQuestion(i, session_id, interactionAgentId(i)));
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<QuestionRouteHost['get']>[2]);
}
