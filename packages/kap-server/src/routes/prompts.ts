import { join } from 'node:path';

import {
  IBootstrapService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentToolPolicyService,
  IAgentPromptService,
  IAgentSkillService,
  IAuthSummaryService,
  IEventBus,
  IEventService,
  IFileService,
  ISessionMediaStore,
  ISessionMetadata,
  ISessionSkillCatalog,
  isUserActivatableSkillType,
  promptMetadataTextFromContentParts,
  ProfileError,
  type PromptHandle,
  type PromptQueueSnapshot,
  type PromptReservation,
  type PromptWithSkillsResult,
  reservePrompt,
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
import { projectPromptContentParts } from '../services/messages/messageProjection';
import {
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  type PromptSkillActivation,
} from '../protocol/rest-prompt';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import {
  assertPromptFileRefs,
  assertPromptSessionMediaRefs,
  contentToCoreParts,
  resolvePromptMediaFiles,
  type PromptMediaPreparation,
} from '../lib/promptMedia';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { type ActionTable, resolveActionTarget, runAction } from './action-dispatch';

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
  const agent =
    agentId === undefined || agentId === MAIN_AGENT_ID
      ? await ensureMainAgent(session)
      : session.accessor.get(IAgentLifecycleService).findAgentHandle(agentId);
  if (agent === undefined) {
    throw new Error2('agent.not_found', `agent ${agentId} does not exist`);
  }
  return {
    prompt: agent.accessor.get(IAgentPromptService),
    skill: agent.accessor.get(IAgentSkillService),
    events: agent.accessor.get(IEventBus),
    auth: agent.accessor.get(IAuthSummaryService),
    profile: agent.accessor.get(IAgentProfileService),
    toolPolicy: agent.accessor.get(IAgentToolPolicyService),
    permissionMode: agent.accessor.get(IAgentPermissionModeService),
  };
}

async function assertActivatableSkills(
  catalog: ISessionSkillCatalog,
  skills: readonly PromptSkillActivation[],
): Promise<void> {
  await catalog.ready;
  for (const skill of skills) {
    const definition = catalog.catalog.getSkill(skill.name);
    if (definition === undefined) {
      throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Skill "${skill.name}" was not found`);
    }
    if (!isUserActivatableSkillType(definition.metadata.type)) {
      throw new Error2(
        ErrorCodes.SKILL_TYPE_UNSUPPORTED,
        `Skill "${definition.name}" cannot be activated by the user`,
      );
    }
  }
}

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
        [ErrorCode.SKILL_NOT_FOUND]: {},
        [ErrorCode.SKILL_NOT_ACTIVATABLE]: {},
        [ErrorCode.AUTH_PROVISIONING_REQUIRED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: { detailsSchema: authProviderDetailsSchema },
        [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: { detailsSchema: authProviderDetailsSchema },
        [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: { detailsSchema: authModelDetailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ID_CONFLICT]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Submit a prompt to a session',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      let preparedMedia: PromptMediaPreparation | undefined;
      let reservation: PromptReservation | undefined;
      let enqueued = false;
      try {
        await assertPromptFileRefs(req.body.content, core.accessor.get(IFileService));
        const session = await resolveSession(core, session_id);
        if (req.body.skills !== undefined) {
          if (req.body.prompt_id !== undefined) {
            throw new Error2(
              ErrorCodes.REQUEST_INVALID,
              'prompt_id cannot be combined with a bundled skill submission',
            );
          }
          await assertActivatableSkills(
            session.accessor.get(ISessionSkillCatalog),
            req.body.skills,
          );
        }
        await assertPromptSessionMediaRefs(
          req.body.content,
          session.accessor.get(ISessionMediaStore),
        );
        const resolved = await resolvePromptFromSession(session, req.body.agent_id);
        reservation = reservePrompt(resolved.prompt, req.body.prompt_id);
        await resolved.auth.ensureReady();

        const telemetry = core.accessor.get(ITelemetryService).withContext({ sessionId: session_id });
        preparedMedia = await resolvePromptMediaFiles(
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
        const resolvedContent = preparedMedia.content;

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
        if (req.body.skills !== undefined) {
          if (req.body.agent_id !== undefined && req.body.agent_id !== MAIN_AGENT_ID) {
            await applyPromptMetadataUpdate({
              metadata: session.accessor.get(ISessionMetadata),
              eventService: core.accessor.get(IEventService),
              sessionId: session_id,
            }, promptMetadataTextFromContentParts(parts));
          }
          const settlement = watchPromptSettlements(resolved.events);
          let result: PromptWithSkillsResult;
          try {
            result = await resolved.skill.promptWithSkills({
              input: parts,
              skills: req.body.skills,
            });
          } catch (error) {
            settlement.dispose();
            throw error;
          }
          enqueued = true;
          settlement.settle(result.prompt_id, () => preparedMedia?.discard());
          reply.send(
            okEnvelope(
              {
                prompt_id: result.prompt_id,
                user_message_id: result.prompt_id,
                status: result.state,
                content: projectPromptContentParts(parts),
                created_at: result.created_at,
              },
              req.id,
            ),
          );
          return;
        }
        await applyPromptMetadataUpdate({
          metadata: session.accessor.get(ISessionMetadata),
          eventService: core.accessor.get(IEventService),
          sessionId: session_id,
        }, promptMetadataTextFromContentParts(parts));
        const handle = await reservation.submit({
          role: 'user',
          content: parts,
          toolCalls: [],
          origin: { kind: 'user' },
        });
        enqueued = true;
        const staging = preparedMedia;
        void Promise.race([handle.launched, handle.completion]).then(
          () => staging?.discard(),
          () => staging?.discard(),
        );
        reply.send(okEnvelope(projectPromptHandle(handle), req.id));
      } catch (error) {
        if (!enqueued) await preparedMedia?.discard();
        sendMappedError(reply, req, error);
      } finally {
        reservation?.dispose();
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
        const target = resolveActionTarget({
          tail,
          actions: promptActions,
          resourceLabel: 'prompt',
        });
        if ('message' in target) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, target.message, req.id));
          return;
        }
        const resolved = await resolvePrompt(core, session_id);
        await runAction({
          action: target.action,
          id: target.id,
          actions: promptActions,
          extra: { resolved, session_id, req, reply },
        });
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(actionRoute.path, actionRoute.options, actionRoute.handler as Parameters<PromptRouteHost['post']>[2]);
}

type PromptActionExtra = {
  readonly resolved: Awaited<ReturnType<typeof resolvePrompt>>;
  readonly session_id: string;
  readonly req: { readonly id: string };
  readonly reply: { readonly send: (payload: unknown) => unknown };
};

type PromptActionCtx = PromptActionExtra & { readonly id: string; readonly body: unknown };

const promptActions: ActionTable<'abort' | 'steer', PromptActionExtra> = {
  abort: { handle: abortPromptAction },
  steer: { handle: steerPromptAction },
};

async function abortPromptAction(ctx: PromptActionCtx): Promise<void> {
  const { resolved, session_id, req, reply, id } = ctx;
  resolved.prompt.abort(id);
  requestLog(req)?.info({ session_id, prompt_id: id }, 'prompt aborted');
  reply.send(okEnvelope({ aborted: true }, req.id));
}

async function steerPromptAction(ctx: PromptActionCtx): Promise<void> {
  const { resolved, req, reply, id } = ctx;
  await resolved.prompt.steer([id]);
  reply.send(okEnvelope({ steered: true, prompt_ids: [id] }, req.id));
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

export function projectPromptSnapshot(prompt: PromptQueueSnapshot['pending'][number]) {
  const status = prompt.state === 'running' || prompt.state === 'steered'
    ? 'running'
    : prompt.state === 'blocked' ? 'blocked' : 'queued';
  const origin = prompt.message.origin;
  const bundled = origin?.kind === 'user' ? (origin.skillActivations?.length ?? 0) : 0;
  const content = bundled === 0 ? prompt.message.content : prompt.message.content.slice(bundled);
  return {
    prompt_id: prompt.id,
    user_message_id: prompt.userMessageId,
    status,
    content: projectPromptContentParts(content),
    created_at: prompt.createdAt,
  };
}

export function watchPromptSettlements(events: IEventBus): {
  settle(promptId: string, discard: () => void | Promise<void>): void;
  dispose(): void;
} {
  const settledIds = new Set<string>();
  const parentOf = new Map<string, string>();
  let armed: { id: string; discard: () => void | Promise<void> } | undefined;
  const subscription = events.subscribe((event) => {
    if (event.type === 'prompt.steered') {
      const steered = event as {
        readonly promptIds?: unknown;
        readonly activePromptId?: unknown;
      };
      if (Array.isArray(steered.promptIds) && typeof steered.activePromptId === 'string') {
        for (const childId of steered.promptIds) {
          if (typeof childId === 'string') parentOf.set(childId, steered.activePromptId);
        }
        if (armed !== undefined && steered.promptIds.includes(armed.id)) {
          armed = { id: steered.activePromptId, discard: armed.discard };
        }
      }
      return;
    }
    if (event.type !== 'prompt.completed' && event.type !== 'prompt.aborted') return;
    const id = (event as { readonly promptId?: unknown }).promptId;
    if (typeof id !== 'string') return;
    settledIds.add(id);
    if (armed !== undefined && armed.id === id) {
      const { discard } = armed;
      armed = undefined;
      subscription.dispose();
      void discard();
    }
  });
  return {
    settle(promptId: string, discard: () => void | Promise<void>): void {
      if (settledIds.has(promptId) || settledIds.has(parentOf.get(promptId) ?? '')) {
        subscription.dispose();
        void discard();
        return;
      }
      armed = { id: promptId, discard };
    },
    dispose(): void {
      armed = undefined;
      subscription.dispose();
    },
  };
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
      case 'prompt.id_conflict':
        reply.send(errEnvelope(ErrorCode.PROMPT_ID_CONFLICT, err.message, requestId, err.stack));
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
      case 'skill.not_found':
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'skill.type_unsupported':
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_ACTIVATABLE, err.message, requestId, err.stack));
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
