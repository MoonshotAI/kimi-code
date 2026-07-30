/**
 * `/feedback` route handlers — user feedback submission and attachment uploads.
 *
 * Thin adapters over `IFeedbackService` (see `src/services/feedback/`): the
 * validated wire body is forwarded to the managed collection backend with the
 * managed provider's OAuth token. `not_signed_in` maps to `40111`, backend
 * failures to `50001`.
 *
 *   POST /feedback                  body: FeedbackSubmitBody          data: FeedbackSubmitResponse
 *   POST /feedback/upload_url       body: FeedbackUploadUrlBody       data: FeedbackUploadUrlResponse
 *   POST /feedback/upload_complete  body: FeedbackUploadCompleteBody  data: null
 */

import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  feedbackSubmitBodySchema,
  feedbackSubmitResponseSchema,
  feedbackUploadCompleteBodySchema,
  feedbackUploadUrlBodySchema,
  feedbackUploadUrlResponseSchema,
} from '../protocol/rest-feedback';
import { FeedbackError, type IFeedbackService } from '../services/feedback/feedback';

interface FeedbackRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

function sendError(req: { id: string }, reply: { send(payload: unknown): unknown }, error: unknown): void {
  if (error instanceof FeedbackError) {
    const code = error.reason === 'not_signed_in' ? ErrorCode.AUTH_TOKEN_MISSING : ErrorCode.INTERNAL_ERROR;
    reply.send(errEnvelope(code, error.message, req.id, error.stack));
    return;
  }
  requestLog(req)?.error({ err: error }, 'feedback request failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      error instanceof Error ? error.message : String(error),
      req.id,
      error instanceof Error ? error.stack : undefined,
    ),
  );
}

export function registerFeedbackRoutes(app: FeedbackRouteHost, feedback: IFeedbackService): void {
  const submitRoute = defineRoute(
    {
      method: 'POST',
      path: '/feedback',
      body: feedbackSubmitBodySchema,
      success: { data: feedbackSubmitResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Submit user feedback; forwarded to the managed collection backend',
      tags: ['feedback'],
    },
    async (req, reply) => {
      try {
        const { feedbackId } = await feedback.submit(req.body);
        reply.send(okEnvelope({ feedback_id: feedbackId }, req.id));
      } catch (error) {
        sendError(req, reply, error);
      }
    },
  );
  app.post(
    submitRoute.path,
    submitRoute.options,
    submitRoute.handler as Parameters<FeedbackRouteHost['post']>[2],
  );

  const uploadUrlRoute = defineRoute(
    {
      method: 'POST',
      path: '/feedback/upload_url',
      body: feedbackUploadUrlBodySchema,
      success: { data: feedbackUploadUrlResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Create presigned upload URLs for a feedback attachment',
      tags: ['feedback'],
    },
    async (req, reply) => {
      try {
        const result = await feedback.createUploadUrl(req.body);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendError(req, reply, error);
      }
    },
  );
  app.post(
    uploadUrlRoute.path,
    uploadUrlRoute.options,
    uploadUrlRoute.handler as Parameters<FeedbackRouteHost['post']>[2],
  );

  const uploadCompleteRoute = defineRoute(
    {
      method: 'POST',
      path: '/feedback/upload_complete',
      body: feedbackUploadCompleteBodySchema,
      success: { data: z.null() },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Mark a feedback attachment upload as complete',
      tags: ['feedback'],
    },
    async (req, reply) => {
      try {
        await feedback.completeUpload(req.body);
        reply.send(okEnvelope(null, req.id));
      } catch (error) {
        sendError(req, reply, error);
      }
    },
  );
  app.post(
    uploadCompleteRoute.path,
    uploadCompleteRoute.options,
    uploadCompleteRoute.handler as Parameters<FeedbackRouteHost['post']>[2],
  );
}
