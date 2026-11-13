import {
  feedbackAvailabilitySchema,
  feedbackCompleteResultSchema,
  feedbackCompleteUploadInputSchema,
  feedbackModelAliasQuerySchema,
  feedbackSubmitInputSchema,
  feedbackSubmitResultSchema,
  feedbackUploadUrlInputSchema,
  feedbackUploadUrlResultSchema,
  IFeedbackService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface RouteHost {
  get(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: { modelAlias?: string } },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: { modelAlias?: string }; body: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerFeedbackRoutes(app: RouteHost, core: Scope): void {
  const feedback = () => core.accessor.get(IFeedbackService);
  const query = feedbackModelAliasQuerySchema;

  const availability = defineRoute(
    {
      method: 'GET',
      path: '/feedback/availability',
      querystring: query,
      success: { data: feedbackAvailabilitySchema },
      description: 'Whether /feedback can be submitted for the active model',
      tags: ['feedback'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(await feedback().availability(req.query.modelAlias), req.id));
    },
  );
  app.get(availability.path, availability.options, availability.handler as Parameters<RouteHost['get']>[2]);

  const submit = defineRoute(
    {
      method: 'POST',
      path: '/feedback',
      querystring: query,
      body: feedbackSubmitInputSchema,
      success: { data: feedbackSubmitResultSchema },
      description: 'Submit feedback for the active model',
      tags: ['feedback'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(await feedback().submit(req.body, req.query.modelAlias), req.id));
    },
  );
  app.post(submit.path, submit.options, submit.handler as Parameters<RouteHost['post']>[2]);

  const uploadUrl = defineRoute(
    {
      method: 'POST',
      path: '/feedback/upload-url',
      querystring: query,
      body: feedbackUploadUrlInputSchema,
      success: { data: feedbackUploadUrlResultSchema },
      description: 'Create a feedback attachment upload',
      tags: ['feedback'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(await feedback().createUploadUrl(req.body, req.query.modelAlias), req.id));
    },
  );
  app.post(uploadUrl.path, uploadUrl.options, uploadUrl.handler as Parameters<RouteHost['post']>[2]);

  const complete = defineRoute(
    {
      method: 'POST',
      path: '/feedback/upload-complete',
      querystring: query,
      body: feedbackCompleteUploadInputSchema,
      success: { data: feedbackCompleteResultSchema },
      description: 'Complete a feedback attachment upload',
      tags: ['feedback'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(await feedback().completeUpload(req.body, req.query.modelAlias), req.id));
    },
  );
  app.post(complete.path, complete.options, complete.handler as Parameters<RouteHost['post']>[2]);
}
