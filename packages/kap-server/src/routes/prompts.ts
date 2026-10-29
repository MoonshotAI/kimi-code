import { join } from 'node:path';

import {
  IBootstrapService,
  getOrRestoreAgent,
  IAgentLoopService,
  IAgentProfileService,
  IAgentEnvironmentBindingService,
  IAgentEnvironmentService,
  IAgentPromptQueueService,
  IAgentSkillService,
  IEventBus,
  IEventService,
  IFileService,
  ISessionMediaStore,
  ISessionMetadata,
  ISessionSkillCatalog,
  isUserActivatableSkillType,
  promptDisplayTextFromContentParts,
  promptMetadataTextFromContentParts,
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
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { annotateBundledSkillParts, isSkillActivationPart } from '@moonshot-ai/agent-core-v2/human/agent/origin';
import type { UserEntry } from '@moonshot-ai/agent-core-v2/human/agent/turn';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/llm/message';
import { isUserPromptSubmitHookPart } from '@moonshot-ai/agent-core-v2/agent/contextMemory/hookParts';
import { ErrorCode } from '../protocol/error-codes';
import { projectPromptContentParts } from '../services/messages/messageProjection';
import {
  promptAbortResponseSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  queueMoveRequestSchema,
  queuePauseResponseSchema,
  type PromptSkillActivation,
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
import { applyPromptLaunchMode } from './sessionAgentConfig';
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
    agent,
    agentId: agentId ?? MAIN_AGENT_ID,
    prompt: agent.accessor.get(IAgentLoopService),
    queue: agent.accessor.get(IAgentPromptQueueService),
    skill: agent.accessor.get(IAgentSkillService),
    events: agent.accessor.get(IEventBus),
    profile: agent.accessor.get(IAgentProfileService),
    binding: agent.accessor.get(IAgentEnvironmentBindingService),
    environment: agent.accessor.get(IAgentEnvironmentService),
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

export function registerPromptsRoutes(app: PromptRouteHost, core: Scope): void {
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
        [ErrorCode.COMPACTION_UNABLE]: {},
        [ErrorCode.GOAL_ALREADY_EXISTS]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
        ...sessionConflictErrors,
      },
      description: 'Submit an input or a compaction; it starts now, steers into the running turn, or waits in the queue',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const submitOnce = async (): Promise<void> => {
        if (req.body.compact !== undefined) {
          await submitCompaction(req.body.compact.instruction);
          return;
        }
        const content = req.body.content ?? [];
        let preparedMedia: PromptMediaPreparation | undefined;
        let reservation: PromptIdReservation | undefined;
        let enqueued = false;
        try {
          const session = await resolveSession(core, session_id);
          let resolved: Awaited<ReturnType<typeof resolvePromptFromSession>> | undefined;
          if (contentHasPathRefs(content)) {
            resolved = await resolvePromptFromSession(session, req.body.agent_id);
            if (resolved.binding.current.environmentId !== 'local') {
              throw new Error2(
                ErrorCodes.REQUEST_INVALID,
                'file attachments by server-local path require the local environment',
              );
            }
          }
          await assertPromptFileRefs(content, core.accessor.get(IFileService));
          await assertPromptPathRefs(content);
          if (req.body.skills !== undefined) {
            await assertActivatableSkills(
              session.accessor.get(ISessionSkillCatalog),
              req.body.skills,
            );
          }
          const resolvedSessionMedia = await resolvePromptSessionMediaRefs(
            content,
            session.accessor.get(ISessionMediaStore),
          );
          resolved ??= await resolvePromptFromSession(session, req.body.agent_id);
          const mode = req.body.mode;
          if (mode !== undefined && resolved.agentId !== MAIN_AGENT_ID) {
            throw new Error2(ErrorCodes.REQUEST_INVALID, 'mode is only supported for the main agent');
          }
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
                providerType: resolved.profile.getModelProviderType(),
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
          let entry: UserEntry;
          if (req.body.skills !== undefined) {
            if (resolved.agentId !== MAIN_AGENT_ID) {
              await applyPromptMetadataUpdate({
                metadata: session.accessor.get(ISessionMetadata),
                eventService: core.accessor.get(IEventService),
                sessionId: session_id,
              }, promptMetadataTextFromContentParts(parts, clientMetadata));
            }
            entry = await resolved.skill.preparePromptWithSkills(
              { input: parts, clientMetadata, skills: req.body.skills, attachments: promptAttachments },
              reservation.id,
            );
          } else {
            await applyPromptMetadataUpdate({
              metadata: session.accessor.get(ISessionMetadata),
              eventService: core.accessor.get(IEventService),
              sessionId: session_id,
            }, promptMetadataTextFromContentParts(parts, clientMetadata));
            entry = {
              message: { role: 'user', content: parts },
              meta: {
                promptId: reservation.id,
                origin: { kind: 'user', attachments: promptAttachments, clientMetadata } as PromptOrigin,
                tracked: true,
              },
            };
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
              delivery: req.body.delivery ?? 'queue',
              mode,
              prepare:
                mode === undefined
                  ? undefined
                  : () => applyPromptLaunchMode(resolved.agent, mode, promptObjectiveText(parts, req.body.metadata)),
              onDrop: () => {
                settlement.dispose();
                void staging.discardStaged();
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
          }
          const projected = projectPromptSnapshot(
            handle ?? {
              id: reservation.id,
              userMessageId: entry.meta?.userMessageId ?? reservation.id,
              createdAt: entry.meta?.createdAt ?? '',
              state: 'pending',
              message: { ...entry.message, origin: entry.meta?.origin as PromptOrigin | undefined },
            },
          );
          reply.send(okEnvelope({ ...projected, accepted_as: result.acceptedAs }, req.id));
        } catch (error) {
          if (!enqueued) await preparedMedia?.discardStaged();
          throw error;
        } finally {
          reservation?.dispose();
        }
      };
      const submitCompaction = async (instruction: string | undefined): Promise<void> => {
        const resolved = await resolvePrompt(core, session_id, req.body.agent_id);
        const reservation = reservePromptId(session_id, req.body.prompt_id);
        try {
          const trimmed = instruction?.trim();
          const result = resolved.queue.submitCompaction({
            id: reservation.id,
            instruction: trimmed === undefined || trimmed === '' ? undefined : trimmed,
          });
          reservation.submit();
          requestLog(req)?.info(
            { session_id, prompt_id: reservation.id, accepted_as: result.acceptedAs },
            'compaction submitted',
          );
          reply.send(okEnvelope({ prompt_id: reservation.id, accepted_as: result.acceptedAs }, req.id));
        } finally {
          reservation.dispose();
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

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts/{tail}',
      success: { data: promptAbortResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
      },
      description: 'Abort a running prompt',
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
    [ErrorCode.PROMPT_NOT_FOUND]: {},
  };

  const pauseRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/agents/{agent_id}/queue::pause',
      params: queueParamsSchema,
      success: { data: queuePauseResponseSchema },
      errors: queueErrors,
      description: 'Pause the queue: queued inputs and steers stay put until it is resumed',
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
      success: { data: z.object({}) },
      errors: queueErrors,
      description: 'Steer, move or cancel one queued input',
      tags: ['prompts'],
      operationId: 'queueAction',
    },
    async (req, reply) => {
      const { session_id, agent_id, tail } = req.params as {
        session_id: string;
        agent_id: string;
        tail: string;
      };
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

const promptActions: ActionTable<'abort', PromptActionExtra> = {
  abort: { handle: abortPromptAction },
};

async function abortPromptAction(ctx: PromptActionCtx): Promise<void> {
  const { resolved, session_id, req, reply, id } = ctx;
  if (resolved.queue.snapshot().items.some((item) => item.id === id)) resolved.queue.cancel(id);
  else resolved.prompt.cancel({ promptId: id });
  requestLog(req)?.info({ session_id, prompt_id: id }, 'prompt aborted');
  reply.send(okEnvelope({ aborted: true }, req.id));
}

type QueueActionExtra = {
  readonly queue: IAgentPromptQueueService;
  readonly req: { readonly id: string };
  readonly reply: { readonly send: (payload: unknown) => unknown };
};

type QueueActionCtx = QueueActionExtra & { readonly id: string; readonly body: unknown };

const queueActions: ActionTable<'steer' | 'move' | 'cancel', QueueActionExtra> = {
  steer: { handle: ({ queue, req, reply, id }: QueueActionCtx) => {
    queue.steer(id);
    reply.send(okEnvelope({}, req.id));
  } },
  move: { handle: ({ queue, req, reply, id, body }: QueueActionCtx) => {
    const parsed = queueMoveRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    queue.move(id, parsed.data.before_prompt_id);
    reply.send(okEnvelope({}, req.id));
  } },
  cancel: { handle: ({ queue, req, reply, id }: QueueActionCtx) => {
    queue.cancel(id);
    reply.send(okEnvelope({}, req.id));
  } },
};

function promptObjectiveText(parts: readonly ContentPart[], metadata: Record<string, unknown> | undefined): string {
  const displayText = metadata?.['display_text'];
  if (typeof displayText === 'string' && displayText.trim() !== '') return displayText.trim();
  return promptDisplayTextFromContentParts(parts).trim();
}

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
        mode: item.mode,
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
