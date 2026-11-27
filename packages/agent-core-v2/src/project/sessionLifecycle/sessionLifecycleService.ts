import { randomUUID } from 'node:crypto';

import { join } from 'pathe';

import type { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { LOCAL_ENVIRONMENT_ID, type EnvironmentBinding, type EnvironmentLease } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { ProgramWorkdir } from '#/program/program';
import type { ProgramMcpLease } from '#/program/programMcp';
import {
  createScopedChildHandle,
  type ISessionScopeHandle,
} from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { AsyncEmitter, Emitter, type Event, type IWaitUntil } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { drainLogCloses } from '#/_base/log/logService';
import { parseBooleanEnv } from '#/_base/utils/env';
import { DEFAULT_PLAN_MODE_SECTION } from '#/features/plan/configSection';
import { IAgentFileHistoryService } from '#/features/fileHistory/fileHistory';
import { FILE_HISTORY_BLOB_PREFIX } from '#/features/fileHistory/fileHistoryService';
import {
  dropFileHistorySession,
  relocateFileHistorySession,
  touchForkedFileHistory,
} from '#/features/fileHistory/fileHistoryRetention';
import { sameDir } from '#/_base/utils/workdir-slug';
import { IAgentChangeNotifierService } from '#/agent/changeNotifier/changeNotifier';
import { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import {
  EnvironmentSetBinding,
  type WorkdirMoveBaseline,
} from '#/agent/environmentBinding/environmentBindingOps';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentTaskService } from '#/agent/task/task';
import {
  IAgentWorkdirMoveService,
  type PreparedWorkdirRelocation,
} from '#/agent/workdirMove/workdirMove';
import { IAgentCronService } from '#/features/cron/cronService';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { IAgentLoopService } from '#/agent/loop/loop';
import { readUserPermissionRules } from '#/agent/permissionRules/configSection';
import { IProjectPermissionRulesService } from '#/agent/permissionRules/projectPermissionRules';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentSwarmService, SWARM_MODE_ENV } from '#/features/swarm/agent/swarm';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IEventService } from '#/app/event/event';
import { IFlagService } from '#/app/flag/flag';
import { sessionIndexLine } from '#/app/project/projectAlias';
import { ISessionPresence, SESSION_PRESENCE_DIR } from '#/app/sessionPresence/sessionPresence';
import { CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ISessionIndex,
  ISessionIndexMirror,
  PARENT_SESSION_ID_KEY,
} from '#/app/sessionIndex/sessionIndex';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import type { SessionEndedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { bindTelemetryScope } from '#/app/telemetry/telemetryService';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import {
  type AppendLogTruncation,
  IAppendLogStore,
} from '#/persistence/interface/appendLogStore';
import { ISessionLockService } from '#/persistence/interface/sessionLock';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';
import { SyncDescriptor } from '#/_base/di/descriptors';
import {
  ISessionEphemeralMcpServers,
  sessionEphemeralMcpServersSeed,
} from '#/session/mcp/ephemeralMcpServers';
import { sessionAgentProfileCatalogSeed } from '#/session/sessionAgentProfileCatalog/agentProfileCatalogSeed';
import {
  ISessionMetadata,
  SESSION_META_VERSION,
  type AgentMeta,
  type SessionMeta,
} from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalogData } from '#/features/skill/session/skillCatalogData';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import {
  ISessionDisabledMcpSources,
  sessionDisabledMcpSourcesSeed,
  sessionMcpSourcesSeed,
} from '#/session/mcp/mcpSource';
import { ISessionMcpService, SessionMcpService } from '#/session/mcp/sessionMcpService';
import { ISessionProjectInfo } from '#/session/projectInfo/projectInfo';
import { resolveEffectiveWorkspaceRoots } from '#/session/workspaceContext/workspaceRoots';
import { ISessionWorkdir } from '#/session/workdir/workdir';
import {
  drainSessionMetadataWrites,
  encodeSessionMeta,
  toEpochMs,
} from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionNotify } from '#/features/notify/sessionNotify';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  AGENT_WIRE_RECORD_KEY,
  assertWireRecordsReaderVersion,
  createWireMetadataRecord,
  type WireRecord,
} from '#/wire/record';
import { normalizeLegacyTurnSteerRecords } from '#/wire/human';
import { repairWireJournal } from '#/wire/repair';
import { flattenChain } from '#/wire/tree/index';

import { IProjectContext } from '#/project/projectContext/projectContext';
import { IProjectTrust } from '#/project/projectTrust/projectTrust';
import { IUserAgentProfileLoader } from '#/project/projectAgentProfileLoader/userAgentProfileLoader';
import { IPluginAgentProfileLoader } from '#/project/projectAgentProfileLoader/pluginAgentProfileLoader';
import type { IProjectMcpService } from '#/project/projectMcp/projectMcp';
import { PLUGIN_SKILL_SOURCE_ID } from '#/features/skill/catalog/skillSource';

import { agentScopeOf, sessionDirOf, sessionScopeOf } from './internal/addressing';
import { SessionArchived, SessionDeleted, SessionRestored } from './sessionLifecycleEvents';
import {
  assertForkTurnIndex,
  sliceMainRecordsForRunningFork,
  sliceMainRecordsAtTurn,
  sliceRecordsBeforePendingWork,
  sliceSubagentRecordsAtTime,
} from './internal/forkTurnSlice';
import {
  type CreateChildSessionOptions,
  type CreateSessionOptions,
  type ForkSessionOptions,
  type MoveSessionOptions,
  type ResumeSessionOptions,
  type SessionArchivedEvent,
  type SessionClosedEvent,
  type SessionCloseReason,
  type SessionCreatedEvent,
  type SessionCreateSource,
  type SessionForkedEvent,
  type SessionWillCloseEvent,
  type SessionWillCreateEvent,
  ISessionLifecycleService,
} from './sessionLifecycle';
import { IProviderCatalogService } from '#/provider-catalog/providerCatalogService';

type MaterializeSessionOptions = Omit<CreateSessionOptions, 'sessionId'> & {
  readonly sessionId: string;
};

type WorkdirWithMcp = ProgramWorkdir & { readonly mcp: IProjectMcpService };

const NO_ABORT = new AbortController().signal;

function sessionEnvironment(
  environmentId: string | undefined,
  cwd: string | undefined,
): (EnvironmentBinding & { readonly cwd: string }) | undefined {
  if (environmentId === undefined || environmentId === LOCAL_ENVIRONMENT_ID) {
    return cwd === undefined ? undefined : { environmentId: LOCAL_ENVIRONMENT_ID, cwd };
  }
  if (cwd === undefined) {
    throw new EnvironmentError('environment.invalid_cwd', `environment ${environmentId} requires a cwd`);
  }
  return { environmentId, cwd };
}

const SESSION_CREATE_RELOAD_SKILL_SOURCES: readonly string[] = [
  'user',
  'explicit',
  'extra',
  PLUGIN_SKILL_SOURCE_ID,
];

export class SessionLifecycleService extends Disposable implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, ISessionScopeHandle>();
  private readonly _onWillCreateSession = this._register(
    new Emitter<SessionWillCreateEvent>(),
  );
  readonly onWillCreateSession: Event<SessionWillCreateEvent> =
    this._onWillCreateSession.event;
  private readonly _onDidCreateSession = this._register(
    new AsyncEmitter<SessionCreatedEvent & IWaitUntil>(),
  );
  readonly onDidCreateSession: Event<SessionCreatedEvent & IWaitUntil> =
    this._onDidCreateSession.event;
  private readonly _onWillCloseSession = this._register(
    new AsyncEmitter<SessionWillCloseEvent & IWaitUntil>(),
  );
  readonly onWillCloseSession: Event<SessionWillCloseEvent & IWaitUntil> =
    this._onWillCloseSession.event;
  private readonly _onDidCloseSession = this._register(new Emitter<SessionClosedEvent>());
  readonly onDidCloseSession: Event<SessionClosedEvent> = this._onDidCloseSession.event;
  private readonly _onDidArchiveSession = this._register(new Emitter<SessionArchivedEvent>());
  readonly onDidArchiveSession: Event<SessionArchivedEvent> = this._onDidArchiveSession.event;
  private readonly _onDidForkSession = this._register(new Emitter<SessionForkedEvent>());
  readonly onDidForkSession: Event<SessionForkedEvent> = this._onDidForkSession.event;
  private readonly resuming = new Map<string, Promise<ISessionScopeHandle | undefined>>();
  private readonly resumeFailures = new Map<string, Error>();

  constructor(
    private readonly instantiation: IInstantiationService,
    @IProjectContext private readonly projectContext: IProjectContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionIndexMirror private readonly indexMirror: ISessionIndexMirror,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @ISessionLockService private readonly sessionLocks: ISessionLockService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly log: ILogService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IEventService private readonly event: IEventService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IFlagService private readonly flags: IFlagService,
    @IUserAgentProfileLoader
    private readonly userAgentProfileLoader: IUserAgentProfileLoader,
    @IPluginAgentProfileLoader
    private readonly pluginAgentProfileLoader: IPluginAgentProfileLoader,
    private readonly acquireMcp: (workDir?: string) => Promise<ProgramMcpLease>,
    @IProviderCatalogService private readonly models: IProviderCatalogService,
    @IProviderCatalogService private readonly providers: IProviderCatalogService,
    private readonly environments: IEnvironmentService,
    private readonly trust: IProjectTrust,
    private readonly acquireWorkdir: (environmentId: string, cwd: string, followsPrimary?: boolean, launchDir?: string) => Promise<ProgramWorkdir>,
    onDispose?: () => void,
  ) {
    super();
    if (onDispose !== undefined) this._register({ dispose: onDispose });
  }

  private get workspaceId(): string {
    return this.projectContext.workspaceId;
  }

  private get handlerScope(): string {
    return this.projectContext.persistenceScope;
  }

  async create(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    const sessionId = opts.sessionId ?? createSessionId();
    const environment = sessionEnvironment(opts.environmentId, opts.environmentCwd);
    const workDir = this.sessionWorkDir(opts.workDir, environment);
    const effective = { ...opts, workDir };
    const workdir = await this.openWorkdir(environment, workDir, true);
    await workdir.skills
      .reloadSources(SESSION_CREATE_RELOAD_SKILL_SOURCES)
      .catch(() => undefined);
    const handle = await this.materializeSession({ ...effective, sessionId }, environment, workdir);
    try {
      if (environment !== undefined) {
        await handle.accessor.get(ISessionMetadata).update(
          environment.environmentId === LOCAL_ENVIRONMENT_ID
            ? { environmentCwd: environment.cwd }
            : {
                environmentId: environment.environmentId,
                environmentCwd: environment.cwd,
                cwd: workDir,
              },
          { touchUpdatedAt: false },
        );
      }
      const agents = handle.accessor.get(IAgentLifecycleService);
      const main =
        opts.mainAgentBinding !== undefined || opts.ensureMainAgent === true
          ? await agents.create({
              agentId: MAIN_AGENT_ID,
              binding: opts.mainAgentBinding,
              environmentId: environment?.environmentId,
              environmentCwd: environment?.cwd,
            })
          : undefined;
      const defaultPlanMode = this.config.get<boolean>(DEFAULT_PLAN_MODE_SECTION) === true;
      const defaultSwarmMode = parseBooleanEnv(this.bootstrap.getEnv(SWARM_MODE_ENV)) === true;
      if (defaultPlanMode || defaultSwarmMode) {
        const mainAgent = main ?? (await ensureMainAgent(handle));
        const mainHandle = agents.handleOf(mainAgent.agentId);
        if (mainHandle === undefined) {
          throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
        }
        if (defaultPlanMode) await mainHandle.accessor.get(IAgentPlanService).enter();
        if (defaultSwarmMode) mainHandle.accessor.get(IAgentSwarmService).enter('manual');
      }
      await opts.prepare?.(handle);
      await this.appendSessionIndexEntry(sessionId, workDir);
    } catch (error) {
      const sessionDir = handle.accessor.get(ISessionContext).sessionDir;
      this.sessions.delete(sessionId);
      await this.drainAgents(handle).catch(() => {});
      void handle.dispose();
      await this.hostFs.remove(sessionDir).catch(() => {});
      await this.index.remove(sessionId).catch(() => {});
      throw error;
    }
    await this.announceCreated({ sessionId, handle, source: 'startup' });
    return handle;
  }

  async move(opts: MoveSessionOptions): Promise<ISessionScopeHandle> {
    const { sessionId } = opts;
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) {
      await inflight.catch(() => undefined);
    }
    const existingHandle = this.sessions.get(sessionId);
    const summary = await this.index.get(sessionId);
    const persistedHere = summary !== undefined && summary.workspaceId === this.workspaceId;
    if (existingHandle === undefined && !persistedHere) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }

    const lease = this.sessionLocks.lease(sessionId);
    try {
      const persisted = await this.readMetaFromDisk(sessionId);
      const currentEnvId = persisted?.environmentId ?? summary?.environmentId;
      if (currentEnvId !== undefined && currentEnvId !== LOCAL_ENVIRONMENT_ID) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          `Session "${sessionId}" runs in remote environment "${currentEnvId}" and cannot be moved to a local worktree`,
          { details: { sessionId, environmentId: currentEnvId } },
        );
      }

      const nextEnv = sessionEnvironment(LOCAL_ENVIRONMENT_ID, opts.environmentCwd);
      const nextWorkDir = this.sessionWorkDir(opts.workDir, nextEnv);
      await this.requireReadableCwd({ environmentId: LOCAL_ENVIRONMENT_ID, cwd: nextWorkDir });

      const oldHandle = existingHandle ?? (await this.doResume(sessionId, 'reclaimed'));
      if (oldHandle === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
      }

      const oldMeta = await oldHandle.accessor.get(ISessionMetadata).read();
      const oldEnv = sessionEnvironment(oldMeta.environmentId, oldMeta.environmentCwd);
      const oldWorkDir = this.sessionWorkDir(
        oldMeta.cwd ?? oldHandle.accessor.get(ISessionContext).cwd,
        oldEnv,
      );
      if (sameDir(oldWorkDir, nextWorkDir) && oldMeta.environmentCwd === opts.environmentCwd) {
        return oldHandle;
      }

      this.assertSessionIdleForMove(sessionId, oldHandle);

      const nextWorkdir = await this.openWorkdir(nextEnv, nextWorkDir, true);
      await nextWorkdir.skills
        .reloadSources(SESSION_CREATE_RELOAD_SKILL_SOURCES)
        .catch(() => undefined);

      const additionalDirs = [...oldHandle.accessor.get(ISessionProjectInfo).additionalDirs];
      const mcpServers = { ...oldHandle.accessor.get(ISessionEphemeralMcpServers) };
      const disabledMcpSources = [...oldHandle.accessor.get(ISessionDisabledMcpSources)];
      const hadMainAgent =
        oldMeta.agents?.[MAIN_AGENT_ID] !== undefined ||
        oldHandle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID) !== undefined;

      const relocation = await this.rebindAgentsForRelocation({
        sessionId,
        oldHandle,
        oldMeta,
        oldWorkDir,
        nextWorkDir,
        nextEnvironmentCwd: opts.environmentCwd,
      });

      await oldHandle.accessor.get(ISessionMetadata).update(
        {
          cwd: nextWorkDir,
          environmentCwd: opts.environmentCwd,
        },
        { touchUpdatedAt: false },
      );
      await drainSessionMetadataWrites();
      await this.appendSessionIndexEntry(sessionId, nextWorkDir);
      await relocateFileHistorySession({
        docs: this.docs,
        workspaceId: this.workspaceId,
        projectRoot: this.projectContext.meta.root,
        sessionId,
        fromPlacement: {
          environmentId: oldMeta.environmentId,
          environmentCwd: oldMeta.environmentCwd,
        },
        toPlacement: {
          environmentId: oldMeta.environmentId,
          environmentCwd: opts.environmentCwd,
        },
      });
      await this.indexMirror.drain();

      await this.teardownLiveSession(sessionId, oldHandle, 'reclaim', true);

      try {
        return await this.rematerializeRelocatedSession({
          sessionId,
          nextWorkDir,
          nextEnv,
          nextWorkdir,
          additionalDirs,
          mcpServers,
          disabledMcpSources,
          hadMainAgent,
        });
      } catch (error) {
        await this.rollbackFailedRelocation({
          sessionId,
          oldMeta,
          oldWorkDir,
          failedEnvironmentCwd: opts.environmentCwd,
          relocation,
          additionalDirs,
          mcpServers,
          disabledMcpSources,
        }).catch(() => undefined);
        throw error;
      }
    } finally {
      lease.release();
    }
  }

  private async rebindAgentsForRelocation(input: {
    readonly sessionId: string;
    readonly oldHandle: ISessionScopeHandle;
    readonly oldMeta: SessionMeta;
    readonly oldWorkDir: string;
    readonly nextWorkDir: string;
    readonly nextEnvironmentCwd: string | undefined;
  }): Promise<PreparedWorkdirRelocation> {
    const agents = input.oldHandle.accessor.get(IAgentLifecycleService);
    const mainHandle = agents.handleOf(MAIN_AGENT_ID);
    const changeNotifier = mainHandle?.accessor.get(IAgentChangeNotifierService);
    changeNotifier?.mute();
    try {
      let relocation: PreparedWorkdirRelocation = {};
      if (mainHandle !== undefined) {
        relocation = await mainHandle.accessor
          .get(IAgentWorkdirMoveService)
          .prepareRelocation({ oldWorkDir: input.oldWorkDir, nextWorkDir: input.nextWorkDir });
        await mainHandle.accessor.get(IAgentEnvironmentBindingService).rebindLocalWorkDir({
          cwd: input.nextEnvironmentCwd,
          originCwd: relocation.originCwd,
          pendingBaseline: relocation.pendingBaseline,
        });
      }
      const liveAgentIds = new Set<string>();
      for (const agent of agents.list()) {
        liveAgentIds.add(agent.agentId);
        if (agent.agentId === MAIN_AGENT_ID) continue;
        const subHandle = agents.handleOf(agent.agentId);
        if (subHandle !== undefined) {
          await subHandle.accessor
            .get(IAgentEnvironmentBindingService)
            .rebindLocalWorkDir({ cwd: input.nextEnvironmentCwd });
        }
      }
      for (const agent of agents.list()) {
        const handle = agents.handleOf(agent.agentId);
        if (handle !== undefined) {
          await handle.accessor.get(IEventDispatcher).flush();
        }
      }
      for (const agentId of Object.keys(input.oldMeta.agents ?? {})) {
        if (agentId === MAIN_AGENT_ID || liveAgentIds.has(agentId)) continue;
        await this.appendColdAgentLocalBinding(input.sessionId, agentId, {
          cwd: input.nextEnvironmentCwd,
        });
      }
      await this.appendLogStore.flush();
      return relocation;
    } catch (error) {
      changeNotifier?.unmute();
      throw error;
    }
  }

  private async rematerializeRelocatedSession(input: {
    readonly sessionId: string;
    readonly nextWorkDir: string;
    readonly nextEnv: ReturnType<typeof sessionEnvironment>;
    readonly nextWorkdir: WorkdirWithMcp;
    readonly additionalDirs: readonly string[];
    readonly mcpServers: ResumeSessionOptions['mcpServers'];
    readonly disabledMcpSources: readonly string[];
    readonly hadMainAgent: boolean;
  }): Promise<ISessionScopeHandle> {
    const newHandle = await this.materializeSession(
      {
        sessionId: input.sessionId,
        workDir: input.nextWorkDir,
        additionalDirs: [...input.additionalDirs],
        mcpServers: { ...input.mcpServers },
        disabledMcpSources: [...input.disabledMcpSources],
      },
      input.nextEnv,
      input.nextWorkdir,
    );
    try {
      if (input.hadMainAgent) {
        const newAgents = newHandle.accessor.get(IAgentLifecycleService);
        if (newAgents.get(MAIN_AGENT_ID) === undefined) {
          await newAgents.create({
            agentId: MAIN_AGENT_ID,
            environmentId: input.nextEnv?.environmentId,
            environmentCwd: input.nextEnv?.cwd,
          });
        }
      }
      await this._onDidCreateSession.fireAsync(
        { sessionId: input.sessionId, handle: newHandle, source: 'reclaimed' },
        NO_ABORT,
      );
      return newHandle;
    } catch (error) {
      this.sessions.delete(input.sessionId);
      await newHandle.dispose();
      throw error;
    }
  }

  private assertSessionIdleForMove(sessionId: string, handle: ISessionScopeHandle): void {
    const activity = handle.accessor.get(ISessionActivityView).state();
    if (activity.busy || activity.pendingInteraction !== 'none') {
      throw new Error2(
        ErrorCodes.TURN_AGENT_BUSY,
        `Session "${sessionId}" cannot be moved while a turn or interaction is active`,
        { details: { sessionId } },
      );
    }
    const agents = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agents.list()) {
      const agentHandle = agents.handleOf(agent.agentId);
      if (agentHandle === undefined) continue;
      const snapshot = agentHandle.accessor.get(IAgentLoopService).snapshot();
      if (
        snapshot.state === 'running' ||
        snapshot.activeTurnId !== undefined ||
        snapshot.turn !== undefined ||
        snapshot.queue.length > 0 ||
        snapshot.hasPendingRequests
      ) {
        throw new Error2(
          ErrorCodes.TURN_AGENT_BUSY,
          `Session "${sessionId}" cannot be moved while a turn or queued message is pending`,
          { details: { sessionId, agentId: agent.agentId } },
        );
      }
      if (agentHandle.accessor.get(IAgentFullCompactionService).compacting !== null) {
        throw new Error2(
          ErrorCodes.TURN_AGENT_BUSY,
          `Session "${sessionId}" cannot be moved while compaction is running`,
          { details: { sessionId, agentId: agent.agentId } },
        );
      }
      if (agentHandle.accessor.get(IAgentTaskService).list(true).length > 0) {
        throw new Error2(
          ErrorCodes.TURN_AGENT_BUSY,
          `Session "${sessionId}" cannot be moved while background tasks are running`,
          { details: { sessionId, agentId: agent.agentId } },
        );
      }
      if (agentHandle.accessor.get(IAgentCronService).list().length > 0) {
        throw new Error2(
          ErrorCodes.TURN_AGENT_BUSY,
          `Session "${sessionId}" cannot be moved while scheduled cron tasks are active`,
          { details: { sessionId, agentId: agent.agentId } },
        );
      }
    }
  }

  private async teardownLiveSession(
    sessionId: string,
    handle: ISessionScopeHandle,
    reason: Exclude<SessionCloseReason, 'archive'>,
    awaitDispose: boolean,
  ): Promise<void> {
    await this.announceWillClose({ sessionId, handle, reason });
    this.sessions.delete(sessionId);
    await this.drainAgents(handle);
    await this.appendLogStore.drainRetirements();
    await drainSessionMetadataWrites();
    await this.indexMirror.drain();
    const disposePromise = handle.dispose();
    if (awaitDispose) {
      await disposePromise;
    } else {
      void disposePromise;
    }
    await this.environments.drainSession(sessionId);
    await drainLogCloses();
    this._onDidCloseSession.fire({ sessionId });
  }

  private async rollbackFailedRelocation(input: {
    readonly sessionId: string;
    readonly oldMeta: SessionMeta;
    readonly oldWorkDir: string;
    readonly failedEnvironmentCwd: string | undefined;
    readonly relocation: PreparedWorkdirRelocation;
    readonly additionalDirs: readonly string[];
    readonly mcpServers: ResumeSessionOptions['mcpServers'];
    readonly disabledMcpSources: readonly string[];
  }): Promise<void> {
    const { sessionId, oldMeta, oldWorkDir } = input;
    const restoredMeta: SessionMeta = {
      ...oldMeta,
      cwd: oldWorkDir,
      environmentCwd: oldMeta.environmentCwd,
    };
    await this.docs.set(
      sessionScopeOf(this.handlerScope, sessionId),
      'state.json',
      encodeSessionMeta(restoredMeta),
    );
    this.indexMirror.record(
      buildSessionSummary({
        id: sessionId,
        workspaceId: this.workspaceId,
        cwd: oldWorkDir,
        environmentId: restoredMeta.environmentId,
        environmentCwd: restoredMeta.environmentCwd,
        title: restoredMeta.title,
        lastPrompt: restoredMeta.lastPrompt,
        createdAt: restoredMeta.createdAt,
        updatedAt: restoredMeta.updatedAt,
        archived: restoredMeta.archived,
        archivedAt: restoredMeta.archivedAt,
        custom: restoredMeta.custom,
        lastTurnReason: restoredMeta.lastTurnReason,
      }),
    );
    await this.appendSessionIndexEntry(sessionId, oldWorkDir);
    await relocateFileHistorySession({
      docs: this.docs,
      workspaceId: this.workspaceId,
      projectRoot: this.projectContext.meta.root,
      sessionId,
      fromPlacement: {
        environmentId: oldMeta.environmentId,
        environmentCwd: input.failedEnvironmentCwd,
      },
      toPlacement: {
        environmentId: oldMeta.environmentId,
        environmentCwd: oldMeta.environmentCwd,
      },
    });
    const agentIds = new Set<string>([MAIN_AGENT_ID, ...Object.keys(oldMeta.agents ?? {})]);
    for (const agentId of agentIds) {
      await this.appendColdAgentLocalBinding(
        sessionId,
        agentId,
        agentId === MAIN_AGENT_ID
          ? {
              cwd: oldMeta.environmentCwd,
              originCwd: input.relocation.previousOriginCwd ?? null,
              pendingBaseline: input.relocation.previousPendingBaseline ?? null,
            }
          : { cwd: oldMeta.environmentCwd },
      );
    }
    await this.appendLogStore.flush();
    const resumed = await this.doResume(sessionId, 'reclaimed', {
      additionalDirs: [...input.additionalDirs],
      mcpServers: { ...input.mcpServers },
      disabledMcpSources: [...input.disabledMcpSources],
    });
    const resumedMain = resumed?.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
    if (resumedMain !== undefined) {
      await resumedMain.accessor
        .get(IAgentWorkdirMoveService)
        .restoreAgentsMdSnapshot(oldWorkDir)
        .catch(() => undefined);
      await resumedMain.accessor.get(IEventDispatcher).flush();
      await this.appendLogStore.flush();
    }
  }

  private async appendColdAgentLocalBinding(
    sessionId: string,
    agentId: string,
    binding: {
      readonly cwd?: string;
      readonly originCwd?: string | null;
      readonly pendingBaseline?: WorkdirMoveBaseline | null;
    },
  ): Promise<void> {
    const bindingRecord: WireRecord = {
      type: EnvironmentSetBinding.type,
      time: Date.now(),
      agentId,
      environmentId: LOCAL_ENVIRONMENT_ID,
      ...(binding.cwd === undefined ? {} : { cwd: binding.cwd }),
      ...(binding.originCwd === undefined ? {} : { originCwd: binding.originCwd }),
      ...(binding.pendingBaseline === undefined
        ? {}
        : { pendingBaseline: binding.pendingBaseline }),
    };
    await this.appendRecordToColdAgentLog(sessionId, agentId, bindingRecord, {
      createIfEmpty: false,
      checkReaderVersion: false,
    });
  }

  private async appendRecordToColdAgentLog(
    sessionId: string,
    agentId: string,
    nextRecord: WireRecord,
    options: { readonly createIfEmpty: boolean; readonly checkReaderVersion: boolean },
  ): Promise<void> {
    const scope = agentScopeOf(sessionScopeOf(this.handlerScope, sessionId), agentId);
    const tolerate = { onTruncate: () => {} };
    let first: WireRecord | undefined;
    for await (const record of this.appendLogStore.read<WireRecord>(
      scope,
      AGENT_WIRE_RECORD_KEY,
      tolerate,
    )) {
      first = record;
      break;
    }
    if (first === undefined) {
      if (!options.createIfEmpty) return;
      this.appendLogStore.append(scope, AGENT_WIRE_RECORD_KEY, createWireMetadataRecord());
      this.appendLogStore.append(scope, AGENT_WIRE_RECORD_KEY, nextRecord);
      return;
    }
    if (first.type === 'metadata') {
      if (options.checkReaderVersion) {
        assertWireRecordsReaderVersion([first]);
      }
      this.appendLogStore.append(scope, AGENT_WIRE_RECORD_KEY, nextRecord);
      return;
    }
    const records: WireRecord[] = [createWireMetadataRecord()];
    for await (const record of this.appendLogStore.read<WireRecord>(
      scope,
      AGENT_WIRE_RECORD_KEY,
      tolerate,
    )) {
      records.push(record);
    }
    records.push(nextRecord);
    await this.appendLogStore.rewrite(scope, AGENT_WIRE_RECORD_KEY, records);
  }

  private async materializeSession(
    opts: MaterializeSessionOptions,
    environment: EnvironmentBinding & { readonly cwd: string } | undefined,
    workdir: WorkdirWithMcp,
  ): Promise<ISessionScopeHandle> {
    const workspaceId = this.workspaceId;
    const sessionScope = sessionScopeOf(this.handlerScope, opts.sessionId);
    const sessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, opts.sessionId);
    const metaScope = sessionScope;
    const dirs = workdir.dirs;
    try {
      await Promise.all([this.config.ready, this.models.ready, this.providers.ready]);
      readUserPermissionRules(this.config);
      await dirs.ready;
      await dirs.mergeAdditionalDirs(environment?.cwd ?? opts.workDir, opts.additionalDirs ?? []);
    } catch (error) {
      workdir.dispose();
      throw error;
    }
    const ctx: ISessionContext = {
      _serviceBrand: undefined,
      sessionId: opts.sessionId,
      workspaceId,
      sessionDir,
      metaScope,
      cwd: environment?.environmentId === LOCAL_ENVIRONMENT_ID ? environment.cwd : opts.workDir,
      scope: (subKey?: string): string =>
        subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
    };
    const telemetryBinding = bindTelemetryScope(this.telemetry, {
      session_id: opts.sessionId,
    });
    let handle: ISessionScopeHandle;
    const scopeCreated = new Emitter<ISessionScopeHandle>();
    try {
      handle = createScopedChildHandle(
        this.instantiation,
        LifecycleScope.Session,
        opts.sessionId,
        {
          seeds: [
            ...sessionContextSeed(ctx),
            [IProjectLocalConfigService, workdir.localConfig],
            [IProjectTrust, this.trust],
            [ITelemetryService, telemetryBinding.telemetry],
            ...sessionAgentProfileCatalogSeed({
              _serviceBrand: undefined,
              workspaceKey: workspaceId,
              contextKeys: [workdir.contextKey, workdir.configuredSources.contextKey],
            }),
            [ISessionSkillCatalogData, workdir.skills.sessionData()],
            [ISessionInstructionsProvider, workdir.instructions.sessionProvider()],
            [ISessionMcpService, new SyncDescriptor(SessionMcpService)],
            ...sessionMcpSourcesSeed(workdir.mcp.sources()),
            ...sessionDisabledMcpSourcesSeed(opts.disabledMcpSources ?? []),
            [ISessionProjectInfo, dirs.sessionInfo()],
            [ISessionWorkdir, {
              _serviceBrand: undefined,
              environmentId: environment?.environmentId ?? LOCAL_ENVIRONMENT_ID,
              cwd: environment?.cwd,
              fs: workdir.fs,
            }],
            ...sessionEphemeralMcpServersSeed(opts.mcpServers ?? {}),
          ],
          configureContainer: (container) => {
            container.invokeFunction((accessor) => {
              accessor.get(ISessionMcpService);
            });
            container.anchorKernelEntry(
              () => telemetryBinding.dispose(),
              'telemetry:session-context',
            );
            container.anchorKernelEntry(() => { workdir.dispose(); }, 'sessionLifecycle:workdir');
            const presence = container
              .invokeFunction((accessor) => accessor.get(ISessionPresence))
              .markOpen(sessionDir);
            container.anchorKernelEntry(() => presence.dispose(), 'sessionLifecycle:presence');
            this._onWillCreateSession.fire({
              sessionId: opts.sessionId,
              onDidCreateScope: scopeCreated.event,
              readSeed: (id) => container.invokeFunction((accessor) => accessor.get(id)),
              contributeSeed: (id, value) => {
                container.provide(id, value);
              },
              onSessionDispose: (dispose) => {
                container.anchorKernelEntry(dispose, 'sessionLifecycle:willCreateParticipant');
              },
            });
          },
        },
      ) as ISessionScopeHandle;
      scopeCreated.fire(handle);
    } catch (error) {
      telemetryBinding.dispose();
      workdir.dispose();
      throw error;
    } finally {
      scopeCreated.dispose();
    }
    try {
      await handle.accessor.get(ISessionMetadata).ready;
      await handle.accessor.get(ISessionNotify).ready;
      await handle.accessor.get(ISessionToolPolicy).ready;
      await handle.accessor.get(IProjectPermissionRulesService).ready;
      await Promise.all([
        workdir.agentProfiles.ready,
        workdir.configuredSources.extraAgentProfiles.ready,
        workdir.configuredSources.explicitAgentProfiles.ready,
        this.userAgentProfileLoader.ready,
        this.pluginAgentProfileLoader.ready,
      ]);
    } catch (error) {
      void handle.dispose();
      void workdir.configuredSources.explicitAgentProfiles.reload().catch(() => undefined);
      throw error;
    }
    this.sessions.set(opts.sessionId, handle);
    return handle;
  }

  private sessionWorkDir(fallbackCwd: string, environment: EnvironmentBinding | undefined): string {
    if (environment !== undefined && environment.environmentId !== LOCAL_ENVIRONMENT_ID) return fallbackCwd;
    const primary = this.projectContext.meta.root;
    return resolveEffectiveWorkspaceRoots(
      { workspaceId: this.workspaceId, cwd: fallbackCwd },
      environment,
      { primaryByWorkspace: { [this.workspaceId]: primary }, additionalDirs: [] },
    ).workDir;
  }

  private async openWorkdir(
    environment: (EnvironmentBinding & { readonly cwd: string }) | undefined,
    workDir: string,
    requiresCwd: boolean,
  ): Promise<WorkdirWithMcp> {
    const mcp = await this.acquireMcp(environment === undefined ? undefined : workDir);
    try {
      const workdir = await this.connectWorkdir(environment, workDir, requiresCwd);
      return {
        ...workdir,
        mcp: mcp.service,
        dispose: () => {
          mcp.dispose();
          workdir.dispose();
        },
      };
    } catch (error) {
      mcp.dispose();
      throw error;
    }
  }

  private async connectWorkdir(
    environment: (EnvironmentBinding & { readonly cwd: string }) | undefined,
    workDir: string,
    requiresCwd: boolean,
  ): Promise<ProgramWorkdir> {
    if (environment === undefined) return this.acquireWorkdir(LOCAL_ENVIRONMENT_ID, workDir, true);
    if (requiresCwd) await this.requireReadableCwd(environment);
    return this.acquireWorkdir(environment.environmentId, environment.cwd, false, workDir);
  }

  private async requireReadableCwd({ environmentId, cwd }: EnvironmentBinding & { readonly cwd: string }): Promise<void> {
    let lease: EnvironmentLease;
    try {
      lease = await this.environments.acquireWhenReady({ environmentId }, ['fs']);
    } catch (error) {
      if (error instanceof EnvironmentError) throw error;
      throw new EnvironmentError(
        'environment.unavailable',
        `failed to connect environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      const stat = await lease.environment.fs!.stat(cwd).catch((error: unknown) => {
        throw new EnvironmentError(
          'environment.invalid_cwd',
          `cwd ${cwd} is not readable on environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (!stat.isDirectory) {
        throw new EnvironmentError('environment.invalid_cwd', `cwd ${cwd} is not a directory on environment ${environmentId}`);
      }
    } finally {
      lease.dispose();
    }
  }

  private async appendSessionIndexEntry(sessionId: string, workDir: string): Promise<void> {
    const sessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sessionId);
    this.appendLogStore.append('', 'session_index.jsonl', sessionIndexLine({ sessionId, sessionDir, workDir }, this.projectContext.meta.root));
    await this.appendLogStore.flush();
  }

  private async announceCreated(event: SessionCreatedEvent): Promise<void> {
    await this._onDidCreateSession.fireAsync(event, NO_ABORT);
    event.handle.accessor.get(ITelemetryService).track2('session_started', {
      resumed: event.source !== 'startup',
      experimental_flags: this.flags.exposedIds().toSorted().join(','),
    });
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    if (this.resuming.has(sessionId)) return undefined;
    return this.sessions.get(sessionId);
  }

  resume(
    sessionId: string,
    opts?: ResumeSessionOptions,
    source: Extract<SessionCreateSource, 'resume' | 'reclaimed'> = 'resume',
  ): Promise<ISessionScopeHandle | undefined> {
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    this.resumeFailures.delete(sessionId);
    const promise = this.doResume(sessionId, source, opts)
      .catch((error: unknown) => {
        this.telemetry
          .withContext({ session_id: sessionId })
          .track2('session_load_failed', {
            reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
          });
        this.resumeFailures.set(sessionId, error instanceof Error ? error : new Error('session resume failed'));
        throw error;
      })
      .finally(() => this.resuming.delete(sessionId));
    this.resuming.set(sessionId, promise);
    return promise;
  }

  async whenResumeSettled(sessionId: string): Promise<void> {
    await this.resuming.get(sessionId);
    const failure = this.resumeFailures.get(sessionId);
    if (failure !== undefined) throw failure;
  }

  private async doResume(
    sessionId: string,
    source: SessionCreateSource,
    opts?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;

    const summary = await this.index.get(sessionId);
    if (summary === undefined || summary.workspaceId !== this.workspaceId) return undefined;
    const persisted = await this.readMetaFromDisk(sessionId);
    const environment = sessionEnvironment(persisted?.environmentId, persisted?.environmentCwd);
    const fallbackCwd = persisted?.cwd ?? summary.cwd ?? this.projectContext.meta.root;
    const workDir = this.sessionWorkDir(fallbackCwd, environment);

    const handle = await this.materializeSession({
      sessionId,
      workDir,
      additionalDirs: opts?.additionalDirs,
      mcpServers: opts?.mcpServers,
      disabledMcpSources: opts?.disabledMcpSources,
    }, environment, await this.openWorkdir(environment, workDir, environment?.environmentId !== LOCAL_ENVIRONMENT_ID));
    try {
      const agents = handle.accessor.get(IAgentLifecycleService);
      if (agents.get(MAIN_AGENT_ID) === undefined) {
        await agents.create({ agentId: MAIN_AGENT_ID });
      }
      await this.announceCreated({ sessionId, handle, source });
    } catch (error) {
      this.sessions.delete(sessionId);
      void handle.dispose();
      throw error;
    }
    return handle;
  }

  list(): readonly ISessionScopeHandle[] {
    const ready: ISessionScopeHandle[] = [];
    for (const [id, handle] of this.sessions) {
      if (!this.resuming.has(id)) ready.push(handle);
    }
    return ready;
  }

  async close(sessionId: string, reason: Exclude<SessionCloseReason, 'archive'> = 'exit'): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    await this.teardownLiveSession(sessionId, handle, reason, false);
    const ended: SessionEndedEvent = { reason };
    this.telemetry.withContext({ session_id: sessionId }).track2('session_ended', ended);
  }

  async archive(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    const lease = this.sessionLocks.lease(sessionId);
    try {
      const meta = handle.accessor.get(ISessionMetadata);
      await meta.setArchived(true);
      await this.drainAgents(handle);
      await this.appendLogStore.drainRetirements();
      this.event.publish(
        new SessionArchived({
          payload: { sessionId, workspaceId: this.projectContext.workspaceId },
        }),
      );
      await this.announceWillClose({ sessionId, handle, reason: 'archive' });
      this.sessions.delete(sessionId);
      await drainSessionMetadataWrites();
      await this.indexMirror.drain();
      void handle.dispose();
      await this.environments.drainSession(sessionId);
      await drainLogCloses();
      this._onDidArchiveSession.fire({ sessionId });
      this.telemetry.withContext({ session_id: sessionId }).track2('session_ended', { reason: 'archive' });
    } finally {
      lease.release();
    }
  }

  async restore(
    sessionId: string,
    opts?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const handle = await this.resume(sessionId, opts);
    if (handle === undefined) return undefined;
    const metadata = handle.accessor.get(ISessionMetadata);
    const wasArchived = (await metadata.read()).archived;
    await metadata.setArchived(false);
    if (wasArchived) {
      this.event.publish(
        new SessionRestored({
          payload: { sessionId, workspaceId: this.projectContext.workspaceId },
        }),
      );
    }
    return handle;
  }

  async delete(sessionId: string): Promise<void> {
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) {
      await inflight.catch(() => undefined);
    }
    const handle = this.sessions.get(sessionId);
    const summary = await this.index.get(sessionId);
    const persistedHere = summary !== undefined && summary.workspaceId === this.workspaceId;
    if (handle === undefined && !persistedHere) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const lease = this.sessionLocks.lease(sessionId);
    try {
      if (handle !== undefined) {
        await this.close(sessionId);
      }
      await this.hostFs.remove(sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sessionId));
      await this.index.remove(sessionId);
      await dropFileHistorySession({ docs: this.docs, workspaceId: this.workspaceId, projectRoot: this.projectContext.meta.root, placement: summary ?? {}, sessionId });
      this.appendLogStore.append('', 'session_index.jsonl', { sessionId, deleted: true });
      await this.appendLogStore.flush();
      this.event.publish(
        new SessionDeleted({
          payload: { sessionId, workspaceId: this.projectContext.workspaceId, session: summary },
        }),
      );
    } finally {
      lease.release();
    }
  }

  private async announceWillClose(event: SessionWillCloseEvent): Promise<void> {
    await this._onWillCloseSession.fireAsync(event, NO_ABORT);
  }

  private async drainAgents(handle: ISessionScopeHandle): Promise<void> {
    const agentLifecycle = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agentLifecycle.list()) {
      await agentLifecycle.remove(agent);
    }
  }

  async fork(opts: ForkSessionOptions): Promise<SessionMeta> {
    const sourceId = opts.sourceSessionId;

    const sourceHandle = this.sessions.get(sourceId);
    const indexSummary = await this.index.get(sourceId);
    if (
      (sourceHandle === undefined && indexSummary === undefined) ||
      (indexSummary !== undefined && indexSummary.workspaceId !== this.workspaceId)
    ) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceId} does not exist`);
    }
    assertForkTurnIndex(opts.turnIndex);

    let targetId: string | undefined;
    let targetSessionDir: string | undefined;
    const quiescenceHolds: IDisposable[] = [];
    const historySnapshotAgentIds = new Set<string>();
    const activeTurnIds = new Map<string, number>();
    const queuedPromptIds = new Map<string, readonly string[]>();
    const sourceLease = this.sessionLocks.lease(sourceId);
    try {
      if (sourceHandle !== undefined) {
        const sourceAgents = sourceHandle.accessor.get(IAgentLifecycleService);
        const sourceAgentHandles = sourceAgents.list().flatMap((agent) => {
          const handle = sourceAgents.handleOf(agent.agentId);
          return handle === undefined ? [] : [handle];
        });
        for (const agentHandle of sourceAgentHandles) {
          const loop = agentHandle.accessor.get(IAgentLoopService);
          const snapshot = loop.snapshot();
          const activeTurnId = snapshot.activeTurnId ?? snapshot.turn?.turnId;
          const requiresHistorySnapshot = activeTurnId !== undefined || snapshot.hasPendingRequests;
          const hold = requiresHistorySnapshot
            ? loop.tryAcquireHistorySnapshot()
            : loop.tryAcquireQuiescence();
          if (hold === undefined) {
            throw new Error2(
              ErrorCodes.SESSION_FORK_ACTIVE_TURN,
              `Session "${sourceId}" cannot be forked while another session history operation is in progress`,
              { details: { sessionId: sourceId, agentId: agentHandle.id } },
            );
          }
          quiescenceHolds.push(hold);
          if (requiresHistorySnapshot) {
            historySnapshotAgentIds.add(agentHandle.id);
            queuedPromptIds.set(
              agentHandle.id,
              snapshot.queue.flatMap((item) => {
                const promptId = item.attributes?.promptId;
                return typeof promptId === 'string' ? [promptId] : [];
              }),
            );
          }
          if (activeTurnId !== undefined) activeTurnIds.set(agentHandle.id, activeTurnId);
        }
        for (const agentHandle of sourceAgentHandles) {
          await agentHandle.accessor.get(IEventDispatcher).flush();
        }
        await this.appendLogStore.flush();
      }
      await drainSessionMetadataWrites();
      if (sourceHandle !== undefined) {
        const sourceAgents = sourceHandle.accessor.get(IAgentLifecycleService);
        for (const agent of sourceAgents.list()) {
          const agentHandle = sourceAgents.handleOf(agent.agentId);
          if (agentHandle === undefined) continue;
          await agentHandle.accessor.get(IAgentFileHistoryService).settled();
        }
      }
      const sourceMeta =
        sourceHandle !== undefined
          ? await sourceHandle.accessor.get(ISessionMetadata).read()
          : await this.readMetaFromDisk(sourceId);

      targetId = opts.newSessionId ?? createSessionId();
      if (this.sessions.has(targetId) || (await this.index.get(targetId)) !== undefined) {
        throw new Error2(
          ErrorCodes.SESSION_ALREADY_EXISTS,
          `Session "${targetId}" already exists`,
        );
      }

      const runningFork = historySnapshotAgentIds.size > 0;
      const mainRecords =
        opts.turnIndex === undefined && !runningFork
          ? undefined
          : normalizeLegacyTurnSteerRecords(
              flattenChain(await this.readSourceWireRecords(sourceHandle, sourceId, MAIN_AGENT_ID)),
            );
      const completedMainRecords =
        mainRecords === undefined || !runningFork
          ? mainRecords
          : sliceRecordsBeforePendingWork(
              mainRecords,
              activeTurnIds.get(MAIN_AGENT_ID),
              queuedPromptIds.get(MAIN_AGENT_ID) ?? [],
            );
      const turnSlice =
        opts.turnIndex !== undefined
          ? sliceMainRecordsAtTurn(completedMainRecords!, sourceId, opts.turnIndex)
          : runningFork
            ? sliceMainRecordsForRunningFork(
                mainRecords!,
                sourceId,
                activeTurnIds.get(MAIN_AGENT_ID),
                queuedPromptIds.get(MAIN_AGENT_ID) ?? [],
              )
            : undefined;

      targetSessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, targetId);
      await this.copySessionFiles(
        sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sourceId),
        targetSessionDir,
        turnSlice !== undefined,
      );

      const sourceAgents = sourceMeta?.agents ?? {};
      const agentIds = Object.keys(sourceAgents);
      let retainedAgentIds: readonly string[] = agentIds;
      if (turnSlice !== undefined) {
        const retained: string[] = [];
        for (const agentId of agentIds) {
          let slicedRecords: readonly WireRecord[] | undefined;
          if (agentId === MAIN_AGENT_ID) {
            slicedRecords = turnSlice.records;
          } else {
            const subagentRecords = sliceSubagentRecordsAtTime(
              sliceRecordsBeforePendingWork(
                flattenChain(await this.readSourceWireRecords(sourceHandle, sourceId, agentId)),
                activeTurnIds.get(agentId),
                queuedPromptIds.get(agentId) ?? [],
              ),
              turnSlice.cutoffTime,
            );
            if (subagentRecords.length === 0) continue;
            slicedRecords = subagentRecords;
          }
          await this.copyAgentWire({
            sourceHandle,
            sourceSessionId: sourceId,
            agentId,
            targetSessionId: targetId,
            records: slicedRecords,
          });
          retained.push(agentId);
        }
        retainedAgentIds = retained;
        await this.pruneTruncatedForkFiles(targetSessionDir, agentIds, retainedAgentIds);
      } else {
        await Promise.all(agentIds.map((agentId) => this.appendForkedMarker(targetId!, agentId)));
        await this.appendLogStore.flush();
        await touchForkedFileHistory({
          docs: this.docs,
          hostFs: this.hostFs,
          workspaceId: this.workspaceId,
          projectRoot: this.projectContext.meta.root,
          placement: sourceMeta ?? {},
          sessionDir: targetSessionDir,
          sessionId: targetId!,
        });
      }

      const title = opts.title ?? `Fork: ${sourceMeta?.title || sourceId}`;
      const now = Date.now();
      const agents: Record<string, AgentMeta> = {};
      for (const agentId of retainedAgentIds) {
        const sourceAgent = sourceAgents[agentId]!;
        agents[agentId] = {
          homedir: join(
            this.bootstrap.homeDir,
            agentScopeOf(sessionScopeOf(this.handlerScope, targetId), agentId),
          ),
          type: agentId === MAIN_AGENT_ID ? 'main' : 'sub',
          parentAgentId: agentId === MAIN_AGENT_ID ? undefined : MAIN_AGENT_ID,
          forkedFrom: sourceAgent.forkedFrom,
          labels: labelsFromAgentMeta(sourceAgent),
        };
      }
      const hostCwd = sourceHandle?.accessor.get(ISessionContext).cwd ?? sourceMeta?.cwd ?? this.projectContext.cwd;
      const meta: SessionMeta = {
        id: targetId,
        version: SESSION_META_VERSION,
        cwd: hostCwd,
        createdAt: now,
        updatedAt: toEpochMs(sourceMeta?.updatedAt) || now,
        archived: false,
        title,
        titleKind: opts.title !== undefined ? 'custom' : sourceMeta?.titleKind,
        forkedFrom: sourceId,
        agents,
        environmentId: sourceMeta?.environmentId,
        environmentCwd: sourceMeta?.environmentCwd,
        custom: forkCustomMetadata(sourceMeta?.custom, opts.metadata),
        lastPrompt: turnSlice === undefined ? sourceMeta?.lastPrompt : turnSlice.lastPrompt,
        lastTurnReason: turnSlice === undefined ? sourceMeta?.lastTurnReason : turnSlice.lastTurnReason,
      };
      await this.docs.set(
        sessionScopeOf(this.handlerScope, targetId),
        'state.json',
        encodeSessionMeta(meta),
      );
      this.indexMirror.record(
        buildSessionSummary({
          id: targetId,
          workspaceId: this.workspaceId,
          cwd: hostCwd,
          environmentId: meta.environmentId,
          environmentCwd: meta.environmentCwd,
          title,
          lastPrompt: meta.lastPrompt,
          createdAt: now,
          updatedAt: meta.updatedAt,
          archived: false,
          custom: meta.custom,
          lastTurnReason: meta.lastTurnReason,
        }),
      );
      await this.appendSessionIndexEntry(
        targetId,
        this.sessionWorkDir(hostCwd, sessionEnvironment(meta.environmentId, meta.environmentCwd)),
      );
      this._onDidForkSession.fire({ sourceSessionId: sourceId, sessionId: targetId });
      return meta;
    } catch (error) {
      if (targetSessionDir !== undefined) {
        await this.hostFs.remove(targetSessionDir).catch(() => {});
      }
      throw error;
    } finally {
      for (const hold of quiescenceHolds) hold.dispose();
      sourceLease.release();
    }
  }

  async createChild(opts: CreateChildSessionOptions): Promise<SessionMeta> {
    const title =
      opts.title ??
      `Child: ${(await this.resolveSourceTitle(opts.sourceSessionId)) ?? opts.sourceSessionId}`;
    const metadata = {
      ...opts.metadata,
      [PARENT_SESSION_ID_KEY]: opts.sourceSessionId,
      [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND,
    };
    return this.fork({
      sourceSessionId: opts.sourceSessionId,
      newSessionId: opts.newSessionId,
      title,
      metadata,
    });
  }

  private async resolveSourceTitle(sourceId: string): Promise<string | undefined> {
    const live = this.sessions.get(sourceId);
    if (live !== undefined) {
      return (await live.accessor.get(ISessionMetadata).read()).title;
    }
    return (await this.index.get(sourceId))?.title;
  }

  private async copyAgentWire(args: {
    readonly sourceHandle: ISessionScopeHandle | undefined;
    readonly sourceSessionId: string;
    readonly agentId: string;
    readonly targetSessionId: string;
    readonly records?: readonly WireRecord[];
  }): Promise<void> {
    const records = [
      ...(args.records ??
        (await this.readSourceWireRecords(args.sourceHandle, args.sourceSessionId, args.agentId))),
    ];
    assertWireRecordsReaderVersion(records);
    if (records.length === 0) {
      records.push(createWireMetadataRecord());
    } else if (records[0]?.type !== 'metadata') {
      records.unshift(createWireMetadataRecord());
    }
    records.push(forkedRecord(args.agentId));

    await this.appendLogStore.rewrite(
      agentScopeOf(sessionScopeOf(this.handlerScope, args.targetSessionId), args.agentId),
      AGENT_WIRE_RECORD_KEY,
      records,
    );
  }

  private async appendForkedMarker(targetSessionId: string, agentId: string): Promise<void> {
    await this.appendRecordToColdAgentLog(targetSessionId, agentId, forkedRecord(agentId), {
      createIfEmpty: true,
      checkReaderVersion: true,
    });
  }

  private async readSourceWireRecords(
    sourceHandle: ISessionScopeHandle | undefined,
    sourceSessionId: string,
    agentId: string,
  ): Promise<WireRecord[]> {
    if (sourceHandle !== undefined) {
      const agentHandle = sourceHandle.accessor
        .get(IAgentLifecycleService)
        .handleOf(agentId);
      if (agentHandle !== undefined) {
        await agentHandle.accessor.get(IEventDispatcher).flush();
      }
    }
    const scope = agentScopeOf(sessionScopeOf(this.handlerScope, sourceSessionId), agentId);
    let truncation: AppendLogTruncation | undefined;
    const records = await collect(
      this.appendLogStore.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, {
        onTruncate: (info) => {
          truncation = info;
        },
      }),
    );
    assertWireRecordsReaderVersion(records);
    if (truncation !== undefined) {
      await repairWireJournal(
        {
          appendLog: this.appendLogStore,
          storage: this.storage,
          log: this.log,
          telemetry: this.telemetry,
        },
        scope,
        AGENT_WIRE_RECORD_KEY,
        records,
        truncation,
      );
    }
    return records;
  }

  private async pruneTruncatedForkFiles(
    targetSessionDir: string,
    agentIds: readonly string[],
    retainedAgentIds: readonly string[],
  ): Promise<void> {
    const retained = new Set(retainedAgentIds);
    const removals: Promise<void>[] = [];
    for (const agentId of agentIds) {
      if (retained.has(agentId)) continue;
      removals.push(this.hostFs.remove(join(targetSessionDir, 'agents', agentId)));
    }
    for (const agentId of retainedAgentIds) {
      const agentDir = join(targetSessionDir, 'agents', agentId);
      removals.push(this.hostFs.remove(join(agentDir, 'tasks')));
      removals.push(this.hostFs.remove(join(agentDir, 'cron')));
      removals.push(this.hostFs.remove(join(agentDir, FILE_HISTORY_BLOB_PREFIX)));
    }
    await Promise.all(removals);
  }

  private async copySessionFiles(
    sourceDir: string,
    targetDir: string,
    excludeWire: boolean,
  ): Promise<void> {
    let entries: readonly HostDirEntry[];
    try {
      entries = await this.hostFs.readdir(sourceDir);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    await this.copySessionDirEntries(sourceDir, targetDir, entries, '', excludeWire);
  }

  private async copySessionDirEntries(
    sourceDir: string,
    targetDir: string,
    entries: readonly HostDirEntry[],
    relBase: string,
    excludeWire: boolean,
  ): Promise<void> {
    const fileWrites: Promise<void>[] = [];
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      if (rel === 'state.json' || rel === 'logs' || rel === 'upcoming-goals.json' || rel === SESSION_PRESENCE_DIR) {
        continue;
      }
      if (excludeWire && entry.name === AGENT_WIRE_RECORD_KEY) continue;
      if (entry.isSymbolicLink === true) continue;
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory) {
        let children: readonly HostDirEntry[];
        try {
          children = await this.hostFs.readdir(sourcePath);
        } catch (error) {
          if (isMissingFileError(error)) continue;
          throw error;
        }
        await this.hostFs.mkdir(targetPath, { recursive: true });
        await this.copySessionDirEntries(sourcePath, targetPath, children, rel, excludeWire);
      } else if (entry.isFile) {
        fileWrites.push(
          (async () => {
            const data = await this.hostFs.readBytes(sourcePath);
            await this.hostFs.mkdir(targetDir, { recursive: true });
            await this.hostFs.writeBytes(targetPath, data);
          })(),
        );
      }
    }
    await Promise.all(fileWrites);
  }

  private async readMetaFromDisk(sessionId: string): Promise<SessionMeta | undefined> {
    return this.docs.get<SessionMeta>(sessionScopeOf(this.handlerScope, sessionId), 'state.json');
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function isMissingFileError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  const code = (unwrapped as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}

function createSessionId(): string {
  return `session_${randomUUID()}`;
}

function forkedRecord(agentId: string): WireRecord {
  return { type: 'forked', agentId, time: Date.now() };
}

function forkCustomMetadata(
  source: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...withoutGoal(source), ...withoutGoal(input) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function withoutGoal(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const { goal: _drop, ...rest } = value as { goal?: unknown; [key: string]: unknown };
  return rest;
}
