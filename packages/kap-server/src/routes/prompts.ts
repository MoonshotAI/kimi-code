import { join } from 'node:path';

import {
  IBootstrapService,
  getOrRestoreAgent,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentEnvironmentBindingService,
  IAgentEnvironmentService,
  IAgentToolPolicyService,
  IAgentGoalService,
  IAgentPlanService,
  IAgentPromptQueueService,
  IAgentSkillService,
  IAgentSwarmService,
  IAgentTowerService,
  IEventBus,
  IEventService,
  IFileService,
  ISessionMediaStore,
  ISessionMetadata,
  ISessionSkillCatalog,
  isUserActivatableSkillType,
  promptMetadataTextFromContentParts,
  ProfileError,
  type ContextMessage,
  type PromptOrigin,
  type PromptQueueSnapshot,
  type PromptQueueSubmitResult,
  type PromptState,
  newMessageId,
  ISessionContext,
  reloadOnStale,
  resumeSessionById,
  ITelemetryService,
  applyPromptMetadataUpdate,
  Error2,
  ErrorCodes,
  sessionMediaOriginalsDir,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { UserEntry } from '@moonshot-ai/agent-core-v2/human/agent/turn';
import { annotateBundledSkillParts, isSkillActivationPart } from '@moonshot-ai/agent-core-v2/human/agent/origin';
import { isUserPromptSubmitHookPart } from '@moonshot-ai/agent-core-v2/agent/contextMemory/hookParts';
import { ErrorCode } from '../protocol/error-codes';
import { projectPromptContentParts } from '../services/messages/messageProjection';
import {
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  queueMoveRequestSchema,
  queuePauseResponseSchema,
  type PromptSkillActivation,
  type PromptSubmission,
  type QueuedInputWire,
  type QueueStateWire,
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

const queueParamsSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
});

const queueActionParamsSchema = queueParamsSchema.extend({
  tail: z.string().min(1),
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
    agentId: agentId ?? MAIN_AGENT_ID,
    agent,
    queue: agent.accessor.get(IAgentPromptQueueService),
    prompt: agent.accessor.get(IAgentLoopService),
    skill: agent.accessor.get(IAgentSkillService),
    events: agent.accessor.get(IEventBus),
    profile: agent.accessor.get(IAgentProfileService),
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
        const result = projectPromptList(await resolvePrompt(core, session_id));
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
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FILE_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ID_CONFLICT]: {},
        [ErrorCode.GOAL_ALREADY_EXISTS]: {},
        [ErrorCode.GOAL_OBJECTIVE_EMPTY]: {},
        [ErrorCode.GOAL_OBJECTIVE_TOO_LONG]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
        ...sessionConflictErrors,
      },
      description: 'Submit a prompt to a session',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const submitOnce = async (): Promise<void> => {
        let preparedMedia: PromptMediaPreparation | undefined;
        let reservation: PromptIdReservation | undefined;
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
          reservation = reservePromptId(session_id, req.body.prompt_id);

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
          const staging = preparedMedia;
          const promptAttachments =
            staging.attachments.length > 0 ? staging.attachments : undefined;
          const parts = contentToCoreParts(staging.content);
          const clientMetadata = req.body.metadata === undefined ? undefined : [structuredClone(req.body.metadata)];
          const updateMetadata = (): Promise<void> => applyPromptMetadataUpdate({
            metadata: session.accessor.get(ISessionMetadata),
            eventService: core.accessor.get(IEventService),
            sessionId: session_id,
          }, promptMetadataTextFromContentParts(parts, clientMetadata));
          let entry: UserEntry;
          let onStart: () => Promise<void>;
          if (req.body.skills !== undefined) {
            const prepared = await resolved.skill.preparePromptWithSkills(
              { input: parts, clientMetadata, skills: req.body.skills, attachments: promptAttachments },
              reservation.id,
            );
            entry = prepared.entry;
            onStart = async () => {
              if (resolved.agentId !== MAIN_AGENT_ID) await updateMetadata();
              await prepared.onStart();
            };
          } else {
            entry = {
              message: { role: 'user', content: parts },
              meta: {
                promptId: reservation.id,
                origin: { kind: 'user', attachments: promptAttachments, clientMetadata } as PromptOrigin,
                tracked: true,
              },
            };
            onStart = updateMetadata;
          }
          entry = {
            ...entry,
            meta: { ...entry.meta, createdAt: entry.meta?.createdAt ?? new Date().toISOString() },
          };
          const settlement = watchPromptSettlements(resolved.events);
          let result: PromptQueueSubmitResult;
          try {
            result = await resolved.queue.submitInput({
              id: reservation.id,
              entry,
              delivery: 'queue',
              prepare: submissionSettings(resolved, req.body),
              onStart,
              onDrop: () => {
                settlement.dispose();
                void staging.discard();
              },
            });
          } catch (error) {
            settlement.dispose();
            throw error;
          }
          reservation.submit();
          enqueued = true;
          const handle = result.handle;
          if (handle === undefined) {
            settlement.settle(reservation.id, () => staging.discard());
          } else {
            settlement.dispose();
            if (result.acceptedAs === 'turn') {
              await Promise.race([handle.launched, handle.completion]);
            }
            void Promise.race([handle.launched, handle.completion]).then(
              () => staging.discard(),
              () => staging.discard(),
            );
            if (
              req.body.skills !== undefined &&
              result.acceptedAs === 'turn' &&
              (await handle.launched) === undefined &&
              handle.state !== 'blocked'
            ) {
              throw new Error2(ErrorCodes.INTERNAL, 'the skill prompt failed to start a turn');
            }
          }
          reply.send(okEnvelope(projectPromptSnapshot(
            handle ?? {
              id: reservation.id,
              userMessageId: entry.meta?.userMessageId ?? reservation.id,
              createdAt: entry.meta?.createdAt ?? '',
              state: 'pending',
              message: { ...entry.message, origin: entry.meta?.origin as PromptOrigin | undefined },
            },
          ), req.id));
        } catch (error) {
          if (!enqueued) await preparedMedia?.discardStaged();
          throw error;
        } finally {
          reservation?.dispose();
        }
      };
      try {
        await reloadOnStale(core.accessor, session_id, submitOnce);
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
        await steerPrompts(await resolvePrompt(core, session_id), req.body.prompt_ids);
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

  const queueErrors = {
    [ErrorCode.VALIDATION_FAILED]: {},
    [ErrorCode.SESSION_NOT_FOUND]: {},
    [ErrorCode.SESSION_BUSY]: {},
    [ErrorCode.PROMPT_NOT_FOUND]: {},
  };

  const pauseRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/agents/{agent_id}/queue::pause',
      params: queueParamsSchema,
      success: { data: queuePauseResponseSchema },
      errors: queueErrors,
      description: 'Pause the queue: queued prompts and steers stay put until it is resumed',
      tags: ['prompts'],
      operationId: 'pauseQueue',
    },
    async (req, reply) => {
      try {
        const { session_id, agent_id } = req.params;
        (await resolvePrompt(core, session_id, agent_id)).queue.pause();
        reply.send(okEnvelope({ paused: true }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(pauseRoute.path, pauseRoute.options, pauseRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const resumeRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/agents/{agent_id}/queue::resume',
      params: queueParamsSchema,
      success: { data: queuePauseResponseSchema },
      errors: queueErrors,
      description: 'Resume the queue',
      tags: ['prompts'],
      operationId: 'resumeQueue',
    },
    async (req, reply) => {
      try {
        const { session_id, agent_id } = req.params;
        (await resolvePrompt(core, session_id, agent_id)).queue.resume();
        reply.send(okEnvelope({ paused: false }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(resumeRoute.path, resumeRoute.options, resumeRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const queueActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/agents/{agent_id}/queue/{tail}',
      params: queueActionParamsSchema,
      body: z.preprocess((value) => (value === undefined ? {} : value), queueMoveRequestSchema),
      success: { data: z.object({}) },
      errors: queueErrors,
      description: 'Move one queued prompt',
      tags: ['prompts'],
      operationId: 'queueAction',
    },
    async (req, reply) => {
      const { session_id, agent_id, tail } = req.params;
      try {
        const target = resolveActionTarget({ tail, actions: queueActions, resourceLabel: 'prompt' });
        if ('message' in target) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, target.message, req.id));
          return;
        }
        const resolved = await resolvePrompt(core, session_id, agent_id);
        await runAction({
          action: target.action,
          id: target.id,
          actions: queueActions,
          extra: { queue: resolved.queue, req, reply },
          body: req.body,
        });
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(queueActionRoute.path, queueActionRoute.options, queueActionRoute.handler as Parameters<PromptRouteHost['post']>[2]);
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
  if (isQueued(resolved.queue, id)) resolved.queue.cancel(id);
  else resolved.prompt.cancel({ promptId: id });
  requestLog(req)?.info({ session_id, prompt_id: id }, 'prompt aborted');
  reply.send(okEnvelope({ aborted: true }, req.id));
}

async function steerPromptAction(ctx: PromptActionCtx): Promise<void> {
  const { resolved, req, reply, id } = ctx;
  await steerPrompts(resolved, [id]);
  reply.send(okEnvelope({ steered: true, prompt_ids: [id] }, req.id));
}

type ResolvedPrompt = Awaited<ReturnType<typeof resolvePrompt>>;

function isQueued(queue: IAgentPromptQueueService, id: string): boolean {
  return queue.snapshot().items.some((item) => item.id === id);
}

async function steerPrompts(resolved: ResolvedPrompt, promptIds: readonly string[]): Promise<void> {
  const queued = new Map(resolved.queue.snapshot().items.map((item) => [item.id, item]));
  if (promptIds.some((id) => queued.get(id)?.kind === 'compact')) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'only an input can be steered');
  }
  const loopIds = promptIds.filter((id) => !queued.has(id));
  const loopPending = new Set(resolved.prompt.snapshot().queue.map((item) => item.meta?.promptId));
  if (loopIds.some((id) => !loopPending.has(id))) {
    throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
  }
  for (const id of promptIds) {
    if (queued.has(id)) resolved.queue.steer(id);
  }
  if (loopIds.length > 0) await resolved.prompt.steer(loopIds);
}

function submissionSettings(
  resolved: ResolvedPrompt,
  body: PromptSubmission,
): (() => Promise<void>) | undefined {
  const mainAgent = resolved.agentId === MAIN_AGENT_ID;
  const enterPlan = mainAgent && body.plan_mode === true;
  const goalObjective = mainAgent ? body.goal_objective : undefined;
  const changesSettings =
    body.profile !== undefined ||
    body.model !== undefined ||
    body.thinking !== undefined ||
    body.permission_mode !== undefined ||
    body.swarm_mode !== undefined ||
    body.disabled_tools !== undefined ||
    enterPlan ||
    goalObjective !== undefined;
  if (!changesSettings) return undefined;
  return async () => {
    let thinkingConsumed = false;
    if (body.profile !== undefined) {
      thinkingConsumed =
        (await applyProfileSelection(resolved.profile, body.profile, body.model, body.thinking)) &&
        body.thinking !== undefined;
    }
    if (body.model !== undefined) await resolved.profile.setModel(body.model);
    if (body.thinking !== undefined && !thinkingConsumed) resolved.profile.setThinking(body.thinking);
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
    if (enterPlan) await enterPlanMode(resolved.agent);
    if (goalObjective !== undefined) await startGoal(resolved.agent, goalObjective);
  };
}

async function enterPlanMode(agent: IAgentScopeHandle): Promise<void> {
  const plan = agent.accessor.get(IAgentPlanService);
  if ((await plan.status()) === null) await plan.enter();
  const tower = agent.accessor.get(IAgentTowerService);
  if (tower.isActive) await tower.exit();
}

async function startGoal(agent: IAgentScopeHandle, objective: string): Promise<void> {
  await agent.accessor.get(IAgentGoalService).createGoal({ objective });
  const plan = agent.accessor.get(IAgentPlanService);
  if ((await plan.status()) !== null) plan.exit();
}

function projectPromptList(resolved: ResolvedPrompt) {
  const snapshot = resolved.prompt.snapshot();
  const active =
    snapshot.activePromptId === undefined
      ? undefined
      : resolved.prompt.promptHandle(snapshot.activePromptId);
  const loopQueued = snapshot.queue
    .filter((item) => item.meta?.tracked === true)
    .map((item) =>
      projectPromptSnapshot({
        id: item.meta?.promptId ?? '',
        userMessageId: item.meta?.userMessageId ?? '',
        createdAt: item.meta?.createdAt ?? '',
        state: 'pending',
        message: { ...item.message, origin: item.meta?.origin as PromptOrigin | undefined },
      }),
    );
  const serverQueued = resolved.queue.snapshot().items.flatMap((item) =>
    item.kind === 'input'
      ? [
          projectPromptSnapshot({
            id: item.id,
            userMessageId: item.entry.meta?.userMessageId ?? item.id,
            createdAt: item.createdAt,
            state: 'pending',
            message: { ...item.entry.message, origin: item.entry.meta?.origin as PromptOrigin | undefined },
          }),
        ]
      : [],
  );
  return {
    active: active === undefined ? null : projectPromptSnapshot(active),
    queued: [...loopQueued, ...serverQueued],
  };
}

type QueueActionExtra = {
  readonly queue: IAgentPromptQueueService;
  readonly req: { readonly id: string };
  readonly reply: { readonly send: (payload: unknown) => unknown };
};

type QueueActionCtx = QueueActionExtra & { readonly id: string; readonly body: unknown };

const queueActions: ActionTable<'move', QueueActionExtra> = {
  move: { handle: ({ queue, req, reply, id, body }: QueueActionCtx) => {
    const parsed = queueMoveRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    queue.move(id, parsed.data.before_prompt_id);
    reply.send(okEnvelope({}, req.id));
  } },
};

export function toWireQueueState(snapshot: PromptQueueSnapshot): QueueStateWire {
  return {
    paused: snapshot.paused,
    inputs: snapshot.items.map((item): QueuedInputWire => {
      if (item.kind === 'compact') {
        return {
          prompt_id: item.id,
          user_message_id: item.id,
          kind: 'compact',
          delivery: 'queue',
          content: [],
          instruction: item.instruction,
          created_at: item.createdAt,
        };
      }
      const origin = item.entry.meta?.origin as PromptOrigin | undefined;
      const projected = projectPromptSnapshot({
        id: item.id,
        userMessageId: item.entry.meta?.userMessageId ?? item.id,
        createdAt: item.createdAt,
        state: 'pending',
        message: { ...item.entry.message, origin },
      });
      const skills = origin?.kind === 'user' ? (origin.skillActivations ?? []) : [];
      return {
        prompt_id: item.id,
        user_message_id: projected.user_message_id,
        kind: 'input',
        delivery: item.delivery,
        content: projected.content,
        skills:
          skills.length === 0
            ? undefined
            : skills.map((skill) => ({ name: skill.skillName, args: skill.skillArgs })),
        client_metadata: projected.metadata,
        created_at: item.createdAt,
      };
    }),
  };
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
    : prompt.state === 'blocked' ? 'blocked' : 'queued';
  const origin = prompt.message.origin;
  const bundled = origin?.kind === 'user' ? (origin.skillActivations ?? []) : [];
  const content = annotateBundledSkillParts(prompt.message.content, bundled).filter(
    (part) => !isSkillActivationPart(part) && !isUserPromptSubmitHookPart(part),
  );
  return {
    prompt_id: prompt.id,
    user_message_id: prompt.userMessageId,
    status,
    content: projectPromptContentParts(content),
    created_at: prompt.createdAt,
    metadata: origin?.kind === 'user' || origin?.kind === 'skill_activation' ? origin.clientMetadata?.[0] : undefined,
  };
}

export interface PromptIdReservation {
  readonly id: string;
  submit(): void;
  dispose(): void;
}

const reservedPromptIds = new Map<string, Set<string>>();

export function reservePromptId(sessionId: string, promptId?: string): PromptIdReservation {
  if (promptId !== undefined && promptId.length === 0) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_id must not be empty');
  }
  let reserved = reservedPromptIds.get(sessionId);
  if (reserved === undefined) {
    reserved = new Set<string>();
    reservedPromptIds.set(sessionId, reserved);
  }
  if (promptId !== undefined && reserved.has(promptId)) {
    throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${promptId}' is already in use`);
  }
  const id = promptId ?? newMessageId();
  reserved.add(id);
  let submitted = false;
  return {
    id,
    submit: () => {
      submitted = true;
    },
    dispose: () => {
      if (!submitted) reserved.delete(id);
    },
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
  error: unknown,
): void {
  if (sendEnvironmentError(reply, req.id, error)) return;
  sendSessionMappedError(reply, req, error);
}
