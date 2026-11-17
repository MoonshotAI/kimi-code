import { z } from 'zod';

import { IBootstrapService, IOAuthService, type Scope } from '@moonshot-ai/agent-core-v2';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { errEnvelope } from '../protocol/envelope';
import {
  createFeedbackRequestSchema,
  feedbackCreatedSchema,
  feedbackIdParamsSchema,
  updateFeedbackRequestSchema,
} from '../protocol/rest-feedback';
import { FeedbackRouteError, ManagedFeedbackGateway } from '../services/feedback';

interface FeedbackRouteHost {
  addContentTypeParser(
    contentType: string,
    parser: (
      request: unknown,
      payload: AsyncIterable<Uint8Array>,
      done: (error: Error | null, body: unknown) => void,
    ) => void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: unknown, reply: unknown) => unknown,
  ): unknown;
}

interface FeedbackReply {
  code(status: number): FeedbackReply;
  send(payload: unknown): unknown;
}

export function registerFeedbackRoutes(app: FeedbackRouteHost, core: Scope): void {
  const gateway = new ManagedFeedbackGateway(
    core.accessor.get(IOAuthService),
    core.accessor.get(IBootstrapService).getEnv('KIMI_CODE_BASE_URL') ??
      process.env['KIMI_CODE_BASE_URL'],
  );
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  const create = defineRoute(
    {
      method: 'POST',
      path: '/feedback',
      body: createFeedbackRequestSchema,
      success: { data: feedbackCreatedSchema },
      errors: { [ErrorCode.INTERNAL_ERROR]: {} },
      description: 'Create Desktop reply or global feedback',
      tags: ['feedback'],
    },
    async (req, reply) => {
      try {
        const feedbackId = await gateway.create(req.body);
        reply.send(okEnvelope({ feedback_id: feedbackId }, req.id));
      } catch (error) {
        sendFeedbackError(reply as unknown as FeedbackReply, req.id, error);
      }
    },
  );
  app.post(create.path, create.options, create.handler as Parameters<FeedbackRouteHost['post']>[2]);

  const update = defineRoute(
    {
      method: 'POST',
      path: '/feedback/update',
      body: updateFeedbackRequestSchema,
      success: { data: z.null() },
      errors: { [ErrorCode.INTERNAL_ERROR]: {} },
      description: 'Update feedback content and top-level info fields',
      tags: ['feedback'],
    },
    async (req, reply) => {
      try {
        await gateway.update(req.body);
        reply.send(okEnvelope(null, req.id));
      } catch (error) {
        sendFeedbackError(reply as unknown as FeedbackReply, req.id, error);
      }
    },
  );
  app.post(update.path, update.options, update.handler as Parameters<FeedbackRouteHost['post']>[2]);

  const attachment = defineRoute(
    {
      method: 'POST',
      path: '/feedback/{feedback_id}/attachments',
      params: feedbackIdParamsSchema,
      success: { data: z.null() },
      errors: { [ErrorCode.INTERNAL_ERROR]: {} },
      consumes: ['application/octet-stream'],
      description: 'Upload a feedback attachment through managed OAuth',
      tags: ['feedback'],
    },
    async (req, reply) => {
      try {
        const filename = decodeFilename(req.headers['x-feedback-file-name']);
        const declaredSize = readDeclaredSize(req.headers['x-feedback-file-size']);
        if (!isByteIterable(req.body)) throw new FeedbackRouteError('attachment body must be a byte stream', 400);
        await gateway.upload(req.params.feedback_id, { filename, declaredSize, bytes: req.body });
        reply.send(okEnvelope(null, req.id));
      } catch (error) {
        sendFeedbackError(reply as unknown as FeedbackReply, req.id, error);
      }
    },
  );
  app.post(
    attachment.path,
    attachment.options,
    attachment.handler as Parameters<FeedbackRouteHost['post']>[2],
  );
}

function decodeFilename(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedbackRouteError('x-feedback-file-name is required', 400);
  }
  try {
    const filename = decodeURIComponent(value);
    if (filename.length === 0) throw new Error('empty');
    return filename;
  } catch {
    throw new FeedbackRouteError('x-feedback-file-name must be URI encoded', 400);
  }
}

function readDeclaredSize(value: unknown): number {
  const size = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new FeedbackRouteError('x-feedback-file-size must be a non-negative integer', 400);
  }
  return size;
}

function isByteIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function sendFeedbackError(reply: FeedbackReply, requestId: string, error: unknown): void {
  const status = error instanceof FeedbackRouteError ? error.status : 502;
  const message = error instanceof Error ? error.message : String(error);
  reply.code(status).send(errEnvelope(ErrorCode.INTERNAL_ERROR, message, requestId));
}
