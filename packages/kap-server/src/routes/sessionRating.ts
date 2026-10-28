import { resumeSessionById, type Scope } from '@moonshot-ai/agent-core-v2';
import type { SessionRatingHost } from '@moonshot-ai/kimi-code-product/session-rating/node';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  sessionRatingRequestSchema,
  sessionRatingResultSchema,
} from '../protocol/rest-session-rating';
import type { TranscriptService } from '../services/transcript/transcriptService';

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
  transcripts: TranscriptService,
  core: Scope,
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
      },
      description:
        'Evaluate the latest completed transcript turn, or report a displayed rating and its final answer',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const request = req.body;
      if (request.op === 'evaluate') {
        const store = transcripts.forSessionLive(session_id);
        const items = store === undefined
          ? (await transcripts.readColdSnapshot(session_id))?.items
          : store.getAgent('main')?.getItems();
        const latest = items?.findLast((item) => item.kind === 'turn');
        const completed = latest?.turnId === request.turn_id && latest.state !== 'running';
        if (completed && store === undefined) {
          await resumeSessionById(core.accessor, session_id);
          await sessionRating.whenReady(session_id);
        }
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
