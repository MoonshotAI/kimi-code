import type { SessionRatingHost } from '@moonshot-ai/kimi-code-product/session-rating/node';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  sessionRatingRequestSchema,
  sessionRatingResultSchema,
} from '../protocol/rest-session-rating';
import type { ConversationService } from '../services/conversation/conversationService';

interface SessionRatingRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown; headers: Record<string, unknown> },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerSessionRatingRoutes(
  app: SessionRatingRouteHost,
  sessionRating: SessionRatingHost,
  conversations: ConversationService,
): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/rating',
      params: z.object({ session_id: z.string().min(1) }),
      body: sessionRatingRequestSchema,
      success: { data: sessionRatingResultSchema.nullable() },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {
          detailsSchema: z.array(z.object({ path: z.string(), message: z.string() })),
        },
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description:
        'Evaluate the latest completed transcript turn, or report a displayed rating and its final answer',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const request = req.body;
      if (request.op === 'evaluate') {
        const turns = await conversations.mainTurns(session_id);
        const latest = turns?.findLast((turn) => turn.kind === 'agent');
        const completed = latest?.turn_id === request.turn_id && latest.status === 'ended';
        if (completed) await sessionRating.whenReady(session_id);
        const offer = completed ? sessionRating.evaluate(session_id) : undefined;
        reply.send(okEnvelope({
          appearance: offer === undefined
            ? null
            : { id: offer.appearanceId, survey: offer.survey },
        }, req.id));
        return;
      }
      sessionRating.report(session_id, request.op === 'respond'
        ? { type: 'respond', appearanceId: request.appearance_id, response: request.response }
        : { type: request.op, appearanceId: request.appearance_id });
      reply.send(okEnvelope(null, req.id));
    },
  );
  app.post(
    route.path,
    route.options,
    route.handler as Parameters<SessionRatingRouteHost['post']>[2],
  );
}
