import { join } from 'pathe';

import { IInstantiationService } from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { ILogService } from '#/_base/log/log';
import { Error2, ErrorCodes } from '#/errors';
import { LifecycleScope } from '#/app/scopes';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ISessionEventBus } from '#/app/event/eventBus';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import { permissionModeConfiguredKey } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { hasPinnedPermissionMode } from '#/features/tower/tower';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkdir } from '#/session/workdir/workdir';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { withSubagentProfile } from '#/session/agentLifecycle/subagentMetadata';
import {
  agentContextOf,
  IAgentScopeContext,
  makeAgentScopeContext,
} from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnEnded } from '#/agent/loop/turnOps';
import {
  attachInteractionAgent,
  cancelInteractionsForTurn,
  detachInteractionAgent,
} from '#/agent/interaction/interactionWiring';
import { interactions } from '#/human/interaction/facade';
import {
  IAgentProfileService,
  type ProfileBindingSnapshot,
} from '#/agent/profile/profile';
import { abortError } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';

import { historyFromContextPreservingToolNotes } from '#/agent/loop/history';
import { closeTrailingOpenToolExchange } from '#/agent/contextMemory/openToolExchange';
import { IAgentEnvironmentBindingSeed, IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import '#/agent/environmentBinding/environmentBindingService';
import { EnvironmentSetBinding } from '#/agent/environmentBinding/environmentBindingOps';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { IWireService } from '#/wire/wire';
import { WireService } from '#/wire/wireService';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { AgentBlobServiceImpl } from '#/agent/blob/agentBlobServiceImpl';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ISessionLockService } from '#/persistence/interface/sessionLock';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { bindTelemetryScope } from '#/app/telemetry/telemetryService';
import type { AgentContext } from '#/agent/agentContext/agentContext';

import { ManagedAgent } from './managedAgent';
import {
  type AgentListFilter,
  type AgentScopeCreatedEvent,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
} from './agentLifecycle';

let nextAgentId = 0;

const REMOVE_PROMPT_QUIESCE_TIMEOUT_MS = 3_000;
const REMOVE_PROMPT_QUIESCE_POLL_MS = 10;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly roster = new Map<string, ManagedAgent>();
  private readonly creating = new Map<string, Promise<AgentContext>>();
  private nextLifecycleGeneration = 0;
  private readonly onDidCreateEmitter = this._register(new Emitter<AgentContext>());
  private readonly onDidCreateScopeEmitter = this._register(new Emitter<AgentScopeCreatedEvent>());
  private readonly onWillCloseEmitter = this._register(new Emitter<AgentContext>());
  private readonly onDidCloseEmitter = this._register(new Emitter<AgentContext>());

  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidCreateScope() {
    return this.onDidCreateScopeEmitter.event;
  }
  get onWillClose() {
    return this.onWillCloseEmitter.event;
  }
  get onDidClose() {
    return this.onDidCloseEmitter.event;
  }

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionWorkdir private readonly workdir: ISessionWorkdir,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionEventBus bus: ISessionEventBus,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @ISessionLockService private readonly sessionLocks: ISessionLockService,
    @IBlobStore private readonly blobStore: IBlobStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly logger: ILogService,
  ) {
    super();
    this._register(
      bus.subscribe(TurnEnded, (event) => {
        cancelInteractionsForTurn(event.agentId, this.ctx.sessionId, event.turnId);
      }),
    );
    this._register(
      this.onDidClose((context) => {
        detachInteractionAgent(context.agentId, this.ctx.sessionId);
      }),
    );
    this._register({
      dispose: () => {
        interactions.purgeSession(this.ctx.sessionId);
      },
    });
  }

  async create(opts: CreateAgentOptions = {}): Promise<AgentContext> {
    if (opts.agentId !== undefined) {
      const inflight = this.creating.get(opts.agentId);
      if (inflight !== undefined) return inflight;
      const existing = this.roster.get(opts.agentId);
      if (existing !== undefined && !existing.closing) return existing.context;
    }
    const agentId = opts.agentId ?? (await this.nextAvailableAgentId());
    const promise = this.doCreate(agentId, opts);
    this.creating.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(agentId);
    }
  }

  private async nextAvailableAgentId(): Promise<string> {
    let maxSuffix = -1;
    const consider = (id: string): void => {
      const match = /^agent-(\d+)$/.exec(id);
      if (match !== null) maxSuffix = Math.max(maxSuffix, Number(match[1]));
    };
    for (const id of this.roster.keys()) consider(id);
    const persisted = (await this.sessionMetadata.read()).agents ?? {};
    for (const id of Object.keys(persisted)) consider(id);
    const candidate = Math.max(maxSuffix + 1, nextAgentId);
    nextAgentId = candidate + 1;
    return `agent-${String(candidate)}`;
  }

  private async doCreate(agentId: string, opts: CreateAgentOptions): Promise<AgentContext> {
    if (this.roster.has(agentId)) {
      throw new Error2(ErrorCodes.AGENT_ALREADY_EXISTS, `Agent "${agentId}" already exists`, {
        details: { agentId },
      });
    }
    const agent = await this.buildAgentScope(agentId, opts);
    if (!this.roster.has(agentId)) {
      throw abortError(`Agent "${agentId}" linking was cancelled`);
    }
    return agent;
  }

  private async buildAgentScope(
    agentId: string,
    opts: CreateAgentOptions,
  ): Promise<AgentContext> {
    const agentScope = this.ctx.scope(`agents/${agentId}`);
    const agentHomedir = join(this.bootstrap.homeDir, agentScope);
    const generation = ++this.nextLifecycleGeneration;
    const meta: AgentMeta = {
      homedir: agentHomedir,
      type: agentId === 'main' ? 'main' : 'sub',
      parentAgentId: agentId === 'main' ? undefined : 'main',
      forkedFrom: opts.forkedFrom,
      labels: withSubagentProfile(
        opts.labels,
        agentId === 'main' ? undefined : opts.binding?.profile,
      ),
    };
    const scopeContext = makeAgentScopeContext({
      agentId,
      agentScope,
      forkedFrom: opts.forkedFrom,
      meta,
      generation,
    });
    const agent = scopeContext.agentContext;
    const eventBus = this.instantiation.invokeFunction((accessor) =>
      accessor.get(ISessionEventBus) as ISessionEventBus | undefined,
    );
    eventBus?.activateAgent(agent);
    let managed: ManagedAgent | undefined;
    let didCreate = false;
    let finalizerArmed = false;
    let stage = 'scope';
    let containerRef: InstantiationService | undefined;
    let createdHandle: IAgentScopeHandle | undefined;
    let wireView: WireService | undefined;
    const telemetryBinding = bindTelemetryScope(this.telemetry, {
      agent_id: agentId,
      mode: 'agent',
    });
    try {
      const blobView = new AgentBlobServiceImpl(this.blobStore, scopeContext);
      const wire = new WireService(
        scopeContext,
        this.appendLogStore,
        blobView,
        this.storage,
        this.logger,
        telemetryBinding.telemetry,
        this.sessionLocks,
        this.ctx,
      );
      wireView = wire;
      stage = 'seal';
      await wire.seal();
      stage = 'scope';
      const handle = createScopedChildHandle(
        this.instantiation,
        LifecycleScope.Agent,
        agentId,
        {
          seeds: [
            [IAgentScopeContext, scopeContext],
            [ITelemetryService, telemetryBinding.telemetry],
            [IAgentEnvironmentBindingSeed, {
              _serviceBrand: undefined,
              binding: opts.environmentId === undefined
                ? { environmentId: this.workdir.environmentId, cwd: this.workdir.cwd }
                : { environmentId: opts.environmentId, cwd: opts.environmentCwd },
            }],
            [IAgentBlobService, blobView],
            [IWireService, wire],
          ],
          configureContainer: (container) => {
            container.anchorKernelEntry(
              () => telemetryBinding.dispose(),
              'telemetry:agent-context',
            );
            container.anchorKernelEntry(() => {
              wire.dispose();
            }, 'wire-view-dispose');
            container.anchorKernelFinalizer(() => {
              eventBus?.deactivateAgent(agent);
            }, 'agent-event-bus-deactivate');
            finalizerArmed = true;
            containerRef = container;
          },
        },
      ) as IAgentScopeHandle;
      createdHandle = handle;
      const container = containerRef!;
      const loop = handle.accessor.get(IAgentLoopService);
      const scopeHandle: IAgentScopeHandle = {
        id: agentId,
        kind: LifecycleScope.Agent,
        accessor: {
          get: (id) => container.invokeFunction((accessor) => accessor.get(id)),
        },
        dispose: () => loop.close().then(() => container.disposeAsync()),
      };
      this.rosterAdopt(scopeHandle);
      managed = this.roster.get(agentId);
      stage = 'register';
      await this.sessionMetadata.registerAgent(agentId, meta);
      this.onDidCreateEmitter.fire(agent);
      didCreate = true;
      this.onDidCreateScopeEmitter.fire({ context: agent, handle, meta });
      stage = 'binding';
      if (opts.environmentId !== undefined && opts.environmentId !== LOCAL_ENVIRONMENT_ID) {
        await handle.accessor.get(IEventDispatcher).dispatch(
          new EnvironmentSetBinding({
            agentId,
            environmentId: opts.environmentId,
            cwd: opts.environmentCwd,
          }),
        );
      }
      stage = 'restore';
      await wire.withRestoreSnapshot(async () => {
        handle.accessor.get(IAgentPermissionRulesService);
        await handle.accessor.get(IEventDispatcher).restore();
        attachInteractionAgent(agentId, this.ctx.sessionId, handle.accessor.get(IEventDispatcher));
        stage = 'bootstrap';
        const initialProfile = await this.bindBootstrap(handle, opts);
        if (initialProfile !== undefined) await loop.setProfile(initialProfile);
        stage = 'toolActivation';
        await handle.accessor.get(IAgentToolActivationService).activate();
        stage = 'start';
        await loop.start(opts.initialTools);
      });
      return agent;
    } catch (error) {
      this.telemetry.track2('agent_create_failed', {
        agent_id: agentId,
        stage,
        error_type: error instanceof Error ? error.name : 'Unknown',
      });
      if (managed !== undefined) {
        managed.closing = true;
        if (this.roster.get(agentId) === managed) this.roster.delete(agentId);
        managed.killSpace();
        try {
          await managed.handle.dispose();
        } catch { }
      } else {
        if (createdHandle !== undefined) {
          try {
            await createdHandle.dispose();
          } catch { }
        }
        wireView?.dispose();
        telemetryBinding.dispose();
      }
      if (!finalizerArmed) eventBus?.deactivateAgent(agent);
      if (didCreate) this.onDidCloseEmitter.fire(agent);
      throw error;
    }
  }

  private async bindBootstrap(
    handle: IAgentScopeHandle,
    opts: CreateAgentOptions,
  ): Promise<ProfileBindingSnapshot | undefined> {
    const profile = handle.accessor.get(IAgentProfileService);
    let initialProfile: ProfileBindingSnapshot | undefined;
    if (opts.binding !== undefined) {
      initialProfile = await profile.bind(opts.binding);
    } else if (opts.initialProfile !== undefined) {
      initialProfile = profile.applyBindingSnapshot(opts.initialProfile);
    }
    const permissionMode = this.config.get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
    const hasRestoredPermissionMode = handle.accessor
      .get(IAgentStateService)
      .get(permissionModeConfiguredKey);
    if (permissionMode !== undefined && !hasRestoredPermissionMode) {
      handle.accessor.get(IAgentPermissionModeService).setMode(permissionMode);
    }
    return initialProfile;
  }

  async fork(sourceContext: AgentContext, opts?: ForkAgentOptions): Promise<AgentContext> {
    const sourceManaged = this.managedFor(sourceContext);
    if (sourceManaged === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `Source agent "${sourceContext.agentId}" does not exist`,
        { details: { agentId: sourceContext.agentId } },
      );
    }
    if (opts?.agentId !== undefined && this.get(opts.agentId) !== undefined) {
      throw new Error2(ErrorCodes.AGENT_ALREADY_EXISTS, `Agent "${opts.agentId}" already exists`, {
        details: { agentId: opts.agentId },
      });
    }
    const source = sourceManaged.handle;
    const sourceLoop = source.accessor.get(IAgentLoopService);
    const sourceData = sourceLoop.data();
    const override = opts?.binding;
    const sourceBinding = source.accessor.get(IAgentEnvironmentBindingService).current;
    const childContext = await this.create({
      agentId: opts?.agentId,
      binding: override?.profile === undefined ? undefined : {
        profile: override.profile,
        model: override.model ?? sourceData.modelAlias,
        thinking: override.thinking ?? sourceData.thinkingLevel,
      },
      initialProfile: override?.profile === undefined ? sourceData : undefined,
      initialTools: override?.profile === undefined ? sourceLoop.baselineTools() : undefined,
      environmentId: sourceBinding.environmentId,
      environmentCwd: sourceBinding.cwd,
      forkedFrom: source.id,
      labels: withSubagentProfile(opts?.labels, override?.profile ?? sourceData.profileName),
    });
    const child = this.requireManaged(childContext).handle;

    const childLoop = child.accessor.get(IAgentLoopService);
    if (override !== undefined && override.profile === undefined) {
      if (override.model !== undefined) await childLoop.setModel(override.model);
      if (override.thinking !== undefined) childLoop.setThinking(override.thinking);
    }

    const sourceMessages = sourceLoop.history();
    if (sourceMessages.length > 0) {
      await child.accessor
        .get(IAgentLoopService)
        .initializeHistory(historyFromContextPreservingToolNotes(closeTrailingOpenToolExchange(sourceMessages)));
    }
    return childContext;
  }

  get(agentId: string): AgentContext | undefined {
    const managed = this.roster.get(agentId);
    if (managed === undefined || managed.closing || !managed.active) return undefined;
    return managed.context;
  }

  list(filter?: AgentListFilter): readonly AgentContext[] {
    const all = [...this.roster.values()]
      .filter((managed) => managed.active && !managed.closing)
      .map((managed) => managed.context);
    const prefix = filter?.prefix;
    if (prefix === undefined) return all;
    return all.filter((context) => context.agentId.startsWith(prefix));
  }

  broadcastPermissionMode(mode: PermissionMode): void {
    for (const managed of this.roster.values()) {
      if (managed.closing || !managed.active) continue;
      const handle = managed.handle;
      if (hasPinnedPermissionMode(handle.accessor.get(IAgentLoopService).data().profileName)) {
        continue;
      }
      handle.accessor.get(IAgentPermissionModeService).setMode(mode);
    }
  }

  handleOf(agentId: string): IAgentScopeHandle | undefined {
    const managed = this.roster.get(agentId);
    if (managed === undefined || managed.closing || !managed.active) return undefined;
    return managed.handle;
  }

  adopt(handle: IAgentScopeHandle): AgentContext {
    const agent = agentContextOf(handle);
    const agentId = agent.agentId;
    const existing = this.roster.get(agentId);
    if (existing !== undefined) {
      if (!existing.closing && existing.context === agent) return existing.context;
      if (!existing.closing) {
        throw new Error(`Agent "${agentId}" is already managed by a different context`);
      }
    }
    this.adoptAgentScope(agent, handle);
    return agent;
  }

  private adoptAgentScope(
    agent: AgentContext,
    handle: IAgentScopeHandle,
  ): void {
    try {
      const scopeHandle: IAgentScopeHandle = {
        ...handle,
        dispose: () => handle.accessor.get(IAgentLoopService).close().then(() => handle.dispose()),
      };
      this.rosterAdopt(scopeHandle);
      this.onDidCreateEmitter.fire(agent);
      this.onDidCreateScopeEmitter.fire({ context: agent, handle: scopeHandle });
      attachInteractionAgent(agent.agentId, this.ctx.sessionId, handle.accessor.get(IEventDispatcher));
    } catch (error) {
      const managed = this.roster.get(agent.agentId);
      if (managed !== undefined && managed.context === agent) {
        managed.closing = true;
        this.roster.delete(agent.agentId);
        managed.killSpace();
      }
      throw error;
    }
  }

  private rosterAdopt(handle: IAgentScopeHandle): AgentContext {
    const agent = agentContextOf(handle);
    const existing = this.roster.get(agent.agentId);
    if (existing !== undefined) {
      if (!existing.closing && existing.context === agent) return existing.context;
      if (!existing.closing) {
        throw new Error(`Agent "${agent.agentId}" is already managed by a different context`);
      }
    }
    const managed = new ManagedAgent(agent, handle);
    managed.active = true;
    this.roster.set(agent.agentId, managed);
    return agent;
  }

  async remove(agent: AgentContext): Promise<void> {
    const managed = this.roster.get(agent.agentId);
    if (managed === undefined || managed.context !== agent || managed.closing) return;
    managed.closing = true;
    await this.removeManaged(agent, managed);
  }

  private async removeManaged(agent: AgentContext, managed: ManagedAgent): Promise<void> {
    this.onWillCloseEmitter.fire(agent);
    const handle = managed.handle;
    const loop = handle.accessor.get(IAgentLoopService);
    const compaction = handle.accessor.get(IAgentFullCompactionService).compacting;
    const compactionSettled = compaction?.promise.catch(() => undefined) ?? Promise.resolve();
    const reason = abortError('Agent removed');
    if (compaction !== null && !compaction.abortController.signal.aborted) {
      compaction.abortController.abort(reason);
    }
    const promptIdleDeadline = Date.now() + REMOVE_PROMPT_QUIESCE_TIMEOUT_MS;
    let releaseQuiescence: (() => void) | undefined;
    for (;;) {
      for (const queueId of loop.snapshot().queue.map((item) => item.attributes?.promptId)) {
        if (queueId !== undefined) loop.cancel({ promptId: queueId }, reason);
      }
      loop.cancel(undefined, reason);
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let settled: boolean;
      try {
        settled = await Promise.race([
          Promise.all([loop.settled(), compactionSettled]).then(() => true),
          new Promise<false>((resolve) => {
            deadlineTimer = setTimeout(() => {
              resolve(false);
            }, promptIdleDeadline - Date.now());
          }),
        ]);
      } finally {
        clearTimeout(deadlineTimer);
      }
      if (!settled) break;
      let idle = true;
      try {
        const snapshot = loop.snapshot();
        idle = snapshot.state === 'idle' && snapshot.queue.length === 0;
      } catch {
        idle = true;
      }
      if (idle) {
        try {
          const guard = loop.tryAcquireQuiescence();
          if (guard !== undefined) {
            releaseQuiescence = () => guard.dispose();
            break;
          }
        } catch {
          break;
        }
      }
      if (Date.now() >= promptIdleDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, REMOVE_PROMPT_QUIESCE_POLL_MS));
    }
    let stopError: Error | undefined;
    try {
      await loop.close();
    } catch (error) {
      stopError = error instanceof Error ? error : new Error(String(error));
    }
    try {
      await handle.accessor.get(IEventDispatcher).flush().catch(onUnexpectedError);
      managed.killSpace();
      try {
        await managed.handle.dispose();
      } catch (error) {
        stopError ??= error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      releaseQuiescence?.();
    }
    if (this.roster.get(agent.agentId) === managed) this.roster.delete(agent.agentId);
    this.onDidCloseEmitter.fire(agent);
    if (stopError !== undefined) throw stopError;
  }

  private managedFor(agent: AgentContext): ManagedAgent | undefined {
    const managed = this.roster.get(agent.agentId);
    if (managed === undefined || managed.context !== agent || managed.closing) return undefined;
    return managed;
  }

  private requireManaged(agent: AgentContext): ManagedAgent {
    const managed = this.managedFor(agent);
    if (managed === undefined) {
      throw new Error(
        `Agent ${agent.agentId}:${String(agent.generation)} is not a lifecycle-issued context`,
      );
    }
    return managed;
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentLifecycleService,
  AgentLifecycleService,
  ScopeActivation.OnScopeCreated,
  'agentLifecycle',
);
