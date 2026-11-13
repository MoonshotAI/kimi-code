import { IFeedbackService, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface RouteHost {
  get(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: { model_alias?: string } },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: { model_alias?: string } },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const modelAliasQuerySchema = z.object({
  model_alias: z.string().optional(),
});

const availabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('needs-login') }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

const feedbackResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), feedback_id: z.number() }),
  z.object({ kind: z.literal('needs-login') }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

const uploadPartSchema = z.object({
  part_number: z.number(),
  url: z.string(),
  method: z.string(),
  size: z.number(),
});

const uploadUrlResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    upload_id: z.number(),
    parts: z.array(uploadPartSchema),
  }),
  z.object({ kind: z.literal('needs-login') }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

const completeResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok') }),
  z.object({ kind: z.literal('needs-login') }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

const submitBodySchema = z.object({
  model_alias: z.string().optional(),
  content: z.string(),
  session_id: z.string(),
  version: z.string(),
  os: z.string(),
  model: z.string().nullable(),
  contact: z.string().optional(),
  info: z.record(z.string(), z.unknown()).optional(),
});

const uploadUrlBodySchema = z.object({
  model_alias: z.string().optional(),
  feedback_id: z.number(),
  filename: z.string(),
  size: z.number(),
  sha256: z.string(),
});

const completeBodySchema = z.object({
  model_alias: z.string().optional(),
  upload_id: z.number(),
  parts: z.array(z.object({ part_number: z.number(), etag: z.string() })),
});

export function registerFeedbackRoutes(app: RouteHost, core: Scope): void {
  const availability = defineRoute(
    {
      method: 'GET',
      path: '/feedback/availability',
      querystring: modelAliasQuerySchema,
      success: { data: availabilitySchema },
      description: 'Whether /feedback can be submitted for the active model',
      tags: ['feedback'],
    },
    async (req, reply) => {
      const result = await core.accessor.get(IFeedbackService).availability(req.query.model_alias);
      reply.send(okEnvelope(result, req.id));
    },
  );
  app.get(availability.path, availability.options, availability.handler as Parameters<RouteHost['get']>[2]);

  const submit = defineRoute(
    {
      method: 'POST',
      path: '/feedback',
      body: submitBodySchema,
      success: { data: feedbackResultSchema },
      description: 'Submit feedback for the active model',
      tags: ['feedback'],
    },
    async (req, reply) => {
      const body = req.body as z.infer<typeof submitBodySchema>;
      const result = await core.accessor.get(IFeedbackService).submit(
        {
          content: body.content,
          sessionId: body.session_id,
          version: body.version,
          os: body.os,
          model: body.model,
          contact: body.contact,
          info: body.info,
        },
        body.model_alias,
      );
      reply.send(
        okEnvelope(
          result.kind === 'ok' ? { kind: 'ok', feedback_id: result.feedbackId } : result,
          req.id,
        ),
      );
    },
  );
  app.post(submit.path, submit.options, submit.handler as Parameters<RouteHost['post']>[2]);

  const uploadUrl = defineRoute(
    {
      method: 'POST',
      path: '/feedback/upload-url',
      body: uploadUrlBodySchema,
      success: { data: uploadUrlResultSchema },
      description: 'Create a feedback attachment upload',
      tags: ['feedback'],
    },
    async (req, reply) => {
      const body = req.body as z.infer<typeof uploadUrlBodySchema>;
      const result = await core.accessor.get(IFeedbackService).createUploadUrl(
        {
          feedbackId: body.feedback_id,
          filename: body.filename,
          size: body.size,
          sha256: body.sha256,
        },
        body.model_alias,
      );
      reply.send(
        okEnvelope(
          result.kind === 'ok'
            ? {
                kind: 'ok',
                upload_id: result.uploadId,
                parts: result.parts.map((part) => ({
                  part_number: part.partNumber,
                  url: part.url,
                  method: part.method,
                  size: part.size,
                })),
              }
            : result,
          req.id,
        ),
      );
    },
  );
  app.post(uploadUrl.path, uploadUrl.options, uploadUrl.handler as Parameters<RouteHost['post']>[2]);

  const complete = defineRoute(
    {
      method: 'POST',
      path: '/feedback/upload-complete',
      body: completeBodySchema,
      success: { data: completeResultSchema },
      description: 'Complete a feedback attachment upload',
      tags: ['feedback'],
    },
    async (req, reply) => {
      const body = req.body as z.infer<typeof completeBodySchema>;
      const result = await core.accessor.get(IFeedbackService).completeUpload(
        {
          uploadId: body.upload_id,
          parts: body.parts.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
        },
        body.model_alias,
      );
      reply.send(okEnvelope(result, req.id));
    },
  );
  app.post(complete.path, complete.options, complete.handler as Parameters<RouteHost['post']>[2]);
}
