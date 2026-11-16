import {
  ErrorCodes,
  IAgentChangeNotifierService,
  IAgentLoopService,
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentPluginService,
  IAgentTaskService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IPluginService,
  ISessionAgentProfileCatalog,
  ISessionActivityView,
  ISessionBtwService,
  ISessionContext,
  ISessionIndex,
  ISessionMetadata,
  type SessionMeta,
  ISessionTitleService,
  IEventService,
  SessionCreated,
  ISessionManager,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  closeSessionById,
  getLiveSessionById,
  getOrRestoreAgent,
  programForSession,
  resolveSubagentModelPool,
  reloadOnStale,
  resumeSessionById,
  setSessionArchived,
  Error2,
  type IAgentScopeHandle,
  type Scope,
  type SubagentModelPoolSnapshot,
} from '@moonshot-ai/agent-core-v2';
import { ISessionLockService } from '@moonshot-ai/agent-core-v2/persistence/interface/sessionLock';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { ISessionRunGate } from '@moonshot-ai/agent-core-v2/session/sessionActivity/sessionRunGate';
import { historyEntryFromContext } from '@moonshot-ai/agent-core-v2/agent/loop/history';
import { wrapSystemReminder } from '@moonshot-ai/agent-core-v2/features/reminder/systemReminder';
import {
  legacySessionMetaScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
} from '@moonshot-ai/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import { SessionMetaUpdated } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetaEvents';
import { ErrorCode } from '../protocol/error-codes';
import type { ConversationService } from '../services/conversation/conversationService';
import {
  archiveSessionResponseSchema,
  cancelSessionRequestSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionRequestSchema,
  deleteSessionResponseSchema,
  forkSessionRequestSchema,
  sessionCancelResponseSchema,
  sessionContinueResponseSchema,
  sessionWarningsResponseSchema,
  startBtwSessionResponseSchema,
  takeoverSessionResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  updateSessionProfileRequestSchema,
  updateSessionProfileResponseSchema,
} from '../protocol/rest-session';
import {
  sessionSchema,
  type Session,
  type SessionGit,
  type SessionPendingInteraction,
} from '../protocol/session';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { readAgentState } from '../transport/ws/v1/agentState';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { type ActionTable, dispatchAction } from './action-dispatch';
import { sendEnvironmentError } from './environment';
import {
  sendMappedError as sendSessionMappedError,
  sessionConflictErrors,
} from './sessionErrors';
import {
  agentConfigErrors,
  applyAgentConfigToSession,
  applySessionAgentConfig,
  creationMainAgentBinding,
} from './sessionAgentConfig';
import { customSessionMetadata, updateSessionProfile } from './sessionProfile';

interface SessionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown; headers: Record<string, unknown> },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const sessionActionRequestSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.object({
    title: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    turn_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    instruction: z.string().optional(),
    turn_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    include_background: z.boolean().optional(),
    count: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  }),
);

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerSessionsRoutes(app: SessionRouteHost, core: Scope, conversations: ConversationService): void {
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions',
      body: createSessionRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
        ...agentConfigErrors,
      },
      description: 'Create a new session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const body = req.body;
      const topCwd = body.cwd;
      const metaCwd = typeof body.metadata?.cwd === 'string' ? body.metadata.cwd : undefined;
      if (topCwd !== undefined && metaCwd !== undefined && topCwd !== metaCwd) {
        reply.send(
          buildValidationEnvelope(
            [{ path: 'cwd', message: `cwd (${topCwd}) must equal metadata.cwd (${metaCwd})` }],
            req.id,
          ),
        );
        return;
      }
      const callerCwd = topCwd ?? metaCwd;
      const cwdPath = topCwd !== undefined ? 'cwd' : 'metadata.cwd';
      const workspaceId = body.workspace_id;
      if (workspaceId === undefined && callerCwd === undefined) {
        reply.send(
          buildValidationEnvelope(
            [{ path: cwdPath, message: 'either workspace_id or cwd is required' }],
            req.id,
          ),
        );
        return;
      }

      const registry = core.accessor.get(IWorkspaceService);
      let workDir: string;
      let bucket: { readonly id: string; readonly root: string } | undefined;
      if (workspaceId !== undefined) {
        const workspace = await registry.get(workspaceId);
        if (workspace === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${workspaceId} does not exist`,
              req.id,
            ),
          );
          return;
        }
        if (callerCwd !== undefined && callerCwd !== workspace.root) {
          reply.send(
            buildValidationEnvelope(
              [
                {
                  path: cwdPath,
                  message: `${cwdPath} (${callerCwd}) must equal workspace root (${workspace.root})`,
                },
              ],
              req.id,
            ),
          );
          return;
        }
        workDir = workspace.root;
        bucket = workspace;
      } else {
        workDir = callerCwd as string;
      }

      try {
        const resolved =
          bucket === undefined
            ? await registry.createOrTouch(workDir)
            : ((await registry.touch(bucket.id)) ?? bucket);
        const custom = customSessionMetadata(body.metadata);
        const agentConfig = body.agent_config ?? {};
        const mainAgentBinding = await creationMainAgentBinding(core, agentConfig);
        const { profile: _profile, model: _model, thinking: _thinking, ...settings } = agentConfig;
        const appliesSettings = Object.keys(settings).some((key) => key !== 'tower_base');
        const handle = await core.accessor.get(ISessionManager).create({
          workspaceId: resolved.id,
          workDir,
          environmentId: body.environment_id,
          environmentCwd: body.environment_cwd,
          mainAgentBinding,
          ensureMainAgent: body.environment_id !== undefined && body.environment_id !== 'local',
          prepare: async (session) => {
            if (Object.keys(custom).length > 0) {
              await session.accessor.get(ISessionMetadata).update({ custom });
            }
            if (appliesSettings) await applyAgentConfigToSession(session, settings);
          },
        });
        const metadata = handle.accessor.get(ISessionMetadata);
        if (typeof body.title === 'string') await metadata.setTitle(body.title);
        const meta = await metadata.read();
        const sessionId = meta.id;
        const session = toWireSession(
          { ...meta, workspaceId: resolved.id },
          resolved.root,
          resolveSessionFacts(core, sessionId),
        );
        core.accessor.get(IEventService).publish(
          new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }),
        );
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get a session by ID',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const cwd =
        summary.cwd ?? (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
      if (cwd === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(toWireSession(summary, cwd, resolveSessionFacts(core, session_id)), req.id),
      );
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const updateProfileRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      body: updateSessionProfileRequestSchema,
      success: { data: updateSessionProfileResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TOWER_MODE_INVALID]: {},
        ...agentConfigErrors,
        ...sessionConflictErrors,
      },
      description: 'Update session profile (title, metadata, agent_config)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const { agent_config, ...profileBody } = req.body;
        const fields = await updateSessionProfile(core, session_id, profileBody);
        if (agent_config !== undefined) {
          await applySessionAgentConfig(core, session_id, agent_config);
        }
        const session = toWireSession(fields, fields.root, resolveSessionFacts(core, fields.id));
        const main = await resolveMainAgent(core, session_id);
        const agent = readAgentState(main, session.activity === 'turn');
        if (typeof req.body.title === 'string' && req.body.title.trim().length > 0) {
          core.accessor.get(IEventService).publish(
            new SessionMetaUpdated({
              payload: {
                agentId: 'main',
                sessionId: session_id,
                title: session.title,
                patch: { title: session.title, isCustomTitle: true },
              },
            }),
          );
        }
        reply.send(okEnvelope({ session, agent }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    updateProfileRoute.path,
    updateProfileRoute.options,
    updateProfileRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const generateTitleRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/title/generate',
      params: sessionIdParamSchema,
      body: z.preprocess(
        (value) => (value === undefined ? {} : value),
        z.object({
          force: z.boolean().optional(),
          source: z.enum(['user_prompts', 'first_turn', 'digest']).optional(),
        }),
      ),
      success: { data: z.object({ title: z.string() }) },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_TITLE_UNAVAILABLE]: {},
        ...sessionConflictErrors,
      },
      description: 'Generate the session title via the managed chat_title tool',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const handle = await resumeSessionById(core.accessor, session_id);
        if (handle === undefined) {
          reply.send(
            errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} not found`, req.id),
          );
          return;
        }
        const title = await handle.accessor
          .get(ISessionTitleService)
          .generateTitle({ force: req.body.force === true, source: req.body.source });
        if (title === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.SESSION_TITLE_UNAVAILABLE,
              'session title generation is unavailable (no managed OAuth login, no prompt yet, or the backend request failed)',
              req.id,
            ),
          );
          return;
        }
        reply.send(okEnvelope({ title }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    generateTitleRoute.path,
    generateTitleRoute.options,
    generateTitleRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const sessionActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{tail}',
      params: sessionActionTailParamSchema,
      body: sessionActionRequestSchema,
      success: {
        data: z.union([
          sessionSchema,
          compactSessionResponseSchema,
          undoSessionResponseSchema,
          sessionCancelResponseSchema,
          sessionContinueResponseSchema,
          startBtwSessionResponseSchema,
          archiveSessionResponseSchema,
          deleteSessionResponseSchema,
          takeoverSessionResponseSchema,
        ]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        ...sessionConflictErrors,
        [ErrorCode.COMPACTION_UNABLE]: {},
        [ErrorCode.SESSION_UNDO_UNAVAILABLE]: {},
        [ErrorCode.TURN_NOT_FOUND]: {},
        [ErrorCode.TURN_NOT_CONTINUABLE]: {},
      },
      description: 'Run a session action',
      tags: ['sessions'],
      operationId: 'runSessionAction',
    },
    async (req, reply) => {
      try {
        await dispatchAction({
          tail: req.params.tail,
          actions: sessionActions,
          resourceLabel: 'session',
          extra: { core, conversations, req, reply },
          body: req.body,
          onUnsupported: (message) => {
            reply.send(buildValidationEnvelope([{ path: 'session_id', message }], req.id));
          },
        });
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    sessionActionRoute.path,
    sessionActionRoute.options,
    sessionActionRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const sessionWarningsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/warnings',
      params: sessionIdParamSchema,
      success: { data: sessionWarningsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description: 'Get session-level warnings (e.g. oversized AGENTS.md)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      try {
        const agent = await ensureMainAgent(session);
        const agentsMdWarning = agent.accessor.get(IAgentLoopService).getAgentsMdWarning();
        const warnings =
          agentsMdWarning === undefined
            ? []
            : [
                {
                  code: 'agents-md-oversized',
                  message: agentsMdWarning,
                  severity: 'warning' as const,
                },
              ];
        reply.send(okEnvelope({ warnings }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    sessionWarningsRoute.path,
    sessionWarningsRoute.options,
    sessionWarningsRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );
}

type SessionAction =
  | 'fork'
  | 'compact'
  | 'undo'
  | 'cancel'
  | 'continue'
  | 'btw'
  | 'restore'
  | 'archive'
  | 'delete'
  | 'reload'
  | 'takeover';

interface SessionActionExtra {
  readonly core: Scope;
  readonly conversations: ConversationService;
  readonly req: {
    readonly id: string;
  };
  readonly reply: {
    readonly send: (payload: unknown) => unknown;
  };
}

type SessionActionCtx<TBody = unknown> = SessionActionExtra & {
  readonly id: string;
  readonly body: TBody;
};

const sessionActions: ActionTable<SessionAction, SessionActionExtra> = {
  fork: { body: forkSessionRequestSchema, handle: forkSessionAction },
  compact: { body: compactSessionRequestSchema, handle: compactSessionAction },
  undo: { body: undoSessionRequestSchema, handle: undoSessionAction },
  cancel: { body: cancelSessionRequestSchema, handle: cancelSessionAction },
  continue: { handle: continueSessionAction },
  btw: { handle: btwSessionAction },
  restore: { handle: restoreSessionAction },
  archive: { handle: archiveSessionAction },
  delete: { handle: deleteSessionAction },
  reload: { handle: reloadSessionAction },
  takeover: { handle: takeoverSessionAction },
};

async function forkSessionAction(
  ctx: SessionActionCtx<z.infer<typeof forkSessionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const lease = await programForSession(core.accessor, id);
  if (lease === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  try {
    const meta = await core.accessor.get(ISessionManager).fork({
      sourceSessionId: id,
      title: body.title,
      metadata: body.metadata,
      turnIndex: body.turn_index,
    });
    const session = toWireSession(
      { ...meta, workspaceId: lease.instance.program.workspaceId },
      meta.cwd ?? '',
      resolveSessionFacts(core, meta.id),
    );
    core.accessor
      .get(IEventService)
      .publish(new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }));
    requestLog(req)?.info(
      { session_id: id, action: 'fork', new_session_id: session.id },
      'session action completed',
    );
    reply.send(okEnvelope(session, req.id));
  } finally {
    lease.dispose();
  }
}

async function compactSessionAction(
  ctx: SessionActionCtx<z.infer<typeof compactSessionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  await reloadOnStale(core.accessor, id, async () => {
    const agent = await resolveMainAgent(core, id);
    const started = agent.accessor
      .get(IAgentFullCompactionService)
      .begin({ source: 'manual', instruction: normalizeOptional(body.instruction) });
    if (!started) {
      throw new Error2(
        ErrorCodes.COMPACTION_UNABLE,
        'A compaction is already running. Wait for it to finish, then retry.',
      );
    }
  });
  requestLog(req)?.info({ session_id: id, action: 'compact' }, 'session action completed');
  reply.send(okEnvelope({}, req.id));
}

async function undoSessionAction(
  ctx: SessionActionCtx<z.infer<typeof undoSessionRequestSchema>>,
): Promise<void> {
  const { core, conversations, req, reply, id, body } = ctx;
  const removed = await reloadOnStale(
    core.accessor,
    id,
    async () => (await conversations.feed(id, body.agent_id ?? MAIN_AGENT_ID)).undo(body.turn_id),
    { retry: false },
  );
  requestLog(req)?.info({ session_id: id, action: 'undo' }, 'session action completed');
  reply.send(okEnvelope({ removed_turn_ids: removed }, req.id));
}

async function cancelSessionAction(
  ctx: SessionActionCtx<z.infer<typeof cancelSessionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const targetAgentId = body.agent_id ?? MAIN_AGENT_ID;
  const live = getLiveSessionById(core.accessor, id);
  if (live === undefined) {
    const summary = await core.accessor.get(ISessionIndex).get(id);
    if (summary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
    }
    if (targetAgentId !== MAIN_AGENT_ID) {
      const docs = core.accessor.get(IAtomicDocumentStore);
      const metaScope = sessionScopeOf(
        workspacePersistenceScope(
          core.accessor.get(IBootstrapService).scope('sessions'),
          summary.workspaceId,
        ),
        id,
      );
      const raw =
        (await docs.get<SessionMeta>(metaScope, 'state.json')) ??
        (await docs.get<SessionMeta>(legacySessionMetaScopeOf(metaScope), 'state.json'));
      if (raw?.agents?.[targetAgentId] === undefined) {
        throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${targetAgentId} does not exist`);
      }
    }
    requestLog(req)?.info({ session_id: id, action: 'cancel', cancelled: false }, 'session action completed');
    reply.send(okEnvelope({ cancelled: false }, req.id));
    return;
  }

  let agent: IAgentScopeHandle | undefined;
  if (targetAgentId === MAIN_AGENT_ID) {
    agent = live.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
  } else {
    agent = await getOrRestoreAgent(live, targetAgentId);
    if (agent === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${targetAgentId} does not exist`);
    }
  }

  let cancelled = agent !== undefined ? agent.accessor.get(IAgentLoopService).cancel() : false;
  if (body.include_background === true) {
    const handles: IAgentScopeHandle[] = [];
    if (body.agent_id !== undefined) {
      if (agent !== undefined) handles.push(agent);
    } else {
      const lifecycle = live.accessor.get(IAgentLifecycleService);
      for (const entry of lifecycle.list()) {
        const handle = lifecycle.handleOf(entry.agentId);
        if (handle !== undefined) handles.push(handle);
      }
    }
    for (const handle of handles) {
      const taskService = handle.accessor.get(IAgentTaskService);
      for (const task of taskService.list(true)) {
        if (task.detached) {
          await taskService.stopByUser(task.taskId);
          cancelled = true;
        }
      }
    }
  }

  requestLog(req)?.info(
    { session_id: id, action: 'cancel', agent_id: targetAgentId, include_background: body.include_background === true, cancelled },
    'session action completed',
  );
  reply.send(okEnvelope({ cancelled }, req.id));
}

const CONTINUE_INTERRUPTED_REMINDER =
  'No new user message was sent. Continue the interrupted work from where it stopped; do not repeat steps that already completed.';

async function continueSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, conversations, req, reply, id } = ctx;
  await reloadOnStale(core.accessor, id, async () => {
    const session = await resumeSessionById(core.accessor, id);
    if (session === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
    }
    const agent = await ensureMainAgent(session);
    const loop = agent.accessor.get(IAgentLoopService);
    await loop.start();

    const assertIdle = (): void => {
      const snap = loop.snapshot();
      const compacting = agent.accessor.get(IAgentFullCompactionService).compacting !== null;
      if (snap.state === 'running' || snap.paused || snap.hasPendingRequests || compacting) {
        throw new Error2(ErrorCodes.SESSION_BUSY, `session ${id} is currently busy`);
      }
    };

    assertIdle();
    session.accessor.get(ISessionRunGate).begin();
    const feed = await conversations.feed(id, MAIN_AGENT_ID);

    const resolveContinuableState = (metaReason: string | undefined): {
      continuable: boolean;
      ownerPromptId?: string;
    } => {
      const turns = feed.turns();
      const latestTurn = turns.at(-1);
      let ownerPromptId: string | undefined;
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        for (let j = turns[i]!.items.length - 1; j >= 0; j -= 1) {
          const item = turns[i]!.items[j]!;
          if (item.type === 'user_message' && item.prompt_ids.length > 0) {
            ownerPromptId = item.prompt_ids.at(-1);
            break;
          }
        }
        if (ownerPromptId !== undefined) break;
      }
      if (latestTurn !== undefined) {
        return {
          continuable:
            latestTurn.status === 'ended' &&
            (latestTurn.outcome === 'interrupted' || latestTurn.outcome === 'failed'),
          ownerPromptId,
        };
      }
      return {
        continuable: metaReason === 'cancelled' || metaReason === 'failed',
        ownerPromptId,
      };
    };

    const metaReason = (await session.accessor.get(ISessionMetadata).read()).lastTurnReason;
    if (!resolveContinuableState(metaReason).continuable) {
      throw new Error2(
        ErrorCodes.TURN_NOT_CONTINUABLE,
        `session ${id} has no interrupted or failed turn to continue`,
      );
    }

    const sessionModel = loop.getModel();
    await core.accessor.get(IAuthSummaryService).ensureReady(sessionModel || undefined);

    assertIdle();
    const refreshedMetaReason = (await session.accessor.get(ISessionMetadata).read()).lastTurnReason;
    assertIdle();
    session.accessor.get(ISessionRunGate).begin();
    const finalState = resolveContinuableState(refreshedMetaReason);
    if (!finalState.continuable) {
      throw new Error2(
        ErrorCodes.TURN_NOT_CONTINUABLE,
        `session ${id} has no interrupted or failed turn to continue`,
      );
    }

    loop.remind(
      historyEntryFromContext({
        role: 'user',
        content: [{ type: 'text', text: wrapSystemReminder(CONTINUE_INTERRUPTED_REMINDER) }],
        origin: {
          kind: 'injection',
          variant: 'turn_continue',
          ownerPromptId: finalState.ownerPromptId,
        },
      }),
    );
    loop.continueTurn();
    requestLog(req)?.info({ session_id: id, action: 'continue' }, 'session action completed');
    reply.send(okEnvelope({ continued: true }, req.id));
  });
}

async function btwSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const session = await resumeSessionById(core.accessor, id);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  const agent = await ensureMainAgent(session);
  const sessionModel = agent.accessor.get(IAgentLoopService).getModel();
  await core.accessor.get(IAuthSummaryService).ensureReady(sessionModel || undefined);
  const agentId = await session.accessor.get(ISessionBtwService).start();
  reply.send(okEnvelope({ agent_id: agentId }, req.id));
}

async function restoreSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const restored = await core.accessor.get(ISessionManager).restore(id);
  if (restored === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  const meta = await restored.accessor.get(ISessionMetadata).read();
  const sessionCtx = restored.accessor.get(ISessionContext);
  const session = toWireSession(
    { ...meta, workspaceId: sessionCtx.workspaceId },
    sessionCtx.cwd,
    resolveSessionFacts(core, meta.id),
  );
  requestLog(req)?.info({ session_id: id, action: 'restore' }, 'session action completed');
  reply.send(okEnvelope(session, req.id));
}

async function archiveSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const summary = await core.accessor.get(ISessionManager).status(id);
  if (summary === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  await setSessionArchived(core.accessor, id, true);
  requestLog(req)?.info({ session_id: id, action: 'archive' }, 'session action completed');
  reply.send(okEnvelope({ archived: true }, req.id));
}

async function takeoverSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const summary = await core.accessor.get(ISessionManager).status(id);
  if (summary === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  core.accessor.get(ISessionLockService).takeover(id);
  requestLog(req)?.info({ session_id: id, action: 'takeover' }, 'session action completed');
  reply.send(okEnvelope({ taken_over: true }, req.id));
}

async function deleteSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  await core.accessor.get(ISessionManager).delete(id);
  requestLog(req)?.info({ session_id: id, action: 'delete' }, 'session action completed');
  reply.send(okEnvelope({ deleted: true }, req.id));
}

async function reloadSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const live = getLiveSessionById(core.accessor, id);
  const indexEntry =
    live === undefined ? await core.accessor.get(ISessionIndex).get(id) : undefined;
  if (live !== undefined) {
    const agentLifecycle = live.accessor.get(IAgentLifecycleService);
    for (const agent of agentLifecycle.list()) {
      const agentHandle = agentLifecycle.handleOf(agent.agentId);
      if (agentHandle === undefined) continue;
      if (agentHandle.accessor.get(IAgentLoopService).snapshot().state === 'running') {
        throw new Error2(
          ErrorCodes.SESSION_BUSY,
          `Session "${id}" cannot be reloaded while a turn is running`,
          { details: { sessionId: id } },
        );
      }
      if (agentHandle.accessor.get(IAgentFullCompactionService).compacting !== null) {
        throw new Error2(
          ErrorCodes.SESSION_BUSY,
          `Session "${id}" cannot be reloaded while compaction is running`,
          { details: { sessionId: id } },
        );
      }
    }
  } else if (indexEntry === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  const workspaceId =
    live?.accessor.get(ISessionContext).workspaceId ?? indexEntry?.workspaceId;
  let previousSubagentNames: readonly string[] | undefined;
  let previousModelPool: SubagentModelPoolSnapshot | null | undefined;
  let staleNotifier: IAgentChangeNotifierService | undefined;
  if (live !== undefined) {
    const main = live.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
    if (main !== undefined) {
      previousSubagentNames = main.accessor
        .get(ISessionAgentProfileCatalog)
        .list()
        .map((profile) => profile.name);
      const pool = resolveSubagentModelPool(main.accessor.get(IConfigService));
      previousModelPool =
        pool === undefined
          ? null
          : { defaultModel: pool.defaultModel, models: { ...pool.models } };
      staleNotifier = main.accessor.get(IAgentChangeNotifierService);
      staleNotifier.mute();
    }
  }
  try {
    await core.accessor.get(IConfigService).reload();
    await core.accessor.get(IPluginService).reloadPlugins();
    await refreshWorkspaceCatalogs(core, workspaceId, id);
  } catch (error) {
    if (staleNotifier !== undefined) {
      staleNotifier.unmute();
      await Promise.all([
        staleNotifier.notifyAgentsMdChanges(),
        staleNotifier.notifySkillChanges(),
        staleNotifier.notifySubagentChanges({}),
        staleNotifier.notifyWorkspaceDirsChanges(),
      ]).catch(() => undefined);
    }
    throw error;
  }
  if (live !== undefined) {
    await closeSessionById(core.accessor, id);
  }
  const handle = await resumeSessionById(core.accessor, id);
  if (handle === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  const main = handle.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
  await main?.accessor.get(IAgentPluginService).refreshSessionStart();
  if (main !== undefined) {
    const notifier = main.accessor.get(IAgentChangeNotifierService);
    await notifier.notifyAgentsMdChanges();
    await notifier.notifySkillChanges();
    await notifier.notifySubagentChanges({ previousSubagentNames, previousModelPool });
    await notifier.notifyWorkspaceDirsChanges();
    main.accessor.get(IAgentLoopService).flushReminders();
  }
  const meta = await handle.accessor.get(ISessionMetadata).read();
  const sessionCtx = handle.accessor.get(ISessionContext);
  const session = toWireSession(
    { ...meta, workspaceId: sessionCtx.workspaceId },
    sessionCtx.cwd,
    resolveSessionFacts(core, meta.id),
  );
  requestLog(req)?.info({ session_id: id, action: 'reload' }, 'session action completed');
  reply.send(okEnvelope(session, req.id));
}

async function refreshWorkspaceCatalogs(
  core: Scope,
  workspaceId: string | undefined,
  excludedSessionId: string,
): Promise<void> {
  if (workspaceId !== undefined) {
    const target = core.accessor.get(IWorkspaceInstanceManager).get(workspaceId);
    if (target !== undefined) {
      await target.program.reload();
    }
  }
  const sessions = core.accessor.get(ISessionManager).list();
  await Promise.all(
    sessions.map(async (session) => {
      if (session.id === excludedSessionId) return;
      const main = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
      if (main === undefined) return;
      await main.accessor.get(IAgentPluginService).refreshSessionStart();
    }),
  );
}

export interface SessionWireFields {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly archivedAt?: number;
  readonly custom?: Record<string, unknown>;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export function toWireSession(
  fields: SessionWireFields,
  cwd: string,
  facts: SessionFacts,
  git?: SessionGit,
): Session {
  const lastTurnReason =
    facts.lastTurnReason ?? (facts.live === false ? fields.lastTurnReason : undefined);
  const lastTurnOutcome =
    lastTurnReason === 'cancelled' ? 'interrupted' : lastTurnReason;
  const activity = facts.mainTurnActive ? 'turn' : facts.busy ? 'background' : 'idle';
  return {
    id: fields.id,
    workspace_id: fields.workspaceId,
    cwd,
    title: fields.title ?? '',
    created_at: new Date(fields.createdAt).toISOString(),
    updated_at: new Date(fields.updatedAt).toISOString(),
    archived_at:
      fields.archivedAt === undefined ? undefined : new Date(fields.archivedAt).toISOString(),
    activity,
    pending_interaction: facts.pendingInteraction,
    last_turn_outcome: lastTurnOutcome,
    archived: fields.archived,
    last_prompt: fields.lastPrompt,
    metadata: buildWireMetadata(fields.custom),
    git,
  };
}

export interface SessionFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly live?: boolean;
}

export function resolveSessionFacts(core: Scope, sessionId: string): SessionFacts {
  const handle = getLiveSessionById(core.accessor, sessionId);
  if (handle === undefined) {
    return {
      busy: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
      live: false,
    };
  }
  return {
    ...handle.accessor.get(ISessionActivityView).state(),
    live: true,
  };
}

async function resolveMainAgent(core: Scope, sessionId: string): Promise<IAgentScopeHandle> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  return ensureMainAgent(session);
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function buildWireMetadata(
  custom: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (custom === undefined) return undefined;
  const { goal: _drop, ...rest } = custom as { goal?: unknown; [key: string]: unknown };
  return Object.keys(rest).length === 0 ? undefined : rest;
}

function buildValidationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
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
