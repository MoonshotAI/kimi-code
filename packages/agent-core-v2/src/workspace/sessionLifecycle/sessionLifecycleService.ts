/**
 * `sessionLifecycle` domain — `ISessionLifecycleService` implementation.
 *
 * Owns the registry of THIS handler's open Session child scopes, creating
 * them through the DI scope tree (children of the handler's Workspace
 * scope) and seeding each with its identity, storage addressing derived
 * from the handler's persistence scope, and a per-session lifecycle-hooks
 * slots instance it runs around create/close,
 * tearing sessions down on close/archive — archiving flags the session's
 * metadata, removes its agents, restoring clears
 * the archived flag, and broadcasts the transition; deleting closes a live
 * session through the same flow, then removes the session directory
 * (metadata, agent wire records, plans, logs), evicts the index read-model
 * entry, and appends a `deleted` tombstone to the shared
 * `session_index.jsonl`, raising `session.not_found` for ids this handler
 * never persisted. Pending metadata writes and the index mirror are
 * drained before any teardown, so a listing right after close/archive/delete
 * never reads a stale outcome. Session start and
 * resume failures are reported through telemetry. Each Session scope
 * receives a telemetry view bound to its session id, while failures before
 * a scope is available use an ephemeral context view. Closing a session
 * never touches the handler itself.
 * Every Session scope is also seeded with the handler's shared workspace
 * resources as pure-data read views (the injection contracts) — discovery,
 * watching and connecting all live on the Workspace-scope services; session
 * consumers read the seeds and refresh off their change events. The five
 * workspace-projection seeds are provided by the seed-adapter units
 * installed with the scope (`installSessionSeedAdapters`), not by `extra`.
 * Materializes the session's initial metadata on
 * creation. Bound at Workspace scope.
 * Persisted sessions are discovered through the session-index read model.
 * On create / fork the
 * session is also appended to the shared `session_index.jsonl` so v1 clients
 * (TUI, export) can discover sessions created by the v2 engine; the entry is
 * indexed under the handler's workspace id — the same id seeding the
 * session's storage scope — so an alias spelling of the workDir cannot split
 * the session into a bucket v1 readers never look in. Fork flushes
 * live Agent wire journals, normalizes a missing protocol envelope, and
 * appends the fork boundary before restoring the target Agent; fork is
 * confined to this handler (source and target share the workspace bucket).
 * Fork restores the source's recency onto the target: the metadata write
 * carries an explicit `updatedAt` and runs after agent recreation as the
 * fork's final metadata write (agent registration is non-touching), ahead
 * of cron duplication, so a mid-fork failure never leaves cloned cron
 * records behind.
 * On
 * materialize, the agent-profile loaders' `ready` is awaited
 * before the handle is published — agent-file discovery is local-
 * fs and cheap, and a resumed session's first turn must see file-defined
 * agent types in the `Agent` tool description; only the `fatal` explicit
 * loader rejects, exactly the case that should
 * fail fast, and on that failure the half-materialized handle is disposed
 * instead of poisoning the session cache, and the explicit loader is re-armed
 * with a fire-and-forget `reload()` so a fixed agent file unblocks later
 * creates
 * (the workspace skill catalog, by contrast, is kicked fire-and-forget).
 * The handler's shared MCP manager is NOT awaited before create/resume
 * returns — it connects fire-and-forget at Workspace scope, and the seeded
 * handle's `ready` promise lets the agent's LLM steps wait on it instead
 * (see `AgentMcpService`). A session created with ephemeral `mcpServers`
 * gets them seeded verbatim (`ISessionEphemeralMcpServers`); connecting
 * them is the MCP domain's own concern — `workspaceMcp` subscribes to this
 * service's `onWillCreateSession`, reads the session's seeds through the
 * event's session-domain surface (`readSeed` / `contributeSeed` /
 * `onSessionDispose`), contributes its session overlay handle, and attaches
 * the overlay's shutdown to the session's teardown, so this service never
 * depends on MCP.
 * The session-level services whose subscriptions
 * must exist before the first agent / turn (external hooks, cron, the
 * subagent model-pool startup validation) opt into `OnScopeCreated` activation.
 * The subagent model pool itself is validated even earlier — at
 * the top of `materializeSession`, before the MCP overlay, the session scope,
 * and any persisted artifact come into existence, and again at the top of
 * `fork` before the source session's files are copied — so a broken pool
 * (or invalid `force` configuration) fails create/resume/fork without
 * leaving orphaned session dirs or leaked
 * overlay connections behind; the Session-scope validation service
 * (`session/subagent/subagentModelsValidationService.ts`) repeats the same
 * check at scope activation as a backstop for paths that bypass this service.
 * That pre-flight awaits the kosong model/provider registries' `ready`
 * alongside `config.ready` first: the catalog resolves aliases through those
 * registries rather than the config document, so a cold bootstrap that
 * creates a session before hydration completes must not fail a valid pool
 * with `CONFIG_INVALID`.
 * The pool is gated behind the `secondary-model` experiment, so with the
 * experiment off these validations are no-ops and the section stays inert.
 */

import { randomUUID } from 'node:crypto';

import { join } from 'pathe';
import { ulid } from 'ulid';

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import {
  createScopedChildHandle,
  type ISessionScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { Emitter, type Event } from '#/_base/event';
import { DEFAULT_PLAN_MODE_SECTION } from '#/features/plan/configSection';
import { IAgentPlanService } from '#/features/plan/plan';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
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
import { createHooks } from '#/hooks';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';
import { sessionEphemeralMcpServersSeed } from '#/session/mcp/ephemeralMcpServers';
import { sessionAgentProfileCatalogSeed } from '#/session/sessionAgentProfileCatalog/agentProfileCatalogSeed';
import { installSessionSeedAdapters } from '#/session/sessionSeed/sessionSeedAdapters';
import {
  ISessionLifecycleHooks,
  sessionLifecycleHooksSeed,
  type SessionLifecycleHookSlots,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { drainSessionMetadataWrites, toEpochMs } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { IWireService } from '#/wire/wire';
import {
  AGENT_WIRE_RECORD_KEY,
  createWireMetadataRecord,
  type WireRecord,
} from '#/wire/record';
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

import { agentScopeOf, sessionDirOf, sessionScopeOf } from './internal/addressing';
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

// NOTE: stays Disposable — its own 'get' and 'config' collide with the Fiber
export class SessionLifecycleService extends Disposable implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, ISessionScopeHandle>();
  private readonly _onWillCreateSession = this._register(
    new Emitter<SessionWillCreateEvent>(),
  );
  readonly onWillCreateSession: Event<SessionWillCreateEvent> =
    this._onWillCreateSession.event;
  private readonly _onDidCreateSession = this._register(new Emitter<SessionCreatedEvent>());
  readonly onDidCreateSession: Event<SessionCreatedEvent> = this._onDidCreateSession.event;
  private readonly _onDidCloseSession = this._register(new Emitter<SessionClosedEvent>());
  readonly onDidCloseSession: Event<SessionClosedEvent> = this._onDidCloseSession.event;
  private readonly _onDidArchiveSession = this._register(new Emitter<SessionArchivedEvent>());
  readonly onDidArchiveSession: Event<SessionArchivedEvent> = this._onDidArchiveSession.event;
  private readonly _onDidForkSession = this._register(new Emitter<SessionForkedEvent>());
  readonly onDidForkSession: Event<SessionForkedEvent> = this._onDidForkSession.event;
  private readonly resuming = new Map<string, Promise<ISessionScopeHandle | undefined>>();

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IWorkspaceContext private readonly workspaceContext: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionIndexMirror private readonly indexMirror: ISessionIndexMirror,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ICronTaskPersistence private readonly cronStore: ICronTaskPersistence,
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
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @IProviderService private readonly providers: IProviderService,
    @IFlagService private readonly flags: IFlagService,
  ) {
    super();
  }

  private get workspaceId(): string {
    return this.workspaceContext.workspaceId;
  }

  private get handlerScope(): string {
    return this.workspaceContext.persistenceScope;
  }

  async create(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    const sessionId = opts.sessionId ?? createSessionId();
    const handle = await this.materializeSession({ ...opts, sessionId });
    try {
      const main =
        opts.mainAgentBinding === undefined
          ? undefined
          : await handle.accessor.get(IAgentLifecycleService).create({
              agentId: MAIN_AGENT_ID,
              binding: opts.mainAgentBinding,
            });
      if (this.config.get<boolean>(DEFAULT_PLAN_MODE_SECTION) === true) {
        const planAgent = main ?? (await ensureMainAgent(handle));
        await planAgent.accessor.get(IAgentPlanService).enter();
      }
      await this.appendSessionIndexEntry(sessionId, opts.workDir);
    } catch (error) {
      const sessionDir = handle.accessor.get(ISessionContext).sessionDir;
      this.sessions.delete(sessionId);
      await this.drainAgents(handle).catch(() => {});
      handle.dispose();
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
    const hooks = createHooks<SessionLifecycleHookSlots, keyof SessionLifecycleHookSlots>([
      'onDidCreateSession',
      'onWillCloseSession',
    ]);
    await this.hostEnv.ready;
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Session,
      opts.sessionId,
      {
        seeds: [
          ...sessionContextSeed(ctx),
          ...sessionLifecycleHooksSeed(hooks),
          [ITelemetryService, this.telemetry.withContext({ sessionId: opts.sessionId })],
          ...sessionAgentProfileCatalogSeed({
            _serviceBrand: undefined,
            workspaceKey: workspaceId,
          }),
          [ISessionProcessRunner, this.processRunner],
          ...sessionEphemeralMcpServersSeed(opts.mcpServers ?? {}),
        ],
        configureContainer: (container) => {
          installSessionSeedAdapters(container);
          // The will-create moment is a business-lifecycle event; the DI
          // container behind the participation surface stays this service's
          // implementation detail.
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
      handle.dispose();
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
    await event.handle.accessor
      .get(ISessionLifecycleHooks)
      .onDidCreateSession.run({ source: event.source });
    this._onDidCreateSession.fire(event);
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
    const promise = this.doResume(sessionId, opts)
      .catch((error: unknown) => {
        this.telemetry
          .withContext({ sessionId })
          .track2('session_load_failed', {
            reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
          });
        throw error;
      })
      .finally(() => this.resuming.delete(sessionId));
    this.resuming.set(sessionId, promise);
    return promise;
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
    const agents = handle.accessor.get(IAgentLifecycleService);
    if (agents.get(MAIN_AGENT_ID) === undefined) {
      await agents.create({ agentId: MAIN_AGENT_ID });
    }
    await this.announceCreated({ sessionId, handle, source: 'resume' });
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
    await drainSessionMetadataWrites();
    await this.indexMirror.drain();
    handle.dispose();
    this._onDidCloseSession.fire({ sessionId });
  }

  async archive(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    const meta = handle.accessor.get(ISessionMetadata);
    await meta.setArchived(true);
    await this.drainAgents(handle);
    this.event.publish({
      type: 'event.session.archived',
      payload: { sessionId },
    });
    await this.announceWillClose({ sessionId, handle, reason: 'archive' });
    this.sessions.delete(sessionId);
    await drainSessionMetadataWrites();
    await this.indexMirror.drain();
    handle.dispose();
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
    await event.handle.accessor
      .get(ISessionLifecycleHooks)
      .onWillCloseSession.run({ reason: event.reason });
  }

  private async drainAgents(handle: ISessionScopeHandle): Promise<void> {
    const agentLifecycle = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agentLifecycle.list()) {
      await agentLifecycle.remove(agent.id);
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

    let targetId: string | undefined;
    let target: ISessionScopeHandle | undefined;
    let targetSessionDir: string | undefined;
    try {
      await this.assertSubagentModelPoolPreFlight();
      // A turn that just ended may still have its outcome write queued;
      // settle pending metadata writes before reading the source for
      // inheritance, or the fork could copy a stale (or absent) outcome.
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
      for (const agentId of agentIds) {
        await this.copyAgentWire({
          sourceHandle,
          sourceSessionId: sourceId,
          agentId,
          targetSessionId: targetCtx.sessionId,
        });
      }

      const title = opts.title ?? `Fork: ${sourceMeta?.title || sourceId}`;

      for (const agentId of agentIds) {
        const sourceAgent = sourceAgents[agentId]!;
        await target.accessor.get(IAgentLifecycleService).create({
          agentId,
          forkedFrom: sourceAgent.forkedFrom,
          labels: labelsFromAgentMeta(sourceAgent),
        });
      }

      await targetMeta.update({
        title,
        isCustomTitle: opts.title !== undefined ? true : sourceMeta?.isCustomTitle === true,
        forkedFrom: sourceId,
        archived: false,
        updatedAt: toEpochMs(sourceMeta?.updatedAt) || Date.now(),
        lastPrompt: sourceMeta?.lastPrompt,
        // The fork continues the source's conversation, so it inherits the
        // last turn's outcome too — otherwise a restart would drop a failure
        // the warm fork was still reporting.
        lastTurnReason: sourceMeta?.lastTurnReason,
        custom: forkCustomMetadata(sourceMeta?.custom, opts.metadata),
      });

      await this.duplicateCronTasks(sourceId, targetId);

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
          target.dispose();
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
  }): Promise<void> {
    if (args.sourceHandle !== undefined) {
      const agentHandle = args.sourceHandle.accessor
        .get(IAgentLifecycleService)
        .get(args.agentId);
      if (agentHandle !== undefined) {
        await agentHandle.accessor.get(IWireService).flush();
      }
    }

    const records = await collect(
      this.appendLogStore.read<WireRecord>(
        agentScopeOf(sessionScopeOf(this.handlerScope, args.sourceSessionId), args.agentId),
        AGENT_WIRE_RECORD_KEY,
      ),
    );
    if (records.length === 0) {
      records.push(createWireMetadataRecord());
    } else if (records[0]?.type !== 'metadata') {
      records.unshift(createWireMetadataRecord());
    }
    records.push(forkedRecord());

    await this.appendLogStore.rewrite(
      agentScopeOf(sessionScopeOf(this.handlerScope, args.targetSessionId), args.agentId),
      AGENT_WIRE_RECORD_KEY,
      records,
    );
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
      if (rel === 'state.json' || rel === 'logs' || entry.name === AGENT_WIRE_RECORD_KEY) {
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

  private async duplicateCronTasks(sourceId: string, targetId: string): Promise<void> {
    const tasks = await this.cronStore.list({ workspaceId: this.workspaceId });
    for (const task of tasks) {
      if (task.tags?.[CRON_SESSION_TAG] !== sourceId) continue;
      const clone: CronTask = {
        ...task,
        id: ulid(),
        tags: { ...task.tags, [CRON_SESSION_TAG]: targetId },
      };
      await this.cronStore.save(this.workspaceId, clone);
    }
  }

  private async readMetaFromDisk(sessionId: string): Promise<SessionMeta | undefined> {
    return this.docs.get<SessionMeta>(sessionScopeOf(this.handlerScope, sessionId), 'state.json');
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  ISessionLifecycleService,
  SessionLifecycleService,
  ScopeActivation.OnScopeCreated,
  'sessionLifecycle',
);

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

function forkedRecord(): WireRecord {
  return { type: 'forked', time: Date.now() };
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
