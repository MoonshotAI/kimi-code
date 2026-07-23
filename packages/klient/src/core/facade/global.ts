/**
 * The `global` facade — aggregated, single-object-param methods over the
 * engine's app-scope services. Each method maps to one underlying service
 * call (except `env()`, which fans out and merges); the `Caller` underneath
 * applies contract validation and hands the call to the transport. Facade
 * code never sees service tokens, scope routing, or transport details.
 */

import type {
  SessionListQuery,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import type { SessionMeta } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { Page } from '@moonshot-ai/agent-core-v2/persistence/interface/queryStore';
import type {
  Workspace,
  WorkspaceUpdate,
} from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import type {
  ConfigDiagnostic,
  ConfigInspectValue,
  ConfigTarget,
} from '@moonshot-ai/agent-core-v2/app/config/config';
import type { ProviderConfig } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
import type {
  AuthStatus,
  IOAuthService,
} from '@moonshot-ai/agent-core-v2/app/auth/auth';
import type { ExperimentalFeatureState } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import type {
  FsBrowseResponse,
  FsHomeResponse,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import type { ModelRecord } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import type { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import type { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';

import type { AnonymousProviderInput, GenerateEvent, GenerateInput, GenerateParams, ProviderInput } from './kosong-types.js';
import type {
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from '@moonshot-ai/agent-core-v2/app/plugin/types';

/** Low-level caller the klient factory builds: routes + validates one service call. */
export type Caller = (service: string, method: string, args: unknown[]) => Promise<unknown>;

/** Scoped variant — the factory's real signature; global methods bind the core scope. */
export type ScopedCaller = (
  scope: { readonly sessionId?: string; readonly agentId?: string },
  service: string,
  method: string,
  args: unknown[],
) => Promise<unknown>;

/** Streaming variant of `ScopedCaller` — returns a validated `AsyncIterable`. */
export type ScopedStreamCaller = (
  scope: { readonly sessionId?: string; readonly agentId?: string },
  service: string,
  method: string,
  args: unknown[],
) => AsyncIterable<unknown>;

// ---------------------------------------------------------------------------
// Wire-type aliases for shapes the engine sources from `@moonshot-ai/protocol`
// (not a direct klient dependency) — derived through the service interfaces.
// ---------------------------------------------------------------------------

export type RefreshProviderModelsResponse = Awaited<
  ReturnType<IOAuthService['refreshOAuthProviderModels']>
>;
export type OAuthFlowStart = Awaited<ReturnType<IOAuthService['startLogin']>>;
export type OAuthFlowSnapshot = NonNullable<Awaited<ReturnType<IOAuthService['getFlow']>>>;
export type OAuthLoginCancelResponse = Awaited<ReturnType<IOAuthService['cancelLogin']>>;
export type OAuthLogoutResponse = Awaited<ReturnType<IOAuthService['logout']>>;

export type ModelCatalogItem = Awaited<ReturnType<IModelCatalog['listModels']>>[number];
export type ProviderCatalogItem = Awaited<
  ReturnType<IModelCatalog['listProviders']>
>[number];
export type SetDefaultModelResponse = Awaited<
  ReturnType<IModelCatalog['setDefaultModel']>
>;
export type RefreshProviderModelsOptions = NonNullable<
  Parameters<IProviderDiscoveryService['refreshProviderModels']>[0]
>;

/** String-literal form of the engine's `ConfigTarget` enum, so consumers never import the enum value. */
export type ConfigTargetLiteral = `${ConfigTarget}`;

// ---------------------------------------------------------------------------
// Facade interfaces
// ---------------------------------------------------------------------------

export interface GlobalSessionsFacade {
  list(query: SessionListQuery): Promise<Page<SessionSummary>>;
  get(id: string): Promise<SessionSummary | undefined>;
  countActive(workspaceIds: readonly string[]): Promise<number>;
  /**
   * Create a session rooted at `workDir` (the workspace is registered
   * implicitly), optionally titled. Returns the persisted metadata. No agent
   * is created — `session(id).agent('main')` materializes it on first use.
   */
  create(input: {
    workDir: string;
    additionalDirs?: readonly string[];
    title?: string;
  }): Promise<SessionMeta>;
}

export interface GlobalWorkspacesFacade {
  list(): Promise<readonly Workspace[]>;
  get(id: string): Promise<Workspace | undefined>;
  createOrTouch(input: { root: string; name?: string }): Promise<Workspace>;
  update(input: { id: string; patch: WorkspaceUpdate }): Promise<Workspace | undefined>;
  delete(id: string): Promise<void>;
}

export interface GlobalConfigFacade {
  get<T = unknown>(domain: string): Promise<T>;
  getAll(): Promise<Record<string, unknown>>;
  inspect<T = unknown>(domain: string): Promise<ConfigInspectValue<T>>;
  set(input: { domain: string; patch: unknown; target?: ConfigTargetLiteral }): Promise<void>;
  replace(input: {
    domain: string;
    value: unknown;
    target?: ConfigTargetLiteral;
  }): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): Promise<readonly ConfigDiagnostic[]>;
}

export interface GlobalKosongFacade {
  // -- Provider ---------------------------------------------------------
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(id: string): Promise<ProviderCatalogItem>;
  /** Add a named provider (string id + config) or an anonymous single-model provider (object). */
  addProvider(id: string, config: ProviderInput): Promise<void>;
  addProvider(config: AnonymousProviderInput): Promise<void>;
  removeProvider(id: string): Promise<void>;
  refreshProviders(opts?: RefreshProviderModelsOptions): Promise<RefreshProviderModelsResponse>;

  // -- Model ------------------------------------------------------------
  listModels(): Promise<readonly ModelCatalogItem[]>;
  setDefaultModel(id: string): Promise<SetDefaultModelResponse>;

  // -- Generate (streaming) -----------------------------------------------
  generate(
    modelId: string,
    input: GenerateInput,
    params?: GenerateParams,
  ): AsyncIterable<GenerateEvent>;
}

export interface GlobalAuthFacade {
  status(provider?: string): Promise<AuthStatus>;
  summarize(): Promise<readonly AuthStatus[]>;
  startLogin(provider?: string): Promise<OAuthFlowStart>;
  flow(provider?: string): Promise<OAuthFlowSnapshot | undefined>;
  cancelLogin(provider?: string): Promise<OAuthLoginCancelResponse>;
  logout(provider?: string): Promise<OAuthLogoutResponse>;
  /**
   * @deprecated Use `kosong.refreshProviders({ scope: 'oauth' })` — the
   * kosong facade owns provider-model refresh; this alias remains for one
   * release cycle.
   */
  refreshProviderModels(): Promise<RefreshProviderModelsResponse>;
}

export interface GlobalFlagsFacade {
  list(): Promise<readonly ExperimentalFeatureState[]>;
  enabled(id: string): Promise<boolean>;
  enabledIds(): Promise<readonly string[]>;
  explain(id: string): Promise<ExperimentalFeatureState | undefined>;
  snapshot(): Promise<Record<string, boolean>>;
}

export interface GlobalPluginsFacade {
  list(): Promise<readonly PluginSummary[]>;
  info(id: string): Promise<PluginInfo>;
  install(source: string): Promise<PluginSummary>;
  setEnabled(input: { id: string; enabled: boolean }): Promise<void>;
  setMcpServerEnabled(input: { id: string; server: string; enabled: boolean }): Promise<void>;
  remove(id: string): Promise<void>;
  reload(): Promise<ReloadSummary>;
  checkUpdates(): Promise<readonly PluginUpdateStatus[]>;
  listCommands(): Promise<readonly PluginCommandDef[]>;
}

export interface GlobalHostFsFacade {
  browse(absPath?: string): Promise<FsBrowseResponse>;
  home(): Promise<FsHomeResponse>;
}

/** Aggregated host/environment snapshot (`bootstrapService` properties). */
export interface KlientEnvInfo {
  readonly platform: string;
  readonly arch: string;
  readonly cwd: string;
  readonly osHomeDir: string;
  readonly homeDir: string;
  readonly configPath: string;
  readonly clientVersion: string;
  readonly sessionsDir: string;
  readonly blobsDir: string;
  readonly storeDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
}

export interface GlobalFacade {
  readonly sessions: GlobalSessionsFacade;
  readonly workspaces: GlobalWorkspacesFacade;
  readonly config: GlobalConfigFacade;
  readonly kosong: GlobalKosongFacade;
  readonly auth: GlobalAuthFacade;
  readonly flags: GlobalFlagsFacade;
  readonly plugins: GlobalPluginsFacade;
  readonly hostFs: GlobalHostFsFacade;
  env(): Promise<KlientEnvInfo>;
}

// ---------------------------------------------------------------------------
// Implementation — thin reshaping over `Caller`. Casts are safe by
// construction: the contract validates outputs, and type-parity assertions
// tie every contract schema to its engine type.
// ---------------------------------------------------------------------------

const ENV_PROPERTIES = [
  'platform',
  'arch',
  'cwd',
  'osHomeDir',
  'homeDir',
  'configPath',
  'clientVersion',
  'sessionsDir',
  'blobsDir',
  'storeDir',
  'cacheDir',
  'logsDir',
] as const;

export function createGlobalFacade(scoped: ScopedCaller, scopedStream: ScopedStreamCaller): GlobalFacade {
  const call: Caller = (service, method, args) => scoped({}, service, method, args);
  const streamCall = (service: string, method: string, args: unknown[]) =>
    scopedStream({}, service, method, args);
  // The bootstrap snapshot is frozen at process start, so the aggregated
  // env() result can never change — resolve it once and reuse the promise.
  let envPromise: Promise<KlientEnvInfo> | undefined;
  const env = (): Promise<KlientEnvInfo> => {
    envPromise ??= Promise.all(
      ENV_PROPERTIES.map((prop) => call('bootstrapService', prop, []) as Promise<string>),
    ).then(
      (values) =>
        Object.fromEntries(
          ENV_PROPERTIES.map((prop, index) => [prop, values[index]]),
        ) as unknown as KlientEnvInfo,
    );
    return envPromise;
  };

  return {
    sessions: {
      list: (query) => call('sessionIndex', 'list', [query]) as Promise<Page<SessionSummary>>,
      get: (id) => call('sessionIndex', 'get', [id]) as Promise<SessionSummary | undefined>,
      countActive: (workspaceIds) =>
        call('sessionIndex', 'countActive', [workspaceIds]) as Promise<number>,
      create: async ({ workDir, additionalDirs, title }) => {
        const handle = (await scoped({}, 'sessionLifecycleService', 'create', [
          { workDir, additionalDirs },
        ])) as { id: string };
        const scope = { sessionId: handle.id };
        if (title !== undefined) {
          await scoped(scope, 'sessionMetadata', 'setTitle', [title]);
        }
        return scoped(scope, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
      },
    },

    workspaces: {
      list: () => call('workspaceService', 'list', []) as Promise<readonly Workspace[]>,
      get: (id) => call('workspaceService', 'get', [id]) as Promise<Workspace | undefined>,
      createOrTouch: ({ root, name }) =>
        call('workspaceService', 'createOrTouch', [root, name]) as Promise<Workspace>,
      update: ({ id, patch }) =>
        call('workspaceService', 'update', [id, patch]) as Promise<Workspace | undefined>,
      delete: (id) => call('workspaceService', 'delete', [id]) as Promise<void>,
    },

    config: {
      get: <T>(domain: string) => call('configService', 'get', [domain]) as Promise<T>,
      getAll: () => call('configService', 'getAll', []) as Promise<Record<string, unknown>>,
      inspect: <T>(domain: string) =>
        call('configService', 'inspect', [domain]) as Promise<ConfigInspectValue<T>>,
      set: ({ domain, patch, target }) =>
        call('configService', 'set', [domain, patch, target]) as Promise<void>,
      replace: ({ domain, value, target }) =>
        call('configService', 'replace', [domain, value, target]) as Promise<void>,
      reload: () => call('configService', 'reload', []) as Promise<void>,
      diagnostics: () =>
        call('configService', 'diagnostics', []) as Promise<readonly ConfigDiagnostic[]>,
    },

    kosong: {
      listProviders: () =>
        call('modelResolver', 'listProviders', []) as Promise<
          readonly ProviderCatalogItem[]
        >,
      getProvider: (id) =>
        call('modelResolver', 'getProvider', [id]) as Promise<ProviderCatalogItem>,
      addProvider: ((
        idOrConfig: string | AnonymousProviderInput,
        maybeConfig?: ProviderInput,
      ): Promise<void> => {
        if (typeof idOrConfig === 'string') {
          // Named provider — map ProviderInput to ProviderConfig wire shape.
          const config = maybeConfig!;
          const wire: ProviderConfig = {
            type: config.type,
            baseUrl: config.baseUrl,
            defaultModel: config.defaultModel,
            apiKey: config.auth.method === 'api-key' ? config.auth.apiKey : '',
          };
          return call('providerService', 'set', [idOrConfig, wire]) as Promise<void>;
        }
        // Anonymous provider — map AnonymousProviderInput to ModelRecord wire shape.
        const anon = idOrConfig;
        const capabilities = anon.capabilities
          ? Object.entries(anon.capabilities)
              .filter(([, v]) => v)
              .map(([k]) => k)
          : undefined;
        const wire: ModelRecord = {
          model: anon.model,
          protocol: anon.protocol as ModelRecord['protocol'],
          baseUrl: anon.baseUrl,
          apiKey: anon.auth.method === 'api-key' ? anon.auth.apiKey : '',
          displayName: anon.displayName,
          maxContextSize: anon.maxContextSize,
          capabilities,
        };
        return call('modelService', 'set', [anon.id, wire]) as Promise<void>;
      }) as GlobalKosongFacade['addProvider'],
      removeProvider: async (id) => {
        // Try provider registry first; fall back to model registry.
        const existing = await call('providerService', 'get', [id]);
        if (existing !== undefined) {
          return call('providerService', 'delete', [id]) as Promise<void>;
        }
        return call('modelService', 'delete', [id]) as Promise<void>;
      },
      refreshProviders: (opts) =>
        call('providerDiscovery', 'refreshProviderModels', [
          opts,
        ]) as Promise<RefreshProviderModelsResponse>,

      listModels: () =>
        call('modelResolver', 'listModels', []) as Promise<readonly ModelCatalogItem[]>,
      setDefaultModel: (id) =>
        call('modelResolver', 'setDefaultModel', [id]) as Promise<SetDefaultModelResponse>,

      generate: (modelId, input, params) =>
        streamCall('modelResolver', 'generate', [modelId, input, params]) as AsyncIterable<GenerateEvent>,
    },

    auth: {
      status: (provider) => call('oauthService', 'status', [provider]) as Promise<AuthStatus>,
      summarize: () => call('authSummaryService', 'summarize', []) as Promise<readonly AuthStatus[]>,
      startLogin: (provider) =>
        call('oauthService', 'startLogin', [provider]) as Promise<OAuthFlowStart>,
      flow: (provider) =>
        call('oauthService', 'getFlow', [provider]) as Promise<OAuthFlowSnapshot | undefined>,
      cancelLogin: (provider) =>
        call('oauthService', 'cancelLogin', [provider]) as Promise<OAuthLoginCancelResponse>,
      logout: (provider) =>
        call('oauthService', 'logout', [provider]) as Promise<OAuthLogoutResponse>,
      refreshProviderModels: () =>
        call('oauthService', 'refreshOAuthProviderModels', []) as Promise<RefreshProviderModelsResponse>,
    },

    flags: {
      list: () => call('flagService', 'explainAll', []) as Promise<readonly ExperimentalFeatureState[]>,
      enabled: (id) => call('flagService', 'enabled', [id]) as Promise<boolean>,
      enabledIds: () => call('flagService', 'enabledIds', []) as Promise<readonly string[]>,
      explain: (id) =>
        call('flagService', 'explain', [id]) as Promise<ExperimentalFeatureState | undefined>,
      snapshot: () => call('flagService', 'snapshot', []) as Promise<Record<string, boolean>>,
    },

    plugins: {
      list: () => call('pluginService', 'listPlugins', []) as Promise<readonly PluginSummary[]>,
      info: (id) => call('pluginService', 'getPluginInfo', [{ id }]) as Promise<PluginInfo>,
      install: (source) =>
        call('pluginService', 'installPlugin', [{ source }]) as Promise<PluginSummary>,
      setEnabled: (input) => call('pluginService', 'setPluginEnabled', [input]) as Promise<void>,
      setMcpServerEnabled: (input) =>
        call('pluginService', 'setPluginMcpServerEnabled', [input]) as Promise<void>,
      remove: (id) => call('pluginService', 'removePlugin', [{ id }]) as Promise<void>,
      reload: () => call('pluginService', 'reloadPlugins', []) as Promise<ReloadSummary>,
      checkUpdates: () =>
        call('pluginService', 'checkUpdates', []) as Promise<readonly PluginUpdateStatus[]>,
      listCommands: () =>
        call('pluginService', 'listPluginCommands', []) as Promise<readonly PluginCommandDef[]>,
    },

    hostFs: {
      browse: (absPath) =>
        call('hostFolderBrowser', 'browse', [absPath]) as Promise<FsBrowseResponse>,
      home: () => call('hostFolderBrowser', 'home', []) as Promise<FsHomeResponse>,
    },

    env,
  };
}
