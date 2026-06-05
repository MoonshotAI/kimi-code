/**
 * `/sessions/{sid}/prompts*` REST routes (Chain 4 / P1.4, W7.2;
 * abort handler extended in Chain 4b / W7.3).
 *
 * 2 endpoints (REST.md §3.5):
 *
 *   POST   /sessions/{sid}/prompts              body: PromptSubmission  data: PromptSubmitResult
 *   POST   /sessions/{sid}/prompts/{pid}:abort  body: empty             data: { aborted, at_seq? }
 *
 * **Error mapping**:
 *   - `SessionNotFoundError`        → 40401
 *   - `SessionBusyError`            → 40901 (with details.active_prompt_id)
 *   - `PromptNotFoundError`         → 40402
 *   - `PromptAlreadyCompletedError` → 40903 with data `{aborted: false}`
 *     per REST.md §3.5 (idempotent — wire data, non-zero code)
 *   - Other errors → 50001 via W4 `installErrorHandler`.
 *
 * **Shared abort handler** (W7.3): the actual abort logic lives in
 * `IPromptService.abort` — both this REST route AND the WS abort control
 * message dispatch through the same accessor call. The route is just a thin
 * envelope layer.
 *
 * **Anti-corruption**: routes go through `accessor.get(IPromptService)`;
 * no SDK package imports.
 */

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

import { errEnvelope, okEnvelope } from '../envelope.js';
import { buildRouteSchema } from '../middleware/schema.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { parseActionSuffix } from './action-suffix.js';

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

// --- Registration -----------------------------------------------------------

export function registerPromptsRoutes(
  app: PromptRouteHost,
  ix: IInstantiationService,
): void {
  // POST /sessions/{session_id}/prompts ---------------------------------
  app.post(
    '/sessions/:session_id/prompts',
    {
      preHandler: [
        validateParams(sessionIdParamSchema),
        validateBody(promptSubmissionSchema),
      ],
      schema: buildRouteSchema({
        description: 'Submit a prompt to a session',
        tags: ['prompts'],
        params: sessionIdParamSchema,
        body: promptSubmissionSchema,
        response: { 200: promptSubmitResultSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params as { session_id: string };
        const body = req.body as PromptSubmission;
        const result = await ix.invokeFunction((a) =>
          a.get(IPromptService).submit(session_id, body),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // POST /sessions/{session_id}/prompts/{prompt_id}:abort ---------------
  // Fastify's path syntax doesn't allow a literal `:abort` suffix on a
  // colon-prefixed param (`:prompt_id:abort` parses ambiguously). REST.md
  // §3.5 specifies the action-suffix syntax `{prompt_id}:abort`. We register
  // the route by capturing the tail segment (`:tail`) and verifying it ends
  // with `:abort` via the shared `parseActionSuffix` helper (4th call site
  // shared since W9.1).
  app.post(
    '/sessions/:session_id/prompts/:tail',
    {
      preHandler: [],
      schema: buildRouteSchema({
        description: 'Abort a running prompt',
        tags: ['prompts'],
        operationId: 'abortPrompt',
        response: { 200: promptAbortResponseSchema },
      }),
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
  // P2.1 D1 — readiness gate failures. The envelope shape mirrors
  // PLAN.md §3.1.4: `code` is the auth sub-code, `data: null`, `details`
  // carries `{provider_id?, model_id?}` so clients can route onboarding
  // without parsing `msg`.
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
