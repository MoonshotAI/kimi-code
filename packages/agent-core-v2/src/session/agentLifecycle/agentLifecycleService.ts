/**
 * `agentLifecycle` domain (L6) — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes in a flat registry.
 * Seeds each agent's identity through `agent` scopeContext, wires per-agent
 * wire records and the wire state machine, the blob store, and MCP, and
 * registers the agent in the session registry. Bound at Session scope.
 *
 * No agent id is special here: the main agent is created by its bootstrappers
 * as `create({ agentId: 'main' })` (see `mainAgent.ts`), and `fork` requires
 * its source to exist. Caller-facing orchestration (record mirroring, hooks,
 * telemetry, prompt prefixes) lives with the callers — see this domain's
 * wrapper helpers (`tools/agent.ts`, `mirrorAgentRun`).
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { sessionMediaOriginalsDir } from '#/_base/tools/support/image-originals';
import { SyncDescriptor } from '#/_base/di/descriptors';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { ErrorCodes, makeErrorPayload } from '#/errors';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { AgentMcpService } from '#/agent/mcp/mcpService';
import { McpConnectionManager } from '#/agent/mcp/connection-manager';
import { McpOAuthService } from '#/agent/mcp/oauth/service';
import { createMcpOAuthStore } from '#/agent/mcp/oauth/store';
import { resolveSessionMcpConfig } from '#/agent/mcp/session-config';
import { IPluginService } from '#/app/plugin/plugin';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentBuiltinToolsRegistrar } from '#/agent/toolRegistry/builtinToolsRegistrar';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  IAgentWireRecordService,
  type PersistedWireRecord,
} from '#/agent/wireRecord/wireRecord';
import {
  AgentWireRecordService,
  WIRE_RECORD_FILENAME,
} from '#/agent/wireRecord/wireRecordService';
import { serializeV1WireRecord } from '#/agent/wireRecord/v1WireSerializer';
import { type WireMetadataPayload, wireMetadata } from '#/agent/wireRecord/metadataOps';
import { IAgentWireService } from '#/wire/tokens';
import { WireService } from '#/wire/wireServiceImpl';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { AgentBlobServiceImpl } from '#/agent/blob/agentBlobServiceImpl';
import { IAgentExternalHooksService } from '#/agent/externalHooks/externalHooks';

import { createHooks } from '#/hooks';
import {
  type AgentListFilter,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskHooks,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
  type RunAgentOptions,
} from './agentLifecycle';
import { runAgentTurn } from './runAgentTurn';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>([
    'onWillStartAgentTask',
    'onDidStopAgentTask',
  ]);
  private readonly handles = new Map<string, IAgentScopeHandle>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidCreateMainEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private mcpManager: McpConnectionManager | undefined;
  private mcpInitialLoad: Promise<void> | undefined;

  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidCreateMain() {
    return this.onDidCreateMainEmitter.event;
  }
  get onDidDispose() {
    return this.onDidDisposeEmitter.event;
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
    @IAppendLogStore private readonly appendLog?: IAppendLogStore,
  ) {
    super();
  }

  async create(opts: CreateAgentOptions = {}): Promise<IAgentScopeHandle> {
    const agentId = opts.agentId ?? `agent-${nextAgentId++}`;
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
      {
        extra: [
          [
            IAgentScopeContext,
            {
              _serviceBrand: undefined,
              agentId,
              scope: (subKey?: string): string =>
                subKey === undefined || subKey === '' ? agentScope : `${agentScope}/${subKey}`,
            } satisfies IAgentScopeContext,
          ],
          [IAgentWireRecordService, new SyncDescriptor(AgentWireRecordService, [{ homedir: agentHomedir }])],
          [
            IAgentWireService,
            new SyncDescriptor(WireService, [
              {
                logScope: agentScope,
                logKey: WIRE_RECORD_FILENAME,
                serializeRecord: serializeV1WireRecord,
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
        ],
      },
    ) as IAgentScopeHandle;
    this.handles.set(agentId, handle);
    // Record the agent in the session registry so a closed-session fork can
    // enumerate every agent and relocate its wire log.
    await this.sessionMetadata.registerAgent(agentId, {
      homedir: agentHomedir,
      type: agentId === 'main' ? 'main' : 'sub',
      parentAgentId: agentId === 'main' ? undefined : 'main',
      forkedFrom: opts.forkedFrom,
      labels: opts.labels,
    });
    this.onDidCreateEmitter.fire(handle);
    // Force-instantiate the Eager builtin-tools registrar: its constructor
    // consumes every module-level `registerTool(...)` contribution and
    // registers each built-in tool (with `@IX` dependencies resolved against
    // this scope) into the per-agent `IAgentToolRegistryService`. Must happen
    // before the first turn — otherwise the LLM sees an empty tool list. The
    // registrar is separate from the registry itself to avoid a construction
    // cycle where tool ctors transitively depend on the registry.
    handle.accessor.get(IAgentBuiltinToolsRegistrar);
    // Force-instantiate the external hook adapter so it registers listeners on
    // the agent's domain hooks before the first turn. No business service
    // injects it directly; it observes their hooks instead.
    handle.accessor.get(IAgentExternalHooksService);
    // Force-instantiate the agent's MCP service so it attaches the (shared)
    // manager's tools and registers the `wait-for-initial-load` hook before the
    // first turn — otherwise plugin/session MCP servers would connect but their
    // tools would never register until something explicitly requests the service.
    handle.accessor.get(IAgentMcpService);
    await mcpReady;
    await this.ensureWireMetadata(handle, agentScope);
    if (opts.binding !== undefined) {
      await handle.accessor.get(IAgentProfileService).bind(opts.binding);
    }
    if (opts.permissionMode !== undefined) {
      handle.accessor.get(IAgentPermissionModeService).setMode(opts.permissionMode);
    }
    return handle;
  }

  private async ensureWireMetadata(
    handle: IAgentScopeHandle,
    agentScope: string,
  ): Promise<void> {
    const appendLog = this.appendLog;
    if (appendLog === undefined) return;
    let firstRecord: PersistedWireRecord | undefined;
    const remainingRecords: PersistedWireRecord[] = [];
    for await (const record of appendLog.read<PersistedWireRecord>(agentScope, WIRE_RECORD_FILENAME)) {
      if (firstRecord === undefined) {
        firstRecord = record;
        if (firstRecord.type === 'metadata') return;
        continue;
      }
      remainingRecords.push(record);
    }
    if (firstRecord === undefined) {
      handle.accessor.get(IAgentWireService).dispatch(wireMetadata(freshMetadataPayload()));
      return;
    }
    await appendLog.rewrite(agentScope, WIRE_RECORD_FILENAME, [
      freshMetadataRecord(),
      firstRecord,
      ...remainingRecords,
    ]);
  }

  ensureMcpReady(): Promise<void> {
    if (this.mcpInitialLoad !== undefined) return this.mcpInitialLoad;
    const manager = this.getMcpManager();
    const initialLoad = this.connectMcpServers(manager).catch((error: unknown) => {
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

  private async connectMcpServers(manager: McpConnectionManager): Promise<void> {
    const [base, pluginServers] = await Promise.all([
      resolveSessionMcpConfig({ cwd: this.workspace.workDir, homeDir: this.bootstrap.homeDir }),
      this.plugins.enabledMcpServers(),
    ]);
    const servers = { ...base?.servers, ...pluginServers };
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
      this.telemetry.track('mcp_connected', {
        server_count: connectedCount,
        total_count: totalCount,
      });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.telemetry.track('mcp_failed', {
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

  remove(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return Promise.resolve();
    this.handles.delete(agentId);
    handle.dispose();
    this.onDidDisposeEmitter.fire(agentId);
    return Promise.resolve();
  }
}

function freshMetadataPayload(): WireMetadataPayload {
  return {
    protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    created_at: Date.now(),
  };
}

function freshMetadataRecord(): PersistedWireRecord {
  return {
    type: 'metadata',
    ...freshMetadataPayload(),
  };
}

registerScopedService(LifecycleScope.Session, IAgentLifecycleService, AgentLifecycleService, InstantiationType.Delayed, 'agentLifecycle');
