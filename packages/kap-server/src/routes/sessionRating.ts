import type { RatingAction, RatingView } from '@moonshot-ai/kimi-code-product';
import type { SessionRatingHost } from '@moonshot-ai/kimi-code-product/core';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  sessionRatingRequestSchema,
  sessionRatingViewSchema,
  type SessionRatingRequest,
  type SessionRatingView,
} from '../protocol/rest-session-rating';

interface SessionRatingRouteHost {
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
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerSessionRatingRoutes(
  app: SessionRatingRouteHost,
  sessionRating: SessionRatingHost,
): void {
  const viewRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/rating',
      params: sessionIdParamSchema,
      success: { data: sessionRatingViewSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
      },
      description:
        'Read the session rating prompt of a loaded session; sessions that are not loaded report closed',
      tags: ['sessions'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(toWireView(sessionRating.view(req.params.session_id)), req.id));
    },
  );
  app.get(
    viewRoute.path,
    viewRoute.options,
    viewRoute.handler as Parameters<SessionRatingRouteHost['get']>[2],
  );

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/rating',
      params: sessionIdParamSchema,
      body: sessionRatingRequestSchema,
      success: { data: sessionRatingViewSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
      },
      description:
        'Evaluate, answer, undo, or dismiss the session rating prompt; requests that do not match the current prompt return it unchanged',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const view =
        req.body.op === 'evaluate'
          ? await sessionRating.evaluate(session_id)
          : sessionRating.act(session_id, toRatingAction(req.body));
      reply.send(okEnvelope(toWireView(view), req.id));
    },
  );
  app.post(
    actionRoute.path,
    actionRoute.options,
    actionRoute.handler as Parameters<SessionRatingRouteHost['post']>[2],
  );
}

function toRatingAction(request: Exclude<SessionRatingRequest, { op: 'evaluate' }>): RatingAction {
  switch (request.op) {
    case 'select':
      return { type: 'select', appearanceId: request.appearance_id, response: request.response };
    case 'undo':
      return { type: 'undo', appearanceId: request.appearance_id };
    case 'dismiss':
      return { type: 'dismiss', appearanceId: request.appearance_id };
  }
}

function toWireView(view: RatingView): SessionRatingView {
  switch (view.phase) {
    case 'closed':
      return { phase: 'closed' };
    case 'open':
      return { phase: 'open', appearance_id: view.appearanceId, survey: view.survey };
    case 'pending':
      return {
        phase: 'pending',
        appearance_id: view.appearanceId,
        survey: view.survey,
        response: view.response,
        settle_in_ms: view.settleInMs,
      };
    case 'thanks':
      return {
        phase: 'thanks',
        appearance_id: view.appearanceId,
        survey: view.survey,
        response: view.response,
        close_in_ms: view.closeInMs,
      };
  }
}
