import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  IBootstrapService,
  getOrRestoreAgent,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentEnvironmentBindingService,
  IAgentEnvironmentService,
  IAgentToolPolicyService,
  IAgentSkillService,
  IAgentSwarmService,
  IEventBus,
  IEventService,
  IFileService,
  ISessionManager,
  ISessionMediaStore,
  ISessionMetadata,
  ISessionSkillCatalog,
  isUserActivatableSkillType,
  promptMetadataTextFromContentParts,
  ProfileError,
  type ContextMessage,
  type PromptHandle,
  type PromptOrigin,
  type PromptState,
  type PromptWithSkillsResult,
  newMessageId,
  ISessionContext,
  reloadOnStale,
  resumeSessionById,
  ITelemetryService,
  applyPromptMetadataUpdate,
  Error2,
  ErrorCodes,
  sessionMediaOriginalsDir,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import { projectPromptContentParts, projectUserContent } from '../services/messages/messageProjection';
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
  sendMappedError as sendSessionMappedError,
  sessionConflictErrors,
} from './sessionErrors';
import {
  assertPromptFileRefs,
  assertPromptPathRefs,
  contentHasPathRefs,
  contentToCoreParts,
  resolvePromptMediaFiles,
  resolvePromptSessionMediaRefs,
  environmentMediaTargets,
  type PromptMediaPreparation,
} from '../lib/promptMedia';
import { requestLog } from '../lib/requestLog';
import { defineRoute, type RouteDefinition } from '../middleware/defineRoute';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { type ActionTable, resolveActionTarget, runAction } from './action-dispatch';
import { sendEnvironmentError } from './environment';

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
      : await getOrRestoreAgent(session, agentId);
  if (agent === undefined) {
    throw new Error2('agent.not_found', `agent ${agentId} does not exist`);
  }
  return {
    prompt: agent.accessor.get(IAgentLoopService),
    skill: agent.accessor.get(IAgentSkillService),
    events: agent.accessor.get(IEventBus),
    profile: agent.accessor.get(IAgentLoopService),
    toolPolicy: agent.accessor.get(IAgentToolPolicyService),
    permissionMode: agent.accessor.get(IAgentPermissionModeService),
    binding: agent.accessor.get(IAgentEnvironmentBindingService),
    environment: agent.accessor.get(IAgentEnvironmentService),
    swarm: agent.accessor.get(IAgentSwarmService),
  };
}

async function assertActivatableSkills(
  catalog: ISessionSkillCatalog,
  skills: readonly PromptSkillActivation[],
): Promise<void> {
  await catalog.ready;
  for (const skill of skills) {
    const definition = catalog.catalog.getSkill(skill.name, skill.path);
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
  profile: IAgentLoopService,
  loop: IAgentLoopService,
  profileName: string,
  model: string | undefined,
  thinking: string | undefined,
): Promise<boolean> {
  if (profile.data().profileName === profileName) return false;
  try {
    await loop.bindProfile({
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
  core.accessor.get(ISessionManager).onWillDeleteSession?.((event) => {
    promptAttempts.delete(event.sessionId);
  });
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/prompts',
      params: sessionIdParamSchema,
      success: { data: promptListResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description: 'List the active prompt and queued prompts for a session',
      tags: ['prompts'],
      operationId: 'listPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const result = projectPromptList((await resolvePrompt(core, session_id)).prompt);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<PromptRouteHost['get']>[2]);

  type PromptSubmissionHandler = RouteDefinition<
    typeof promptSubmissionSchema,
    typeof sessionIdParamSchema,
    undefined
  >['handler'];
  const submit = (directSteer: boolean): PromptSubmissionHandler => async (req, reply) => {
      const { session_id } = req.params;
      let attempt: PromptAttempt;
      try {
        attempt = beginPromptAttempt(session_id, req.body.prompt_id, {
          route: directSteer ? 'steer' : 'prompts',
          body: req.body,
        });
        if (attempt.earlier !== undefined) {
          reply.send(okEnvelope(await attempt.earlier, req.id));
          return;
        }
      } catch (error) {
        sendMappedError(reply, req, error);
        return;
      }
      const submitOnce = async (): Promise<unknown> => {
        let preparedMedia: PromptMediaPreparation | undefined;
        let enqueued = false;
        try {
          const session = await resolveSession(core, session_id);
          let resolved: Awaited<ReturnType<typeof resolvePromptFromSession>> | undefined;
          if (contentHasPathRefs(req.body.content)) {
            resolved = await resolvePromptFromSession(session, req.body.agent_id);
            if (resolved.binding.current.environmentId !== 'local') {
              throw new Error2(
                ErrorCodes.REQUEST_INVALID,
                'file attachments by server-local path require the local environment',
              );
            }
          }
          await assertPromptFileRefs(req.body.content, core.accessor.get(IFileService));
          await assertPromptPathRefs(req.body.content);
          if (req.body.skills !== undefined) {
            await assertActivatableSkills(
              session.accessor.get(ISessionSkillCatalog),
              req.body.skills,
            );
          }
          const resolvedSessionMedia = await resolvePromptSessionMediaRefs(
            req.body.content,
            session.accessor.get(ISessionMediaStore),
          );
          resolved ??= await resolvePromptFromSession(session, req.body.agent_id);

          const telemetry = core.accessor.get(ITelemetryService).withContext({ session_id });
          const environmentMedia = environmentMediaTargets(resolved.binding.current, resolved.environment);
          try {
            preparedMedia = await resolvePromptMediaFiles(
              resolvedSessionMedia,
              core.accessor.get(IFileService),
              core.accessor.get(IBootstrapService).cacheDir,
              {
                telemetry,
                providerType: resolved.profile.getModelProviderType(req.body.model),
                resolveOriginalsTarget: environmentMedia.resolveOriginalsTarget ?? (async () => {
                  try {
                    const session = await resumeSessionById(core.accessor, session_id);
                    return session === undefined
                      ? undefined
                      : { dir: sessionMediaOriginalsDir(session.accessor.get(ISessionContext).sessionDir) };
                  } catch {
                    return undefined;
                  }
                }),
                resolveAttachmentsTarget: environmentMedia.resolveAttachmentsTarget ?? (async () => {
                  try {
                    const session = await resumeSessionById(core.accessor, session_id);
                    return session === undefined
                      ? undefined
                      : { dir: join(session.accessor.get(ISessionContext).sessionDir, 'attachments') };
                  } catch {
                    return undefined;
                  }
                }),
              },
            );
          } finally {
            environmentMedia.dispose();
          }
          const resolvedContent = preparedMedia.content;
          const promptAttachments =
            preparedMedia.attachments.length > 0 ? preparedMedia.attachments : undefined;

          let thinkingConsumed = false;
          if (req.body.profile !== undefined) {
            thinkingConsumed =
              (await applyProfileSelection(
                resolved.profile,
                resolved.prompt,
                req.body.profile,
                req.body.model,
                req.body.thinking,
              )) && req.body.thinking !== undefined;
          }
          if (req.body.model !== undefined) await resolved.prompt.setModel(req.body.model);
          if (req.body.thinking !== undefined && !thinkingConsumed)
            resolved.profile.setThinking(req.body.thinking);
          if (req.body.permission_mode !== undefined) resolved.permissionMode.setMode(req.body.permission_mode);
          if (req.body.swarm_mode !== undefined && resolved.swarm.isActive !== req.body.swarm_mode) {
            if (req.body.swarm_mode) resolved.swarm.enter('manual');
            else resolved.swarm.exit();
          }
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
          const clientMetadata = req.body.metadata === undefined ? undefined : [structuredClone(req.body.metadata)];
          if (req.body.skills !== undefined) {
            if (req.body.agent_id !== undefined && req.body.agent_id !== MAIN_AGENT_ID) {
              await applyPromptMetadataUpdate({
                metadata: session.accessor.get(ISessionMetadata),
                eventService: core.accessor.get(IEventService),
                sessionId: session_id,
              }, promptMetadataTextFromContentParts(parts, clientMetadata));
            }
            const settlement = watchPromptSettlements(resolved.events);
            let result: PromptWithSkillsResult;
            try {
              result = await resolved.skill.promptWithSkills({
                input: parts,
                promptId: attempt.id,
                clientMetadata,
                skills: req.body.skills,
                attachments: promptAttachments,
                steerIfActive: directSteer || undefined,
              });
            } catch (error) {
              settlement.dispose();
              throw error;
            }
            attempt.enqueued();
            enqueued = true;
            settlement.settle(result.prompt_id, () => preparedMedia?.discard());
            return {
              prompt_id: result.prompt_id,
              user_message_id: result.prompt_id,
              status: result.state,
              content: projectPromptContentParts(parts),
              created_at: result.created_at,
              metadata: clientMetadata?.[0],
            };
          }
          await applyPromptMetadataUpdate({
            metadata: session.accessor.get(ISessionMetadata),
            eventService: core.accessor.get(IEventService),
            sessionId: session_id,
          }, promptMetadataTextFromContentParts(parts, clientMetadata));
          const status = resolved.prompt.snapshot();
          const entry = {
            message: { role: 'user' as const, content: parts },
            meta: {
              promptId: attempt.id,
              origin: { kind: 'user', attachments: promptAttachments, clientMetadata } as PromptOrigin,
            },
          };
          const { id } = directSteer && status.state === 'running'
            ? resolved.prompt.sendNow(entry)
            : resolved.prompt.submit(entry);
          attempt.enqueued();
          enqueued = true;
          const handle = resolved.prompt.promptHandle(id)!;
          if (
            (directSteer && status.state === 'running') ||
            (status.state === 'idle' && !status.paused && status.queue.length === 0)
          ) {
            await Promise.race([handle.launched, handle.completion]);
          }
          const staging = preparedMedia;
          void Promise.race([handle.launched, handle.completion]).then(
            () => staging?.discard(),
            () => staging?.discard(),
          );
          return projectPromptHandle(handle);
        } catch (error) {
          if (!enqueued) await preparedMedia?.discardStaged();
          throw error;
        }
      };
      try {
        const response = await reloadOnStale(core.accessor, session_id, submitOnce);
        attempt.succeed(response);
        reply.send(okEnvelope(response, req.id));
      } catch (error) {
        attempt.fail(error);
        sendMappedError(reply, req, error);
      }
  };
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
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FILE_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ID_CONFLICT]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
        ...sessionConflictErrors,
      },
      description: 'Submit a prompt to a session',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    submit(false),
  );
  app.post(submitRoute.path, submitRoute.options, submitRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const directSteerRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/steer',
      body: promptSubmissionSchema,
      params: sessionIdParamSchema,
      success: { data: promptSubmitResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema: validationDetailsSchema },
        [ErrorCode.SKILL_NOT_FOUND]: {},
        [ErrorCode.SKILL_NOT_ACTIVATABLE]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FILE_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ID_CONFLICT]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
        ...sessionConflictErrors,
      },
      description: 'Steer a message into the active turn',
      tags: ['prompts'],
      operationId: 'steerPromptContent',
    },
    submit(true),
  );
  app.post(directSteerRoute.path, directSteerRoute.options, directSteerRoute.handler as Parameters<PromptRouteHost['post']>[2]);

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
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
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
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description: 'Abort a running prompt or steer a queued prompt',
      tags: ['prompts'],
      operationId: 'promptAction',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params as { session_id: string; tail: string };
      try {
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
  resolved.prompt.cancel({ promptId: id });
  requestLog(req)?.info({ session_id, prompt_id: id }, 'prompt aborted');
  reply.send(okEnvelope({ aborted: true }, req.id));
}

async function steerPromptAction(ctx: PromptActionCtx): Promise<void> {
  const { resolved, req, reply, id } = ctx;
  await resolved.prompt.steer([id]);
  reply.send(okEnvelope({ steered: true, prompt_ids: [id] }, req.id));
}

function projectPromptList(loop: IAgentLoopService) {
  const snapshot = loop.snapshot();
  const active =
    snapshot.activePromptId === undefined
      ? undefined
      : loop.promptHandle(snapshot.activePromptId);
  return {
    active: active === undefined ? null : projectPromptSnapshot(active),
    queued: snapshot.queue
      .map((item) =>
        projectPromptSnapshot({
          id: item.meta?.promptId ?? '',
          userMessageId: item.meta?.userMessageId ?? '',
          createdAt: item.meta?.createdAt ?? '',
          state: 'pending',
          message: { ...item.message, origin: item.meta?.origin as PromptOrigin | undefined },
        }),
      ),
  };
}

function projectPromptHandle(handle: PromptHandle) {
  return projectPromptSnapshot(handle);
}

export function projectPromptSnapshot(prompt: {
  readonly id: string;
  readonly userMessageId: string;
  readonly createdAt: string;
  readonly state: PromptState;
  readonly message: ContextMessage;
}) {
  const status = prompt.state === 'running' || prompt.state === 'steered'
    ? 'running'
    : prompt.state === 'blocked' || prompt.state === 'failed' ? prompt.state : 'queued';
  const origin = prompt.message.origin;
  return {
    prompt_id: prompt.id,
    user_message_id: prompt.userMessageId,
    status,
    content: projectUserContent(prompt.message),
    created_at: prompt.createdAt,
    metadata: origin?.kind === 'user' || origin?.kind === 'skill_activation' ? origin.clientMetadata?.[0] : undefined,
  };
}

export interface PromptAttempt {
  readonly id: string;
  readonly earlier?: Promise<unknown>;
  enqueued(): void;
  succeed(response: unknown): void;
  fail(error: unknown): void;
}

interface PromptAttemptRecord {
  readonly fingerprint: string;
  readonly response: Promise<unknown>;
  settled: boolean;
}

const PROMPT_ATTEMPTS_PER_SESSION = 256;
const promptAttempts = new Map<string, Map<string, PromptAttemptRecord>>();

export function beginPromptAttempt(sessionId: string, promptId: string | undefined, request: unknown): PromptAttempt {
  if (promptId === undefined) return { id: newMessageId(), enqueued: () => {}, succeed: () => {}, fail: () => {} };
  if (promptId.length === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_id must not be empty');
  let attempts = promptAttempts.get(sessionId);
  if (attempts === undefined) {
    attempts = new Map();
    promptAttempts.set(sessionId, attempts);
  }
  const fingerprint = createHash('sha256').update(canonicalJson(request)).digest('hex');
  const earlier = attempts.get(promptId);
  if (earlier !== undefined) {
    if (earlier.fingerprint !== fingerprint) {
      throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${promptId}' is already used by a different request`);
    }
    return { id: promptId, earlier: earlier.response, enqueued: () => {}, succeed: () => {}, fail: () => {} };
  }
  let resolve!: (response: unknown) => void;
  let reject!: (error: unknown) => void;
  const response = new Promise<unknown>((settleOk, settleError) => {
    resolve = settleOk;
    reject = settleError;
  });
  const record: PromptAttemptRecord = { fingerprint, response, settled: false };
  const settle = (): void => {
    record.settled = true;
  };
  response.then(settle, settle);
  attempts.set(promptId, record);
  for (const [oldest, candidate] of attempts) {
    if (attempts.size <= PROMPT_ATTEMPTS_PER_SESSION) break;
    if (candidate.settled) attempts.delete(oldest);
  }
  let enqueued = false;
  return {
    id: promptId,
    enqueued: () => {
      enqueued = true;
    },
    succeed: resolve,
    fail: (error) => {
      if (!enqueued && attempts.get(promptId)?.response === response) {
        attempts.delete(promptId);
        if (attempts.size === 0 && promptAttempts.get(sessionId) === attempts) promptAttempts.delete(sessionId);
      }
      reject(error);
    },
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    field !== null && typeof field === 'object' && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : field,
  );
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
  error: unknown,
): void {
  if (sendEnvironmentError(reply, req.id, error)) return;
  sendSessionMappedError(reply, req, error);
}
