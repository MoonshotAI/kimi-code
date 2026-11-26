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
  ISessionActivityView,
  ISessionBtwService,
  ISessionContext,
  ISessionIndex,
  ISessionMetadata,
  ISessionPromptPredictionService,
  type SessionMeta,
  ISessionTitleService,
  IEventService,
  SessionCreated,
  ISessionManager,
  IHostFileSystem,
  IProjectService,
  IWireService,
  closeSessionById,
  drainSessionMetadataWrites,
  followSessionLifecycles,
  getLiveSessionById,
  getOrRestoreAgent,
  interactions,
  programForSession,
  reloadOnStale,
  reloadProgramForSession,
  resumeSessionById,
  setSessionArchived,
  toDisposable,
  Error2,
  LOCAL_ENVIRONMENT_ID,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import type { ServerResponse } from 'node:http';
import { ISessionLockService } from '@moonshot-ai/agent-core-v2/persistence/interface/sessionLock';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { ISessionRunGate } from '@moonshot-ai/agent-core-v2/session/sessionActivity/sessionRunGate';
import { historyEntryFromContext } from '@moonshot-ai/agent-core-v2/agent/loop/history';
import { wrapSystemReminder } from '@moonshot-ai/agent-core-v2/features/reminder/systemReminder';
import {
  legacySessionMetaScopeOf,
  sessionScopeOf,
  projectPersistenceScope,
} from '@moonshot-ai/agent-core-v2/project/sessionLifecycle/internal/addressing';
import { SessionMetaUpdated } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetaEvents';
import { sessionWorkDir } from '@moonshot-ai/agent-core-v2/session/workspaceContext/workspaceRoots';
import { ErrorCode } from '../protocol/error-codes';
import { listPendingInteractions } from '../protocol/interaction-wire';
import type { PendingInteraction } from '../protocol/interaction';
import type { ConversationService } from '../services/conversation/conversationService';
import { deleteSessionRequestSchema } from '../protocol/rest-worktree';
import { findOnHosts, hostGet, HostSourceError, type HostSources } from '../services/hosts/hostFanout';
import { workspaceRootOf } from '../services/workspaceVisibility';
import {
  archiveSessionResponseSchema,
  cancelPromptPredictionRequestSchema,
  cancelPromptPredictionResponseSchema,
  cancelSessionRequestSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionRequestSchema,
  DEFAULT_SESSION_WAIT_TIMEOUT_MS,
  deleteSessionResponseSchema,
  forkSessionRequestSchema,
  MAX_SESSION_WAIT_TIMEOUT_MS,
  predictPromptRequestSchema,
  predictPromptResponseSchema,
  sessionCancelResponseSchema,
  sessionContinueResponseSchema,
  sessionWarningsResponseSchema,
  startBtwSessionResponseSchema,
  takeoverSessionResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  updateSessionProfileRequestSchema,
  updateSessionProfileResponseSchema,
  waitSessionRequestSchema,
  waitSessionResponseSchema,
  type SessionAction,
} from '../protocol/rest-session';
import {
  sessionSchema,
  type Session,
  type SessionCreate,
  type SessionGit,
  type SessionPendingInteraction,
} from '../protocol/session';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute, type GetRouteHost, type PostRouteHost } from '../middleware/defineRoute';
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
import type { SessionWorktreeService } from '../services/worktrees/sessionWorktreeService';
import { stateInvalid } from '../services/worktrees/worktreeError';
import {
  SESSION_WORKTREE_METADATA_KEY,
  sessionWorktreeWire,
  withStoredSessionWorktree,
} from '../services/worktrees/sessionWorktreeState';

type SessionRouteHost = GetRouteHost & PostRouteHost;

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionGetQuerySchema = z.object({ hosts: z.literal('include').optional() });

const hostSessionSchema = sessionSchema;

async function sessionOnHosts(hosts: HostSources, id: string) {
  return findOnHosts(hosts, async (session) => {
    try {
      return await hostGet<Session>(session, `/api/v1/sessions/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof HostSourceError && error.code === ErrorCode.SESSION_NOT_FOUND) return undefined;
      throw error;
    }
  });
}

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
    timeout_ms: z.number().int().min(0).max(MAX_SESSION_WAIT_TIMEOUT_MS).optional(),
    count: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
    prediction_id: z.string().min(1).optional(),
    expected_turn_id: z.number().int().nonnegative().optional(),
    reason: cancelPromptPredictionRequestSchema.shape.reason,
    remove_worktree: z.boolean().optional(),
    delete_branch: z.boolean().optional(),
  }),
);

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerSessionsRoutes(
  app: SessionRouteHost,
  core: Scope,
  conversations: ConversationService,
  worktrees: SessionWorktreeService,
  hosts?: HostSources,
): void {
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
        [ErrorCode.WORKTREE_UNSUPPORTED]: {},
        ...agentConfigErrors,
      },
      description:
        'Create a new session. With worktree, the session is returned at once at the workspace root with worktree.setup.status "running"; the setup continues in the background and each change is published as a session "updated" event',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const body = req.body;
      const requestedRoots = requestedWorkspaceRoots(body);
      const requestedRoot = requestedRoots.at(-1);
      const conflictingRoot = requestedRoots.find((root) => root.value !== requestedRoot?.value);
      if (requestedRoot !== undefined && conflictingRoot !== undefined) {
        reply.send(
          buildValidationEnvelope(
            [
              {
                path: conflictingRoot.path,
                message: `${conflictingRoot.path} (${conflictingRoot.value}) must equal ${requestedRoot.path} (${requestedRoot.value})`,
              },
            ],
            req.id,
          ),
        );
        return;
      }
      const rootPath = requestedRoots[0]?.path ?? 'workspace_root';
      const workspaceId = body.workspace_id;

      const registry = core.accessor.get(IProjectService);
      let workDir: string;
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
        if (
          requestedRoot !== undefined &&
          requestedRoot.value !== workspace.root &&
          !(await isDirectory(core, requestedRoot.value))
        ) {
          reply.send(
            buildValidationEnvelope(
              [{ path: rootPath, message: `${rootPath} (${requestedRoot.value}) is not an existing directory` }],
              req.id,
            ),
          );
          return;
        }
        if (requestedRoot !== undefined && !(await registry.acceptsWorkDir(workspace, requestedRoot.value))) {
          reply.send(
            buildValidationEnvelope(
              [
                {
                  path: rootPath,
                  message: `${rootPath} (${requestedRoot.value}) must equal workspace root (${workspace.root}), or be inside it or its counterpart in another checkout of the same git repository`,
                },
              ],
              req.id,
            ),
          );
          return;
        }
        workDir = requestedRoot?.value ?? workspace.root;
      } else if (requestedRoot !== undefined) {
        workDir = requestedRoot.value;
      } else {
        reply.send(
          buildValidationEnvelope(
            [{ path: rootPath, message: 'either workspace_id or workspace_root is required' }],
            req.id,
          ),
        );
        return;
      }

      try {
        const touched = workspaceId === undefined ? undefined : await registry.touch(workspaceId);
        const planned =
          body.worktree === undefined
            ? undefined
            : await worktrees.planCreate(touched ?? (await registry.resolveImplicit(workDir)), body.worktree);
        const clientCustom = customSessionMetadata(body.metadata);
        const custom =
          planned === undefined
            ? clientCustom
            : withStoredSessionWorktree(clientCustom, planned.stored);
        const agentConfig = body.agent_config ?? {};
        const mainAgentBinding = await creationMainAgentBinding(core, agentConfig);
        const { profile: _profile, model: _model, thinking: _thinking, ...settings } = agentConfig;
        const appliesSettings = Object.keys(settings).some((key) => key !== 'tower_base');
        const handle = await core.accessor.get(ISessionManager).create({
          workspaceId: planned?.workspaceId ?? workspaceId,
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
        if (typeof body.title === 'string') {
          await handle.accessor.get(ISessionMetadata).setTitle(body.title);
        }
        const session = await toLiveWireSession(core, handle);
        core.accessor.get(IEventService).publish(
          new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }),
        );
        if (planned !== undefined) worktrees.start(session.id, planned);
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
      querystring: sessionGetQuerySchema,
      success: { data: hostSessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.HOST_UNAVAILABLE]: {},
      },
      description:
        'Get a session by ID. hosts=include also looks the session up on each SSH host and tags it with host_id; when it is not found and a host cannot answer, the result is HOST_UNAVAILABLE',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined && req.query.hosts === 'include' && hosts !== undefined) {
        const lookup = await sessionOnHosts(hosts, session_id);
        if (lookup.found !== undefined) {
          reply.send(okEnvelope(lookup.found, req.id));
        } else if (lookup.unavailable.length > 0) {
          reply.send(
            errEnvelope(
              ErrorCode.HOST_UNAVAILABLE,
              `session ${session_id} may be on an unavailable host: ${lookup.unavailable.join(', ')}`,
              req.id,
            ),
          );
        } else {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
        }
        return;
      }
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const session = await readWireSession(core, worktrees, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope(session, req.id));
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
        const main =
          agent_config !== undefined
            ? await resolveMainAgent(core, session_id)
            : await resolveExistingMainAgent(core, session_id);
        const agent = readAgentState(main, session.activity === 'turn');
        if (
          (typeof req.body.title === 'string' && req.body.title.trim().length > 0) ||
          (req.body.metadata !== undefined && Object.keys(req.body.metadata).length > 0)
        ) {
          core.accessor.get(IEventService).publish(
            new SessionMetaUpdated({
              payload: {
                agentId: 'main',
                sessionId: session_id,
                title: session.title,
                patch: { title: session.title, isCustomTitle: Boolean(session.title) },
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
          predictPromptResponseSchema,
          cancelPromptPredictionResponseSchema,
          archiveSessionResponseSchema,
          deleteSessionResponseSchema,
          takeoverSessionResponseSchema,
          waitSessionResponseSchema,
        ]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.AUTH_PROVISIONING_REQUIRED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: {},
        [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        ...sessionConflictErrors,
        [ErrorCode.COMPACTION_UNABLE]: {},
        [ErrorCode.SESSION_UNDO_UNAVAILABLE]: {},
        [ErrorCode.TURN_NOT_FOUND]: {},
        [ErrorCode.TURN_NOT_CONTINUABLE]: {},
        [ErrorCode.WORKTREE_STATE_INVALID]: {},
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
          extra: { core, conversations, worktrees, req, reply },
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

interface SessionActionExtra {
  readonly core: Scope;
  readonly conversations: ConversationService;
  readonly worktrees: SessionWorktreeService;
  readonly req: {
    readonly id: string;
    readonly raw?: {
      readonly aborted: boolean;
      once(event: 'aborted', listener: () => void): unknown;
      off(event: 'aborted', listener: () => void): unknown;
    };
  };
  readonly reply: {
    readonly raw?: ServerResponse;
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
  wait: { body: waitSessionRequestSchema, handle: waitSessionAction },
  continue: { handle: continueSessionAction },
  btw: { handle: btwSessionAction },
  'predict-prompt': {
    body: predictPromptRequestSchema,
    handle: predictPromptAction,
  },
  'cancel-prompt-prediction': {
    body: cancelPromptPredictionRequestSchema,
    handle: cancelPromptPredictionAction,
  },
  restore: { handle: restoreSessionAction },
  archive: { handle: archiveSessionAction },
  delete: { body: deleteSessionRequestSchema, handle: deleteSessionAction },
  reload: { handle: reloadSessionAction },
  takeover: { handle: takeoverSessionAction },
};

async function readWaitSnapshot(
  core: Scope,
  id: string,
): Promise<{
  session: Session;
  pendingInteractions: PendingInteraction[];
  settled: boolean;
  live: ISessionScopeHandle | undefined;
}> {
  const live = getLiveSessionById(core.accessor, id);
  const pendingInteractions = listPendingInteractions(id);
  let baseSession: Session;
  if (live !== undefined) {
    baseSession = await toLiveWireSession(core, live);
  } else {
    const summary = await core.accessor.get(ISessionIndex).get(id);
    if (summary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
    }
    const cwd = await sessionCwd(core, summary);
    if (cwd === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} has no recoverable cwd`);
    }
    baseSession = toWireSession(
      { ...summary, workspaceRoot: await workspaceRootOf(core, summary.workspaceId) },
      cwd,
      resolveSessionFacts(core, id),
    );
  }
  const session =
    pendingInteractions.length > 0 && baseSession.pending_interaction === 'none'
      ? { ...baseSession, pending_interaction: pendingInteractions[0]!.kind }
      : baseSession;
  const settled =
    session.activity !== 'turn' ||
    session.pending_interaction !== 'none' ||
    pendingInteractions.length > 0;
  return { session, pendingInteractions, settled, live };
}

async function persistSessionWrites(live: ISessionScopeHandle | undefined): Promise<void> {
  if (live === undefined) return;
  const agents = live.accessor.get(IAgentLifecycleService);
  for (const agent of agents.list()) {
    await agents.handleOf(agent.agentId)?.accessor.get(IWireService).flush();
  }
  await drainSessionMetadataWrites();
}

async function waitSessionAction(
  ctx: SessionActionCtx<z.infer<typeof waitSessionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const timeoutMs = body.timeout_ms ?? DEFAULT_SESSION_WAIT_TIMEOUT_MS;
  const initial = await readWaitSnapshot(core, id);
  if (initial.settled) {
    await persistSessionWrites(initial.live);
    reply.send(
      okEnvelope(
        {
          session: initial.session,
          pending_interactions: initial.pendingInteractions,
          timed_out: false,
        },
        req.id,
      ),
    );
    return;
  }
  if (timeoutMs === 0 || initial.live === undefined) {
    reply.send(
      okEnvelope(
        {
          session: initial.session,
          pending_interactions: initial.pendingInteractions,
          timed_out: initial.live !== undefined,
        },
        req.id,
      ),
    );
    return;
  }

  const liveHandle = initial.live;
  const raw = reply.raw;
  const outcome = await new Promise<'settled' | 'timeout' | 'aborted'>((resolve) => {
    let done = false;
    const disposables: IDisposable[] = [];
    const onClose = (): void => {
      if (raw?.writableFinished === true) return;
      finish('aborted');
    };
    const finish = (result: 'settled' | 'timeout' | 'aborted'): void => {
      if (done) return;
      done = true;
      raw?.off('close', onClose);
      for (const d of disposables.splice(0)) d.dispose();
      resolve(result);
    };

    raw?.once('close', onClose);
    if (raw?.destroyed === true && !raw.writableFinished) {
      finish('aborted');
      return;
    }

    try {
      disposables.push(
        liveHandle.accessor.get(ISessionActivityView).onDidChange(({ state }) => {
          if (!state.mainTurnActive || state.pendingInteraction !== 'none') {
            finish('settled');
          }
        }),
      );
    } catch {
      finish('settled');
      return;
    }

    disposables.push(
      toDisposable(
        interactions.onDidChangePending(() => {
          if (listPendingInteractions(id).length > 0) {
            finish('settled');
          }
        }),
      ),
      followSessionLifecycles(core.accessor, (service) => {
        const closeSub = service.onDidCloseSession((event) => {
          if (event.sessionId === id) finish('settled');
        });
        const archiveSub = service.onDidArchiveSession((event) => {
          if (event.sessionId === id) finish('settled');
        });
        return {
          dispose: () => {
            closeSub.dispose();
            archiveSub.dispose();
          },
        };
      }),
    );
    const deleteSub = core.accessor.get(ISessionManager).onWillDeleteSession?.((event) => {
      if (event.sessionId === id) finish('settled');
    });
    if (deleteSub !== undefined) disposables.push(deleteSub);

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    disposables.push(toDisposable(() => clearTimeout(timer)));

    const recheck = resolveSessionFacts(core, id);
    if (
      !recheck.mainTurnActive ||
      recheck.pendingInteraction !== 'none' ||
      listPendingInteractions(id).length > 0
    ) {
      finish('settled');
    }
  });

  if (outcome === 'aborted') {
    return;
  }

  const after = await readWaitSnapshot(core, id);
  if (after.settled) await persistSessionWrites(after.live);
  reply.send(
    okEnvelope(
      {
        session: after.session,
        pending_interactions: after.pendingInteractions,
        timed_out: outcome === 'timeout' && !after.settled,
      },
      req.id,
    ),
  );
}

async function forkSessionAction(
  ctx: SessionActionCtx<z.infer<typeof forkSessionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body, worktrees } = ctx;
  const lease = await programForSession(core.accessor, id);
  if (lease === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  try {
    if ((await worktrees.read(id))?.setup.status === 'running') {
      throw stateInvalid('wait for worktree setup to finish before forking this session');
    }
    const meta = await core.accessor.get(ISessionManager).fork({
      sourceSessionId: id,
      title: body.title,
      metadata: body.metadata,
      turnIndex: body.turn_index,
    });
    const workspaceId = lease.instance.program.workspaceId;
    const session = toWireSession(
      { ...meta, workspaceId, workspaceRoot: await workspaceRootOf(core, workspaceId) },
      sessionWorkDir(meta, lease.instance.root),
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
  let live = getLiveSessionById(core.accessor, id);
  if (live === undefined) {
    try {
      await core.accessor.get(ISessionManager).whenResumeSettled(id);
    } catch {
    }
    live = getLiveSessionById(core.accessor, id);
  }
  if (live === undefined) {
    const summary = await core.accessor.get(ISessionIndex).get(id);
    if (summary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
    }
    if (targetAgentId !== MAIN_AGENT_ID) {
      const docs = core.accessor.get(IAtomicDocumentStore);
      const metaScope = sessionScopeOf(
        projectPersistenceScope(
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

  const lifecycle = live.accessor.get(IAgentLifecycleService);
  let agent = lifecycle.handleOf(targetAgentId);
  if (agent === undefined) {
    await lifecycle.whenCreateSettled?.(targetAgentId);
    agent = lifecycle.handleOf(targetAgentId);
  }
  if (targetAgentId !== MAIN_AGENT_ID && agent === undefined) {
    const persisted = (await live.accessor.get(ISessionMetadata).read()).agents?.[targetAgentId];
    if (persisted === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${targetAgentId} does not exist`);
    }
    requestLog(req)?.info(
      { session_id: id, action: 'cancel', agent_id: targetAgentId, include_background: body.include_background === true, cancelled: false },
      'session action completed',
    );
    reply.send(okEnvelope({ cancelled: false }, req.id));
    return;
  }

  let cancelled = agent !== undefined ? agent.accessor.get(IAgentLoopService).cancel() : false;
  if (body.include_background === true) {
    const handles: IAgentScopeHandle[] = [];
    if (body.agent_id !== undefined) {
      if (agent !== undefined) handles.push(agent);
    } else {
      await lifecycle.whenCreateSettled?.();
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

    const resolveContinuableState = (): {
      continuable: boolean;
      ownerPromptId?: string;
    } => {
      if (feed.hasTrailingRejectedPrompt()) {
        return { continuable: false };
      }
      const turns = feed.turns();
      const latestTurn = turns.findLast((turn) => turn.kind === 'agent');
      if (latestTurn === undefined) {
        return { continuable: false };
      }
      let ownerPromptId = feed.latestPromptId();
      if (ownerPromptId === undefined) {
        const firstItem = latestTurn.items[0];
        if (firstItem?.type === 'notification') {
          ownerPromptId = firstItem.item_id;
        }
      }
      if (ownerPromptId === undefined) {
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
      }
      return {
        continuable:
          latestTurn.status === 'ended' &&
          (latestTurn.outcome === 'interrupted' ||
            (latestTurn.outcome === 'failed' && latestTurn.end_reason !== 'blocked')),
        ownerPromptId,
      };
    };

    if (!resolveContinuableState().continuable) {
      throw new Error2(
        ErrorCodes.TURN_NOT_CONTINUABLE,
        `session ${id} has no interrupted or failed turn to continue`,
      );
    }

    const sessionModel = loop.getModel();
    await core.accessor.get(IAuthSummaryService).ensureReady(sessionModel || undefined);

    assertIdle();
    session.accessor.get(ISessionRunGate).begin();
    const finalState = resolveContinuableState();
    if (!finalState.continuable) {
      throw new Error2(
        ErrorCodes.TURN_NOT_CONTINUABLE,
        `session ${id} has no interrupted or failed turn to continue`,
      );
    }

    loop.continueTurn([
      historyEntryFromContext({
        role: 'user',
        content: [{ type: 'text', text: wrapSystemReminder(CONTINUE_INTERRUPTED_REMINDER) }],
        origin: {
          kind: 'injection',
          variant: 'turn_continue',
          ownerPromptId: finalState.ownerPromptId,
        },
      }),
    ]);
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

async function resumePromptPredictionService(core: Scope, id: string): Promise<ISessionPromptPredictionService> {
  const session = await resumeSessionById(core.accessor, id);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  return session.accessor.get(ISessionPromptPredictionService);
}

async function predictPromptAction(
  ctx: SessionActionCtx<z.infer<typeof predictPromptRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const service = await resumePromptPredictionService(core, id);
  const disconnected = (): boolean => req.raw?.aborted === true || reply.raw?.destroyed === true;
  const onAborted = (): void => {
    service.cancel(body.prediction_id, 'disconnect');
  };
  req.raw?.once('aborted', onAborted);
  reply.raw?.once('close', onAborted);
  try {
    if (disconnected()) return;
    const prediction = await service.predict({
      predictionId: body.prediction_id,
      expectedTurnId: body.expected_turn_id,
    });
    if (!disconnected()) {
      reply.send(okEnvelope(predictPromptResponseSchema.parse({ prediction }), req.id));
    }
  } finally {
    req.raw?.off('aborted', onAborted);
    reply.raw?.off('close', onAborted);
  }
}

async function cancelPromptPredictionAction(
  ctx: SessionActionCtx<z.infer<typeof cancelPromptPredictionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const service = await resumePromptPredictionService(core, id);
  const cancelled = service.cancel(body.prediction_id, body.reason);
  reply.send(okEnvelope(cancelPromptPredictionResponseSchema.parse({ cancelled }), req.id));
}

async function restoreSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const restored = await core.accessor.get(ISessionManager).restore(id);
  if (restored === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  const session = await toLiveWireSession(core, restored);
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

async function deleteSessionAction(
  ctx: SessionActionCtx<z.infer<typeof deleteSessionRequestSchema>>,
): Promise<void> {
  const { core, worktrees, req, reply, id, body } = ctx;
  const directory =
    body.remove_worktree === true
      ? (await core.accessor.get(ISessionIndex).get(id))?.cwd
      : undefined;
  await core.accessor.get(ISessionManager).delete(id);
  const worktree =
    directory === undefined
      ? undefined
      : await worktrees.inventory.removeAfterSessionDeletion(directory, body.delete_branch === true);
  requestLog(req)?.info(
    { session_id: id, action: 'delete', worktree: worktree?.outcome },
    'session action completed',
  );
  reply.send(okEnvelope({ deleted: true, worktree }, req.id));
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
  const reloadGuard = live
    ?.accessor.get(IAgentLifecycleService)
    .handleOf(MAIN_AGENT_ID)
    ?.accessor.get(IAgentChangeNotifierService)
    .prepareForReload();
  try {
    await core.accessor.get(IConfigService).reload();
    await core.accessor.get(IPluginService).reloadPlugins();
    await refreshWorkspaceCatalogs(core, id);
  } catch (error) {
    await reloadGuard?.restoreAfterFailure();
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
    await main
      .accessor.get(IAgentChangeNotifierService)
      .notifyAllChanges({ previousSubagentNames: reloadGuard?.previousSubagentNames });
    main.accessor.get(IAgentLoopService).flushReminders();
  }
  const session = await toLiveWireSession(core, handle);
  requestLog(req)?.info({ session_id: id, action: 'reload' }, 'session action completed');
  reply.send(okEnvelope(session, req.id));
}

async function refreshWorkspaceCatalogs(core: Scope, sessionId: string): Promise<void> {
  await reloadProgramForSession(core.accessor, sessionId);
  const sessions = core.accessor.get(ISessionManager).list();
  await Promise.all(
    sessions.map(async (session) => {
      if (session.id === sessionId) return;
      const main = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
      if (main === undefined) return;
      await main.accessor.get(IAgentPluginService).refreshSessionStart();
    }),
  );
}

export interface SessionWireFields extends Omit<SessionSummary, 'cwd'> {
  readonly workspaceRoot?: string;
}

async function isDirectory(core: Scope, path: string): Promise<boolean> {
  try {
    return (await core.accessor.get(IHostFileSystem).stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function sessionCwd(core: Scope, summary: SessionSummary): Promise<string | undefined> {
  const workspace = await core.accessor.get(IProjectService).get(summary.workspaceId);
  return sessionWorkDir(summary, workspace?.root);
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
    workspace_root: fields.workspaceRoot,
    cwd,
    environment_id: fields.environmentId ?? LOCAL_ENVIRONMENT_ID,
    environment_cwd: fields.environmentCwd,
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
    worktree: sessionWorktreeWire(fields.custom),
  };
}

export async function readWireSession(
  core: Scope,
  worktrees: Pick<SessionWorktreeService, 'refreshFacts'>,
  sessionId: string,
): Promise<Session | undefined> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) return undefined;
  const cwd = await sessionCwd(core, summary);
  if (cwd === undefined) return undefined;
  await worktrees.refreshFacts([summary]);
  const workspaceRoot = await workspaceRootOf(core, summary.workspaceId);
  return toWireSession({ ...summary, workspaceRoot }, cwd, resolveSessionFacts(core, sessionId));
}

async function toLiveWireSession(core: Scope, session: ISessionScopeHandle): Promise<Session> {
  const metadata = session.accessor.get(ISessionMetadata);
  const meta = await metadata.read();
  const { workspaceId } = session.accessor.get(ISessionContext);
  const workspaceRoot = await workspaceRootOf(core, workspaceId);
  return toWireSession(
    { ...meta, workspaceId, workspaceRoot },
    metadata.effectiveCwd,
    resolveSessionFacts(core, meta.id),
  );
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

async function resolveExistingMainAgent(
  core: Scope,
  sessionId: string,
): Promise<IAgentScopeHandle | undefined> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  return getOrRestoreAgent(session, MAIN_AGENT_ID);
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

interface RequestedWorkspaceRoot {
  readonly path: string;
  readonly value: string;
}

function requestedWorkspaceRoots(body: SessionCreate): RequestedWorkspaceRoot[] {
  const metadataCwd = body.metadata?.cwd;
  return [
    { path: 'cwd', value: body.cwd },
    { path: 'metadata.cwd', value: typeof metadataCwd === 'string' ? metadataCwd : undefined },
    { path: 'workspace_root', value: body.workspace_root },
  ].filter((root): root is RequestedWorkspaceRoot => root.value !== undefined);
}

function buildWireMetadata(
  custom: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (custom === undefined) return undefined;
  const {
    goal: _goal,
    [SESSION_WORKTREE_METADATA_KEY]: _worktree,
    ...rest
  } = custom as { goal?: unknown; [key: string]: unknown };
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
