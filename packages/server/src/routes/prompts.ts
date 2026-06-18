

import { readFile } from 'node:fs/promises';

import {
  ErrorCode,
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  type PromptSubmission,
} from '@moonshot-ai/protocol';
import { IPromptService, AuthModelNotResolvedError, AuthProvisioningRequiredError, AuthTokenMissingError, AuthTokenUnauthorizedError, PromptAlreadyCompletedError, PromptNotFoundError, SessionBusyError, SessionNotFoundError, FileNotFoundError, IFileStore, type IInstantiationService, type GetResult } from '@moonshot-ai/agent-core';
import { z } from 'zod';


import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

interface PromptRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

class PromptImageFileTypeError extends Error {
  constructor(
    readonly fileId: string,
    readonly mediaType: string,
  ) {
    super(`file ${fileId} is ${mediaType}, not an image`);
    this.name = 'PromptImageFileTypeError';
  }
}

export function registerPromptsRoutes(
  app: PromptRouteHost,
  ix: IInstantiationService,
): void {

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/prompts',
      params: sessionIdParamSchema,
      success: { data: promptListResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List the active prompt and queued prompts for a session',
      tags: ['prompts'],
      operationId: 'listPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const result = await ix.invokeFunction((a) =>
          a.get(IPromptService).list(session_id),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );

  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<PromptRouteHost['get']>[2],
  );

  const submitRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts',
      body: promptSubmissionSchema,
      params: sessionIdParamSchema,
      success: { data: promptSubmitResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {
          detailsSchema: z.array(
            z.object({ path: z.string(), message: z.string() }),
          ),
        },
        [ErrorCode.AUTH_PROVISIONING_REQUIRED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: { detailsSchema: z.object({ provider_id: z.string() }) },
        [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: { detailsSchema: z.object({ provider_id: z.string() }) },
        [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: {
          detailsSchema: z
            .object({ model_id: z.string(), provider_id: z.string() })
            .partial(),
        },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FILE_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: { detailsSchema: z.object({ active_prompt_id: z.string() }) },
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Submit a prompt to a session',
      tags: ['prompts'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const body = req.body;
        const result = await ix.invokeFunction(async (a) =>
          a.get(IPromptService).submit(
            session_id,
            await resolvePromptMediaFiles(body, a.get(IFileStore)),
          ),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );

  app.post(
    submitRoute.path,
    submitRoute.options,
    submitRoute.handler as Parameters<PromptRouteHost['post']>[2],
  );

  const steerManyRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts::steer',
      body: promptSteerRequestSchema,
      params: sessionIdParamSchema,
      success: { data: promptSteerResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
      },
      description: 'Steer queued prompts into the active turn',
      tags: ['prompts'],
      operationId: 'steerPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const result = await ix.invokeFunction((a) =>
          a.get(IPromptService).steer(session_id, req.body.prompt_ids),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );

  app.post(
    steerManyRoute.path,
    steerManyRoute.options,
    steerManyRoute.handler as Parameters<PromptRouteHost['post']>[2],
  );

  const abortRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts/{tail}',
      success: { data: z.union([promptAbortResponseSchema, promptSteerResultSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Abort a running prompt or steer a queued prompt',
      tags: ['prompts'],
      operationId: 'promptAction',
    },
    async (req, reply) => {
      try {
        const { session_id, tail } = req.params as {
          session_id: string;
          tail: string;
        };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['abort', 'steer'] as const,
          resourceLabel: 'prompt',
        });
        if (parsed.kind === 'invalid') {
          reply.send(
            errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id),
          );
          return;
        }

        if (parsed.kind === 'bare') {
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              `unsupported action: ${tail}`,
              req.id,
            ),
          );
          return;
        }
        const prompt_id = parsed.id;
        if (!session_id || !prompt_id) {
          reply.send(
            errEnvelope(ErrorCode.VALIDATION_FAILED, 'invalid path params', req.id),
          );
          return;
        }
        const result = await ix.invokeFunction((a) => {
          const service = a.get(IPromptService);
          return parsed.action === 'abort'
            ? service.abort(session_id, prompt_id)
            : service.steer(session_id, [prompt_id]);
        });
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );

  app.post(
    abortRoute.path,
    abortRoute.options,
    abortRoute.handler as Parameters<PromptRouteHost['post']>[2],
  );
}

async function resolvePromptMediaFiles(
  body: PromptSubmission,
  store: IFileStore,
): Promise<PromptSubmission> {
  let changed = false;
  const content: PromptSubmission['content'] = [];
  for (const part of body.content) {
    if ((part.type !== 'image' && part.type !== 'video') || part.source.kind !== 'file') {
      content.push(part);
      continue;
    }
    const file = await store.get(part.source.file_id);
    assertMediaFile(file, part.type);
    const data = await readFile(file.blobPath);
    const source = {
      kind: 'base64' as const,
      media_type: file.meta.media_type,
      data: data.toString('base64'),
    };
    content.push(part.type === 'video' ? { type: 'video', source } : { type: 'image', source });
    changed = true;
  }
  return changed ? { ...body, content } : body;
}

function assertMediaFile(file: GetResult, expected: 'image' | 'video'): void {
  const prefix = expected === 'video' ? 'video/' : 'image/';
  if (file.meta.media_type.toLowerCase().startsWith(prefix)) return;
  throw new PromptImageFileTypeError(file.meta.id, file.meta.media_type);
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof PromptAlreadyCompletedError) {
    reply.send({
      code: ErrorCode.PROMPT_ALREADY_COMPLETED,
      msg: err.message,
      data: { aborted: false },
      request_id: requestId,
    });
    return;
  }
  if (err instanceof SessionBusyError) {
    reply.send({
      code: ErrorCode.SESSION_BUSY,
      msg: err.message,
      data: null,
      request_id: requestId,
      details: { active_prompt_id: err.activePromptId },
    });
    return;
  }
  if (err instanceof PromptNotFoundError) {
    reply.send(errEnvelope(ErrorCode.PROMPT_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof FileNotFoundError) {
    reply.send(errEnvelope(ErrorCode.FILE_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof PromptImageFileTypeError) {
    reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId));
    return;
  }

  if (err instanceof AuthProvisioningRequiredError) {
    reply.send({
      code: ErrorCode.AUTH_PROVISIONING_REQUIRED,
      msg: err.message,
      data: null,
      request_id: requestId,
      details: null,
    });
    return;
  }
  if (err instanceof AuthTokenMissingError) {
    reply.send({
      code: ErrorCode.AUTH_TOKEN_MISSING,
      msg: err.message,
      data: null,
      request_id: requestId,
      details: { provider_id: err.providerId },
    });
    return;
  }
  if (err instanceof AuthTokenUnauthorizedError) {
    reply.send({
      code: ErrorCode.AUTH_TOKEN_UNAUTHORIZED,
      msg: err.message,
      data: null,
      request_id: requestId,
      details: { provider_id: err.providerId },
    });
    return;
  }
  if (err instanceof AuthModelNotResolvedError) {
    const details: Record<string, unknown> = {};
    if (err.modelId !== undefined) details['model_id'] = err.modelId;
    if (err.providerId !== undefined) details['provider_id'] = err.providerId;
    reply.send({
      code: ErrorCode.AUTH_MODEL_NOT_RESOLVED,
      msg: err.message,
      data: null,
      request_id: requestId,
      details: Object.keys(details).length === 0 ? null : details,
    });
    return;
  }
  throw err;
}
