/**
 * `agentLifecycle` domain (L6) — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes in a flat registry,
 * serializing same-id bootstrap and dropping incomplete handles after startup
 * failure. Seeds each agent's identity through `agent` scopeContext, wires
 * per-agent wire records and the wire state machine, the blob store, and MCP,
 * and registers the agent in the session registry. Binds the agent id into the
 * Agent-scoped telemetry view. New logs receive a metadata
 * envelope while non-empty unversioned logs are rejected. Removal awaits the
 * agent task manager's graceful exit policy before draining turns and full
 * compaction, then disposing the child scope. Fans session-level
 * permission-mode switches out to every live agent. Bound at Session scope.
 *
 * No agent id is special here: the main agent is simply the agent created
 * with the conventional `MAIN_AGENT_ID`, and `fork` requires its source to
 * exist. Caller-facing orchestration (record mirroring, hooks, telemetry,
 * prompt prefixes) lives with the callers — driving turns on an agent is the
 * `subagent` domain (`ISessionSubagentService`); the session's shared MCP
 * subsystem is the `sessionMcp` domain (`ISessionMcpService`), which this
 * service awaits during creation.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import { PermissionModeConfiguredModel } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentToolDedupeService } from '#/agent/toolDedupe/toolDedupe';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentProfileService } from '#/agent/profile/profile';
import { abortError } from '#/_base/utils/abort';
import { IAgentLoopContinuationService } from '#/agent/loop/loopContinuation';
import { IAgentStepRetryService } from '#/agent/stepRetry/stepRetry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentBuiltinToolsRegistrar } from '#/agent/toolRegistry/builtinToolsRegistrar';
import { IAgentMediaToolsRegistrar } from '#/agent/media/mediaTools';
import { IImageConfigBridge } from '#/agent/media/imageConfigBridge';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { IAgentExternalHooksService } from '#/agent/externalHooks/externalHooks';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IWireService } from '#/wire/wire';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  type AgentListFilter,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
} from './agentLifecycle';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IAgentScopeHandle>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private readonly interactionBusDisposables = new Map<string, IDisposable>();
  /** In-flight creation promises, keyed by agent id. Concurrent creations of
   *  the same id join the in-flight one (never a duplicate scope), so a caller
   *  always receives a fully-bootstrapped handle. */
  private readonly creating = new Map<string, Promise<IAgentScopeHandle>>();

  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidDispose() {
    return this.onDidDisposeEmitter.event;
  }

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ISessionMcpService private readonly sessionMcp: ISessionMcpService,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this._register(this.onDidCreate((handle) => this.subscribeInteractionBus(handle)));
    this._register(
      this.onDidDispose((agentId) => {
        const d = this.interactionBusDisposables.get(agentId);
        if (d !== undefined) {
          d.dispose();
          this.interactionBusDisposables.delete(agentId);
        }
      }),
    );
    this._register({
      dispose: () => {
        for (const d of this.interactionBusDisposables.values()) d.dispose();
        this.interactionBusDisposables.clear();
      },
    });
  }

  private subscribeInteractionBus(handle: IAgentScopeHandle): void {
    if (this.interactionBusDisposables.has(handle.id)) return;
    const d = handle.accessor
      .get(IEventBus)
      .subscribe('turn.ended', (e) => this.interaction.cancelPendingForTurn(e.turnId));
    this.interactionBusDisposables.set(handle.id, d);
  }

  async create(opts: CreateAgentOptions = {}): Promise<IAgentScopeHandle> {
    // Create-or-get for explicit ids: join a concurrent in-flight creation or
    // return the existing agent, so callers never see a duplicate scope or a
    // not-yet-ready handle. Auto-minted ids always create fresh.
    if (opts.agentId !== undefined) {
      const inflight = this.creating.get(opts.agentId);
      if (inflight !== undefined) return inflight;
      const existing = this.handles.get(opts.agentId);
      if (existing !== undefined) return existing;
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
    for (const id of this.handles.keys()) consider(id);
    const persisted = (await this.sessionMetadata.read()).agents ?? {};
    for (const id of Object.keys(persisted)) consider(id);
    const candidate = Math.max(maxSuffix + 1, nextAgentId);
    nextAgentId = candidate + 1;
    return `agent-${String(candidate)}`;
  }

  private async doCreate(agentId: string, opts: CreateAgentOptions): Promise<IAgentScopeHandle> {
    const mcpReady = this.sessionMcp.ensureMcpReady();
    const agentHomedir = this.bootstrap.agentHomedir(
      this.ctx.workspaceId,
      this.ctx.sessionId,
      agentId,
    );
    const agentScope = this.bootstrap.agentScope(
      this.ctx.workspaceId,
      this.ctx.sessionId,
      agentId,
    );
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Agent,
      agentId,
      // Seed identity facts and the telemetry view. Every other agent-scope
      // service either derives its configuration from `IAgentScopeContext`
      // (wire, blob) or resolves it through the scope tree (the
      // session's shared MCP manager via `ISessionMcpService`).
      {
        extra: [
          [IAgentScopeContext, makeAgentScopeContext({ agentId, agentScope })],
          [ITelemetryService, this.telemetry.withContext({ agent_id: agentId })],
        ],
      },
    ) as IAgentScopeHandle;
    this.handles.set(agentId, handle);
    try {
      const wire = handle.accessor.get(IWireService);
      await wire.seal();
      await this.sessionMetadata.registerAgent(agentId, {
        homedir: agentHomedir,
        type: agentId === 'main' ? 'main' : 'sub',
        parentAgentId: agentId === 'main' ? undefined : 'main',
        forkedFrom: opts.forkedFrom,
        labels: opts.labels,
      });
      this.onDidCreateEmitter.fire(handle);
      this.igniteEagerServices(handle);
      await mcpReady;
      await wire.restore();
      await this.bindBootstrap(handle, opts);
      return handle;
    } catch (error) {
      // Startup failed: drop the half-built agent so the next `create` starts
      // fresh instead of returning a handle that can never admit turns.
      if (this.handles.get(agentId) === handle) this.handles.delete(agentId);
      try {
        handle.dispose();
      } catch { }
      this.onDidDisposeEmitter.fire(agentId);
      throw error;
    }
  }

  // Force-instantiate the agent-scope observer/registrar services before the
  // first turn: each exists only for its constructor side effects (registering
  // built-in tools, subscribing hooks), so nothing injects them directly.
  // `InstantiationType.Eager` does NOT auto-instantiate in this DI — it only
  // skips the lazy proxy at resolve time — so they must be resolved here or
  // their registrations (built-in tools, loop error handlers, MCP tools) would
  // never happen.
  private igniteEagerServices(handle: IAgentScopeHandle): void {
    handle.accessor.get(IAgentBuiltinToolsRegistrar);
    handle.accessor.get(IAgentMediaToolsRegistrar);
    handle.accessor.get(IImageConfigBridge);
    handle.accessor.get(IAgentToolDedupeService);
    handle.accessor.get(IAgentExternalHooksService);
    handle.accessor.get(IAgentMcpService);
    // Agent plugin service: registers main-agent-only plugin session-start
    // guidance before the first turn (self-gates to a no-op for other agents).
    handle.accessor.get(IAgentPluginService);
    // Tool-select services: precompute tool selection and the announcements
    // derived from it before the first turn.
    handle.accessor.get(IAgentToolSelectService);
    handle.accessor.get(IAgentToolSelectAnnouncementsService);
    handle.accessor.get(IAgentStepRetryService);
    handle.accessor.get(IAgentLoopContinuationService);
    handle.accessor.get(IAgentContextMemoryService);
    handle.accessor.get(IAgentContextInjectorService);
    handle.accessor.get(IAgentGoalService);
    handle.accessor.get(IAgentPlanService);
    handle.accessor.get(IAgentTaskService);
    handle.accessor.get(IAgentUserToolService);
    handle.accessor.get(IAgentFullCompactionService);
    // The activity view publishes `agent.activity.updated` from its constructor
    // subscriptions; without an explicit resolve nothing injects it and the
    // wire would never see the projection.
    handle.accessor.get(IAgentActivityView);
  }

  private async bindBootstrap(
    handle: IAgentScopeHandle,
    opts: CreateAgentOptions,
  ): Promise<void> {
    if (opts.binding !== undefined) {
      await handle.accessor.get(IAgentProfileService).bind(opts.binding);
    }
    // Apply the configured default only when restore found no persisted mode.
    // A resumed Agent's journal owns its permission posture; callers that need
    // an explicit override (for example subagent inheritance) do so after
    // creation through the permission service.
    const wire = handle.accessor.get(IWireService);
    const permissionMode = this.config.get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
    const hasRestoredPermissionMode = wire.getModel(PermissionModeConfiguredModel);
    if (permissionMode !== undefined && !hasRestoredPermissionMode) {
      handle.accessor.get(IAgentPermissionModeService).setMode(permissionMode);
    }
  }

  async fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle> {
    const source = this.handles.get(sourceAgentId);
    if (source === undefined) throw new Error(`Source agent "${sourceAgentId}" does not exist`);
    if (opts?.agentId !== undefined && this.handles.has(opts.agentId)) {
      throw new Error(`Agent "${opts.agentId}" already exists`);
    }
    const child = await this.create({ agentId: opts?.agentId, forkedFrom: source.id });

    const sourceData = source.accessor.get(IAgentProfileService).data();
    const childProfile = child.accessor.get(IAgentProfileService);
    const override = opts?.binding;
    if (override?.profile !== undefined) {
      await childProfile.bind({
        profile: override.profile,
        model: override.model ?? sourceData.modelAlias,
        thinking: override?.thinking ?? sourceData.thinkingLevel,
        cwd: override?.cwd ?? sourceData.cwd,
      });
    } else {
      childProfile.applyBindingSnapshot(sourceData);
      if (override?.model !== undefined) await childProfile.setModel(override.model);
      if (override?.thinking !== undefined) childProfile.setThinking(override.thinking);
      if (override?.cwd !== undefined) childProfile.update({ cwd: override.cwd });
    }

    const sourceMessages = source.accessor.get(IAgentContextMemoryService)?.get();
    if (sourceMessages !== undefined && sourceMessages.length > 0) {
      child.accessor.get(IAgentContextMemoryService)?.append(...sourceMessages);
    }
    return child;
  }

  get(agentId: string): IAgentScopeHandle | undefined {
    return this.handles.get(agentId);
  }

  list(filter?: AgentListFilter): readonly IAgentScopeHandle[] {
    const all = [...this.handles.values()];
    const prefix = filter?.prefix;
    if (prefix === undefined) return all;
    return all.filter((handle) => handle.id.startsWith(prefix));
  }

  broadcastPermissionMode(mode: PermissionMode): void {
    for (const handle of this.handles.values()) {
      handle.accessor.get(IAgentPermissionModeService).setMode(mode);
    }
  }

  async remove(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return;
    this.handles.delete(agentId);
    await handle.accessor.get(IAgentTaskService).stopAllOnExit('Session closed');
    const loop = handle.accessor.get(IAgentLoopService);
    const compaction = handle.accessor.get(IAgentFullCompactionService).compacting;
    const compactionSettled = compaction?.promise.catch(() => undefined) ?? Promise.resolve();
    const reason = abortError('Agent removed');
    for (const turnId of loop.status().pendingTurnIds) {
      loop.cancel(turnId, reason);
    }
    loop.cancel(undefined, reason);
    if (compaction !== null && !compaction.abortController.signal.aborted) {
      compaction.abortController.abort(reason);
    }
    await Promise.all([loop.settled(), compactionSettled]);
    handle.dispose();
    this.onDidDisposeEmitter.fire(agentId);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentLifecycleService,
  AgentLifecycleService,
  InstantiationType.Eager,
  'agentLifecycle',
);
