/**
 * `agentLifecycle` domain (L6) — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes in a flat registry,
 * serializing same-id bootstrap and dropping incomplete handles after startup
 * failure. Seeds each agent's identity through `agent` scopeContext, wires
 * per-agent wire records and the wire state machine, the blob store, and MCP,
 * and registers the agent in the session registry. New logs receive a metadata
 * envelope while non-empty unversioned logs are rejected. Removal awaits the
 * agent task manager's graceful exit policy before draining activity and
 * disposing the child scope. Bound at Session scope.
 *
 * No agent id is special here: the main agent is created by its bootstrappers
 * as `create({ agentId: 'main' })` (see `mainAgent.ts`), and `fork` requires
 * its source to exist. Caller-facing orchestration (record mirroring, hooks,
 * telemetry, prompt prefixes) lives with the callers — see this domain's
 * wrapper helpers (`tools/agent.ts`, `mirrorAgentRun`).
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { sessionMediaOriginalsDir } from '#/agent/media/image-originals';
import { SyncDescriptor } from '#/_base/di/descriptors';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  LifecycleScope,
  registerScopedService,
  type ScopeSeed,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { ErrorCodes, Error2, makeErrorPayload } from '#/errors';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { AgentMcpService } from '#/agent/mcp/mcpService';
import { McpConnectionManager } from '#/agent/mcp/connection-manager';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import { McpOAuthService } from '#/agent/mcp/oauth/service';
import { createMcpOAuthStore } from '#/agent/mcp/oauth/store';
import { mergeCallerMcpServers, resolveSessionMcpConfig } from '#/agent/mcp/session-config';
import { IPluginService } from '#/app/plugin/plugin';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentActivityService, ISessionActivityKernel } from '#/activity/activity';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopContinuationService } from '#/agent/loop/loopContinuation';
import { IAgentStepRetryService } from '#/agent/stepRetry/stepRetry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentBuiltinToolsRegistrar } from '#/agent/toolRegistry/builtinToolsRegistrar';
import { IAgentMediaToolsRegistrar } from '#/agent/media/mediaTools';
import { IImageConfigBridge } from '#/agent/media/imageConfigBridge';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  IAgentWireRecordService,
  type PersistedWireRecord,
} from '#/agent/wireRecord/wireRecord';
import {
  AgentWireRecordService,
  missingWireMetadataError,
  WIRE_RECORD_FILENAME,
} from '#/agent/wireRecord/wireRecordService';
import { wireMetadata } from '#/agent/wireRecord/metadataOps';
import { IAgentWireService } from '#/wire/tokens';
import type { PayloadOf } from '#/wire/types';
import { WireService } from '#/wire/wireServiceImpl';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { AgentBlobServiceImpl } from '#/agent/blob/agentBlobServiceImpl';
import { IAgentExternalHooksService } from '#/agent/externalHooks/externalHooks';
import { IAgentToolDedupeService } from '#/agent/toolDedupe/toolDedupe';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionInteractionService } from '#/session/interaction/interaction';

import { createHooks } from '#/hooks';
import {
  type AgentListFilter,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
  type RunAgentOptions,
} from './agentLifecycle';
import { runAgentTurn } from './runAgentTurn';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);
  private readonly handles = new Map<string, IAgentScopeHandle>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidCreateMainEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private readonly onDidStopAgentTaskEmitter = this._register(
    new Emitter<AgentTaskStopHookContext>(),
  );
  private mcpManager: McpConnectionManager | undefined;
  private mcpInitialLoad: Promise<void> | undefined;
  private readonly interactionBusDisposables = new Map<string, IDisposable>();
  private readonly creating = new Map<string, Promise<IAgentScopeHandle>>();
  private readonly mainCreatedHandles = new WeakSet<IAgentScopeHandle>();

  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidCreateMain() {
    return this.onDidCreateMainEmitter.event;
  }
  get onDidDispose() {
    return this.onDidDisposeEmitter.event;
  }
  get onDidStopAgentTask() {
    return this.onDidStopAgentTaskEmitter.event;
  }

  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void {
    this.onDidStopAgentTaskEmitter.fire(context);
  }

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IPluginService private readonly plugins: IPluginService,
    @ILogService private readonly log: ILogService,
    @IAgentProfileCatalogService private readonly catalog: IAgentProfileCatalogService,
    @IAtomicDocumentStore private readonly atomicDocs: IAtomicDocumentStore,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionActivityKernel private readonly activityKernel: ISessionActivityKernel,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @IAppendLogStore private readonly appendLog?: IAppendLogStore,
  ) {
    super();
    // Bridge the per-agent `IEventBus` `turn.ended` into the Session-scope
    // interaction kernel: the bus is Agent-scoped and cannot be injected into
    // `SessionInteractionService` directly. Every agent (main + sub/forked) is
    // created through `create()`, which fires `onDidCreate`, so subscribing here
    // covers all of them; `onDidDispose` releases the per-agent subscription.
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
    const agentId = opts.agentId ?? `agent-${nextAgentId++}`;
    const creating = this.creating.get(agentId);
    if (creating !== undefined) return creating;
    this.assertCanCreate();
    const mcpManager = this.getMcpManager();
    const mcpReady = this.ensureMcpReady();
    // Per-agent homedir → the wire-record persistence key (`hashKey(homedir)`).
    // Bootstrap computes it under the session dir, mirroring v1's
    // `<sessionDir>/agents/<id>`; business code never assembles the path itself.
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
      { extra: this.buildAgentScopeExtras({ agentId, agentHomedir, agentScope, mcpManager }) },
    ) as IAgentScopeHandle;
    this.handles.set(agentId, handle);
    const created = this.bootstrapAgent(handle, agentId, opts, {
      agentHomedir,
      agentScope,
      mcpReady,
    });
    this.creating.set(agentId, created);
    try {
      return await created;
    } finally {
      if (this.creating.get(agentId) === created) this.creating.delete(agentId);
    }
  }

  async whenReady(agentId: string): Promise<IAgentScopeHandle | undefined> {
    const creating = this.creating.get(agentId);
    if (creating === undefined) return this.handles.get(agentId);
    try {
      return await creating;
    } catch {
      return undefined;
    }
  }

  private async bootstrapAgent(
    handle: IAgentScopeHandle,
    agentId: string,
    opts: CreateAgentOptions,
    bootstrap: {
      readonly agentHomedir: string;
      readonly agentScope: string;
      readonly mcpReady: Promise<void>;
    },
  ): Promise<IAgentScopeHandle> {
    try {
      // Record the agent in the session registry so a closed-session fork can
      // enumerate every agent and relocate its wire log.
      await this.sessionMetadata.registerAgent(agentId, {
        homedir: bootstrap.agentHomedir,
        type: agentId === 'main' ? 'main' : 'sub',
        parentAgentId: agentId === 'main' ? undefined : 'main',
        forkedFrom: opts.forkedFrom,
        labels: opts.labels,
      });
      this.onDidCreateEmitter.fire(handle);
      this.igniteEagerServices(handle);
      await bootstrap.mcpReady;
      await this.ensureWireMetadata(handle, bootstrap.agentScope);
      await this.bindBootstrap(handle, opts);
      // Bootstrap (eager tool / hook / MCP setup, wire metadata, profile binding)
      // is complete: drive the activity kernel `initializing → idle` so the agent
      // can admit turns. Until this point `begin` rejects with `activity.initializing`.
      handle.accessor.get(IAgentActivityService).markReady();
      return handle;
    } catch (error) {
      if (this.handles.get(agentId) === handle) this.handles.delete(agentId);
      try {
        handle.dispose();
      } catch {}
      this.onDidDisposeEmitter.fire(agentId);
      throw error;
    }
  }

  private assertCanCreate(): void {
    if (!this.activityKernel.canAccept('agent.create')) {
      throw new Error2(
        ErrorCodes.ACTIVITY_SESSION_REJECTED,
        `Session is ${this.activityKernel.lane()}; agent creation rejected`,
        { details: { lane: this.activityKernel.lane() } },
      );
    }
  }

  private buildAgentScopeExtras(input: {
    readonly agentId: string;
    readonly agentHomedir: string;
    readonly agentScope: string;
    readonly mcpManager: McpConnectionManager;
  }): ScopeSeed {
    const { agentId, agentScope, mcpManager } = input;
    return [
      [IAgentScopeContext, makeAgentScopeContext({ agentId, agentScope })],
      [IAgentWireRecordService, new SyncDescriptor(AgentWireRecordService)],
      [
        IAgentWireService,
        new SyncDescriptor(WireService, [
          {
            logScope: agentScope,
            logKey: WIRE_RECORD_FILENAME,
          },
        ]),
      ],
      [IAgentBlobService, new SyncDescriptor(AgentBlobServiceImpl)],
      [
        IAgentMcpService,
        new SyncDescriptor(AgentMcpService, [
          {
            manager: mcpManager,
            originalsDir: sessionMediaOriginalsDir(this.ctx.sessionDir),
          },
        ]),
      ],
    ];
  }

  // Force-instantiate the agent-scope eager registrars before the first turn,
  // in dependency order: each consumes scope contributions or observes domain
  // hooks and must exist before `bindBootstrap` publishes the first status.
  private igniteEagerServices(handle: IAgentScopeHandle): void {
    // Builtin-tools registrar: consumes every module-level `registerTool(...)`
    // contribution and registers each built-in tool (with `@IX` deps resolved
    // against this scope) into the per-agent `IAgentToolRegistryService`. Must
    // happen before the first turn — otherwise the LLM sees an empty tool list.
    // Separate from the registry itself to avoid a construction cycle where
    // tool ctors transitively depend on the registry.
    handle.accessor.get(IAgentBuiltinToolsRegistrar);
    // Media-tools registrar: media tools cannot use the contribution table
    // (capabilities are unknown until a model binds), so this service
    // re-registers ReadMediaFile on every `agent.status.updated`.
    handle.accessor.get(IAgentMediaToolsRegistrar);
    // Image-config bridge: pushes the env-resolved `[image]` section into the
    // compression support module's resolver seam before the first turn, so
    // ReadMediaFile / MCP / prompt ingestion honor `[image] max_edge_px` and
    // `read_byte_budget` (and their env overrides) through the implicit default.
    handle.accessor.get(IImageConfigBridge);
    // Tool-call dedupe plugin: self-wiring — its constructor registers the
    // loop step hooks and the executor's onBefore/onDidExecuteTool handlers,
    // and no other service injects it. Must be ignited BEFORE the external
    // hooks service below: that get transitively constructs the permission
    // gate, and `toolDedupe` has to sit ahead of `permission` on
    // `onBeforeExecuteTool` so same-step duplicates are suppressed before
    // authorization runs (v1 ran dedup in prepare, before authorize).
    handle.accessor.get(IAgentToolDedupeService);
    // External hook adapter: registers listeners on the agent's domain hooks
    // before the first turn. No business service injects it directly; it
    // observes their hooks instead.
    handle.accessor.get(IAgentExternalHooksService);
    // Agent MCP service: attaches the (shared) manager's tools and registers
    // the `wait-for-initial-load` hook before the first turn — otherwise
    // plugin/session MCP servers would connect but their tools would never
    // register until something explicitly requests the service.
    handle.accessor.get(IAgentMcpService);
    // Tool-select services: precompute tool selection and the announcements
    // derived from it before the first turn.
    handle.accessor.get(IAgentToolSelectService);
    handle.accessor.get(IAgentToolSelectAnnouncementsService);
    // Step-retry plugin: registers the loop error handler that retries
    // retryable provider failures. Nothing injects it directly — it observes
    // the loop — so it must be ignited before the first turn.
    handle.accessor.get(IAgentStepRetryService);
    // Loop-continuation aspect: enqueues the next step whenever a step ran
    // tools. It only observes the loop's onDidFinishStep hook, so without ignition
    // every tool-using turn would stop after a single step.
    handle.accessor.get(IAgentLoopContinuationService);
  }

  private async bindBootstrap(
    handle: IAgentScopeHandle,
    opts: CreateAgentOptions,
  ): Promise<void> {
    if (opts.binding !== undefined) {
      await handle.accessor.get(IAgentProfileService).bind(opts.binding);
    }
    if (opts.permissionMode !== undefined) {
      handle.accessor.get(IAgentPermissionModeService).setMode(opts.permissionMode);
    }
  }

  private async ensureWireMetadata(
    handle: IAgentScopeHandle,
    agentScope: string,
  ): Promise<void> {
    const appendLog = this.appendLog;
    if (appendLog === undefined) return;
    let firstRecord: PersistedWireRecord | undefined;
    for await (const record of appendLog.read<PersistedWireRecord>(
      agentScope,
      WIRE_RECORD_FILENAME,
    )) {
      firstRecord = record;
      break;
    }
    if (firstRecord === undefined) {
      handle.accessor.get(IAgentWireService).dispatch(wireMetadata(freshMetadataPayload()));
      return;
    }
    if (firstRecord.type === 'metadata') return;
    throw missingWireMetadataError();
  }

  ensureMcpReady(callerServers?: Readonly<Record<string, McpServerConfig>>): Promise<void> {
    if (this.mcpInitialLoad !== undefined) return this.mcpInitialLoad;
    const manager = this.getMcpManager();
    const initialLoad = this.connectMcpServers(manager, callerServers).catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
      const message = error instanceof Error ? error.message : String(error);
      this.handles.get('main')?.accessor.get(IEventBus)?.publish({
        type: 'error',
        ...makeErrorPayload(ErrorCodes.MCP_STARTUP_FAILED, message),
      });
    });
    this.mcpInitialLoad = initialLoad;
    return initialLoad;
  }

  notifyMainCreated(handle: IAgentScopeHandle): void {
    if (this.mainCreatedHandles.has(handle)) return;
    this.mainCreatedHandles.add(handle);
    this.onDidCreateMainEmitter.fire(handle);
  }

  async fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle> {
    const source = this.handles.get(sourceAgentId);
    if (source === undefined) throw new Error(`Source agent "${sourceAgentId}" does not exist`);
    const child = await this.create({ agentId: opts?.agentId, forkedFrom: source.id });

    const sourceData = source.accessor.get(IAgentProfileService).data();
    const childProfile = child.accessor.get(IAgentProfileService);
    const override = opts?.binding;
    const model = override?.model ?? sourceData.modelAlias;
    if (model !== undefined) {
      await childProfile.bind({
        profile: override?.profile ?? sourceData.profileName ?? 'agent',
        model,
        thinking: override?.thinking ?? sourceData.thinkingLevel,
        cwd: override?.cwd ?? sourceData.cwd,
      });
    } else {
      childProfile.update({
        profileName: override?.profile ?? sourceData.profileName,
        thinkingLevel: override?.thinking ?? sourceData.thinkingLevel,
        systemPrompt: sourceData.systemPrompt,
        activeToolNames: sourceData.activeToolNames,
      });
    }

    const sourceMessages = source.accessor.get(IAgentContextMemoryService)?.get();
    if (sourceMessages !== undefined && sourceMessages.length > 0) {
      child.accessor.get(IAgentContextMemoryService)?.append(...sourceMessages);
    }
    return child;
  }

  run(agentId: string, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) throw new Error(`Agent "${agentId}" does not exist`);
    return runAgentTurn(handle, request, {
      summaryPolicy: opts.summaryPolicy ?? this.summaryPolicyFor(handle),
      signal: opts.signal,
      onReady: opts.onReady,
    });
  }

  private summaryPolicyFor(handle: IAgentScopeHandle): AgentProfileSummaryPolicy | undefined {
    const profileName = handle.accessor.get(IAgentProfileService).data().profileName;
    if (profileName === undefined) return undefined;
    return this.catalog.get(profileName)?.summaryPolicy;
  }

  /**
   * One shared `McpConnectionManager` per session (built lazily, cached). All
   * agents in the session share it, matching v1's session-scoped MCP and
   * avoiding a reconnect storm per agent. The initial connect is driven
   * through `ensureMcpReady`, so session creation and first agent creation can
   * await config resolution before tool execution starts.
   */
  private getMcpManager(): McpConnectionManager {
    if (this.mcpManager !== undefined) return this.mcpManager;
    const oauthService = new McpOAuthService({
      store: createMcpOAuthStore(this.atomicDocs),
    });
    const manager = new McpConnectionManager({
      log: this.log,
      oauthService,
      stdioCwd: this.workspace.workDir,
    });
    this.mcpManager = manager;
    this._register({ dispose: () => void manager.shutdown() });
    return manager;
  }

  private async connectMcpServers(
    manager: McpConnectionManager,
    callerServers?: Readonly<Record<string, McpServerConfig>>,
  ): Promise<void> {
    const [base, pluginServers] = await Promise.all([
      resolveSessionMcpConfig({ cwd: this.workspace.workDir, homeDir: this.bootstrap.homeDir }),
      this.plugins.enabledMcpServers(),
    ]);
    // Precedence mirrors v1's `mergeCallerMcpServers` + `mergePluginMcpConfig`
    // (`rpc/core-impl.ts`): file config < caller-supplied < plugin.
    const withCaller = mergeCallerMcpServers(base, callerServers);
    const servers = { ...withCaller?.servers, ...pluginServers };
    if (Object.keys(servers).length === 0) return;
    await manager.connectAll(servers);
    this.trackMcpInitialLoad(manager);
  }

  private trackMcpInitialLoad(manager: McpConnectionManager): void {
    const entries = manager.list().filter((entry) => entry.status !== 'disabled');
    const totalCount = entries.length;
    if (totalCount === 0) return;

    const connectedCount = entries.filter((entry) => entry.status === 'connected').length;
    if (connectedCount > 0) {
      this.telemetry.track2('mcp_connected', {
        server_count: connectedCount,
        total_count: totalCount,
      });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.telemetry.track2('mcp_failed', {
        failed_count: failedCount,
        total_count: totalCount,
      });
    }
  }

  getHandle(agentId: string): IAgentScopeHandle | undefined {
    return this.handles.get(agentId);
  }

  list(filter?: AgentListFilter): readonly IAgentScopeHandle[] {
    const all = [...this.handles.values()];
    const prefix = filter?.prefix;
    if (prefix === undefined) return all;
    return all.filter((handle) => handle.id.startsWith(prefix));
  }

  async remove(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return;
    this.handles.delete(agentId);
    await handle.accessor.get(IAgentTaskService).stopAllOnExit('Session closed');
    // Drive the agent activity kernel through disposal: reject new begins and
    // abort any in-flight turn / background activity, then wait for it to drain
    // (including the tool-execution grace window) before releasing the scope.
    // This guarantees no async work keeps running on a disposed agent.
    const activity = handle.accessor.get(IAgentActivityService);
    activity.beginDisposal();
    await activity.settled();
    handle.dispose();
    this.onDidDisposeEmitter.fire(agentId);
  }
}

function freshMetadataPayload(): PayloadOf<typeof wireMetadata> {
  return {
    protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    created_at: Date.now(),
  };
}

registerScopedService(LifecycleScope.Session, IAgentLifecycleService, AgentLifecycleService, InstantiationType.Delayed, 'agentLifecycle');
