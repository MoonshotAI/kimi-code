/**
 * `/api/v1` prompt routes — v1-compatible prompt surface backed by
 * `IPromptLegacyService` (the per-agent v1 scheduler). Paths and wire shapes
 * mirror `packages/server/src/routes/prompts.ts` so existing clients keep
 * working against server-v2.
 */

import {
  IAgentLifecycleService,
  IAgentPromptLegacyService,
  ISessionLifecycleService,
  isKimiError,
  KimiError,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
} from '@moonshot-ai/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
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

const validationDetailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));
const authProviderDetailsSchema = z.object({ provider_id: z.string() });
const authModelDetailsSchema = z.object({ model_id: z.string(), provider_id: z.string() }).partial();

async function resolveLegacy(
  core: Scope,
  sessionId: string,
  agentId?: string,
): Promise<IAgentPromptLegacyService> {
  // `resume` (not `get`) so a persisted-but-cold session — created by a previous
  // process, by v1, or closed in this one — is loaded from disk instead of
  // being reported as `session.not_found`. Mirrors the snapshot route. Returns
  // `undefined` only when the session is unknown or its workspace is gone.
  const session = await core.accessor.get(ISessionLifecycleService).resume(sessionId);
  if (session === undefined) {
    throw new KimiError('session.not_found', `session ${sessionId} does not exist`);
  }
  // A prompt may target a forked side-channel agent (e.g. `/btw`) via
  // `body.agent_id`. Default to `main` when absent; only `main` is
  // auto-created — any other id must already exist (forked beforehand), or it
  // is reported as `agent.not_found`.
  const agent =
    agentId === undefined || agentId === MAIN_AGENT_ID
      ? await ensureMainAgent(session)
      : session.accessor.get(IAgentLifecycleService).getHandle(agentId);
  if (agent === undefined) {
    throw new KimiError('agent.not_found', `agent ${agentId} does not exist`);
  }
  return agent.accessor.get(IAgentPromptLegacyService);
}

export function registerPromptsRoutes(app: PromptRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/prompts',
      params: sessionIdParamSchema,
      success: { data: promptListResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'List the active prompt and queued prompts for a session',
      tags: ['prompts'],
      operationId: 'listPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const result = (await resolveLegacy(core, session_id)).list();
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<PromptRouteHost['get']>[2]);

  const submitRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts',
      body: promptSubmissionSchema,
      params: sessionIdParamSchema,
      success: { data: promptSubmitResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema: validationDetailsSchema },
        [ErrorCode.AUTH_PROVISIONING_REQUIRED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: { detailsSchema: authProviderDetailsSchema },
        [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: { detailsSchema: authProviderDetailsSchema },
        [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: { detailsSchema: authModelDetailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Submit a prompt to a session',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const legacy = await resolveLegacy(core, session_id, req.body.agent_id);
        const result = await legacy.submit(req.body);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(submitRoute.path, submitRoute.options, submitRoute.handler as Parameters<PromptRouteHost['post']>[2]);

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
        const legacy = await resolveLegacy(core, session_id);
        const result = await legacy.steer(req.body.prompt_ids);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(steerManyRoute.path, steerManyRoute.options, steerManyRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const actionRoute = defineRoute(
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
        const { session_id, tail } = req.params as { session_id: string; tail: string };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['abort', 'steer'] as const,
          resourceLabel: 'prompt',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const legacy = await resolveLegacy(core, session_id);
        const result =
          parsed.action === 'abort'
            ? await legacy.abort(parsed.id)
            : await legacy.steer([parsed.id]);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(actionRoute.path, actionRoute.options, actionRoute.handler as Parameters<PromptRouteHost['post']>[2]);
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isKimiError(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
        return;
      case 'prompt.not_found':
        reply.send(errEnvelope(ErrorCode.PROMPT_NOT_FOUND, err.message, requestId));
        return;
      case 'session.busy':
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, err.message, requestId));
        return;
      case 'prompt.already_completed':
        reply.send({
          code: ErrorCode.PROMPT_ALREADY_COMPLETED,
          msg: err.message,
          data: { aborted: false },
          request_id: requestId,
        });
        return;
      case 'request.invalid':
      case 'validation.failed':
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId));
        return;
      case 'auth.provisioning_required':
        reply.send({
          code: ErrorCode.AUTH_PROVISIONING_REQUIRED,
          msg: err.message,
          data: null,
          request_id: requestId,
          details: null,
        });
        return;
      case 'auth.token_missing': {
        const details = authProviderDetails(err);
        if (details === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              `auth error ${err.code} missing provider_id`,
              requestId,
            ),
          );
          return;
        }
        reply.send({
          code: ErrorCode.AUTH_TOKEN_MISSING,
          msg: err.message,
          data: null,
          request_id: requestId,
          details,
        });
        return;
      }
      case 'auth.token_unauthorized': {
        const details = authProviderDetails(err);
        if (details === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              `auth error ${err.code} missing provider_id`,
              requestId,
            ),
          );
          return;
        }
        reply.send({
          code: ErrorCode.AUTH_TOKEN_UNAUTHORIZED,
          msg: err.message,
          data: null,
          request_id: requestId,
          details,
        });
        return;
      }
      case 'auth.model_not_resolved':
        reply.send({
          code: ErrorCode.AUTH_MODEL_NOT_RESOLVED,
          msg: err.message,
          data: null,
          request_id: requestId,
          details: authModelDetails(err),
        });
        return;
    }
  }
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
    ),
  );
}

function authProviderDetails(err: KimiError): { provider_id: string } | undefined {
  const providerId = err.details?.provider_id;
  if (typeof providerId !== 'string') return undefined;
  return { provider_id: providerId };
}

function authModelDetails(err: KimiError): { model_id?: string; provider_id?: string } | null {
  const details: { model_id?: string; provider_id?: string } = {};
  const modelId = err.details?.model_id;
  const providerId = err.details?.provider_id;
  if (typeof modelId === 'string') details.model_id = modelId;
  if (typeof providerId === 'string') details.provider_id = providerId;
  return Object.keys(details).length === 0 ? null : details;
}
