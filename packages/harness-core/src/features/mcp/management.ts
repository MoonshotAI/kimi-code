import type { OsFsPort } from '#/features/os/host/index';

import { loadMcpServersDetailed, resolveMcpJsonPaths } from './config/loader';
import type { McpServerSource } from './config/sources';
import {
  normalizeServerName,
  type GlobalMcpServerConfig,
  type McpUserConfigStore,
} from './config/store';
import { McpServerConfigSchema, type McpServerConfig } from './core/config-schema';
import { toMcpServerConfigView, type McpServerConfigView } from './core/config-view';
import type { McpConnectionManager } from './core/connection-manager';
import { McpManagementError } from './errors';
import {
  AlreadyAuthorizedError,
  type BeginAuthorizationResult,
  type McpOAuthService,
  type McpOAuthTokenState,
} from './oauth/service';
import { canonicalMcpOAuthResource } from './oauth/store';

export type McpManagedServerSource = 'global' | 'plugin' | 'caller';

export interface McpRegistryQuery {
  readonly cwd?: string;
}

export interface McpManagedServer {
  readonly name: string;
  readonly config: McpServerConfig | McpServerConfigView;
  readonly source: McpManagedServerSource;
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: { readonly id: string; readonly name: string };
}

export type McpServerLocator =
  | { readonly source: 'global'; readonly name: string }
  | { readonly source: 'plugin'; readonly pluginId: string; readonly serverName: string };

export type McpServerAuthState =
  | 'not-applicable'
  | 'bearer-token'
  | 'oauth-required'
  | 'oauth-authorized'
  | 'oauth-expired'
  | 'unavailable';

export interface McpAuthStatusQuery extends McpRegistryQuery {
  readonly verify?: boolean;
}

export interface McpServerAuthStatus {
  readonly name: string;
  readonly authStatus: McpServerAuthState;
}

export interface McpServerTestTarget {
  readonly name?: string;
  readonly server?: GlobalMcpServerConfig;
  readonly cwd?: string;
}

export interface McpServerTestResult {
  readonly success: boolean;
  readonly output: string;
}

export interface McpServerInspection {
  readonly serverId: string;
  readonly locator: McpServerLocator;
  readonly runtimeName: string;
  readonly canonicalUrl?: string;
  readonly origin: McpManagedServerSource;
  readonly config: McpServerConfigView;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly authStatus: McpServerAuthState;
  readonly checkedAt?: number;
  readonly error?: string;
}

export type McpServerAuthBeginResult =
  | {
      readonly status: 'authorization-required';
      readonly flowId: string;
      readonly authorizationUrl: string;
    }
  | { readonly status: 'already-authorized' };

export interface McpServerAuthFlowHandle {
  readonly flowId: string;
  readonly timeoutMs?: number;
}

export interface McpManagement {
  listServers(query?: McpRegistryQuery): Promise<readonly McpManagedServer[]>;
  getServer(name: string, query?: McpRegistryQuery): Promise<McpManagedServer>;
  addServer(
    server: GlobalMcpServerConfig,
    query?: McpRegistryQuery,
  ): Promise<readonly McpManagedServer[]>;
  updateServer(
    server: GlobalMcpServerConfig,
    query?: McpRegistryQuery,
  ): Promise<readonly McpManagedServer[]>;
  removeServer(name: string, query?: McpRegistryQuery): Promise<readonly McpManagedServer[]>;
  testServer(target: McpServerTestTarget): Promise<McpServerTestResult>;
  inspectServers(
    targets?: readonly McpServerLocator[],
    query?: McpRegistryQuery,
  ): Promise<readonly McpServerInspection[]>;
  listAuthStatuses(query?: McpAuthStatusQuery): Promise<readonly McpServerAuthStatus[]>;
  beginServerAuth(
    locator: McpServerLocator,
    query?: McpRegistryQuery,
  ): Promise<McpServerAuthBeginResult>;
  completeServerAuth(
    handle: McpServerAuthFlowHandle,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  cancelServerAuth(handle: Pick<McpServerAuthFlowHandle, 'flowId'>): Promise<void>;
  resetServerAuth(locator: McpServerLocator, query?: McpRegistryQuery): Promise<void>;
  dispose(): void;
}

export interface CreateMcpManagementDeps {
  readonly fs?: OsFsPort;
  readonly home?: string;
  readonly workDir: string;
  readonly trusted: boolean;
  readonly servers?: Record<string, McpServerConfig>;
  readonly ephemeral: ReadonlyMap<string, { readonly config: McpServerConfig; readonly cwd?: string }>;
  readonly sources: () => readonly McpServerSource[];
  readonly oauth: McpOAuthService;
  readonly store?: McpUserConfigStore;
  readonly createProbe: (stdioCwd: string) => McpConnectionManager;
  readonly reload: () => Promise<void>;
  readonly disconnect: (name: string) => Promise<void>;
  readonly ready: () => Promise<void>;
}

interface McpRegistryEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly source: McpManagedServerSource;
  readonly origin: string;
  readonly mutable: boolean;
}

type McpRemoteServerConfig = Exclude<McpServerConfig, { readonly transport: 'stdio' }>;

type McpServerRuntimeDescriptor = Omit<McpServerInspection, 'config' | 'authStatus' | 'checkedAt' | 'error'> & {
  readonly config: McpServerConfig;
};

type McpServerRuntimeInspection = McpServerRuntimeDescriptor &
  Pick<McpServerInspection, 'authStatus' | 'checkedAt' | 'error'>;

const DEFAULT_AUTH_TIMEOUT_MS = 15 * 60_000;
const AUTH_FLOW_IDLE_TIMEOUT_MS = 15 * 60_000;
const MAX_AUTH_TIMEOUT_MS = 2 ** 31 - 1;

export function createMcpManagement(deps: CreateMcpManagementDeps): McpManagement {
  const authFlows = new Map<
    string,
    { flow: BeginAuthorizationResult; idleTimer: NodeJS.Timeout }
  >();

  const buildRegistry = async (query: McpRegistryQuery = {}): Promise<McpRegistryEntry[]> => {
    const cwd = query.cwd ?? deps.workDir;
    const detailed = await loadMcpServersDetailed({
      fs: deps.fs,
      cwd,
      home: deps.home,
      trusted: deps.trusted,
      servers: deps.servers,
    });
    const paths = await resolveMcpJsonPaths(deps.fs, cwd, deps.home);
    const entries: McpRegistryEntry[] = [];
    for (const [name, config] of Object.entries(detailed.servers)) {
      const origin = detailed.origins[name] ?? paths.projectRoot;
      entries.push({
        name,
        config,
        source: 'global',
        origin,
        mutable: paths.user !== undefined && origin === paths.user,
      });
    }
    const contributed = await Promise.all(
      deps.sources().map(async (source) => {
        try {
          return { source, servers: await source.load() };
        } catch {
          return { source, servers: {} as Record<string, McpServerConfig> };
        }
      }),
    );
    for (const { source, servers } of contributed) {
      for (const [name, config] of Object.entries(servers)) {
        entries.push({ name, config, source: 'plugin', origin: source.id, mutable: false });
      }
    }
    for (const [name, entry] of deps.ephemeral) {
      entries.push({ name, config: entry.config, source: 'caller', origin: 'caller', mutable: false });
    }
    return entries;
  };

  const listServers = async (query: McpRegistryQuery = {}): Promise<readonly McpManagedServer[]> =>
    (await buildRegistry(query)).map(toManagedServer);

  const getServer = async (name: string, query: McpRegistryQuery = {}): Promise<McpManagedServer> => {
    const entry = (await buildRegistry(query)).find((candidate) => candidate.name === name);
    if (entry !== undefined) return toManagedServer(entry);
    throw serverNotFound(name);
  };

  const requireStore = (): McpUserConfigStore => {
    const store = deps.store;
    if (store === undefined) {
      throw new McpManagementError(
        'mcp.user_store_unavailable',
        'MCP user config store is unavailable without a home directory and fs port.',
      );
    }
    return store;
  };

  const guardMutation = async (name: string, query: McpRegistryQuery): Promise<void> => {
    const matches = (await buildRegistry(query)).filter((entry) => entry.name === name);
    for (const entry of matches) {
      if (entry.source === 'global' && !entry.mutable) {
        throw new McpManagementError(
          'mcp.request_invalid',
          `MCP server "${entry.name}" is read-only: it is defined in ${entry.origin} — edit that file instead`,
        );
      }
    }
  };

  const addServer = async (
    server: GlobalMcpServerConfig,
    query: McpRegistryQuery = {},
  ): Promise<readonly McpManagedServer[]> => {
    const name = normalizeServerName(server.name);
    await guardMutation(name, query);
    await requireStore().add({ ...server, name });
    await deps.reload();
    return listServers(query);
  };

  const updateServer = async (
    server: GlobalMcpServerConfig,
    query: McpRegistryQuery = {},
  ): Promise<readonly McpManagedServer[]> => {
    const name = normalizeServerName(server.name);
    await guardMutation(name, query);
    await requireStore().update({ ...server, name });
    await deps.reload();
    return listServers(query);
  };

  const removeServer = async (
    name: string,
    query: McpRegistryQuery = {},
  ): Promise<readonly McpManagedServer[]> => {
    const normalized = normalizeServerName(name);
    const primary = (await buildRegistry(query)).find((entry) => entry.name === normalized);
    if (primary?.source === 'caller') {
      await deps.disconnect(normalized);
      return listServers(query);
    }
    await guardMutation(normalized, query);
    await requireStore().remove(normalized);
    await deps.reload();
    return listServers(query);
  };

  const resolveTestTarget = async (target: McpServerTestTarget): Promise<GlobalMcpServerConfig> => {
    const { name, server, cwd } = target;
    if (server !== undefined) {
      if (name !== undefined && name !== server.name) {
        throw new McpManagementError(
          'mcp.request_invalid',
          'Pass either an MCP server name or an inline server config, not both',
        );
      }
      const parsed = McpServerConfigSchema.safeParse(server);
      if (!parsed.success) {
        throw new McpManagementError(
          'mcp.config_invalid',
          `Invalid MCP server "${server.name}": ${parsed.error.message}`,
        );
      }
      return { name: server.name, ...parsed.data };
    }
    if (name === undefined) {
      throw new McpManagementError(
        'mcp.request_invalid',
        'Pass an MCP server name or an inline server config',
      );
    }
    const matches = (await buildRegistry({ cwd })).filter((entry) => entry.name === name);
    if (matches.length === 0) {
      throw serverNotFound(name);
    }
    const enabled = matches.filter((entry) => entry.config.enabled !== false);
    if (enabled.length > 1) {
      throw new McpManagementError(
        'mcp.request_invalid',
        `MCP runtime name "${name}" is shared by multiple enabled servers`,
      );
    }
    const entry = enabled[0] ?? matches[0]!;
    return { name: entry.name, ...entry.config };
  };

  const testServer = async (target: McpServerTestTarget): Promise<McpServerTestResult> => {
    await deps.ready();
    const resolved = await resolveTestTarget(target);
    const probe = deps.createProbe(target.cwd ?? deps.workDir);
    try {
      await probe.connectAll({ [resolved.name]: mcpConfigWithoutName(resolved) });
      return standaloneTestResult(resolved.name, probe);
    } finally {
      await probe.shutdown();
    }
  };

  const serverDescriptors = async (
    query: McpRegistryQuery = {},
  ): Promise<readonly McpServerRuntimeDescriptor[]> =>
    (await buildRegistry(query))
      .filter((entry) => entry.source !== 'caller')
      .map(serverDescriptor);

  const inspectServers = async (
    targets?: readonly McpServerLocator[],
    query: McpRegistryQuery = {},
  ): Promise<readonly McpServerInspection[]> => {
    await deps.ready();
    const catalog = await serverDescriptors(query);
    const descriptors = selectServerDescriptors(catalog, targets);
    const inspections = await inspectServerDescriptors(descriptors, catalog);
    return inspections.map((inspection) => ({
      ...inspection,
      config: toMcpServerConfigView(inspection.config),
    }));
  };

  const inspectServerDescriptors = async (
    descriptors: readonly McpServerRuntimeDescriptor[],
    catalog: readonly McpServerRuntimeDescriptor[],
  ): Promise<readonly McpServerRuntimeInspection[]> => {
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
        await deps.oauth.tokenState(server.runtimeName, config.url),
      );
      probeConfigs[server.runtimeName] = server.config;
    }
    let manager: McpConnectionManager | undefined;
    try {
      if (Object.keys(probeConfigs).length > 0) {
        manager = deps.createProbe(deps.workDir);
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
  };

  const serverAuthState = async (
    entry: McpRegistryEntry,
    cwd: string | undefined,
    verify: boolean | undefined,
  ): Promise<McpServerAuthState> => {
    const server = entry.config;
    if (server.enabled === false) return 'not-applicable';
    if (server.transport === 'stdio') return 'not-applicable';
    if (server.bearerTokenEnvVar !== undefined) return 'bearer-token';
    if (server.headers !== undefined && server.auth !== 'oauth') return 'not-applicable';
    if (server.transport !== 'http' && server.auth !== 'oauth') return 'not-applicable';
    const tokens = await deps.oauth.tokenState(entry.name, server.url);
    const offline = (): McpServerAuthState => {
      if (tokens.hasTokens) {
        return !tokens.expired || tokens.hasRefreshToken ? 'oauth-authorized' : 'oauth-expired';
      }
      return server.auth === 'oauth' ? 'oauth-required' : 'not-applicable';
    };

    const probe = async (): Promise<McpServerAuthState> => {
      const manager = deps.createProbe(cwd ?? deps.workDir);
      try {
        await manager.connectAll({ [entry.name]: server });
        const status = manager.get(entry.name)?.status;
        if (status === 'connected') return tokens.hasTokens ? 'oauth-authorized' : 'not-applicable';
        if (status === 'needs-auth') return tokens.hasTokens ? 'oauth-expired' : 'oauth-required';
        return offline();
      } finally {
        await manager.shutdown();
      }
    };

    if (verify === true) return probe();
    if (verify === false || tokens.hasTokens || server.auth === 'oauth') return offline();
    return probe();
  };

  const listAuthStatuses = async (
    query: McpAuthStatusQuery = {},
  ): Promise<readonly McpServerAuthStatus[]> => {
    await deps.ready();
    const entries = await buildRegistry({ cwd: query.cwd });
    return Promise.all(
      entries.map(async (entry) => ({
        name: entry.name,
        authStatus: await serverAuthState(entry, query.cwd, query.verify),
      })),
    );
  };

  const resolveServer = async (
    locator: McpServerLocator,
    query: McpRegistryQuery,
  ): Promise<McpServerRuntimeDescriptor> => {
    const catalog = await serverDescriptors(query);
    const server = selectServerDescriptors(catalog, [locator])[0]!;
    requireUnambiguousRuntimeName(catalog, server);
    return server;
  };

  const requireUnambiguousRuntimeName = (
    catalog: readonly McpServerRuntimeDescriptor[],
    server: McpServerRuntimeDescriptor,
  ): void => {
    const conflict = catalog.find(
      (candidate) =>
        candidate.serverId !== server.serverId &&
        candidate.enabled &&
        candidate.runtimeName === server.runtimeName,
    );
    if (conflict !== undefined) {
      throw new McpManagementError(
        'mcp.request_invalid',
        `MCP runtime name "${server.runtimeName}" is shared by multiple enabled servers; use the locator-addressed RPC instead`,
      );
    }
  };

  const beginServerAuth = async (
    locator: McpServerLocator,
    query: McpRegistryQuery = {},
  ): Promise<McpServerAuthBeginResult> => {
    await deps.ready();
    const server = await resolveServer(locator, query);
    const config = requireOAuthMcpConfig(server.runtimeName, server.config);
    let flow: BeginAuthorizationResult;
    try {
      flow = await deps.oauth.beginAuthorization(server.runtimeName, config.url);
    } catch (error) {
      if (error instanceof AlreadyAuthorizedError) {
        return { status: 'already-authorized' };
      }
      throw toOAuthManagementError(error);
    }
    const flowId = crypto.randomUUID();
    const idleTimer = setTimeout(() => {
      const expired = authFlows.get(flowId);
      authFlows.delete(flowId);
      void expired?.flow.cancel();
    }, AUTH_FLOW_IDLE_TIMEOUT_MS);
    idleTimer.unref();
    authFlows.set(flowId, { flow, idleTimer });
    return {
      status: 'authorization-required',
      flowId,
      authorizationUrl: flow.authorizationUrl.toString(),
    };
  };

  const completeServerAuth = async (
    handle: McpServerAuthFlowHandle,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> => {
    if (
      handle.timeoutMs !== undefined &&
      (!Number.isInteger(handle.timeoutMs) ||
        handle.timeoutMs < 1 ||
        handle.timeoutMs > MAX_AUTH_TIMEOUT_MS)
    ) {
      throw new McpManagementError(
        'mcp.request_invalid',
        `MCP OAuth timeoutMs must be an integer between 1 and ${MAX_AUTH_TIMEOUT_MS}`,
      );
    }
    const active = authFlows.get(handle.flowId);
    if (active === undefined) {
      throw new McpManagementError(
        'mcp.request_invalid',
        `Unknown MCP OAuth flow: ${handle.flowId}`,
      );
    }
    clearTimeout(active.idleTimer);
    try {
      await active.flow.complete({
        signal: options.signal,
        timeoutMs: handle.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
      });
    } catch (error) {
      throw toOAuthManagementError(error);
    } finally {
      authFlows.delete(handle.flowId);
    }
  };

  const cancelServerAuth = async (
    handle: Pick<McpServerAuthFlowHandle, 'flowId'>,
  ): Promise<void> => {
    const active = authFlows.get(handle.flowId);
    if (active === undefined) return;
    clearTimeout(active.idleTimer);
    authFlows.delete(handle.flowId);
    await active.flow.cancel();
  };

  const resetServerAuth = async (
    locator: McpServerLocator,
    query: McpRegistryQuery = {},
  ): Promise<void> => {
    await deps.ready();
    const server = await resolveServer(locator, query);
    const config = requireRemoteMcpConfig(server.runtimeName, server.config);
    try {
      await deps.oauth.invalidate(server.runtimeName, config.url);
    } catch (error) {
      throw toOAuthManagementError(error);
    }
  };

  const dispose = (): void => {
    for (const active of authFlows.values()) {
      clearTimeout(active.idleTimer);
      void active.flow.cancel();
    }
    authFlows.clear();
  };

  return {
    listServers,
    getServer,
    addServer,
    updateServer,
    removeServer,
    testServer,
    inspectServers,
    listAuthStatuses,
    beginServerAuth,
    completeServerAuth,
    cancelServerAuth,
    resetServerAuth,
    dispose,
  };
}

function toManagedServer(entry: McpRegistryEntry): McpManagedServer {
  return {
    name: entry.name,
    config: entry.mutable ? entry.config : toMcpServerConfigView(entry.config),
    source: entry.source,
    origin: entry.origin,
    mutable: entry.mutable,
    plugin: undefined,
  };
}

function serverDescriptor(entry: McpRegistryEntry): McpServerRuntimeDescriptor {
  const locator: McpServerLocator =
    entry.source === 'plugin'
      ? { source: 'plugin', pluginId: entry.origin, serverName: entry.name }
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

function mcpServerId(locator: McpServerLocator): string {
  if (locator.source === 'global') return `global:${encodeURIComponent(locator.name)}`;
  return `plugin:${encodeURIComponent(locator.pluginId)}:${encodeURIComponent(locator.serverName)}`;
}

function describeMcpServerLocator(locator: McpServerLocator): string {
  if (locator.source === 'global') return locator.name;
  return `${locator.pluginId}/${locator.serverName}`;
}

function selectServerDescriptors(
  catalog: readonly McpServerRuntimeDescriptor[],
  targets?: readonly McpServerLocator[],
): readonly McpServerRuntimeDescriptor[] {
  if (targets === undefined) return catalog;
  const byId = new Map(catalog.map((server) => [server.serverId, server]));
  return targets.map((target) => {
    const server = byId.get(mcpServerId(target));
    if (server !== undefined) return server;
    throw new McpManagementError(
      'mcp.server_not_found',
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

function requireRemoteMcpConfig(name: string, config: McpServerConfig): McpRemoteServerConfig {
  if (config.transport !== 'stdio') return config;
  throw new McpManagementError(
    'mcp.request_invalid',
    `MCP server "${name}" does not use a remote transport`,
  );
}

function requireOAuthMcpConfig(name: string, input: McpServerConfig): McpRemoteServerConfig {
  const config = requireRemoteMcpConfig(name, input);
  if (config.bearerTokenEnvVar !== undefined) {
    throw new McpManagementError(
      'mcp.request_invalid',
      `MCP server "${name}" uses a static bearer token`,
    );
  }
  if (config.headers !== undefined && config.auth !== 'oauth') {
    throw new McpManagementError(
      'mcp.request_invalid',
      `MCP server "${name}" uses static headers and is not marked for OAuth`,
    );
  }
  return config;
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

function mcpConfigWithoutName(server: GlobalMcpServerConfig): McpServerConfig {
  const { name: _name, ...config } = server;
  return config;
}

function serverNotFound(name: string): McpManagementError {
  return new McpManagementError('mcp.server_not_found', `MCP server "${name}" was not found`);
}

function toOAuthManagementError(error: unknown): McpManagementError {
  if (error instanceof McpManagementError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new McpManagementError('mcp.oauth_failed', message, { cause: error });
}
