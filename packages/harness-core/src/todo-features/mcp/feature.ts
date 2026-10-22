import { createFeature, useAgent, useApp, useSession, type Feature, useAgentRuntime, useLoopEvent } from '#/app/index';
import {
  createFacadeToken,
  useCleanup,
  useCollection,
  useExpose,
  useFire,
  useInject,
  useReady,
  watch,
} from '#/composition-api/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';
import { join } from 'pathe';

import { ConfigRef, useConfigSection } from '#/todo-features/config/index';
import { KimiFileRegistryRef } from '#/todo-features/files/index';

import type { AgentRuntime } from '#/runtime/index';

import { loadMcpServers, loadMcpServersDetailed, resolveMcpJsonPaths } from './config/loader';
import { MCP_CONFIG_SECTION, mcpConfigSection, type McpSection } from './config/section';
import { McpServerSources } from './config/sources';
import {
  McpUserConfigStore,
  normalizeServerName,
  type GlobalMcpServerConfig,
} from './config/store';
import { abortable } from './core/client-shared';
import { McpServerConfigSchema, type McpServerConfig } from './core/config-schema';
import { toMcpServerConfigView } from './core/config-view';
import {
  McpConnectionManager,
  type McpServerEntry,
} from './core/connection-manager';
import { createMcpDeferredChannel, type McpDynamicToolEntry } from './deferred';
import { McpManagementError } from './errors';
import type {
  McpAuthStatusQuery,
  McpManagedServer,
  McpRegistryQuery,
  McpServerAuthBeginResult,
  McpServerAuthFlowHandle,
  McpServerAuthState,
  McpServerAuthStatus,
  McpServerInspection,
  McpServerLocator,
  McpServerTestResult,
  McpServerTestTarget,
} from './management';
import {
  AlreadyAuthorizedError,
  McpOAuthService,
  type BeginAuthorizationResult,
  type McpOAuthEvent,
  type McpOAuthTokenState,
} from './oauth/service';
import {
  canonicalMcpOAuthResource,
  createFileMcpOAuthStore,
  createMemoryMcpOAuthStore,
} from './oauth/store';
import { createMcpAuthTool } from './tools/authenticate';
import { createMcpTool, planMcpToolRegistrations, reconnectForServer } from './tools/mcp-tool';
import type { CreateMcpProps, McpEvent, McpFacade, McpMediaStore, McpOAuthAuthorizationUrlEvent } from './types';

export const McpRef = createFacadeToken<McpFacade>('mcp');

function syncMcpAgentTools(agent: Agent, runtime: AgentRuntime): void {
  const descriptions = [...runtime.tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    deferred: tool.deferred,
  }));
  const ack = agent.loop.setTools(descriptions);
  if (ack?.type !== 'tools.rejected') return;
  const unsubscribe = agent.loop.subscribe((event) => {
    if (event.type !== 'step.ended' && event.type !== 'turn.ended') return;
    unsubscribe();
    queueMicrotask(() => {
      syncMcpAgentTools(agent, runtime);
    });
  });
}

interface McpRegistryEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly source: 'global' | 'plugin' | 'caller';
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

const _HOME: string | undefined = undefined;

export function createMcp(props: CreateMcpProps = {}): Feature<void, { app: McpEvent; agent: McpOAuthAuthorizationUrlEvent }> {
  const shared: {
    manager?: McpConnectionManager;
    initialLoad?: Promise<void>;
    ephemeral: Map<string, { config: McpServerConfig; cwd?: string }>;
  } = { ephemeral: new Map() };
  return createFeature<{ app: McpEvent; agent: McpOAuthAuthorizationUrlEvent }>('mcp', {
    app() {
      const fire = useFire();
      useConfigSection(mcpConfigSection);
      const config = useInject(ConfigRef);
      const section = (): McpSection =>
        config.value?.get<McpSection>(MCP_CONFIG_SECTION) ?? {};
      const workDir = props.workDir ?? process.cwd();
      const home = props.HOME ?? _HOME;
      const oauthService = new McpOAuthService({
        store:
          home === undefined || props.host === undefined
            ? createMemoryMcpOAuthStore()
            : createFileMcpOAuthStore(join(home, 'credentials', 'mcp'), props.host.fs),
      });
      const manager = new McpConnectionManager({
        host: props.host,
        stdioCwd: workDir,
        oauthService,
        resolveDefaultTimeouts: () => section(),
      });
      shared.manager = manager;
      const sources = useCollection(McpServerSources);
      const loadServers = async (): Promise<Record<string, McpServerConfig>> => {
        const contributed = await Promise.all(
          sources.value.map(async (source) => {
            try {
              return await source.load();
            } catch {
              return {};
            }
          }),
        );
        return {
          ...Object.fromEntries(
            [...shared.ephemeral].map(([name, entry]) => [name, entry.config]),
          ),
          ...Object.assign({}, ...contributed),
          ...(await loadMcpServers({
            fs: props.host?.fs,
            cwd: workDir,
            home,
            trusted: props.trusted ?? false,
            servers: props.servers,
          })),
        };
      };
      const unsubscribeOAuth = oauthService.onEvent((event) => {
        void handleMcpOAuthEvent(manager, oauthService, event).catch(() => undefined);
      });
      const unsubscribeStatus = manager.onStatusChange((entry) => {
        fire({
          type: 'mcp.server.state',
          server: entry.name,
          state: entry.status,
          error: entry.error,
        });
      });
      const initialLoad = (async () => {
        try {
          const servers = await loadServers();
          if (Object.keys(servers).length > 0) await manager.connectAll(servers);
        } catch {
        }
      })();
      shared.initialLoad = initialLoad;
      void oauthService.sweepProactiveRefresh().catch(() => undefined);
      let mutationTail: Promise<void> = Promise.resolve();
      const mutate = (work: () => Promise<void>): Promise<void> => {
        const tail = mutationTail.catch(() => undefined).then(work);
        mutationTail = tail;
        return tail;
      };
      const reloadServers = (): Promise<void> =>
        mutate(async () => {
          const next = await loadServers();
          for (const entry of manager.list()) {
            if (!Object.prototype.hasOwnProperty.call(next, entry.name)) {
              await manager.markRemoved(entry.name);
            }
          }
          for (const [name, config] of Object.entries(next)) {
            await manager.connect(name, config);
          }
        });
      let sourceUnsubscribes: (() => void)[] = [];
      const syncSourceSubscriptions = (): void => {
        for (const unsubscribe of sourceUnsubscribes) unsubscribe();
        sourceUnsubscribes = [];
        for (const source of sources.value) {
          const unsubscribe = source.onDidChange?.(() => {
            void reloadServers();
          });
          if (unsubscribe !== undefined) sourceUnsubscribes.push(unsubscribe);
        }
      };
      syncSourceSubscriptions();
      watch(sources, () => {
        syncSourceSubscriptions();
        void reloadServers();
      });
      const userStore =
        home === undefined || props.host === undefined
          ? undefined
          : new McpUserConfigStore(join(home, 'mcp.json'), props.host.fs);
      const authFlows = new Map<
        string,
        { flow: BeginAuthorizationResult; idleTimer: NodeJS.Timeout }
      >();

      const _createProbe = (stdioCwd: string): McpConnectionManager =>
        new McpConnectionManager({
          host: props.host,
          stdioCwd,
          oauthService,
          resolveDefaultTimeouts: () => section(),
        });

      const disconnect = (name: string): Promise<void> => {
        shared.ephemeral.delete(name);
        return reloadServers();
      };

      const _buildRegistry = async (query: McpRegistryQuery = {}): Promise<McpRegistryEntry[]> => {
        const cwd = query.cwd ?? workDir;
        const detailed = await loadMcpServersDetailed({
          fs: props.host?.fs,
          cwd,
          home,
          trusted: props.trusted ?? false,
          servers: props.servers,
        });
        const paths = await resolveMcpJsonPaths(props.host?.fs, cwd, home);
        const entries: McpRegistryEntry[] = [];
        for (const [name, serverConfig] of Object.entries(detailed.servers)) {
          const origin = detailed.origins[name] ?? paths.projectRoot;
          entries.push({
            name,
            config: serverConfig,
            source: 'global',
            origin,
            mutable: paths.user !== undefined && origin === paths.user,
          });
        }
        const contributed = await Promise.all(
          sources.value.map(async (source) => {
            try {
              return { source, servers: await source.load() };
            } catch {
              return { source, servers: {} as Record<string, McpServerConfig> };
            }
          }),
        );
        for (const { source, servers } of contributed) {
          for (const [name, serverConfig] of Object.entries(servers)) {
            entries.push({ name, config: serverConfig, source: 'plugin', origin: source.id, mutable: false });
          }
        }
        for (const [name, entry] of shared.ephemeral) {
          entries.push({ name, config: entry.config, source: 'caller', origin: 'caller', mutable: false });
        }
        return entries;
      };

      const _requireStore = (): McpUserConfigStore => {
        if (userStore === undefined) {
          throw new McpManagementError(
            'mcp.user_store_unavailable',
            'MCP user config store is unavailable without a home directory and fs port.',
          );
        }
        return userStore;
      };

      const _guardMutation = async (name: string, query: McpRegistryQuery): Promise<void> => {
        const matches = (await _buildRegistry(query)).filter((entry) => entry.name === name);
        for (const entry of matches) {
          if (entry.source === 'global' && !entry.mutable) {
            throw new McpManagementError(
              'mcp.request_invalid',
              `MCP server "${entry.name}" is read-only: it is defined in ${entry.origin} — edit that file instead`,
            );
          }
        }
      };

      const listServers = async (
        query: McpRegistryQuery = {},
      ): Promise<readonly McpManagedServer[]> =>
        (await _buildRegistry(query)).map(toManagedServer);

      const getServer = async (name: string, query: McpRegistryQuery = {}): Promise<McpManagedServer> => {
        const entry = (await _buildRegistry(query)).find((candidate) => candidate.name === name);
        if (entry !== undefined) return toManagedServer(entry);
        throw serverNotFound(name);
      };

      const addServer = async (
        server: GlobalMcpServerConfig,
        query: McpRegistryQuery = {},
      ): Promise<readonly McpManagedServer[]> => {
        const name = normalizeServerName(server.name);
        await _guardMutation(name, query);
        await _requireStore().add({ ...server, name });
        await reloadServers();
        return listServers(query);
      };

      const updateServer = async (
        server: GlobalMcpServerConfig,
        query: McpRegistryQuery = {},
      ): Promise<readonly McpManagedServer[]> => {
        const name = normalizeServerName(server.name);
        await _guardMutation(name, query);
        await _requireStore().update({ ...server, name });
        await reloadServers();
        return listServers(query);
      };

      const removeServer = async (
        name: string,
        query: McpRegistryQuery = {},
      ): Promise<readonly McpManagedServer[]> => {
        const normalized = normalizeServerName(name);
        const primary = (await _buildRegistry(query)).find((entry) => entry.name === normalized);
        if (primary?.source === 'caller') {
          await disconnect(normalized);
          return listServers(query);
        }
        await _guardMutation(normalized, query);
        await _requireStore().remove(normalized);
        await reloadServers();
        return listServers(query);
      };

      const _resolveTestTarget = async (target: McpServerTestTarget): Promise<GlobalMcpServerConfig> => {
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
        const matches = (await _buildRegistry({ cwd })).filter((entry) => entry.name === name);
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
        await initialLoad;
        const resolved = await _resolveTestTarget(target);
        const probe = _createProbe(target.cwd ?? workDir);
        try {
          await probe.connectAll({ [resolved.name]: mcpConfigWithoutName(resolved) });
          return standaloneTestResult(resolved.name, probe);
        } finally {
          await probe.shutdown();
        }
      };

      const _serverDescriptors = async (
        query: McpRegistryQuery = {},
      ): Promise<readonly McpServerRuntimeDescriptor[]> =>
        (await _buildRegistry(query))
          .filter((entry) => entry.source !== 'caller')
          .map(serverDescriptor);

      const _inspectServerDescriptors = async (
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
          const serverConfig = requireRemoteMcpConfig(server.runtimeName, server.config);
          credentialStates.set(
            server.serverId,
            await oauthService.tokenState(server.runtimeName, serverConfig.url),
          );
          probeConfigs[server.runtimeName] = server.config;
        }
        let probe: McpConnectionManager | undefined;
        try {
          if (Object.keys(probeConfigs).length > 0) {
            probe = _createProbe(workDir);
            await probe.connectAll(probeConfigs);
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
            const entry = probe?.get(server.runtimeName);
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
          await probe?.shutdown();
        }
      };

      const inspectServers = async (
        targets?: readonly McpServerLocator[],
        query: McpRegistryQuery = {},
      ): Promise<readonly McpServerInspection[]> => {
        await initialLoad;
        const catalog = await _serverDescriptors(query);
        const descriptors = selectServerDescriptors(catalog, targets);
        const inspections = await _inspectServerDescriptors(descriptors, catalog);
        return inspections.map((inspection) => ({
          ...inspection,
          config: toMcpServerConfigView(inspection.config),
        }));
      };

      const _serverAuthState = async (
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
        const tokens = await oauthService.tokenState(entry.name, server.url);
        const offline = (): McpServerAuthState => {
          if (tokens.hasTokens) {
            return !tokens.expired || tokens.hasRefreshToken ? 'oauth-authorized' : 'oauth-expired';
          }
          return server.auth === 'oauth' ? 'oauth-required' : 'not-applicable';
        };

        const probeAuth = async (): Promise<McpServerAuthState> => {
          const probe = _createProbe(cwd ?? workDir);
          try {
            await probe.connectAll({ [entry.name]: server });
            const status = probe.get(entry.name)?.status;
            if (status === 'connected') return tokens.hasTokens ? 'oauth-authorized' : 'not-applicable';
            if (status === 'needs-auth') return tokens.hasTokens ? 'oauth-expired' : 'oauth-required';
            return offline();
          } finally {
            await probe.shutdown();
          }
        };

        if (verify === true) return probeAuth();
        if (verify === false || tokens.hasTokens || server.auth === 'oauth') return offline();
        return probeAuth();
      };

      const listAuthStatuses = async (
        query: McpAuthStatusQuery = {},
      ): Promise<readonly McpServerAuthStatus[]> => {
        await initialLoad;
        const entries = await _buildRegistry({ cwd: query.cwd });
        return Promise.all(
          entries.map(async (entry) => ({
            name: entry.name,
            authStatus: await _serverAuthState(entry, query.cwd, query.verify),
          })),
        );
      };

      const _requireUnambiguousRuntimeName = (
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

      const _resolveServer = async (
        locator: McpServerLocator,
        query: McpRegistryQuery,
      ): Promise<McpServerRuntimeDescriptor> => {
        const catalog = await _serverDescriptors(query);
        const server = selectServerDescriptors(catalog, [locator])[0]!;
        _requireUnambiguousRuntimeName(catalog, server);
        return server;
      };

      const beginServerAuth = async (
        locator: McpServerLocator,
        query: McpRegistryQuery = {},
      ): Promise<McpServerAuthBeginResult> => {
        await initialLoad;
        const server = await _resolveServer(locator, query);
        const serverConfig = requireOAuthMcpConfig(server.runtimeName, server.config);
        let flow: BeginAuthorizationResult;
        try {
          flow = await oauthService.beginAuthorization(server.runtimeName, serverConfig.url);
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
        await initialLoad;
        const server = await _resolveServer(locator, query);
        const serverConfig = requireRemoteMcpConfig(server.runtimeName, server.config);
        try {
          await oauthService.invalidate(server.runtimeName, serverConfig.url);
        } catch (error) {
          throw toOAuthManagementError(error);
        }
      };

      const _dispose = (): void => {
        for (const active of authFlows.values()) {
          clearTimeout(active.idleTimer);
          void active.flow.cancel();
        }
        authFlows.clear();
      };

      useExpose(McpRef, {
        list: () => manager.list(),
        reconnect: (name) => mutate(() => manager.reconnectAndJoin(name)),
        reload: reloadServers,
        connect: (name, serverConfig, opts) => {
          shared.ephemeral.set(name, { config: serverConfig, cwd: opts?.cwd });
          return reloadServers();
        },
        disconnect,
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
      });
      useCleanup(() => {
        _dispose();
        unsubscribeOAuth();
        unsubscribeStatus();
        for (const unsubscribe of sourceUnsubscribes) unsubscribe();
        sourceUnsubscribes = [];
        if (shared.manager === manager) {
          shared.manager = undefined;
          shared.initialLoad = undefined;
        }
      });
      useCleanup(async () => {
        await manager.shutdown();
        await oauthService.shutdown();
      });
    },
    agent() {
      const manager = shared.manager;
      const initialLoad = shared.initialLoad;
      if (manager === undefined || initialLoad === undefined) return;
      const agent = useAgent();
      const session = useSession();
      const app = useApp();
      const runtime = useAgentRuntime();
      const fire = useFire();
      useReady(initialLoad);

      const registry = useInject(KimiFileRegistryRef);
      const mediaStore = (): McpMediaStore | undefined => {
        if (props.mediaStore !== undefined) return props.mediaStore;
        return agent.loop.policy.resolvers.some((resolver) => resolver.id === 'store-ref')
          ? registry.value
          : undefined;
      };

      let disposed = false;
      let sessionCwdValue: string | undefined;
      const sessionCwd = (): string | undefined => {
        if (props.sessionCwd !== undefined) return props.sessionCwd(session.id);
        return sessionCwdValue;
      };

      const visibleToSession = (name: string): boolean => {
        const cwd = shared.ephemeral.get(name)?.cwd;
        if (cwd === undefined) return true;
        return sessionCwd() === cwd;
      };

      const channel = createMcpDeferredChannel(agent.loop);
      const dynamic = new Map<string, McpDynamicToolEntry>();
      const registrations = new Map<string, Map<string, () => void>>();
      let initialPhase = true;

      const syncDeferred = (): void => {
        channel.sync([...dynamic.values()]);
      };

      const unregisterServer = (server: string): void => {
        const owned = registrations.get(server);
        if (owned === undefined) return;
        registrations.delete(server);
        for (const unregister of owned.values()) unregister();
        for (const name of owned.keys()) dynamic.delete(name);
        syncMcpAgentTools(agent, runtime);
      };

      const ownerOf = (qualified: string): string | undefined => {
        for (const [server, owned] of registrations) {
          if (owned.has(qualified)) return server;
        }
        return undefined;
      };

      const registerDefinitions = (
        server: string,
        definitions: readonly ToolDefinition[],
        deferred: boolean,
      ): void => {
        const owned = new Map<string, () => void>();
        registrations.set(server, owned);
        for (const definition of definitions) {
          const dispose = runtime.executor.register(definition);
          if (deferred) {
            owned.set(definition.name, dispose);
            continue;
          }
          runtime.tools.set(definition.name, definition);
          owned.set(definition.name, () => {
            dispose();
            if (runtime.tools.get(definition.name) === definition) {
              runtime.tools.delete(definition.name);
            }
          });
        }
        syncMcpAgentTools(agent, runtime);
      };

      const mirrorConnected = (entry: McpServerEntry): void => {
        const resolved = manager.resolved(entry.name);
        if (resolved === undefined) return;
        unregisterServer(entry.name);
        const markDeferred = resolved.deferred || !initialPhase;
        const { planned } = planMcpToolRegistrations(
          entry.name,
          resolved.tools.map((tool) => tool.name),
          resolved.enabledNames,
          ownerOf,
        );
        const byName = new Map(resolved.tools.map((tool) => [tool.name, tool]));
        const definitions: ToolDefinition[] = [];
        for (const { qualified, toolName } of planned) {
          const tool = byName.get(toolName);
          if (tool === undefined) continue;
          definitions.push(
            createMcpTool(qualified, tool, resolved.client, {
              mediaStore,
              providerType: props.providerType,
              reconnect: (signal) => reconnectForServer(manager, entry.name, resolved.client, signal),
              isRemoved: () => manager.get(entry.name)?.status === 'removed',
              deferred: markDeferred,
            }),
          );
          if (markDeferred) {
            dynamic.set(qualified, {
              serverName: entry.name,
              description: {
                name: qualified,
                description: tool.description,
                parameters: tool.parameters,
              },
            });
          }
        }
        registerDefinitions(entry.name, definitions, markDeferred);
        syncDeferred();
      };

      const mirrorNeedsAuth = (entry: McpServerEntry): void => {
        unregisterServer(entry.name);
        const oauthService = manager.oauthService;
        const serverUrl = manager.getRemoteServerUrl(entry.name);
        if (oauthService === undefined || serverUrl === undefined) return;
        const markDeferred = manager.configOf(entry.name)?.deferred === true || !initialPhase;
        const tool = createMcpAuthTool({
          serverName: entry.name,
          serverUrl,
          oauthService,
          reconnect: (signal) =>
            signal === undefined
              ? manager.reconnectAndJoin(entry.name)
              : abortable(manager.reconnectAndJoin(entry.name), signal),
          onAuthorizationUrl: (authorizationUrl, expiresAt) => {
            fire({
              type: 'mcp.oauth.authorization_url',
              server: entry.name,
              authorizationUrl,
              expiresAt,
            });
          },
          deferred: markDeferred,
        });
        registerDefinitions(entry.name, [tool], markDeferred);
        if (markDeferred) {
          dynamic.set(tool.name, {
            serverName: entry.name,
            description: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          });
        }
        syncDeferred();
      };

      const mirror = (entry: McpServerEntry): void => {
        if (disposed) return;
        if (!visibleToSession(entry.name)) {
          unregisterServer(entry.name);
          syncDeferred();
          return;
        }
        if (entry.status === 'connected') {
          mirrorConnected(entry);
          return;
        }
        if (entry.status === 'needs-auth') {
          mirrorNeedsAuth(entry);
          return;
        }
        if (entry.status === 'disabled') {
          unregisterServer(entry.name);
          syncDeferred();
        }
      };

      useCleanup(manager.onStatusChange(mirror));
      for (const entry of manager.list()) mirror(entry);
      void initialLoad.then(() => {
        initialPhase = false;
        syncDeferred();
      });
      if (props.sessionCwd === undefined) {
        void app.space.get(session.id).then((record) => {
          if (disposed) return;
          const cwd = record?.metadata?.['cwd'];
          sessionCwdValue = typeof cwd === 'string' ? cwd : undefined;
          if (sessionCwdValue === undefined) return;
          for (const entry of manager.list()) {
            if (shared.ephemeral.get(entry.name)?.cwd !== undefined) mirror(entry);
          }
        }, () => undefined);
      }
      useLoopEvent('turn.started', () => {
        queueMicrotask(() => {
          if (!disposed) syncDeferred();
        });
      });
      useCleanup(() => {
        disposed = true;
        for (const server of registrations.keys()) unregisterServer(server);
      });
    },
  });
}

async function handleMcpOAuthEvent(
  manager: McpConnectionManager,
  oauthService: McpOAuthService,
  event: McpOAuthEvent,
): Promise<void> {
  if (event.type === 'tokens-invalidated' && event.scope !== 'tokens' && event.scope !== 'all') {
    return;
  }
  const entry = manager.get(event.serverName);
  if (entry === undefined) return;
  const serverUrl = manager.getRemoteServerUrl(event.serverName);
  if (serverUrl === undefined || canonicalMcpOAuthResource(serverUrl) !== event.serverUrl) return;
  if (event.type === 'tokens-invalidated') {
    oauthService.forgetProvider(event.serverName, event.serverUrl);
  }
  if (entry.status === 'disabled' || entry.status === 'removed') return;
  if (entry.status === 'pending') {
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = (): void => {};
      let settled = false;
      const reconnect = (next: McpServerEntry | undefined): void => {
        if (settled) return;
        if (next !== undefined && (next.name !== event.serverName || next.status === 'pending')) {
          return;
        }
        settled = true;
        unsubscribe();
        if (next === undefined || next.status === 'disabled' || next.status === 'removed') {
          resolve();
          return;
        }
        void manager.reconnectAfterCurrent(event.serverName).then(resolve, reject);
      };
      unsubscribe = manager.onStatusChange(reconnect);
      if (settled) unsubscribe();
      else reconnect(manager.get(event.serverName));
    });
    return;
  }
  if (
    event.type === 'tokens-saved' &&
    entry.status !== 'needs-auth' &&
    entry.status !== 'failed'
  ) {
    return;
  }
  if (event.type === 'refresh-failed' && entry.status !== 'connected') return;
  await manager.reconnectAndJoin(event.serverName);
}
