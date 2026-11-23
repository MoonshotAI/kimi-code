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
  promptIdSchema,
  promptItemSchema,
  promptListResponseSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  queueMoveRequestSchema,
  steerSubmissionSchema,
  type PromptSkillActivation,
  type QueueMoveRequest,
  type SteerSubmission,
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
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { type ActionTable, resolveActionTarget, runAction } from './action-dispatch';
import type { ConversationService } from '../services/conversation/conversationService';
import { sendEnvironmentError } from './environment';
import { applyThinking } from './sessionAgentConfig';
import type { RouteHost } from './routeHost';

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

const promptParamsSchema = z.object({
  session_id: z.string().min(1),
  prompt_id: promptIdSchema,
});

const promptSubmissionErrors = {
  [ErrorCode.VALIDATION_FAILED]: { detailsSchema: validationDetailsSchema },
  [ErrorCode.SKILL_NOT_FOUND]: {},
  [ErrorCode.SKILL_NOT_ACTIVATABLE]: {},
  [ErrorCode.SESSION_NOT_FOUND]: {},
  [ErrorCode.FILE_NOT_FOUND]: {},
  [ErrorCode.PROMPT_ID_CONFLICT]: {},
  [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: {},
  [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
  [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
  ...sessionConflictErrors,
};

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

export function registerPromptsRoutes(app: PromptRouteHost & RouteHost, core: Scope, conversations: ConversationService): void {
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
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<RouteHost['get']>[2]);

  const submitOnce = async (
    session_id: string,
    body: SteerSubmission,
    attempt: PromptAttempt,
    directSteer: boolean,
  ): Promise<unknown> => {
      let preparedMedia: PromptMediaPreparation | undefined;
      let enqueued = false;
      try {
        const session = await resolveSession(core, session_id);
        let resolved: Awaited<ReturnType<typeof resolvePromptFromSession>> | undefined;
        if (contentHasPathRefs(body.content)) {
          resolved = await resolvePromptFromSession(session, body.agent_id);
          if (resolved.binding.current.environmentId !== 'local') {
            throw new Error2(
              ErrorCodes.REQUEST_INVALID,
              'file attachments by server-local path require the local environment',
            );
          }
        }
        await assertPromptFileRefs(body.content, core.accessor.get(IFileService));
        await assertPromptPathRefs(body.content);
        if (body.skills !== undefined) {
          await assertActivatableSkills(
            session.accessor.get(ISessionSkillCatalog),
            body.skills,
          );
        }
        const resolvedSessionMedia = await resolvePromptSessionMediaRefs(
          body.content,
          session.accessor.get(ISessionMediaStore),
        );
        resolved ??= await resolvePromptFromSession(session, body.agent_id);

        const telemetry = core.accessor.get(ITelemetryService).withContext({ session_id });
        const environmentMedia = environmentMediaTargets(resolved.binding.current, resolved.environment);
        try {
          preparedMedia = await resolvePromptMediaFiles(
            resolvedSessionMedia,
            core.accessor.get(IFileService),
            core.accessor.get(IBootstrapService).cacheDir,
            {
              telemetry,
              providerType: resolved.profile.getModelProviderType(body.model),
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

        if (body.model !== undefined) await resolved.prompt.setModel(body.model);
        if (body.thinking !== undefined) applyThinking(resolved.profile, body.thinking);
        if (body.permission_mode !== undefined) resolved.permissionMode.setMode(body.permission_mode);
        if (body.swarm_mode !== undefined && resolved.swarm.isActive !== body.swarm_mode) {
          if (body.swarm_mode) resolved.swarm.enter('manual');
          else resolved.swarm.exit();
        }
        if (body.disabled_tools !== undefined) {
          try {
            await resolved.toolPolicy.setSessionDisabledTools(body.disabled_tools);
          } catch (error) {
            if (error instanceof ProfileError) {
              throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
            }
            throw error;
          }
        }
        const parts = contentToCoreParts(resolvedContent);
        const clientMetadata = body.metadata === undefined ? undefined : [structuredClone(body.metadata)];
        const agentId = body.agent_id ?? MAIN_AGENT_ID;
        if (body.skills !== undefined) {
          if (body.agent_id !== undefined && body.agent_id !== MAIN_AGENT_ID) {
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
              skills: body.skills,
              attachments: promptAttachments,
              steerIfActive: directSteer || body.delivery === 'steer' || undefined,
            });
          } catch (error) {
            settlement.dispose();
            throw error;
          }
          attempt.enqueued();
          enqueued = true;
          settlement.settle(result.prompt_id, () => preparedMedia?.discard());
          const item = {
            prompt_id: result.prompt_id,
            user_message_id: result.prompt_id,
            status: result.state,
            content: projectPromptContentParts(parts),
            created_at: result.created_at,
            metadata: clientMetadata?.[0],
          };
          if (directSteer) return item;
          const acceptedAs = result.steered === true ? 'steer' : result.state === 'queued' ? 'queue' : 'turn';
          const handle = resolved.prompt.promptHandle(result.prompt_id);
          return {
            ...item,
            accepted_as: acceptedAs,
            turn_id:
              acceptedAs === 'turn' && result.turn_id !== undefined
                ? await conversationTurnId(conversations, session_id, agentId, result.turn_id, handle?.completion)
                : undefined,
          };
        }
        await applyPromptMetadataUpdate({
          metadata: session.accessor.get(ISessionMetadata),
          eventService: core.accessor.get(IEventService),
          sessionId: session_id,
        }, promptMetadataTextFromContentParts(parts, clientMetadata));
        const status = resolved.prompt.snapshot();
        const entry = {
          role: 'user' as const,
          content: parts,
          attributes: {
            promptId: attempt.id,
            origin: { kind: 'user', attachments: promptAttachments, clientMetadata } as PromptOrigin,
          },
        };
        const steerNow = (directSteer || body.delivery === 'steer') && status.state === 'running';
        const { id, acceptedAs } = steerNow
          ? resolved.prompt.sendNow(entry)
          : resolved.prompt.submit(entry);
        attempt.enqueued();
        enqueued = true;
        const handle = resolved.prompt.promptHandle(id)!;
        const accepted = steerNow ? 'steer' as const : acceptedAs;
        const shouldWait = directSteer
          ? steerNow || (status.state === 'idle' && !status.paused && status.queue.length === 0)
          : accepted === 'turn';
        const launched = shouldWait
          ? await Promise.race([handle.launched, handle.completion.then(() => undefined)])
          : undefined;
        const staging = preparedMedia;
        void Promise.race([handle.launched, handle.completion]).then(
          () => staging?.discard(),
          () => staging?.discard(),
        );
        const item = projectPromptHandle(handle);
        if (directSteer) return item;
        return {
          ...item,
          accepted_as: accepted,
          turn_id:
            accepted === 'turn' && launched?.id !== undefined
              ? await conversationTurnId(conversations, session_id, agentId, launched.id, handle.completion)
              : undefined,
        };
      } catch (error) {
        if (!enqueued) await preparedMedia?.discardStaged();
        throw error;
      }
  };
  const runSubmit = async (
    req: { id: string },
    reply: { send(payload: unknown): unknown },
    session_id: string,
    promptId: string | undefined,
    body: SteerSubmission,
    directSteer: boolean,
  ): Promise<void> => {
      let attempt: PromptAttempt;
      try {
        attempt = beginPromptAttempt(session_id, promptId, {
          route: directSteer ? 'steer' : 'prompts',
          body,
        });
        if (attempt.earlier !== undefined) {
          reply.send(okEnvelope(await attempt.earlier, req.id));
          return;
        }
      } catch (error) {
        sendMappedError(reply, req, error);
        return;
      }
      try {
        const response = await reloadOnStale(core.accessor, session_id, () =>
          submitOnce(session_id, body, attempt, directSteer),
        );
        attempt.succeed(response);
        reply.send(okEnvelope(response, req.id));
      } catch (error) {
        attempt.fail(error);
        sendMappedError(reply, req, error);
      }
  };
  const submitRoute = defineRoute(
    {
      method: 'PUT',
      path: '/sessions/{session_id}/prompts/{prompt_id}',
      body: promptSubmissionSchema,
      params: promptParamsSchema,
      success: { data: promptSubmitResultSchema },
      errors: promptSubmissionErrors,
      description: 'Submit a prompt to a session',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    async (req, reply) => {
      await runSubmit(req, reply, req.params.session_id, req.params.prompt_id, req.body, false);
    },
  );
  app.put(submitRoute.path, submitRoute.options, submitRoute.handler as Parameters<RouteHost['put']>[2]);

  const directSteerRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/steer',
      body: steerSubmissionSchema,
      params: sessionIdParamSchema,
      success: { data: promptItemSchema },
      errors: promptSubmissionErrors,
      description: 'Steer a message into the active turn',
      tags: ['prompts'],
      operationId: 'steerPromptContent',
    },
    async (req, reply) => {
      await runSubmit(req, reply, req.params.session_id, req.body.prompt_id, req.body, true);
    },
  );
  app.post(directSteerRoute.path, directSteerRoute.options, directSteerRoute.handler as Parameters<RouteHost['post']>[2]);

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
  app.post(steerManyRoute.path, steerManyRoute.options, steerManyRoute.handler as Parameters<RouteHost['post']>[2]);

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts/{tail}',
      success: { data: promptAbortResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description: 'Abort a prompt by prompt_id',
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
  app.post(actionRoute.path, actionRoute.options, actionRoute.handler as Parameters<RouteHost['post']>[2]);

  const queueActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/agents/{agent_id}/queue/{tail}',
      params: z.object({
        session_id: z.string().min(1),
        agent_id: z.string().min(1),
        tail: z.string().min(1),
      }),
      body: queueMoveRequestSchema.default({}),
      success: { data: z.object({}) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
        ...sessionConflictErrors,
      },
      description: 'Move a queued prompt before another queued prompt or to the end of the queue',
      tags: ['prompts'],
      operationId: 'queueAction',
    },
    async (req, reply) => {
      const { session_id, agent_id, tail } = req.params;
      try {
        const target = resolveActionTarget({ tail, actions: queueActions, resourceLabel: 'queued prompt' });
        if ('message' in target) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, target.message, req.id));
          return;
        }
        await runAction({
          action: target.action,
          id: target.id,
          actions: queueActions,
          extra: { resolved: await resolvePrompt(core, session_id, agent_id), session_id, req, reply },
          body: req.body,
        });
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(queueActionRoute.path, queueActionRoute.options, queueActionRoute.handler as Parameters<RouteHost['post']>[2]);
}

type PromptActionExtra = {
  readonly resolved: Awaited<ReturnType<typeof resolvePrompt>>;
  readonly session_id: string;
  readonly req: { readonly id: string };
  readonly reply: { readonly send: (payload: unknown) => unknown };
};

type PromptActionCtx = PromptActionExtra & { readonly id: string; readonly body: unknown };

const promptActions: ActionTable<'abort', PromptActionExtra> = {
  abort: { handle: abortPromptAction },
};

const queueActions: ActionTable<'move', PromptActionExtra> = {
  move: { body: queueMoveRequestSchema, handle: moveQueuedAction },
};

function moveQueuedAction(ctx: PromptActionCtx): void {
  const { resolved, req, reply, id } = ctx;
  resolved.prompt.moveQueued(id, (ctx.body as QueueMoveRequest).before_prompt_id);
  reply.send(okEnvelope({}, req.id));
}

async function abortPromptAction(ctx: PromptActionCtx): Promise<void> {
  const { resolved, session_id, req, reply, id } = ctx;
  resolved.prompt.cancel({ promptId: id });
  requestLog(req)?.info({ session_id, prompt_id: id }, 'prompt aborted');
  reply.send(okEnvelope({ aborted: true }, req.id));
}

async function conversationTurnId(
  conversations: ConversationService,
  sessionId: string,
  agentId: string,
  turnNumber: number,
  settled: Promise<unknown> | undefined,
): Promise<string | undefined> {
  const feed = await conversations.feed(sessionId, agentId);
  const find = (): string | undefined => feed.turns().find((turn) => turn.turn_number === turnNumber)?.turn_id;
  const found = find();
  if (found !== undefined || settled === undefined) return found;
  return new Promise((resolve) => {
    const subscription = feed.subscribe(() => {
      const turnId = find();
      if (turnId === undefined) return;
      subscription.dispose();
      resolve(turnId);
    });
    void settled.finally(() => {
      subscription.dispose();
      resolve(find());
    });
  });
}

function projectPromptList(loop: IAgentLoopService) {
  const snapshot = loop.snapshot();
  const active =
    snapshot.activePromptId === undefined
      ? undefined
      : loop.promptHandle(snapshot.activePromptId);
  return {
    active: active === undefined ? null : projectPromptSnapshot(active),
    queued: snapshot.queue.map((item) => {
      const projected = projectQueuedPrompt(item);
      return {
        prompt_id: projected.prompt_id,
        user_message_id: projected.user_message_id,
        status: 'queued' as const,
        content: projected.content,
        created_at: projected.created_at,
        metadata: projected.client_metadata,
      };
    }),
  };
}

type QueueEntry = ReturnType<IAgentLoopService['snapshot']>['queue'][number];

export function projectQueuedPrompt(item: QueueEntry): {
  prompt_id: string;
  user_message_id: string;
  content: ReturnType<typeof projectUserContent>;
  skills?: { name: string; args?: string }[];
  client_metadata?: Record<string, unknown>;
  created_at: string;
} {
  const { attributes: _attributes, ...coreMessage } = item;
  const origin = item.attributes?.origin as PromptOrigin | undefined;
  const user = origin?.kind === 'user' ? origin : undefined;
  const skills = user?.skillActivations?.map(({ skillName, skillArgs }) => ({ name: skillName, args: skillArgs }));
  return {
    prompt_id: item.attributes?.promptId ?? '',
    user_message_id: item.attributes?.userMessageId ?? '',
    content: projectUserContent({ ...coreMessage, origin }),
    skills: skills !== undefined && skills.length > 0 ? skills : undefined,
    client_metadata:
      origin?.kind === 'user' || origin?.kind === 'skill_activation' ? origin.clientMetadata?.[0] : undefined,
    created_at: item.attributes?.createdAt ?? '',
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
