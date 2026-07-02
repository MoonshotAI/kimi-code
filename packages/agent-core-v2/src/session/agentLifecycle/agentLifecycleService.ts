/**
 * `agentLifecycle` domain (L6) — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes. Seeds each agent's
 * identity through `agent` scopeContext, wires per-agent wire records, blob
 * store, and MCP, and registers the agent in the session registry. Bound at
 * Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { SyncDescriptor } from '#/_base/di/descriptors';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap';
import { IPluginSessionStartInjectorService } from '#/agent/contextInjector';
import { ILogService } from '#/app/log';
import { AgentMcpService, IAgentMcpService } from '#/agent/mcp';
import { McpConnectionManager } from '#/agent/mcp/connection-manager';
import { resolveSessionMcpConfig } from '#/agent/mcp/session-config';
import { IPluginService } from '#/app/plugin';
import { ISessionContext } from '#/session/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';
import { IAgentScopeContext } from '#/agent/scopeContext';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentBuiltinToolsRegistrar } from '#/agent/toolRegistry';
import { IAgentWireRecordService, AgentWireRecordService } from '#/agent/wireRecord';
import { IAgentBlobStoreService, AgentBlobStoreService } from '#/agent/blobStore';
import {
  IAgentExternalHooksService,
  AgentExternalHooksService,
} from '#/agent/externalHooks';

import { type AgentListFilter, type CreateAgentOptions, IAgentLifecycleService, type SpawnAgentOptions } from './agentLifecycle';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IAgentScopeHandle>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private mcpManager: McpConnectionManager | undefined;

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
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IPluginService private readonly plugins: IPluginService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  async create(opts: CreateAgentOptions): Promise<IAgentScopeHandle> {
    const agentId = opts.agentId ?? `agent-${nextAgentId++}`;
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
          [IAgentBlobStoreService, new SyncDescriptor(AgentBlobStoreService, [{}])],
          [IAgentMcpService, new SyncDescriptor(AgentMcpService, [{ manager: this.getMcpManager() }])],
          // External hooks carries a leading static `options` param; the scoped
          // registry supplies none, so seed an empty one to satisfy the DI
          // contract (static args must fill the slots before the first `@IX`).
          // Kept delayed so it only instantiates (with its full dependency set)
          // when a turn actually resolves it.
          [IAgentExternalHooksService, new SyncDescriptor(AgentExternalHooksService, [{}], true)],
        ],
      },
    ) as IAgentScopeHandle;
    this.handles.set(agentId, handle);
    // Record the agent in the session registry so a closed-session fork can
    // enumerate every agent and relocate its wire log.
    await this.sessionMetadata.registerAgent(agentId, {
      homedir: agentHomedir,
      forkedFrom: opts.forkedFrom,
      swarmItem: opts.swarmItem,
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
    // Force-instantiate the agent's MCP service so it attaches the (shared)
    // manager's tools and registers the `wait-for-initial-load` hook before the
    // first turn — otherwise plugin/session MCP servers would connect but their
    // tools would never register until something explicitly requests the service.
    handle.accessor.get(IAgentMcpService);
    return handle;
  }

  async createMain(): Promise<IAgentScopeHandle> {
    const handle = await this.create({ agentId: 'main' });
    // Force-instantiate the plugin session-start injector so it registers its
    // turn-cadence injection before the first turn. Main-agent only, matching
    // v1's `pluginSessionStarts: type === 'main' ? ... : undefined`.
    handle.accessor.get(IPluginSessionStartInjectorService);
    return handle;
  }

  async clone(sourceAgentId: string): Promise<IAgentScopeHandle> {
    const source =
      this.handles.get(sourceAgentId) ??
      (sourceAgentId === 'main' ? await this.createMain() : undefined);
    if (source === undefined) throw new Error(`Source agent "${sourceAgentId}" does not exist`);
    const child = await this.create({ forkedFrom: source.id });

    const sourceData = source.accessor.get(IAgentProfileService).data();
    child.accessor.get(IAgentProfileService).update({
      modelAlias: sourceData.modelAlias,
      thinkingLevel: sourceData.thinkingLevel,
      systemPrompt: sourceData.systemPrompt,
      activeToolNames: sourceData.activeToolNames,
    });

    const sourceMessages = source.accessor.get(IAgentContextMemoryService)?.get();
    if (sourceMessages !== undefined && sourceMessages.length > 0) {
      child.accessor.get(IAgentContextMemoryService)?.splice(0, 0, sourceMessages);
    }
    return child;
  }

  async spawn(parentAgentId: string, opts?: SpawnAgentOptions): Promise<IAgentScopeHandle> {
    const parent = this.handles.get(parentAgentId);
    if (parent === undefined) throw new Error(`Parent agent "${parentAgentId}" does not exist`);
    const parentData = parent.accessor.get(IAgentProfileService).data();
    const child = await this.create({
      agentId: opts?.agentId,
      forkedFrom: parentAgentId,
      cwd: opts?.cwd ?? parentData.cwd,
      swarmItem: opts?.swarmItem,
    });
    child.accessor.get(IAgentProfileService).update({
      cwd: opts?.cwd ?? parentData.cwd,
      modelAlias: parentData.modelAlias,
      thinkingLevel: parentData.thinkingLevel,
      systemPrompt: parentData.systemPrompt,
      activeToolNames: parentData.activeToolNames,
    });
    return child;
  }

  /**
   * One shared `McpConnectionManager` per session (built lazily, cached). All
   * agents in the session share it, matching v1's session-scoped MCP and
   * avoiding a reconnect storm per subagent. Connects the session-config
   * servers merged with enabled plugin MCP servers (fire-and-forget; the
   * manager's `initialLoad` gates tool use via `waitForInitialLoad`).
   */
  private getMcpManager(): McpConnectionManager {
    if (this.mcpManager !== undefined) return this.mcpManager;
    const manager = new McpConnectionManager({ log: this.log });
    this.mcpManager = manager;
    this._register({ dispose: () => void manager.shutdown() });
    void this.connectMcpServers(manager).catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
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

registerScopedService(LifecycleScope.Session, IAgentLifecycleService, AgentLifecycleService, InstantiationType.Delayed, 'agentLifecycle');
