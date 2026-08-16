/**
 * `/api/v1` prompt routes — v1-compatible prompt surface backed directly by
 * the Agent-scoped `prompt` scheduler. This edge applies protocol conversion,
 * request overrides, and metadata updates while preserving the paths and wire
 * shapes from `packages/server/src/routes/prompts.ts`.
 */

import { join } from 'node:path';

import {
  IBootstrapService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentToolPolicyService,
  IAgentPromptService,
  IAuthSummaryService,
  IEventService,
  IFileService,
  ISessionMetadata,
  parseKimiFileUrl,
  promptMetadataTextFromContentParts,
  ProfileError,
  type ContentPart,
  type PromptHandle,
  type PromptQueueSnapshot,
  ISessionContext,
  resumeSessionById,
  ITelemetryService,
  applyPromptMetadataUpdate,
  isError2,
  Error2,
  ErrorCodes,
  sessionMediaOriginalsDir,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import {
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  type PromptSubmission,
} from '../protocol/rest-prompt';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import {
  assertPromptFileRefs,
  contentToCoreParts,
  resolvePromptMediaFiles,
} from '../lib/promptMedia';
import { requestLog } from '../lib/requestLog';
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

async function resolveSession(core: Scope, sessionId: string): Promise<ISessionScopeHandle> {
  // `resume` (not `get`) so a persisted-but-cold session — created by a previous
  // process, by v1, or closed in this one — is loaded from disk instead of
  // being reported as `session.not_found`. Mirrors the snapshot route. Returns
  // `undefined` only when the session is unknown or its workspace is gone.
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2('session.not_found', `session ${sessionId} does not exist`);
  }
  return session;
}

async function resolvePrompt(core: Scope, sessionId: string, agentId?: string) {
  return resolvePromptFromSession(await resolveSession(core, sessionId), agentId);
}

async function resolvePromptFromSession(session: ISessionScopeHandle, agentId?: string) {
  // A prompt may target a forked side-channel agent (e.g. `/btw`) via
  // `body.agent_id`. Default to `main` when absent; only `main` is
  // auto-created — any other id must already exist (forked beforehand), or it
  // is reported as `agent.not_found`.
  const agent =
    agentId === undefined || agentId === MAIN_AGENT_ID
      ? await ensureMainAgent(session)
      : session.accessor.get(IAgentLifecycleService).get(agentId);
  if (agent === undefined) {
    throw new Error2('agent.not_found', `agent ${agentId} does not exist`);
  }
  return {
    prompt: agent.accessor.get(IAgentPromptService),
    auth: agent.accessor.get(IAuthSummaryService),
    profile: agent.accessor.get(IAgentProfileService),
    toolPolicy: agent.accessor.get(IAgentToolPolicyService),
    permissionMode: agent.accessor.get(IAgentPermissionModeService),
  };
}

/**
 * Bind the resolved agent to the profile named by a prompt submission's
 * `profile` field. First-bind semantics live in the engine: a same-name
 * repeat is short-circuited here as a no-op, while an unknown name or a
 * post-bind switch is rejected by `AgentProfileService.bind` with a coded
 * `ProfileError` — this edge only maps it onto 40001. Checking anything
 * beyond the no-op shortcut here would re-introduce a check-then-act window
 * the engine guard has already closed.
 *
 * `model` falls back to the configured default inside the engine. `thinking`
 * rides along in the bind so an unsupported effort rejects atomically —
 * before any state mutation — instead of wedging the session's identity with
 * a successful bind followed by a failed `setThinking`.
 *
 * Returns true when a bind happened (i.e. `thinking` was consumed by it).
 */
async function applyProfileSelection(
  profile: IAgentProfileService,
  profileName: string,
  model: string | undefined,
  thinking: string | undefined,
): Promise<boolean> {
  if (profile.data().profileName === profileName) return false;
  try {
    await profile.bind({
      profile: profileName,
      model,
      thinking,
      strictThinking: thinking !== undefined,
    });
  } catch (error) {
    if (error instanceof ProfileError) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
    }
    throw error;
  }
  return true;
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
        const result = projectPromptList((await resolvePrompt(core, session_id)).prompt.list());
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
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
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Submit a prompt to a session',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      try {
        // Fail fast on stale file references before anything is resolved or
        // mutated: a bad `file_id` must not create the agent, register `main`
        // in session metadata, or touch the session's controls.
        await assertPromptFileRefs(req.body.content, core.accessor.get(IFileService));
        const resolved = await resolvePrompt(core, session_id, req.body.agent_id);
        await resolved.auth.ensureReady();

        // Media resolution runs BEFORE any control mutation, so a failed
        // submission leaves the session's controls untouched. Prompt videos
        // are materialized to a local copy and carried into context as an
        // internal `kimi-file://` reference; the engine resolves them to a
        // provider form (upload / inline / `<video path>` tag) at request
        // time, so the edge no longer uploads.
        const telemetry = core.accessor.get(ITelemetryService).withContext({ sessionId: session_id });
        const resolvedContent = await resolvePromptMediaFiles(
          req.body.content,
          core.accessor.get(IFileService),
          core.accessor.get(IBootstrapService).cacheDir,
          {
            telemetry,
            resolveOriginalsDir: async () => {
              const session = await resumeSessionById(core.accessor, session_id);
              if (session === undefined) return undefined;
              return sessionMediaOriginalsDir(session.accessor.get(ISessionContext).sessionDir);
            },
            resolveAttachmentsDir: async () => {
              const session = await resumeSessionById(core.accessor, session_id);
              if (session === undefined) return undefined;
              return join(session.accessor.get(ISessionContext).sessionDir, 'attachments');
            },
          },
        );

        // Media prepared successfully — only now do the overrides bind.
        let thinkingConsumed = false;
        if (req.body.profile !== undefined) {
          thinkingConsumed =
            (await applyProfileSelection(
              resolved.profile,
              req.body.profile,
              req.body.model,
              req.body.thinking,
            )) && req.body.thinking !== undefined;
        }
        if (req.body.model !== undefined) await resolved.profile.setModel(req.body.model);
        if (req.body.thinking !== undefined && !thinkingConsumed)
          resolved.profile.setThinking(req.body.thinking);
        if (req.body.permission_mode !== undefined) resolved.permissionMode.setMode(req.body.permission_mode);
        if (req.body.disabled_tools !== undefined) {
          // A session denylist before bind throws `profile.not_bound` — map it
          // onto 40001 like the profile-selection errors above.
          try {
            await resolved.toolPolicy.setSessionDisabledTools(req.body.disabled_tools);
          } catch (error) {
            if (error instanceof ProfileError) {
              throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
            }
            throw error;
          }
        }
        const parts = contentToCoreParts(resolvedContent);
        const session = await resolveSession(core, session_id);
        await applyPromptMetadataUpdate({
          metadata: session.accessor.get(ISessionMetadata),
          eventService: core.accessor.get(IEventService),
          sessionId: session_id,
        }, promptMetadataTextFromContentParts(parts));
        const handle = await resolved.prompt.enqueue({ message: {
          role: 'user',
          content: parts,
          toolCalls: [],
          origin: { kind: 'user' },
        } });
        reply.send(okEnvelope(projectPromptHandle(handle), req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
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
        const resolved = await resolvePrompt(core, session_id);
        await resolved.prompt.steer(req.body.prompt_ids);
        reply.send(okEnvelope({ steered: true, prompt_ids: [...req.body.prompt_ids] }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
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
        const resolved = await resolvePrompt(core, session_id);
        if (parsed.action === 'abort') {
          resolved.prompt.abort(parsed.id);
          requestLog(req)?.info({ session_id, prompt_id: parsed.id }, 'prompt aborted');
          reply.send(okEnvelope({ aborted: true }, req.id));
        } else {
          await resolved.prompt.steer([parsed.id]);
          reply.send(okEnvelope({ steered: true, prompt_ids: [parsed.id] }, req.id));
        }
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(actionRoute.path, actionRoute.options, actionRoute.handler as Parameters<PromptRouteHost['post']>[2]);
}

function projectPromptList(snapshot: PromptQueueSnapshot) {
  return {
    active: snapshot.active === undefined ? null : projectPromptSnapshot(snapshot.active),
    queued: snapshot.pending.map(projectPromptSnapshot),
  };
}

function projectPromptHandle(handle: PromptHandle) {
  return projectPromptSnapshot(handle);
}

function projectPromptSnapshot(prompt: PromptQueueSnapshot['pending'][number]) {
  const status = prompt.state === 'running' || prompt.state === 'steered'
    ? 'running'
    : prompt.state === 'blocked' ? 'blocked' : 'queued';
  return {
    prompt_id: prompt.id,
    user_message_id: prompt.userMessageId,
    status,
    content: corePartsToProtocol(prompt.message.content),
    created_at: prompt.createdAt,
  };
}

function corePartsToProtocol(content: readonly ContentPart[]): PromptSubmission['content'] {
  const parts: PromptSubmission['content'] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.imageUrl.url);
      parts.push(match === null
        ? { type: 'image', source: { kind: 'url', url: part.imageUrl.url, id: part.imageUrl.id } }
        : { type: 'image', source: { kind: 'base64', media_type: match[1]!, data: match[2]! } });
    } else if (part.type === 'video_url') {
      // An internal `kimi-file://<id>?path=…` reference projects back to the
      // daemon upload it came from — the materialization path never leaks to
      // the client.
      const kimiFile = parseKimiFileUrl(part.videoUrl.url);
      if (kimiFile !== undefined) {
        parts.push({ type: 'video', source: { kind: 'file', file_id: kimiFile.fileId } });
        continue;
      }
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.videoUrl.url);
      parts.push(match === null
        ? { type: 'video', source: { kind: 'url', url: part.videoUrl.url, id: part.videoUrl.id } }
        : { type: 'video', source: { kind: 'base64', media_type: match[1]!, data: match[2]! } });
    }
  }
  return parts;
}


function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  err: unknown,
): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'file.not_found':
        reply.send(errEnvelope(ErrorCode.FILE_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'prompt.not_found':
        reply.send(errEnvelope(ErrorCode.PROMPT_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'session.busy':
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, err.message, requestId, err.stack));
        return;
      case 'prompt.already_completed':
        reply.send({
          code: ErrorCode.PROMPT_ALREADY_COMPLETED,
          msg: err.message,
          data: { aborted: false },
          request_id: requestId,
          stack: err.stack,
        });
        return;
      case 'request.invalid':
      case 'validation.failed':
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
      case 'auth.provisioning_required':
        reply.send({
          code: ErrorCode.AUTH_PROVISIONING_REQUIRED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details: null,
        });
        return;
      case 'auth.token_missing': {
        const details = authProviderDetails(err);
        if (details === undefined) {
          log?.error({ err }, 'prompt request failed');
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
          stack: err.stack,
          details,
        });
        return;
      }
      case 'auth.token_unauthorized': {
        const details = authProviderDetails(err);
        if (details === undefined) {
          log?.error({ err }, 'prompt request failed');
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
          stack: err.stack,
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
          stack: err.stack,
          details: authModelDetails(err),
        });
        return;
    }
  }
  log?.error({ err }, 'prompt request failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}

function authProviderDetails(err: Error2): { provider_id: string } | undefined {
  const providerId = err.details?.['provider_id'];
  if (typeof providerId !== 'string') return undefined;
  return { provider_id: providerId };
}

function authModelDetails(err: Error2): { model_id?: string; provider_id?: string } | null {
  const details: { model_id?: string; provider_id?: string } = {};
  const modelId = err.details?.['model_id'];
  const providerId = err.details?.['provider_id'];
  if (typeof modelId === 'string') details.model_id = modelId;
  if (typeof providerId === 'string') details.provider_id = providerId;
  return Object.keys(details).length === 0 ? null : details;
}
