/**
 * `/sessions/{sid}/prompts*` REST routes.
 *
 * 2 endpoints (REST.md §3.5):
 *
 *   POST   /sessions/{sid}/prompts              body: PromptSubmission  data: PromptSubmitResult
 *   POST   /sessions/{sid}/prompts/{pid}:abort  body: empty             data: { aborted, at_seq? }
 *
 * **Stateful session, optional per-turn overrides**: `PromptSubmission`
 * carries `content` (required) plus `metadata?`, `model?`, `thinking?`,
 * `permission_mode?`, `plan_mode?`. The four runtime controls default to
 * the session's shadow state — the canonical mutation path is
 * `POST /sessions/{sid}/profile`. When the body carries any of the four, the
 * services layer diff-dispatches the matching setter (`source='prompt'`)
 * BEFORE running the prompt, so an override is also a state change for
 * the session.
 *
 * **Error mapping**:
 *   - `SessionNotFoundError`        → 40401
 *   - `SessionBusyError`            → 40901 (with details.active_prompt_id)
 *   - `PromptNotFoundError`         → 40402
 *   - `PromptAlreadyCompletedError` → 40903 with data `{aborted: false}`
 *     per REST.md §3.5 (idempotent — wire data, non-zero code)
 *   - Other errors → 50001 via the global `installErrorHandler`.
 *
 * **Shared abort handler**: the actual abort logic lives in
 * `IPromptService.abort` — both this REST route AND the WS abort control
 * message dispatch through the same accessor call. The route is just a thin
 * envelope layer.
 *
 * **Anti-corruption**: routes go through `accessor.get(IPromptService)`;
 * no SDK package imports.
 */

import { readFile } from 'node:fs/promises';

import {
  ErrorCode,
  promptAbortResponseSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  type PromptSubmission,
} from '@moonshot-ai/protocol';
import {
  IPromptService,
  AuthModelNotResolvedError,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  AuthTokenUnauthorizedError,
  PromptAlreadyCompletedError,
  PromptNotFoundError,
  SessionBusyError,
  SessionNotFoundError,
} from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { FileNotFoundError, IFileStore, type GetResult } from '#/services/fileStore';
import { parseActionSuffix } from './action-suffix';

interface PromptRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

// --- Params -----------------------------------------------------------------

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

// --- Registration -----------------------------------------------------------

export function registerPromptsRoutes(
  app: PromptRouteHost,
  ix: IInstantiationService,
): void {
  // POST /sessions/{session_id}/prompts ---------------------------------
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
            await resolvePromptImageFiles(body, a.get(IFileStore)),
          ),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // Cast handler back to the loose shape PromptRouteHost expects so the
  // structural type lines up (TypeScript function params are contravariant).
  app.post(
    submitRoute.path,
    submitRoute.options,
    submitRoute.handler as Parameters<PromptRouteHost['post']>[2],
  );

  // POST /sessions/{session_id}/prompts/{prompt_id}:abort ---------------
  // Fastify's path syntax doesn't allow a literal `:abort` suffix on a
  // colon-prefixed param (`:prompt_id:abort` parses ambiguously). REST.md
  // §3.5 specifies the action-suffix syntax `{prompt_id}:abort`. We register
  // the route by capturing the tail segment (`:tail`) and verifying it ends
  // with `:abort` via the shared `parseActionSuffix` helper.
  const abortRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts/{tail}',
      success: { data: promptAbortResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Abort a running prompt',
      tags: ['prompts'],
      operationId: 'abortPrompt',
    },
    async (req, reply) => {
      try {
        const { session_id, tail } = req.params as {
          session_id: string;
          tail: string;
        };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['abort'] as const,
          resourceLabel: 'prompt',
        });
        if (parsed.kind === 'invalid') {
          reply.send(
            errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id),
          );
          return;
        }
        // The prompts route does not accept a bare prompt_id; only :abort.
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
        const result = await ix.invokeFunction((a) =>
          a.get(IPromptService).abort(session_id, prompt_id),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  app.post(
    abortRoute.path,
    abortRoute.options,
    abortRoute.handler as Parameters<PromptRouteHost['post']>[2],
  );
}

async function resolvePromptImageFiles(
  body: PromptSubmission,
  store: IFileStore,
): Promise<PromptSubmission> {
  let changed = false;
  const content: PromptSubmission['content'] = [];
  for (const part of body.content) {
    if (part.type !== 'image' || part.source.kind !== 'file') {
      content.push(part);
      continue;
    }
    const file = await store.get(part.source.file_id);
    assertImageFile(file);
    const data = await readFile(file.blobPath);
    content.push({
      type: 'image',
      source: {
        kind: 'base64',
        media_type: file.meta.media_type,
        data: data.toString('base64'),
      },
    });
    changed = true;
  }
  return changed ? { ...body, content } : body;
}

function assertImageFile(file: GetResult): void {
  if (file.meta.media_type.toLowerCase().startsWith('image/')) return;
  throw new PromptImageFileTypeError(file.meta.id, file.meta.media_type);
}

/**
 * Map a thrown error to the right envelope. See module header for the table.
 *
 * NOTE: `PromptAlreadyCompletedError` is a SPECIAL case — REST.md §3.5
 * mandates `envelope.code = 40903 + envelope.data = {aborted: false}`. We
 * compose that here rather than using `errEnvelope` (which would set
 * `data: null`).
 */
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
  // Readiness gate failures. The envelope shape uses the auth sub-code,
  // `data: null`, and `details` carrying `{provider_id?, model_id?}` so
  // clients can route onboarding without parsing `msg`.
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
