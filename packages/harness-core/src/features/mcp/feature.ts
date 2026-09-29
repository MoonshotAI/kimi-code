import { homedir } from 'node:os';

import {
  AgentPort,
  ConfigRef,
  createFeature,
  useAgent,
  useConfigSection,
  useSession,
  type FeatureSpec,
  type SessionRecord,
  type ToolDefinition,
} from '@moonshot-ai/agent-core';
import {
  createToken,
  inject,
  pushCleanup,
  useCollection,
  useExpose,
  useFire,
  useNode,
  useReady,
  watch,
  type Unsubscribe,
} from '@moonshot-ai/agent-core/kernel/index';
import { join } from 'pathe';

import { loadMcpServers } from './config/loader';
import { MCP_CONFIG_SECTION, mcpConfigSection, type McpSection } from './config/section';
import { McpServerSources } from './config/sources';
import { McpUserConfigStore } from './config/store';
import { abortable } from './core/client-shared';
import {
  McpConnectionManager,
  type McpServerEntry,
} from './core/connection-manager';
import type { McpServerConfig } from './core/config-schema';
import { createMcpDeferredChannel, type McpDynamicToolEntry } from './deferred';
import { createMcpManagement } from './management';
import { McpOAuthService, type McpOAuthEvent } from './oauth/service';
import { canonicalMcpOAuthResource, createFileMcpOAuthStore } from './oauth/store';
import { createMcpAuthTool } from './tools/authenticate';
import { createMcpTool, planMcpToolRegistrations, reconnectForServer } from './tools/mcp-tool';
import type { CreateMcpProps, McpEvent, McpFacade } from './types';

export const McpRef = createToken<McpFacade>('mcp');

export function createMcp(props: CreateMcpProps = {}): FeatureSpec<McpEvent> {
  const shared: {
    manager?: McpConnectionManager;
    initialLoad?: Promise<void>;
    ephemeral: Map<string, { config: McpServerConfig; cwd?: string }>;
  } = { ephemeral: new Map() };
  return createFeature<McpEvent>('mcp', {
    app() {
      const node = useNode();
      const fire = useFire();
      useConfigSection(mcpConfigSection);
      const configEntries = node.providerRef(ConfigRef);
      const section = (): McpSection =>
        configEntries.value.at(-1)?.value.get<McpSection>(MCP_CONFIG_SECTION) ?? {};
      const workDir = props.workDir ?? process.cwd();
      const home = props.home ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
      const oauthService = new McpOAuthService({
        store: createFileMcpOAuthStore(join(home, 'credentials', 'mcp')),
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
      let sourceUnsubscribes: Unsubscribe[] = [];
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
      const management = createMcpManagement({
        home,
        workDir,
        trusted: props.trusted ?? false,
        servers: props.servers,
        ephemeral: shared.ephemeral,
        sources: () => sources.value,
        oauth: oauthService,
        store: new McpUserConfigStore(join(home, 'mcp.json')),
        createProbe: (stdioCwd) =>
          new McpConnectionManager({
            host: props.host,
            stdioCwd,
            oauthService,
            resolveDefaultTimeouts: () => section(),
          }),
        reload: reloadServers,
        disconnect: (name) => {
          shared.ephemeral.delete(name);
          return reloadServers();
        },
        ready: () => initialLoad,
      });
      const { dispose: disposeManagement, ...managementFace } = management;
      useExpose(McpRef, {
        list: () => manager.list(),
        reconnect: (name) => mutate(() => manager.reconnectAndJoin(name)),
        reload: reloadServers,
        connect: (name, config, opts) => {
          shared.ephemeral.set(name, { config, cwd: opts?.cwd });
          return reloadServers();
        },
        disconnect: (name) => {
          shared.ephemeral.delete(name);
          return reloadServers();
        },
        ...managementFace,
      });
      pushCleanup(node, () => {
        disposeManagement();
        unsubscribeOAuth();
        unsubscribeStatus();
        for (const unsubscribe of sourceUnsubscribes) unsubscribe();
        sourceUnsubscribes = [];
      });
      pushCleanup(node, async () => {
        await manager.shutdown();
        await oauthService.shutdown();
      });
    },
    agent() {
      const manager = shared.manager;
      const initialLoad = shared.initialLoad;
      if (manager === undefined || initialLoad === undefined) return;
      const node = useNode();
      const agent = useAgent();
      const session = useSession();
      const ports = inject(AgentPort);
      const fire = useFire();
      useReady(initialLoad);

      const sessionCwd = (): string | undefined => {
        if (props.sessionCwd !== undefined) return props.sessionCwd(session.sessionId);
        const meta = session.stores.session.getState().sessionMeta.value as
          | SessionRecord
          | undefined;
        const cwd = meta?.metadata?.['cwd'];
        return typeof cwd === 'string' ? cwd : undefined;
      };

      const visibleToSession = (name: string): boolean => {
        const cwd = shared.ephemeral.get(name)?.cwd;
        if (cwd === undefined) return true;
        return sessionCwd() === cwd;
      };

      const channel = createMcpDeferredChannel(agent);
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
      };

      const ownerOf = (qualified: string): string | undefined => {
        for (const [server, owned] of registrations) {
          if (owned.has(qualified)) return server;
        }
        return undefined;
      };

      const registerDefinitions = (server: string, definitions: readonly ToolDefinition[]): void => {
        const owned = new Map<string, () => void>();
        registrations.set(server, owned);
        for (const definition of definitions) {
          owned.set(definition.name, ports.registerTools([definition]));
        }
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
              mediaStore: props.mediaStore,
              providerType: () => agent.config?.model.provider,
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
        registerDefinitions(entry.name, definitions);
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
        registerDefinitions(entry.name, [tool]);
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

      pushCleanup(node, manager.onStatusChange(mirror));
      for (const entry of manager.list()) mirror(entry);
      void initialLoad.then(() => {
        initialPhase = false;
        syncDeferred();
      });
      agent.on('turn.started', () => {
        syncDeferred();
      });
      pushCleanup(node, () => {
        for (const server of [...registrations.keys()]) unregisterServer(server);
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
