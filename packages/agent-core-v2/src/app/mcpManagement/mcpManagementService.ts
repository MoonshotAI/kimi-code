import { randomUUID } from 'node:crypto';

import { normalize } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';

import { ErrorCodes, Error2 } from '#/errors';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { McpServerConfigSchema, type McpServerConfig } from '#/mcpCore/config-schema';
import { toMcpServerConfigView } from '#/mcpCore/configView';
import {
  AlreadyAuthorizedError,
  type BeginAuthorizationResult,
  type McpOAuthService,
  type McpOAuthTokenState,
} from '#/mcpCore/oauth/service';
import { canonicalMcpOAuthResource } from '#/mcpCore/oauth/store';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { LocalRuntime } from '#/runtime/localRuntime';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IConfigService } from '#/app/config/config';
import { MCP_SECTION, type McpSection } from '#/app/mcpConfig/configSection';
import { IMcpConfigStore, normalizeServerName } from '#/app/mcpConfig/configStore';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import {
  IMcpRegistryService,
  type McpRegistryEntry,
  type McpRegistryQuery,
} from '#/app/mcpRegistry/mcpRegistry';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

import {
  IMcpManagementService,
  type GlobalMcpServerConfig,
  type McpAuthStatusQuery,
  type McpManagedServer,
  type McpServerAuthBeginResult,
  type McpServerAuthFlowHandle,
  type McpServerAuthState,
  type McpServerAuthStatus,
  type McpServerDescriptor,
  type McpServerInspection,
  type McpServerLocator,
  type McpServerTestResult,
  type McpServerTestTarget,
} from './mcpManagement';

const DEFAULT_AUTH_TIMEOUT_MS = 15 * 60_000;
const AUTH_FLOW_IDLE_TIMEOUT_MS = 15 * 60_000;
const MAX_AUTH_TIMEOUT_MS = 2 ** 31 - 1;

export class McpManagementService extends Disposable implements IMcpManagementService {
  declare readonly _serviceBrand: undefined;

  private readonly authFlows = new Map<
    string,
    { flow: BeginAuthorizationResult; idleTimer: NodeJS.Timeout }
  >();

  constructor(
    @IMcpRegistryService private readonly registry: IMcpRegistryService,
    @IMcpConfigStore private readonly store: IMcpConfigStore,
    @IMcpOAuthService private readonly oauth: McpOAuthService,
    @IConfigService private readonly config: IConfigService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @IRuntimeResolver private readonly runtimeResolver: IRuntimeResolver,
    @IWorkspaceInstanceManager private readonly workspaceInstances: IWorkspaceInstanceManager,
    @IHostEnvironment private readonly hostEnvironment: IHostEnvironment,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  async listServers(query: McpRegistryQuery = {}): Promise<readonly McpManagedServer[]> {
    return (await this.registry.list(query)).map(toManagedServer);
  }

  async getServer(name: string, query: McpRegistryQuery = {}): Promise<McpManagedServer> {
    return toManagedServer(await this.registry.get(name, query));
  }

  async addServer(
    server: GlobalMcpServerConfig,
    query: McpRegistryQuery = {},
  ): Promise<readonly McpManagedServer[]> {
    const name = normalizeServerName(server.name);
    await this.guardMutation(name, query);
    await this.store.add({ ...server, name });
    return this.listServers(query);
  }

  async updateServer(
    server: GlobalMcpServerConfig,
    query: McpRegistryQuery = {},
  ): Promise<readonly McpManagedServer[]> {
    const name = normalizeServerName(server.name);
    await this.guardMutation(name, query);
    await this.store.update({ ...server, name });
    return this.listServers(query);
  }

  async removeServer(
    name: string,
    query: McpRegistryQuery = {},
  ): Promise<readonly McpManagedServer[]> {
    const normalized = normalizeServerName(name);
    await this.guardMutation(normalized, query);
    await this.store.remove(normalized);
    return this.listServers(query);
  }

  async testServer(target: McpServerTestTarget): Promise<McpServerTestResult> {
    await this.waitForReadiness();
    const resolved = await this.resolveTestTarget(target);
    return this.withProbe(resolved, target.cwd, (manager) =>
      standaloneTestResult(resolved.name, manager),
    );
  }

  private async guardMutation(name: string, query: McpRegistryQuery): Promise<void> {
    const matches = (await this.registry.list(query)).filter((entry) => entry.name === name);
    for (const entry of matches) {
      if (entry.source === 'global' && !entry.mutable) throwReadOnlyMcpServer(entry);
    }
  }

  private async resolveTestTarget(target: McpServerTestTarget): Promise<GlobalMcpServerConfig> {
    const { name, server, cwd } = target;
    if (server !== undefined) {
      if (name !== undefined && name !== server.name) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          'Pass either an MCP server name or an inline server config, not both',
        );
      }
      const parsed = McpServerConfigSchema.safeParse(server);
      if (!parsed.success) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `Invalid MCP server "${server.name}": ${parsed.error.message}`,
        );
      }
      return { name: server.name, ...parsed.data };
    }
    if (name === undefined) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Pass an MCP server name or an inline server config',
      );
    }
    const matches = (await this.registry.list({ cwd })).filter((entry) => entry.name === name);
    if (matches.length === 0) {
      throw new Error2(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" was not found`);
    }
    const enabled = matches.filter((entry) => entry.config.enabled !== false);
    if (enabled.length > 1) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `MCP runtime name "${name}" is shared by multiple enabled servers`,
      );
    }
    const entry = enabled[0] ?? matches[0]!;
    return { name: entry.name, ...entry.config };
  }

  private async withProbe<T>(
    server: GlobalMcpServerConfig,
    cwd: string | undefined,
    inspect: (manager: McpConnectionManager) => T,
  ): Promise<T> {
    await this.waitForReadiness();
    const section = this.config.get<McpSection | undefined>(MCP_SECTION);
    let workspaceId: string | undefined;
    let stdioCwd = cwd;
    let runtimeResolver = this.runtimeResolver;
    let transientRuntimes: RuntimeRegistry | undefined;
    if (server.transport === 'stdio') {
      stdioCwd = normalize(cwd ?? process.cwd());
      const workspace = this.workspaceInstances.findContaining(stdioCwd);
      if (workspace !== undefined) {
        workspaceId = workspace.id;
      } else {
        const runtimeId = server.runtime_id;
        if (runtimeId !== undefined && runtimeId !== 'local') {
          throw new Error2(
            ErrorCodes.REQUEST_INVALID,
            `Cannot probe MCP server "${server.name}" with runtime_id "${runtimeId}": no materialized workspace contains ${stdioCwd}, and an out-of-workspace probe only supports the local runtime`,
          );
        }
        await this.hostEnvironment.ready;
        workspaceId = `mcp-probe-${randomUUID()}`;
        transientRuntimes = new RuntimeRegistry(workspaceId);
        transientRuntimes.register(
          new LocalRuntime(
            workspaceId,
            this.hostEnvironment,
            undefined,
            this.hostProcess,
            undefined,
            undefined,
          ),
        );
        runtimeResolver = {
          _serviceBrand: undefined,
          inspect: (binding) => transientRuntimes!.inspect(binding),
          acquire: (binding, required) => transientRuntimes!.acquire(binding, required),
        };
      }
    }
    const manager = new McpConnectionManager({
      log: this.log,
      stdioCwd,
      runtimeResolver,
      workspaceId,
      runtimeId: workspaceId === undefined ? undefined : 'local',
      oauthService: this.oauth,
      resolveClientName: () => this.identity.current().slug,
      resolveDefaultTimeouts: () => ({
        startupTimeoutMs: section?.startupTimeoutMs,
        toolTimeoutMs: section?.toolTimeoutMs,
      }),
    });
    try {
      await manager.connectAll({ [server.name]: mcpConfigWithoutName(server) });
      return inspect(manager);
    } finally {
      try {
        await manager.shutdown();
      } finally {
        await transientRuntimes?.dispose();
      }
    }
  }

  async listAuthStatuses(query: McpAuthStatusQuery = {}): Promise<readonly McpServerAuthStatus[]> {
    await this.waitForReadiness();
    const entries = await this.registry.list({ cwd: query.cwd });
    return Promise.all(
      entries.map(async (entry) => ({
        name: entry.name,
        authStatus: await this.serverAuthState(entry, query.cwd, query.verify),
      })),
    );
  }

  async inspectServers(
    targets?: readonly McpServerLocator[],
    query: McpRegistryQuery = {},
  ): Promise<readonly McpServerInspection[]> {
    await this.waitForReadiness();
    const catalog = await this.serverDescriptors(query);
    const descriptors = selectServerDescriptors(catalog, targets);
    const inspections = await this.inspectServerDescriptors(descriptors, catalog);
    return inspections.map((inspection) => ({
      ...inspection,
      config: toMcpServerConfigView(inspection.config),
    }));
  }

  async resolveServerByName(name: string, query: McpRegistryQuery = {}): Promise<McpServerLocator> {
    await this.registry.get(name, query);
    const catalog = await this.serverDescriptors(query);
    const matches = catalog.filter((candidate) => candidate.runtimeName === name);
    const descriptor = matches.find((candidate) => candidate.enabled) ?? matches[0]!;
    this.requireUnambiguousRuntimeName(catalog, descriptor);
    return descriptor.locator;
  }

  async beginServerAuth(
    locator: McpServerLocator,
    query: McpRegistryQuery = {},
  ): Promise<McpServerAuthBeginResult> {
    await this.waitForReadiness();
    const server = await this.resolveServer(locator, query);
    const config = requireOAuthMcpConfig(server.runtimeName, server.config);
    try {
      const flow = await this.oauth.beginAuthorization(server.runtimeName, config.url);
      const flowId = randomUUID();
      const idleTimer = setTimeout(() => {
        const expired = this.authFlows.get(flowId);
        this.authFlows.delete(flowId);
        void expired?.flow.cancel();
      }, AUTH_FLOW_IDLE_TIMEOUT_MS);
      idleTimer.unref();
      this.authFlows.set(flowId, { flow, idleTimer });
      return {
        status: 'authorization-required',
        flowId,
        authorizationUrl: flow.authorizationUrl.toString(),
      };
    } catch (error) {
      if (error instanceof AlreadyAuthorizedError) {
        return { status: 'already-authorized' };
      }
      throw error;
    }
  }

  async completeServerAuth(
    handle: McpServerAuthFlowHandle,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (
      handle.timeoutMs !== undefined &&
      (!Number.isInteger(handle.timeoutMs) ||
        handle.timeoutMs < 1 ||
        handle.timeoutMs > MAX_AUTH_TIMEOUT_MS)
    ) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `MCP OAuth timeoutMs must be an integer between 1 and ${MAX_AUTH_TIMEOUT_MS}`,
      );
    }
    const active = this.authFlows.get(handle.flowId);
    if (active === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Unknown MCP OAuth flow: ${handle.flowId}`);
    }
    clearTimeout(active.idleTimer);
    try {
      await active.flow.complete({
        signal: options?.signal,
        timeoutMs: handle.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
      });
    } finally {
      this.authFlows.delete(handle.flowId);
    }
  }

  async cancelServerAuth(handle: Pick<McpServerAuthFlowHandle, 'flowId'>): Promise<void> {
    const active = this.authFlows.get(handle.flowId);
    if (active === undefined) return;
    clearTimeout(active.idleTimer);
    this.authFlows.delete(handle.flowId);
    await active.flow.cancel();
  }

  override dispose(): void {
    for (const active of this.authFlows.values()) {
      clearTimeout(active.idleTimer);
      void active.flow.cancel();
    }
    this.authFlows.clear();
    super.dispose();
  }

  async resetServerAuth(locator: McpServerLocator, query: McpRegistryQuery = {}): Promise<void> {
    await this.waitForReadiness();
    const server = await this.resolveServer(locator, query);
    const config = requireRemoteMcpConfig(server.runtimeName, server.config);
    await this.oauth.invalidate(server.runtimeName, config.url);
  }

  private async serverDescriptors(
    query: McpRegistryQuery = {},
  ): Promise<readonly McpServerRuntimeDescriptor[]> {
    return (await this.registry.list(query)).map((entry) => serverDescriptor(entry));
  }

  private async resolveServer(
    locator: McpServerLocator,
    query: McpRegistryQuery,
  ): Promise<McpServerRuntimeDescriptor> {
    const catalog = await this.serverDescriptors(query);
    const server = selectServerDescriptors(catalog, [locator])[0]!;
    this.requireUnambiguousRuntimeName(catalog, server);
    return server;
  }

  private requireUnambiguousRuntimeName(
    catalog: readonly McpServerRuntimeDescriptor[],
    server: McpServerRuntimeDescriptor,
  ): void {
    const conflict = catalog.find(
      (candidate) =>
        candidate.serverId !== server.serverId &&
        candidate.enabled &&
        candidate.runtimeName === server.runtimeName,
    );
    if (conflict !== undefined) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `MCP runtime name "${server.runtimeName}" is shared by multiple enabled servers; use the locator-addressed RPC instead`,
      );
    }
  }

  private async serverAuthState(
    entry: McpRegistryEntry,
    cwd: string | undefined,
    verify: boolean | undefined,
  ): Promise<McpServerAuthState> {
    const server = entry.config;
    if (server.enabled === false) return 'not-applicable';
    if (server.transport === 'stdio') return 'not-applicable';
    if (server.bearerTokenEnvVar !== undefined) return 'bearer-token';
    if (server.headers !== undefined && server.auth !== 'oauth') return 'not-applicable';
    if (server.transport !== 'http' && server.auth !== 'oauth') return 'not-applicable';
    const tokens = await this.oauth.tokenState(entry.name, server.url);
    const offline = (): McpServerAuthState => {
      if (tokens.hasTokens) {
        return !tokens.expired || tokens.hasRefreshToken ? 'oauth-authorized' : 'oauth-expired';
      }
      return server.auth === 'oauth' ? 'oauth-required' : 'not-applicable';
    };

    const probe = async (): Promise<McpServerAuthState> =>
      this.withProbe({ name: entry.name, ...server }, cwd, (manager) => {
        const status = manager.get(entry.name)?.status;
        if (status === 'connected') return tokens.hasTokens ? 'oauth-authorized' : 'not-applicable';
        if (status === 'needs-auth') return tokens.hasTokens ? 'oauth-expired' : 'oauth-required';
        return offline();
      });

    if (verify === true) return probe();
    if (verify === false || tokens.hasTokens || server.auth === 'oauth') return offline();
    return probe();
  }

  private async inspectServerDescriptors(
    descriptors: readonly McpServerRuntimeDescriptor[],
    catalog: readonly McpServerRuntimeDescriptor[],
  ): Promise<readonly McpServerRuntimeInspection[]> {
    const runtimeNameCounts = new Map<string, number>();
    for (const server of new Map(catalog.map((item) => [item.serverId, item])).values()) {
      if (!server.enabled) continue;
      runtimeNameCounts.set(server.runtimeName, (runtimeNameCounts.get(server.runtimeName) ?? 0) + 1);
    }
    const credentialStates = new Map<string, McpOAuthTokenState>();
    const probeConfigs = Object.create(null) as Record<string, McpServerConfig>;
    for (const server of descriptors) {
      if (configuredMcpAuthState(server) !== undefined) continue;
      if (runtimeNameCounts.get(server.runtimeName) !== 1) continue;
      const config = requireRemoteMcpConfig(server.runtimeName, server.config);
      credentialStates.set(
        server.serverId,
        await this.oauth.tokenState(server.runtimeName, config.url),
      );
      probeConfigs[server.runtimeName] = server.config;
    }
    let manager: McpConnectionManager | undefined;
    try {
      if (Object.keys(probeConfigs).length > 0) {
        const section = this.config.get<McpSection | undefined>(MCP_SECTION);
        manager = new McpConnectionManager({
          log: this.log,
          oauthService: this.oauth,
          resolveClientName: () => this.identity.current().slug,
          resolveDefaultTimeouts: () => ({
            startupTimeoutMs: section?.startupTimeoutMs,
            toolTimeoutMs: section?.toolTimeoutMs,
          }),
        });
        await manager.connectAll(probeConfigs);
      }
      const checkedAt = Date.now();
      return descriptors.map((server) => {
        const configured = configuredMcpAuthState(server);
        if (configured !== undefined) return { ...server, authStatus: configured };
        if (runtimeNameCounts.get(server.runtimeName) !== 1) {
          return {
            ...server,
            authStatus: 'unavailable' as const,
            checkedAt,
            error: `MCP runtime name "${server.runtimeName}" is not unique`,
          };
        }
        const tokens = credentialStates.get(server.serverId);
        const entry = manager?.get(server.runtimeName);
        if (entry?.status === 'connected') {
          return {
            ...server,
            authStatus: tokens?.hasTokens === true ? 'oauth-authorized' : 'not-applicable',
            checkedAt,
          };
        }
        if (entry?.status === 'needs-auth') {
          return {
            ...server,
            authStatus: tokens?.hasTokens === true ? 'oauth-expired' : 'oauth-required',
            checkedAt,
          };
        }
        return {
          ...server,
          authStatus: 'unavailable' as const,
          checkedAt,
          error: entry?.error ?? `MCP server finished with status ${entry?.status ?? 'unknown'}`,
        };
      });
    } finally {
      await manager?.shutdown();
    }
  }

  private async waitForReadiness(): Promise<void> {
    await this.config.ready;
    await this.identity.resolved();
  }
}

function throwReadOnlyMcpServer(entry: McpRegistryEntry): void {
  throw new Error2(
    ErrorCodes.REQUEST_INVALID,
    `MCP server "${entry.name}" is read-only: it is defined in ${entry.origin} — edit that file instead`,
  );
}

function toManagedServer(entry: McpRegistryEntry): McpManagedServer {
  return {
    name: entry.name,
    config: entry.mutable ? entry.config : toMcpServerConfigView(entry.config),
    source: entry.source,
    origin: entry.origin,
    mutable: entry.mutable,
    plugin: entry.plugin,
  };
}

function mcpConfigWithoutName(server: GlobalMcpServerConfig): McpServerConfig {
  const { name: _name, ...config } = server;
  return config;
}

type McpRemoteServerConfig = Exclude<McpServerConfig, { readonly transport: 'stdio' }>;

function requireRemoteMcpConfig(name: string, config: McpServerConfig): McpRemoteServerConfig {
  if (config.transport !== 'stdio') return config;
  throw new Error2(
    ErrorCodes.REQUEST_INVALID,
    `MCP server "${name}" does not use a remote transport`,
  );
}

function requireOAuthMcpConfig(name: string, input: McpServerConfig): McpRemoteServerConfig {
  const config = requireRemoteMcpConfig(name, input);
  if (config.bearerTokenEnvVar !== undefined) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${name}" uses a static bearer token`,
    );
  }
  if (config.headers !== undefined && config.auth !== 'oauth') {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${name}" uses static headers and is not marked for OAuth`,
    );
  }
  return config;
}

/** Stable wire id of a locator: `global:<name>` / `plugin:<pluginId>:<serverName>`. */
export function mcpServerId(locator: McpServerLocator): string {
  if (locator.source === 'global') return `global:${encodeURIComponent(locator.name)}`;
  return `plugin:${encodeURIComponent(locator.pluginId)}:${encodeURIComponent(locator.serverName)}`;
}

export function describeMcpServerLocator(locator: McpServerLocator): string {
  if (locator.source === 'global') return locator.name;
  return `${locator.pluginId}/${locator.serverName}`;
}

type McpServerRuntimeDescriptor = Omit<McpServerDescriptor, 'config'> & {
  readonly config: McpServerConfig;
};

type McpServerRuntimeInspection = McpServerRuntimeDescriptor &
  Pick<McpServerInspection, 'authStatus' | 'checkedAt' | 'error'>;

function serverDescriptor(entry: McpRegistryEntry): McpServerRuntimeDescriptor {
  const locator: McpServerLocator =
    entry.source === 'plugin' && entry.plugin !== undefined
      ? { source: 'plugin', pluginId: entry.plugin.id, serverName: entry.plugin.name }
      : { source: 'global', name: entry.name };
  return {
    serverId: mcpServerId(locator),
    locator,
    runtimeName: entry.name,
    canonicalUrl:
      entry.config.transport === 'stdio'
        ? undefined
        : canonicalMcpOAuthResource(entry.config.url),
    origin: entry.source,
    config: entry.config,
    enabled: entry.config.enabled !== false,
    editable: entry.mutable,
  };
}

function selectServerDescriptors(
  catalog: readonly McpServerRuntimeDescriptor[],
  targets?: readonly McpServerLocator[],
): readonly McpServerRuntimeDescriptor[] {
  const effectiveTargets = targets === null ? undefined : targets;
  if (effectiveTargets === undefined) return catalog;
  const byId = new Map(catalog.map((server) => [server.serverId, server]));
  return effectiveTargets.map((target) => {
    const server = byId.get(mcpServerId(target));
    if (server !== undefined) return server;
    throw new Error2(
      ErrorCodes.MCP_SERVER_NOT_FOUND,
      `MCP server "${describeMcpServerLocator(target)}" was not found`,
    );
  });
}

function configuredMcpAuthState(
  server: McpServerRuntimeDescriptor,
): McpServerAuthState | undefined {
  if (!server.enabled || server.config.enabled === false) return 'not-applicable';
  if (server.config.transport === 'stdio') return 'not-applicable';
  if (server.config.bearerTokenEnvVar !== undefined) return 'bearer-token';
  if (server.config.headers !== undefined && server.config.auth !== 'oauth') {
    return 'not-applicable';
  }
  return undefined;
}

function standaloneTestResult(
  name: string,
  manager: McpConnectionManager,
): McpServerTestResult {
  const entry = manager.get(name);
  if (entry?.status !== 'connected') {
    return {
      success: false,
      output: entry?.error ?? `MCP server "${name}" finished with status ${entry?.status ?? 'unknown'}`,
    };
  }
  const tools = manager.resolved(name)?.rawTools ?? [];
  const lines = [
    `Connected to MCP server "${name}".`,
    `Available tools: ${tools.length}`,
    ...tools.map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ''}`),
  ];
  return { success: true, output: lines.join('\n') };
}

registerScopedService(
  LifecycleScope.App,
  IMcpManagementService,
  McpManagementService,
  ScopeActivation.OnDemand,
  'mcpManagement',
);
