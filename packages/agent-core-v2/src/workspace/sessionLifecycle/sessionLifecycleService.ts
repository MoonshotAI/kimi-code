import { randomUUID } from 'node:crypto';

import { join } from 'pathe';

import type { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import {
  createScopedChildHandle,
  type ISessionScopeHandle,
} from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { AsyncEmitter, Emitter, type Event, type IWaitUntil } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { drainLogCloses } from '#/_base/log/logService';
import { DEFAULT_PLAN_MODE_SECTION } from '#/features/plan/configSection';
import { IAgentPlanService } from '#/features/plan/plan';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ISessionIndex,
  ISessionIndexMirror,
  PARENT_SESSION_ID_KEY,
} from '#/app/sessionIndex/sessionIndex';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import {
  type AppendLogTruncation,
  IAppendLogStore,
} from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';
import { sessionEphemeralMcpServersSeed } from '#/session/mcp/ephemeralMcpServers';
import { sessionAgentProfileCatalogSeed } from '#/session/sessionAgentProfileCatalog/agentProfileCatalogSeed';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalogData } from '#/features/skill/session/skillCatalogData';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { drainSessionMetadataWrites, toEpochMs } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  AGENT_WIRE_RECORD_KEY,
  createWireMetadataRecord,
  type WireRecord,
} from '#/wire/record';
import { repairWireJournal } from '#/wire/repair';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IProviderService } from '#/kosong/provider/provider';
import { IFlagService } from '#/app/flag/flag';
import { assertValidSubagentModelConfig } from '#/session/subagent/configSection';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import {
  IExplicitAgentProfileLoader,
} from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import {
  IExtraAgentProfileLoader,
} from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import {
  IWorkspaceAgentProfileLoader,
} from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { PLUGIN_SKILL_SOURCE_ID } from '#/features/skill/catalog/skillSource';

import { agentScopeOf, sessionDirOf, sessionScopeOf } from './internal/addressing';
import { SessionArchived } from './sessionLifecycleEvents';
import {
  assertForkTurnIndex,
  sliceMainRecordsAtTurn,
  sliceSubagentRecordsAtTime,
} from './internal/forkTurnSlice';
import {
  type CreateChildSessionOptions,
  type CreateSessionOptions,
  type ForkSessionOptions,
  type ResumeSessionOptions,
  type SessionArchivedEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionForkedEvent,
  type SessionWillCloseEvent,
  type SessionWillCreateEvent,
  ISessionLifecycleService,
} from './sessionLifecycle';

type MaterializeSessionOptions = Omit<CreateSessionOptions, 'sessionId'> & {
  readonly sessionId: string;
};

const NO_ABORT = new AbortController().signal;

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
    @IWorkspaceContext private readonly workspaceContext: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionIndexMirror private readonly indexMirror: ISessionIndexMirror,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly log: ILogService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IEventService private readonly event: IEventService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IWorkspaceAgentProfileLoader
    private readonly workspaceAgentProfileLoader: IWorkspaceAgentProfileLoader,
    @IExtraAgentProfileLoader
    private readonly extraAgentProfileLoader: IExtraAgentProfileLoader,
    @IExplicitAgentProfileLoader
    private readonly explicitAgentProfileLoader: IExplicitAgentProfileLoader,
    @IUserAgentProfileLoader
    private readonly userAgentProfileLoader: IUserAgentProfileLoader,
    @IPluginAgentProfileLoader
    private readonly pluginAgentProfileLoader: IPluginAgentProfileLoader,
    @IWorkspaceDirs private readonly workspaceDirs: IWorkspaceDirs,
    @IWorkspaceSkillCatalog private readonly workspaceSkillCatalog: IWorkspaceSkillCatalog,
    @IWorkspaceInstructionsService private readonly workspaceInstructions: IWorkspaceInstructionsService,
    @IWorkspaceMcpService private readonly workspaceMcp: IWorkspaceMcpService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @IProviderService private readonly providers: IProviderService,
    @IFlagService private readonly flags: IFlagService,
    onDispose?: () => void,
  ) {
    super();
    if (onDispose !== undefined) this._register({ dispose: onDispose });
  }

  private get workspaceId(): string {
    return this.workspaceContext.workspaceId;
  }

  private get handlerScope(): string {
    return this.workspaceContext.persistenceScope;
  }

  async create(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    const sessionId = opts.sessionId ?? createSessionId();
    await this.workspaceSkillCatalog
      .reloadSources(SESSION_CREATE_RELOAD_SKILL_SOURCES)
      .catch(() => undefined);
    const handle = await this.materializeSession({ ...opts, sessionId });
    try {
      const agents = handle.accessor.get(IAgentLifecycleService);
      const main =
        opts.mainAgentBinding === undefined
          ? undefined
          : await agents.create({
              agentId: MAIN_AGENT_ID,
              binding: opts.mainAgentBinding,
            });
      if (this.config.get<boolean>(DEFAULT_PLAN_MODE_SECTION) === true) {
        const planAgent = main ?? (await ensureMainAgent(handle));
        const planHandle = agents.handleOf(planAgent.agentId);
        if (planHandle === undefined) {
          throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
        }
        await planHandle.accessor.get(IAgentPlanService).enter();
      }
      await this.appendSessionIndexEntry(sessionId, opts.workDir);
    } catch (error) {
      const sessionDir = handle.accessor.get(ISessionContext).sessionDir;
      this.sessions.delete(sessionId);
      await this.drainAgents(handle).catch(() => {});
      void handle.dispose();
      await this.hostFs.remove(sessionDir).catch(() => {});
      throw error;
    }
    await this.announceCreated({ sessionId, handle, source: 'startup' });
    return handle;
  }

  private async assertSubagentModelPoolPreFlight(): Promise<void> {
    await Promise.all([this.config.ready, this.models.ready, this.providers.ready]);
    assertValidSubagentModelConfig(this.config, this.flags, this.modelCatalog);
  }

  private async materializeSession(opts: MaterializeSessionOptions): Promise<ISessionScopeHandle> {
    const workspaceId = this.workspaceId;
    const sessionScope = sessionScopeOf(this.handlerScope, opts.sessionId);
    const sessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, opts.sessionId);
    const metaScope = sessionScope;
    await this.assertSubagentModelPoolPreFlight();
    await this.workspaceDirs.ready;
    await this.workspaceDirs.mergeAdditionalDirs(opts.workDir, opts.additionalDirs ?? []);
    const ctx: ISessionContext = {
      _serviceBrand: undefined,
      sessionId: opts.sessionId,
      workspaceId,
      sessionDir,
      metaScope,
      cwd: opts.workDir,
      scope: (subKey?: string): string =>
        subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
    };
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Session,
      opts.sessionId,
      {
        seeds: [
          ...sessionContextSeed(ctx),
          [ITelemetryService, this.telemetry.withContext({ sessionId: opts.sessionId })],
          ...sessionAgentProfileCatalogSeed({
            _serviceBrand: undefined,
            workspaceKey: workspaceId,
          }),
          [ISessionSkillCatalogData, this.workspaceSkillCatalog.sessionData()],
          [ISessionInstructionsProvider, this.workspaceInstructions.sessionProvider()],
          [ISessionMcpHandle, this.workspaceMcp.sessionHandle()],
          [ISessionWorkspaceInfo, this.workspaceDirs.sessionInfo()],
          ...sessionEphemeralMcpServersSeed(opts.mcpServers ?? {}),
        ],
        configureContainer: (container) => {
          this._onWillCreateSession.fire({
            sessionId: opts.sessionId,
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
    try {
      await handle.accessor.get(ISessionMetadata).ready;
      await handle.accessor.get(ISessionToolPolicy).ready;
      await Promise.all([
        this.workspaceAgentProfileLoader.ready,
        this.extraAgentProfileLoader.ready,
        this.explicitAgentProfileLoader.ready,
        this.userAgentProfileLoader.ready,
        this.pluginAgentProfileLoader.ready,
      ]);
    } catch (error) {
      void handle.dispose();
      void this.explicitAgentProfileLoader.reload().catch(() => undefined);
      throw error;
    }
    this.sessions.set(opts.sessionId, handle);
    return handle;
  }

  private async appendSessionIndexEntry(sessionId: string, workDir: string): Promise<void> {
    const sessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sessionId);
    this.appendLogStore.append('', 'session_index.jsonl', {
      sessionId,
      sessionDir,
      workDir,
    });
    await this.appendLogStore.flush();
  }

  private async announceCreated(event: SessionCreatedEvent): Promise<void> {
    await this._onDidCreateSession.fireAsync(event, NO_ABORT);
    event.handle.accessor
      .get(ITelemetryService)
      .track2('session_started', { resumed: event.source === 'resume' });
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    if (this.resuming.has(sessionId)) return undefined;
    return this.sessions.get(sessionId);
  }

  resume(sessionId: string, opts?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    this.resumeFailures.delete(sessionId);
    const promise = this.doResume(sessionId, opts)
      .catch((error: unknown) => {
        this.telemetry
          .withContext({ sessionId })
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
    opts?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;

    const summary = await this.index.get(sessionId);
    if (summary === undefined || summary.workspaceId !== this.workspaceId) return undefined;
    const workDir = summary.cwd ?? this.workspaceContext.cwd;

    const handle = await this.materializeSession({
      sessionId,
      workDir,
      additionalDirs: opts?.additionalDirs,
      mcpServers: opts?.mcpServers,
    });
    try {
      const agents = handle.accessor.get(IAgentLifecycleService);
      if (agents.get(MAIN_AGENT_ID) === undefined) {
        await agents.create({ agentId: MAIN_AGENT_ID });
      }
      await this.announceCreated({ sessionId, handle, source: 'resume' });
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

  async close(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    this.sessions.delete(sessionId);
    await this.drainAgents(handle);
    await this.appendLogStore.drainRetirements();
    await drainSessionMetadataWrites();
    await this.indexMirror.drain();
    void handle.dispose();
    await drainLogCloses();
    this._onDidCloseSession.fire({ sessionId });
  }

  async archive(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    const meta = handle.accessor.get(ISessionMetadata);
    await meta.setArchived(true);
    await this.drainAgents(handle);
    await this.appendLogStore.drainRetirements();
    this.event.publish(
      new SessionArchived({
        payload: { sessionId, workspaceId: this.workspaceContext.workspaceId },
      }),
    );
    await this.announceWillClose({ sessionId, handle, reason: 'archive' });
    this.sessions.delete(sessionId);
    await drainSessionMetadataWrites();
    await this.indexMirror.drain();
    void handle.dispose();
    await drainLogCloses();
    this._onDidArchiveSession.fire({ sessionId });
  }

  async restore(
    sessionId: string,
    opts?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const handle = await this.resume(sessionId, opts);
    if (handle === undefined) return undefined;
    await handle.accessor.get(ISessionMetadata).setArchived(false);
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
    if (handle !== undefined) {
      await this.close(sessionId);
    }
    await this.hostFs.remove(sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sessionId));
    await this.index.remove(sessionId);
    this.appendLogStore.append('', 'session_index.jsonl', { sessionId, deleted: true });
    await this.appendLogStore.flush();
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

  async fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle> {
    const sourceId = opts.sourceSessionId;

    const sourceHandle = this.sessions.get(sourceId);
    const indexSummary = await this.index.get(sourceId);
    if (
      (sourceHandle === undefined && indexSummary === undefined) ||
      (indexSummary !== undefined && indexSummary.workspaceId !== this.workspaceId)
    ) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceId} does not exist`);
    }
    if (sourceHandle !== undefined) {
      const sourceAgents = sourceHandle.accessor.get(IAgentLifecycleService);
      for (const agent of sourceAgents.list()) {
        const agentHandle = sourceAgents.handleOf(agent.agentId);
        if (agentHandle === undefined) continue;
        if (agentHandle.accessor.get(IAgentActivityView).state().turn !== undefined) {
          throw new Error2(
            ErrorCodes.SESSION_FORK_ACTIVE_TURN,
            `Session "${sourceId}" cannot be forked while a turn is running`,
            { details: { sessionId: sourceId } },
          );
        }
      }
    }
    assertForkTurnIndex(opts.turnIndex);

    let targetId: string | undefined;
    let target: ISessionScopeHandle | undefined;
    let targetSessionDir: string | undefined;
    try {
      await this.assertSubagentModelPoolPreFlight();
      await drainSessionMetadataWrites();
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

      const turnSlice =
        opts.turnIndex === undefined
          ? undefined
          : sliceMainRecordsAtTurn(
              await this.readSourceWireRecords(sourceHandle, sourceId, MAIN_AGENT_ID),
              sourceId,
              opts.turnIndex,
            );

      targetSessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, targetId);
      await this.copySessionFiles(
        sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sourceId),
        targetSessionDir,
      );

      target = await this.materializeSession({
        sessionId: targetId,
        workDir: this.workspaceContext.cwd,
      });
      const targetCtx = target.accessor.get(ISessionContext);
      const targetMeta = target.accessor.get(ISessionMetadata);

      const sourceAgents = sourceMeta?.agents ?? {};
      const agentIds = Object.keys(sourceAgents);
      const retainedAgentIds: string[] = [];
      for (const agentId of agentIds) {
        let slicedRecords: readonly WireRecord[] | undefined;
        if (turnSlice !== undefined) {
          if (agentId === MAIN_AGENT_ID) {
            slicedRecords = turnSlice.records;
          } else {
            const subagentRecords = sliceSubagentRecordsAtTime(
              await this.readSourceWireRecords(sourceHandle, sourceId, agentId),
              turnSlice.cutoffTime,
            );
            if (subagentRecords.length === 0) continue;
            slicedRecords = subagentRecords;
          }
        }
        await this.copyAgentWire({
          sourceHandle,
          sourceSessionId: sourceId,
          agentId,
          targetSessionId: targetCtx.sessionId,
          records: slicedRecords,
        });
        retainedAgentIds.push(agentId);
      }

      if (turnSlice !== undefined) {
        await this.pruneTruncatedForkFiles(targetSessionDir, agentIds, retainedAgentIds);
      }

      const title = opts.title ?? `Fork: ${sourceMeta?.title || sourceId}`;

      for (const agentId of retainedAgentIds) {
        const sourceAgent = sourceAgents[agentId]!;
        await target.accessor.get(IAgentLifecycleService).create({
          agentId,
          forkedFrom: sourceAgent.forkedFrom,
          labels: labelsFromAgentMeta(sourceAgent),
        });
      }

      await targetMeta.update({
        title,
        titleKind: opts.title !== undefined ? 'custom' : 'replaceable',
        forkedFrom: sourceId,
        archived: false,
        updatedAt: toEpochMs(sourceMeta?.updatedAt) || Date.now(),
        lastPrompt: turnSlice === undefined ? sourceMeta?.lastPrompt : turnSlice.lastPrompt,
        lastTurnReason: sourceMeta?.lastTurnReason,
        custom: forkCustomMetadata(sourceMeta?.custom, opts.metadata),
      });

      await this.appendSessionIndexEntry(targetId, this.workspaceContext.cwd);
      this._onDidForkSession.fire({
        sourceSessionId: sourceId,
        sessionId: targetId,
        handle: target,
      });
      await this.announceCreated({ sessionId: targetId, handle: target, source: 'fork' });
      return target;
    } catch (error) {
      if (targetId !== undefined) {
        this.sessions.delete(targetId);
      }
      if (target !== undefined) {
        try {
          void target.dispose();
        } catch {
        }
      }
      if (targetSessionDir !== undefined) {
        await this.hostFs.remove(targetSessionDir).catch(() => {});
      }
      throw error;
    }
  }

  async createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle> {
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
    }
    await Promise.all(removals);
  }

  private async copySessionFiles(sourceDir: string, targetDir: string): Promise<void> {
    let entries: readonly HostDirEntry[];
    try {
      entries = await this.hostFs.readdir(sourceDir);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    await this.copySessionDirEntries(sourceDir, targetDir, entries, '');
  }

  private async copySessionDirEntries(
    sourceDir: string,
    targetDir: string,
    entries: readonly HostDirEntry[],
    relBase: string,
  ): Promise<void> {
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      if (rel === 'state.json' || rel === 'logs' || rel === 'upcoming-goals.json' || entry.name === AGENT_WIRE_RECORD_KEY) {
        continue;
      }
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
        await this.copySessionDirEntries(sourcePath, targetPath, children, rel);
      } else if (entry.isFile) {
        const data = await this.hostFs.readBytes(sourcePath);
        await this.hostFs.mkdir(targetDir, { recursive: true });
        await this.hostFs.writeBytes(targetPath, data);
      }
    }
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
