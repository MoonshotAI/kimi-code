import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { ErrorCodes, KimiError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import { PluginManager } from '#/plugin';
import { LocalFetchURLProvider } from '#/tools/providers/local-fetch-url';
import { MoonshotFetchURLProvider } from '#/tools/providers/moonshot-fetch-url';
import { MoonshotWebSearchProvider } from '#/tools/providers/moonshot-web-search';
import { ImageLimits } from '#/tools/support/image-limits';
import type { PromisableMethods } from '#/utils/types';
import { getCoreVersion } from '#/version';
import { resolveThinkingEffort } from '../agent/config/thinking';
import { Agent } from '../agent';
import { limitAgentReplayByTurns } from '../agent/replay/turns';
import {
  applyPrintModeConfigDefaults,
  ensureKimiHome,
  loadRuntimeConfigSafe,
  mergeConfigPatch,
  migrateThinkingEffortMaxToHigh,
  readConfigFileForUpdate,
  normalizeAdditionalDirs,
  readWorkspaceAdditionalDirs,
  resolveWorkspaceAdditionalDirs,
  resolveConfigPath,
  resolveKimiHome,
  writeConfigFile,
  type KimiConfig,
  type McpRemoteServerConfig,
  McpServerConfigSchema,
  type McpServerConfig,
  type MoonshotServiceConfig,
} from '../config';
import {
  FLAG_DEFINITIONS,
  FlagResolver,
  type ExperimentalFeatureState,
} from '../flags';
import type { Logger } from '../logging/types';
import {
  AlreadyAuthorizedError,
  canonicalMcpOAuthResource,
  GlobalMcpConfigStore,
  McpConnectionManager,
  McpOAuthService,
  McpServerRegistry,
  mcpServerConfigsEqual,
  resolveMcpStartupTimeoutMs,
  resolveMcpToolTimeoutMs,
  resolveSessionMcpConfig,
  mergeCallerMcpServers,
  normalizeServerName,
  toMcpServerConfigView,
  type BeginAuthorizationResult,
  type McpOAuthTokenState,
  type McpRegistryEntry,
  type McpServerSource,
  type SessionMcpConfig,
} from '../mcp';
import { SessionAgentProfileCatalog } from '../profile';
import { Session, type SessionMeta, type SessionSkillConfig } from '../session';
import { exportSessionDirectory } from '../session/export';
import { resolveMainAgentProfile } from '../session/main-agent-profile';
import {
  registerBuiltinSkills,
  SessionSkillRegistry,
  resolveSkillRoots,
  summarizeSkill,
} from '../skill';
import {
  ProviderManager, type BearerTokenProvider,
  type OAuthTokenProviderResolver
} from '../session/provider-manager';
import { SessionAPIImpl } from '../session/rpc';
import { normalizeWorkDir, SessionStore } from '../session/store/index';
import { touchWorkspaceRegistry } from '../session/store/workspace-registry-file';
import {
  noopTelemetryClient,
  withTelemetryContext,
  withTelemetryProperties,
  type TelemetryClient,
  type TelemetryProperties,
} from '../telemetry';
import type { CoreRPCClient } from './client';
import type {
  ActivateSkillPayload,
  ActivatePluginCommandPayload,
  AddAdditionalDirPayload,
  AddAdditionalDirResult,
  AddSessionMcpServerPayload,
  AppMcpServerConfig,
  AppMcpServerDescriptor,
  AppMcpServerInspection,
  ArchiveSessionPayload,
  BeginGlobalMcpServerAuthResult,
  BeginCompactionPayload,
  CancelGlobalMcpServerAuthPayload,
  CancelPayload,
  CancelPlanPayload,
  CancelShellCommandPayload,
  CloseSessionPayload,
  CompleteGlobalMcpServerAuthPayload,
  ConfigDiagnostics,
  CoreAPI,
  CoreInfo,
  CreateGoalPayload,
  CreateSessionPayload,
  DeleteSessionPayload,
  DetachBackgroundPayload,
  ClientTelemetryInfo,
  EmptyPayload,
  EnterSwarmPayload,
  GetGlobalMcpServerPayload,
  GoalSnapshot,
  GoalToolResult,
  GlobalMcpServerAuthState,
  GlobalMcpServerAuthStatus,
  GlobalMcpServerConfig,
  GlobalMcpServerNamePayload,
  GlobalMcpServerTestResult,
  ExportSessionPayload,
  ExportSessionResult,
  ForkSessionPayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
  GetCronTasksResult,
  GetKimiConfigPayload,
  GetPluginInfoPayload,
  InstallPluginPayload,
  ImportContextPayload,
  InspectAppMcpServersPayload,
  ListGlobalMcpServerAuthStatusesPayload,
  ListGlobalMcpServersPayload,
  ListSessionsPayload,
  ListWorkspaceSkillsPayload,
  McpManagedServerInfo,
  McpServerInfo,
  McpServerLocator,
  McpServerLocatorPayload,
  McpStartupMetrics,
  PluginInfo,
  PluginSummary,
  PromptPayload,
  PutGlobalMcpServerPayload,
  RunShellCommandPayload,
  ReconnectMcpServerPayload,
  RegisterToolPayload,
  ReloadSessionPayload,
  ReloadPluginsResult,
  RemoveKimiProviderPayload,
  RemovePluginPayload,
  RenameSessionPayload,
  ResumeSessionPayload,
  SessionSummary,
  SetActiveToolsPayload,
  SetKimiConfigPayload,
  SetModelPayload,
  SetModelResult,
  SetPermissionPayload,
  SetPluginEnabledPayload,
  SetPluginMcpServerEnabledPayload,
  SetThinkingPayload,
  SkillSummary,
  PluginCommandDef,
  SteerPayload,
  StopBackgroundPayload,
  TestGlobalMcpServerPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
  UpdateSessionMetadataPayload,
} from './core-api';
import type { ResumedAgentState, ResumeSessionResult } from './resumed';
import type { SDKRPC } from './sdk-api';
import type { SessionWarning } from '@moonshot-ai/protocol';
import { proxyWithExtraPayload } from './types';
import { KaosShellNotFoundError, LocalKaos, type Kaos } from '@moonshot-ai/kaos';
import type { ToolServices } from '../tools/support/services';

const KIMI_CODE_PROVIDER_NAME = 'managed:kimi-code';
const KIMI_CODE_BASE_URL_ENV = 'KIMI_CODE_BASE_URL';
const KIMI_CODE_OAUTH_HOST_ENV = 'KIMI_CODE_OAUTH_HOST';
const KIMI_OAUTH_HOST_ENV = 'KIMI_OAUTH_HOST';
const WEB_SEARCH_BASE_URL_ENV = 'KIMI_WEB_SEARCH_BASE_URL';
const WEB_SEARCH_API_KEY_ENV = 'KIMI_WEB_SEARCH_API_KEY';
const WEB_FETCH_BASE_URL_ENV = 'KIMI_WEB_FETCH_BASE_URL';
const WEB_FETCH_API_KEY_ENV = 'KIMI_WEB_FETCH_API_KEY';
const DEFAULT_GLOBAL_MCP_AUTH_TIMEOUT_MS = 15 * 60 * 1000;
type AgentScopedPayload<T> = T & { readonly agentId: string };
type SessionScopedPayload<T> = T & { readonly sessionId: string };
type SessionAgentPayload<T> = SessionScopedPayload<AgentScopedPayload<T>>;
type RenameSessionRequest = SessionScopedPayload<RenameSessionPayload>;
type UpdateSessionMetadataRequest = SessionScopedPayload<UpdateSessionMetadataPayload>;
interface GlobalMcpOAuthFlow {
  readonly flow: BeginAuthorizationResult;
}

export interface KimiCoreOptions {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly runtime?: ToolServices | undefined;
  readonly kimiRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
  /**
   * Workspace-id resolver handed to the session store: the registered
   * workspace id for the same physical root as a session's workDir (identity
   * comparison folds case/slashes for Windows-shaped paths), so bucket
   * derivation reuses the registered id instead of minting a split bucket.
   * Wired by the services layer from the workspace registry; when omitted the
   * store always mints (legacy behavior).
   */
  readonly resolveWorkspaceId?: (workDir: string) => Promise<string | undefined>;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient | undefined;
  readonly appVersion?: string;
  /**
   * Host UI mode (`'print'` for `kimi -p`, `'cli'` for the TUI, ...). When
   * `'print'`, sessions are created with the print-mode config defaults from
   * `applyPrintModeConfigDefaults` (user-set values still win).
   */
  readonly uiMode?: string | undefined;
}

export class KimiCore implements PromisableMethods<CoreAPI> {
  readonly sdk: Promise<SDKRPC>;
  readonly homeDir: string;
  readonly configPath: string;
  readonly sessions = new Map<string, Session>();
  readonly telemetry: TelemetryClient;

  private kaos: Promise<Kaos> | undefined;
  private runtime: ToolServices | undefined;
  private config: KimiConfig;
  private configWarnings: readonly string[] = [];
  private readonly runtimeOverride: ToolServices | undefined;
  private readonly userHomeDir: string;
  private readonly kimiRequestHeaders: Record<string, string> | undefined;
  private readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver | undefined;
  private readonly skillDirs: readonly string[];
  private readonly sessionStore: SessionStore;
  private readonly globalMcpConfig: GlobalMcpConfigStore;
  /**
   * Process-wide MCP OAuth orchestrator — shared with every Session (single
   * provider cache and single-flight refresh); each session subscribes to its
   * credential events itself, so even a session still being constructed sees
   * every login / reset / refresh-failed.
   */
  private readonly mcpOAuth: McpOAuthService;
  /** Unified MCP server view (global layered files + plugin manifests). */
  private readonly mcpRegistry: McpServerRegistry;
  private readonly globalMcpOAuthFlows = new Map<string, GlobalMcpOAuthFlow>();
  readonly plugins: PluginManager;
  private pluginsReady: Promise<void>;
  private pluginsLoadError: Error | undefined;
  private readonly appVersion: string | undefined;
  private readonly experimentalFlags: FlagResolver;
  /** `true` when the host runs `kimi -p` (v1 print mode); see `withPrintModeDefaults`. */
  private readonly printMode: boolean;
  /** Owner-scoped [image] limits; reload pushes the new config via setConfig. */
  readonly imageLimits: ImageLimits;

  constructor(
    protected readonly rpcClient: CoreRPCClient,
    options: KimiCoreOptions = {},
  ) {
    this.homeDir = resolveKimiHome(options.homeDir);
    this.userHomeDir = homedir();
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.runtimeOverride = options.runtime;
    this.runtime = options.runtime;
    this.kimiRequestHeaders = options.kimiRequestHeaders;
    this.resolveOAuthTokenProvider = options.resolveOAuthTokenProvider;
    this.skillDirs = options.skillDirs ?? [];
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.appVersion = options.appVersion;
    this.printMode = options.uiMode === 'print';
    ensureKimiHome(this.homeDir);
    // One-shot config migrations, before the first load (best-effort, never
    // throws): rewrites a persisted thinking.effort "max" to "high" once.
    migrateThinkingEffortMaxToHigh(this.configPath, this.homeDir);
    // Schema errors degrade (invalid sections are dropped with warnings) so a
    // typo cannot prevent startup, but a file that cannot be used at all —
    // TOML syntax error, unreadable — fails fast: defaults-only would start
    // the app looking logged out, which is worse than the parse error.
    const loaded = loadRuntimeConfigSafe(this.configPath);
    if (loaded.fileError !== undefined) {
      throw loaded.fileError;
    }
    this.config = loaded.config;
    this.configWarnings = [...loaded.fileWarnings, ...loaded.envWarnings];
    if (this.configWarnings.length > 0) {
      log.warn('config load degraded', { warnings: this.configWarnings });
    }
    this.experimentalFlags = new FlagResolver(
      process.env,
      FLAG_DEFINITIONS,
      this.config.experimental,
    );
    this.imageLimits = new ImageLimits(process.env, this.config.image);
    this.sessionStore = new SessionStore(this.homeDir, {
      resolveWorkspaceId: options.resolveWorkspaceId,
    });
    this.globalMcpConfig = new GlobalMcpConfigStore(this.homeDir);
    this.mcpOAuth = new McpOAuthService({ kimiHomeDir: this.homeDir });
    this.plugins = new PluginManager({ kimiHomeDir: this.homeDir });
    this.mcpRegistry = new McpServerRegistry({
      homeDir: this.homeDir,
      store: this.globalMcpConfig,
      plugins: this.plugins,
      managedPluginEnv: () => this.managedKimiCodeEnvForPlugins(),
    });
    // Re-arm proactive refresh timers for credentials written by earlier
    // processes; token writes in this process re-arm via the provider hook.
    this.mcpOAuth.sweepProactiveRefresh();
    // Capture the error rather than swallow it: mutators and explicit /plugins
    // reads rethrow so the user sees what's wrong; createSession/resumeSession
    // degrade silently (no plugin skills, no sessionStart injections) so the harness still
    // starts. Reload clears the error on success.
    this.pluginsReady = this.plugins.load().catch((error: unknown) => {
      this.pluginsLoadError = error instanceof Error ? error : new Error(String(error));
    });
    log.info('experimental flags enabled', { flags: this.experimentalFlags.enabledIds() });

    this.sdk = rpcClient(this);
  }

  async createSession(input: CreateSessionPayload): Promise<SessionSummary> {
    return this.createSessionWithOverrides(input, {});
  }

  async createSessionWithOverrides(
    input: CreateSessionPayload,
    overrides: { kaos?: Kaos; persistenceKaos?: Kaos },
  ): Promise<SessionSummary> {
    const options = input;
    const workDir = requiredWorkDir('createSession', options.workDir);
    const config = this.reloadProviderManager();
    const sessionConfig = this.withPrintModeDefaults(config);
    const id = options.id ?? createSessionId();
    const modelAlias = options.model ?? config.defaultModel;
    const model = modelAlias !== undefined ? config.models?.[modelAlias] : undefined;
    // Forward only an explicitly requested effort. With no explicit value the
    // initial effort is left to ConfigState.update(), which resolves it from
    // the resolved provider — that carries the provider-level protocol context
    // a raw model alias lacks (e.g. provider type "anthropic" with a custom
    // model name must default to the inferred profile effort, not "off").
    const thinkingEffort =
      options.thinking === undefined
        ? undefined
        : resolveThinkingEffort(options.thinking, config.thinking, model);
    const permissionMode = options.permission ?? config.defaultPermissionMode;
    const baseMcpConfig = await resolveSessionMcpConfig({
      cwd: workDir,
      homeDir: this.homeDir,
    });
    const withCallerMcp = mergeCallerMcpServers(baseMcpConfig, options.mcpServers);
    const parentKaos = overrides.kaos ?? (await this.getKaos());
    const persistenceKaos = overrides.persistenceKaos ?? parentKaos;
    // Read the workspace local config (`.kimi-code/local.toml`) through the
    // persistence (local) kaos, not the tool kaos. In ACP mode the tool kaos is
    // the reverse-RPC bridge and the client does not know the session yet during
    // `session/new`, so reading through it fails with "unknown session"
    // (https://github.com/MoonshotAI/kimi-code/issues/988). The local config is
    // a system file and must not depend on the tool bridge — same reason
    // `Session.systemContextKaos` is backed by the persistence sink.
    const localWorkspaceDirs = await readWorkspaceAdditionalDirs(persistenceKaos, workDir);
    const callerAdditionalDirs = await resolveWorkspaceAdditionalDirs(
      parentKaos,
      workDir,
      options.additionalDirs ?? [],
    );
    const additionalDirs = normalizeAdditionalDirs([
      ...localWorkspaceDirs.additionalDirs,
      ...callerAdditionalDirs,
    ]);
    const agentCatalogWarnings: Array<{ readonly message: string; readonly error?: unknown }> = [];
    const reportAgentCatalogWarnings = (logger: Logger): void => {
      for (const warning of agentCatalogWarnings) {
        logger.warn(
          warning.message,
          warning.error === undefined ? undefined : { error: warning.error },
        );
      }
    };
    await this.pluginsReady;
    const agentCatalog = new SessionAgentProfileCatalog({
      workDir,
      brandHomeDir: this.homeDir,
      osHomeDir: this.userHomeDir,
      extraDirs: config.extraAgentDirs,
      explicitFiles: options.agentFiles,
      pluginRoots: this.plugins.pluginAgentRoots(),
      warn: (message, error) => {
        agentCatalogWarnings.push({ message, error });
      },
    });
    try {
      await agentCatalog.ready;
      resolveMainAgentProfile(agentCatalog, options.agentProfile);
    } catch (error) {
      reportAgentCatalogWarnings(log.createChild({ sessionId: id }));
      throw error;
    }
    const summary = await this.sessionStore.create({
      id,
      workDir,
    });
    // Register the cwd in the shared workspaces catalog (`<homeDir>/workspaces.json`,
    // also read by the agent-core-v2 server) so TUI-created sessions surface as
    // workspaces. Best-effort: the catalog is a hint, never session state.
    await touchWorkspaceRegistry(this.homeDir, workDir).catch((error: unknown) => {
      log.warn('workspace registry touch failed', { workDir, error: String(error) });
    });
    const result: SessionSummary = {
      ...summary,
      metadata: options.metadata,
    };
    const clientTelemetry = clientTelemetryProperties(options.client);
    const sessionTelemetryBase = withTelemetryContext(this.telemetry, { sessionId: summary.id });
    const sessionTelemetry =
      Object.keys(clientTelemetry).length === 0
        ? sessionTelemetryBase
        : withTelemetryProperties(sessionTelemetryBase, clientTelemetry);

    await this.pluginsReady;
    const pluginSessionStarts = this.plugins.enabledSessionStarts();
    const pluginCommands = await this.plugins.enabledCommands();
    const mcpConfig = this.mergePluginMcpConfig(withCallerMcp);

    // Session ctor attaches its own log sink. If anything in the setup-after-
    // ctor block throws, `session.close()` releases the sink (and mcp).
    const runtime = await this.resolveRuntime(config);
    const session = new Session({
      kaos: parentKaos.withCwd(workDir),
      persistenceKaos,
      toolServices: runtime,
      config: sessionConfig,
      id,
      homedir: summary.sessionDir,
      kimiHomeDir: this.homeDir,
      rpc: proxyWithExtraPayload(await this.sdk, { sessionId: summary.id }),
      providerManager: this.resolveProviderManager(summary.id),
      background: sessionConfig.background,
      hooks: [...(config.hooks ?? []), ...this.plugins.enabledHooks()],
      permissionRules: config.permission?.rules,
      skills: this.resolveSessionSkillConfig(config),
      agents: {
        catalog: agentCatalog,
        profileName: options.agentProfile,
      },
      mcpConfig,
      mcpOAuthService: this.mcpOAuth,
      mcpConfigResolver: (name) => this.resolveMcpRuntimeTarget(name, workDir),
      experimentalFlags: this.experimentalFlags,
      imageLimits: this.imageLimits,
      telemetry: sessionTelemetry,
      pluginSessionStarts,
      pluginCommands,
      pluginSystemPrompts: this.plugins.enabledSystemPrompts(),
      appVersion: this.appVersion,
      additionalDirs,
      drainAgentTasksOnStop: options.drainAgentTasksOnStop,
    });
    try {
      reportAgentCatalogWarnings(session.log);
      session.metadata = {
        ...session.metadata,
        createdAt: new Date(summary.createdAt).toISOString(),
        updatedAt: new Date(summary.updatedAt).toISOString(),
        workDir,
        ...(summary.title !== undefined
          ? {
              title: summary.title,
              isCustomTitle: true,
            }
          : {}),
        custom: options.metadata === undefined ? {} : { ...options.metadata },
      };
      const mainAgent = await session.createMain();
      mainAgent.config.update({
        modelAlias: options.model ?? config.defaultModel,
        thinkingEffort,
      });
      if (permissionMode !== undefined) {
        mainAgent.permission.setMode(permissionMode);
      }
      // Honor config.defaultPlanMode for fresh sessions. Resumed sessions
      // restore their own plan state from records and never re-apply this.
      if (config.defaultPlanMode === true) {
        await mainAgent.planMode.enter();
      }
      await session.writeMetadata();
      await session.flushMetadata();
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
    this.sessions.set(id, session);
    if (Object.keys(clientTelemetry).length > 0) {
      sessionTelemetry.track('session_started', { resumed: false });
    }
    return withAdditionalDirs(result, session);
  }

  getCoreInfo(): CoreInfo {
    return { version: getCoreVersion() };
  }

  getExperimentalFeatures(): readonly ExperimentalFeatureState[] {
    return this.experimentalFlags.explainAll();
  }

  async closeSession({ sessionId }: CloseSessionPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.close();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Release process-wide resources: close every live session, then shut down
   * the shared MCP OAuth service (proactive-refresh timers, in-flight
   * interactive authorization flows, credential listeners and cached
   * providers). Idempotent; the SDK RPC client awaits this on close so
   * timers and callback listeners never outlive their host.
   */
  async shutdown(): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.closeSession({ sessionId }).catch((error: unknown) => {
        log.warn('session close during core shutdown failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    await this.mcpOAuth.shutdown();
  }

  async archiveSession({ sessionId }: ArchiveSessionPayload): Promise<void> {
    await this.closeSession({ sessionId });
    await this.sessionStore.archive(sessionId);
  }

  async deleteSession({ sessionId }: DeleteSessionPayload): Promise<void> {
    await this.closeSession({ sessionId });
    await this.sessionStore.delete(sessionId);
  }

  async resumeSession(input: ResumeSessionPayload): Promise<ResumeSessionResult> {
    return this.resumeSessionWithOverrides(input, {});
  }

  async resumeSessionWithOverrides(
    input: ResumeSessionPayload,
    overrides: {
      kaos?: Kaos;
      persistenceKaos?: Kaos;
      forcePluginSessionStartReminder?: boolean;
      refreshPluginAgents?: boolean;
    },
  ): Promise<ResumeSessionResult> {
    const summary = await this.sessionStore.get(input.sessionId);
    const parentKaosForRead = overrides.kaos ?? (await this.getKaos());
    // Read `.kimi-code/local.toml` through the persistence (local) kaos, not the
    // tool kaos — see createSessionWithOverrides and issue #988.
    const localWorkspaceDirs = await readWorkspaceAdditionalDirs(
      overrides.persistenceKaos ?? parentKaosForRead,
      summary.workDir,
    );
    const callerAdditionalDirs = await resolveWorkspaceAdditionalDirs(
      parentKaosForRead,
      summary.workDir,
      input.additionalDirs ?? [],
    );
    const additionalDirs = normalizeAdditionalDirs([
      ...localWorkspaceDirs.additionalDirs,
      ...callerAdditionalDirs,
    ]);
    const active = this.sessions.get(summary.id);
    if (active !== undefined) {
      await active.assertMainProfileSelection(input.agentProfile);
      if (overrides.kaos !== undefined) {
        active.setToolKaos(overrides.kaos.withCwd(summary.workDir));
      }
      await active.setBaseAdditionalDirs(additionalDirs);
      return withAdditionalDirs(
        await resumeSessionResult(
          summary,
          active,
          undefined,
          input.includeSubagents,
          input.replayTurnLimit,
        ),
        active,
      );
    }

    const config = this.reloadProviderManager();
    const sessionConfig = this.withPrintModeDefaults(config);
    const baseMcpConfig = await resolveSessionMcpConfig({
      cwd: summary.workDir,
      homeDir: this.homeDir,
    });
    const withCallerMcp = mergeCallerMcpServers(baseMcpConfig, input.mcpServers);
    await this.pluginsReady;
    const pluginSessionStarts = this.plugins.enabledSessionStarts();
    const pluginCommands = await this.plugins.enabledCommands();
    const mcpConfig = this.mergePluginMcpConfig(withCallerMcp);
    const runtime = await this.resolveRuntime(config);
    const parentKaos = parentKaosForRead;
    const persistenceKaos = overrides.persistenceKaos ?? parentKaos;
    const session = new Session({
      kaos: parentKaos.withCwd(summary.workDir),
      persistenceKaos,
      toolServices: runtime,
      config: sessionConfig,
      id: summary.id,
      homedir: summary.sessionDir,
      kimiHomeDir: this.homeDir,
      rpc: proxyWithExtraPayload(await this.sdk, { sessionId: summary.id }),
      providerManager: this.resolveProviderManager(summary.id),
      background: sessionConfig.background,
      hooks: [...(config.hooks ?? []), ...this.plugins.enabledHooks()],
      permissionRules: config.permission?.rules,
      skills: this.resolveSessionSkillConfig(config),
      agents: {
        userHomeDir: this.userHomeDir,
        extraDirs: config.extraAgentDirs,
        pluginRoots:
          overrides.refreshPluginAgents === true ? this.plugins.pluginAgentRoots() : undefined,
        refreshPluginAgents: overrides.refreshPluginAgents,
      },
      mcpConfig,
      mcpOAuthService: this.mcpOAuth,
      mcpConfigResolver: (name) => this.resolveMcpRuntimeTarget(name, summary.workDir),
      experimentalFlags: this.experimentalFlags,
      imageLimits: this.imageLimits,
      telemetry: withTelemetryContext(this.telemetry, { sessionId: summary.id }),
      initializeMainAgent: false,
      pluginSessionStarts,
      pluginCommands,
      pluginSystemPrompts: this.plugins.enabledSystemPrompts(),
      appVersion: this.appVersion,
      additionalDirs,
    });
    let warning: string | undefined;
    try {
      const resumeResult = await session.resume();
      warning = resumeResult.warning;
      await session.assertMainProfileSelection(input.agentProfile);
      await this.refreshSessionRuntimeConfig(session, config);
      if (overrides.refreshPluginAgents === true) {
        await session.writeMetadata();
      }
    } catch (error) {
      await session.close().catch(() => {});
      withTelemetryContext(this.telemetry, { sessionId: summary.id }).track('session_load_failed', {
        reason: telemetryErrorReason(error),
      });
      throw error;
    }
    this.sessions.set(summary.id, session);
    if (overrides.forcePluginSessionStartReminder === true) {
      // Append before constructing the result so the returned ResumeSessionResult
      // (and any SDK caller's resumeState) reflects the refreshed plugin context.
      await session.appendPluginSessionStartReminder();
    }
    return resumeSessionResult(
      summary,
      session,
      warning,
      input.includeSubagents,
      input.replayTurnLimit,
    );
  }

  async reloadSession(input: ReloadSessionPayload): Promise<ResumeSessionResult> {
    const summary = await this.sessionStore.get(input.sessionId);
    const active = this.sessions.get(summary.id);
    if (active?.hasActiveTurn === true) {
      throw new KimiError(
        ErrorCodes.TURN_AGENT_BUSY,
        `Session "${summary.id}" cannot be reloaded while a turn is running`,
        { details: { sessionId: summary.id } },
      );
    }

    this.reloadProviderManager();
    this.clearRuntimeCache();
    await this.reloadPlugins({});

    if (active !== undefined) {
      await active.closeForReload();
      this.sessions.delete(summary.id);
    }
    return this.resumeSessionWithOverrides(
      { sessionId: summary.id },
      {
        forcePluginSessionStartReminder: input.forcePluginSessionStartReminder,
        refreshPluginAgents: true,
      },
    );
  }

  async forkSession(input: ForkSessionPayload): Promise<ResumeSessionResult> {
    const source = await this.sessionStore.get(input.sessionId);
    const active = this.sessions.get(source.id);
    if (active?.hasActiveTurn === true) {
      throw new KimiError(
        ErrorCodes.SESSION_FORK_ACTIVE_TURN,
        `Session "${source.id}" cannot be forked while a turn is running`,
        { details: { sessionId: source.id } },
      );
    }

    if (active !== undefined) {
      await active.flushMetadata();
    }

    const id = input.id ?? createSessionId();
    await this.sessionStore.fork({
      sourceId: source.id,
      targetId: id,
      title: input.title,
      metadata: input.metadata,
      turnIndex: input.turnIndex,
    });
    return this.resumeSession({ sessionId: id });
  }

  async listSessions(input: ListSessionsPayload = {}): Promise<readonly SessionSummary[]> {
    return this.sessionStore.list(input);
  }

  async renameSession({ sessionId, ...payload }: RenameSessionRequest): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      await new SessionAPIImpl(session).renameSession(payload);
      return;
    }
    await this.sessionStore.rename(sessionId, payload.title);
  }

  async exportSession(input: ExportSessionPayload): Promise<ExportSessionResult> {
    const summary = await this.sessionStore.get(input.sessionId);
    const active = this.sessions.get(input.sessionId);
    // Closed sessions have no `Session.log`; create an ad-hoc child bound to
    // their id so the entries still route to the session log file.
    const exportLog =
      active?.log ?? log.createChild({ sessionId: input.sessionId });
    if (active !== undefined) {
      try {
        await active.flushMetadata();
      } catch (error) {
        exportLog.warn('flushMetadata failed before export', { error });
      }
    }
    await warnIfLogFlushFails(exportLog, 'export session log flush failed', () =>
      getRootLogger().flushSession(input.sessionId),
    );
    if (input.includeGlobalLog === true) {
      await warnIfLogFlushFails(exportLog, 'export global log flush failed', () =>
        getRootLogger().flushGlobal(),
      );
    }
    const result = await exportSessionDirectory({
      request: input,
      summary,
      homeDir: this.homeDir,
      globalLogPath: getRootLogger().getConfig()?.globalLogPath,
    });
    return result;
  }

  async getKimiConfig(input?: GetKimiConfigPayload): Promise<KimiConfig> {
    if (input?.reload) {
      this.reloadRuntimeConfig();
    }
    return this.config;
  }

  async getConfigDiagnostics(_input?: EmptyPayload): Promise<ConfigDiagnostics> {
    return { warnings: this.configWarnings };
  }

  async setKimiConfig(input: SetKimiConfigPayload): Promise<KimiConfig> {
    const config = mergeConfigPatch(this.readConfigForWrite(), input);
    await writeConfigFile(this.configPath, config);
    return this.reloadRuntimeConfig();
  }

  async removeKimiProvider(input: RemoveKimiProviderPayload): Promise<KimiConfig> {
    const config = this.readConfigForWrite();
    delete config.providers[input.providerId];

    let removedDefault = false;
    const existingModels = config.models ?? {};
    for (const [key, model] of Object.entries(existingModels)) {
      if (
        typeof model === 'object' &&
        model !== null &&
        !Array.isArray(model) &&
        model['provider'] === input.providerId
      ) {
        delete existingModels[key];
        if (config.defaultModel === key) removedDefault = true;
      }
    }
    config.models = existingModels;

    if (removedDefault) {
      config.defaultModel = undefined;
    }

    if (config.defaultProvider === input.providerId) {
      config.defaultProvider = undefined;
    }

    await writeConfigFile(this.configPath, config);
    return this.reloadRuntimeConfig();
  }

  /**
   * Every registry-backed management lookup waits for the initial plugin load
   * and surfaces its failure: right after construction the registry snapshot
   * can still be missing plugin-contributed servers, so an unguarded call
   * could shadow a read-only plugin server with a user-level write.
   */
  private async awaitMcpRegistryReady(): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
  }

  async listGlobalMcpServers(
    input?: ListGlobalMcpServersPayload,
  ): Promise<readonly McpManagedServerInfo[]> {
    await this.awaitMcpRegistryReady();
    return (await this.mcpRegistry.list({ cwd: input?.cwd })).map(toManagedServerInfo);
  }

  async getGlobalMcpServer({
    name,
    cwd,
  }: GetGlobalMcpServerPayload): Promise<McpManagedServerInfo> {
    await this.awaitMcpRegistryReady();
    return toManagedServerInfo(await this.mcpRegistry.get(name, { cwd }));
  }

  async listGlobalMcpServerAuthStatuses(
    input?: ListGlobalMcpServerAuthStatusesPayload,
  ): Promise<readonly GlobalMcpServerAuthStatus[]> {
    await this.awaitMcpRegistryReady();
    const entries = await this.mcpRegistry.list({ cwd: input?.cwd });
    return Promise.all(
      entries.map(async (entry) => ({
        name: entry.name,
        authStatus: await this.mcpServerAuthState(entry, input?.cwd, input?.verify),
      })),
    );
  }

  async addGlobalMcpServer(
    { server, cwd }: PutGlobalMcpServerPayload,
  ): Promise<readonly McpManagedServerInfo[]> {
    await this.awaitMcpRegistryReady();
    // Normalize once: the store trims names, so the read-only guard, the
    // persisted key, and live-session reconciliation must all agree (a padded
    // name would otherwise persist trimmed but reconcile the raw name).
    const name = normalizeServerName(server.name);
    const existing = await this.mcpRegistry.get(name, { cwd }).catch(() => undefined);
    if (existing !== undefined && !(existing.source === 'global' && existing.mutable)) {
      // A same-named plugin / project-layer entry already exists; writing a
      // user-level shadow would silently change precedence, so reject. A
      // mutable user-level duplicate falls through to the store's own
      // "already exists" error.
      this.throwReadOnlyMcpServer(existing);
    }
    await this.globalMcpConfig.add({ ...server, name });
    await this.reconcileMcpServerInSessions([name], 'global-add');
    return this.listGlobalMcpServers({ cwd });
  }

  async updateGlobalMcpServer(
    { server, cwd }: PutGlobalMcpServerPayload,
  ): Promise<readonly McpManagedServerInfo[]> {
    await this.awaitMcpRegistryReady();
    const name = normalizeServerName(server.name);
    const existing = await this.mcpRegistry.get(name, { cwd }).catch(() => undefined);
    if (existing === undefined) {
      // Preserve the store's not-found error (and its config validation).
      await this.globalMcpConfig.update({ ...server, name });
    } else {
      this.throwReadOnlyMcpServer(existing);
      await this.globalMcpConfig.update({ ...server, name });
      await this.reconcileMcpServerInSessions([name], 'global-update');
    }
    return this.listGlobalMcpServers({ cwd });
  }

  async removeGlobalMcpServer(
    { name, cwd }: GlobalMcpServerNamePayload,
  ): Promise<readonly McpManagedServerInfo[]> {
    await this.awaitMcpRegistryReady();
    const normalized = normalizeServerName(name);
    const existing = await this.mcpRegistry.get(normalized, { cwd }).catch(() => undefined);
    if (existing !== undefined) this.throwReadOnlyMcpServer(existing);
    await this.globalMcpConfig.remove(normalized);
    await this.reconcileMcpServerInSessions([normalized], 'global-remove');
    return this.listGlobalMcpServers({ cwd });
  }

  private throwReadOnlyMcpServer(entry: McpRegistryEntry): void {
    if (entry.source === 'global' && entry.mutable) return;
    // A disabled plugin descriptor is absent from the runtime target, so a
    // user-level entry of this name becomes the effective one the moment it
    // is written — never block mutations on a dead shadow. (Disabled project
    // entries still shadow the user file at runtime, so they keep their
    // read-only rejection.)
    if (entry.source === 'plugin' && entry.config.enabled === false) return;
    const reason =
      entry.source === 'plugin'
        ? `it is contributed by plugin "${entry.origin}" — update the plugin manifest instead`
        : `it is defined in ${entry.origin} — edit that file instead`;
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${entry.name}" is read-only: ${reason}`,
    );
  }

  /**
   * Recompute what one live session should run for `name` and drive it there.
   * This is the single sync path behind every MCP config mutation (global
   * CRUD, plugin install/enable/disable/remove/reload, persisted session
   * adds): the target comes from the registry's runtime resolution (enabled
   * plugin > project > user file) instead of mutation-specific patching, so
   * shadowed layers recover when the winner disappears — a disabled plugin
   * falls back to the project/user entry instead of vanishing, and a removed
   * user-level entry resurrects its project-layer shadow.
   *
   * Caller-injected entries shadow every registry source for their session
   * and are left alone.
   */
  private async reconcileMcpServerInSession(session: Session, name: string): Promise<void> {
    const entry = session.mcp.getRawEntry(name);
    if (entry?.source === 'caller') return;
    const target = await this.resolveMcpRuntimeTarget(name, session.metadata.workDir);
    if (target === undefined) {
      if (entry !== undefined) await session.mcp.remove(name);
      return;
    }
    if (
      entry !== undefined &&
      entry.source === target.source &&
      mcpServerConfigsEqual(entry.config, target.config)
    ) {
      return;
    }
    await session.mcp.connect(name, target.config, target.source);
  }

  /**
   * {@link reconcileMcpServerInSession} fanned out to every live session.
   * Per-session failures are logged with context instead of failing the
   * calling RPC: the config files / plugin state remain the source of truth,
   * and an untouched session self-heals on its next config-aware reconnect.
   */
  private async reconcileMcpServerInSessions(
    names: Iterable<string>,
    op: string,
    excludeSessionId?: string,
  ): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (sessionId === excludeSessionId) continue;
      for (const name of names) {
        tasks.push(
          this.reconcileMcpServerInSession(session, name).catch((error: unknown) => {
            log.error('mcp live-session sync failed', {
              op,
              server: name,
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }),
        );
      }
    }
    await Promise.all(tasks);
  }

  /**
   * Reconcile every live session's plugin-affected MCP entries with the
   * current plugin state (install / enable / disable / remove / reload). The
   * affected names are the union of what the plugins currently contribute and
   * what any session still runs as plugin-sourced, since those may need to
   * fall back to a shadowed file-layer config or be torn down.
   */
  private async syncPluginMcpServersInSessions(): Promise<void> {
    const names = new Set<string>(
      this.plugins
        .mcpServerEntries({ managedEnv: this.managedKimiCodeEnvForPlugins() })
        .filter((entry) => entry.config.enabled !== false)
        .map((entry) => entry.name),
    );
    for (const session of this.sessions.values()) {
      for (const entry of session.mcp.list()) {
        if (entry.source === 'plugin') names.add(entry.name);
      }
    }
    await this.reconcileMcpServerInSessions(names, 'plugin-sync');
  }

  async beginGlobalMcpServerAuth(
    { name, cwd }: GlobalMcpServerNamePayload,
  ): Promise<BeginGlobalMcpServerAuthResult> {
    return this.beginAppMcpServerAuth(await this.resolveLegacyNamedAppMcpServer(name, cwd));
  }

  async beginMcpServerAuth({
    locator,
    cwd,
  }: McpServerLocatorPayload): Promise<BeginGlobalMcpServerAuthResult> {
    return this.beginAppMcpServerAuth(await this.resolveAppMcpServer(locator, cwd));
  }

  private async beginAppMcpServerAuth(
    server: AppMcpServerRuntimeDescriptor,
  ): Promise<BeginGlobalMcpServerAuthResult> {
    const config = requireOAuthMcpConfig(server.runtimeName, server.config);
    try {
      const flow = await this.mcpOAuth.beginAuthorization(server.runtimeName, config.url);
      const flowId = randomUUID();
      this.globalMcpOAuthFlows.set(flowId, { flow });
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

  async completeGlobalMcpServerAuth(
    payload: CompleteGlobalMcpServerAuthPayload,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.completeMcpServerAuth(payload, options);
  }

  async completeMcpServerAuth(
    { flowId, timeoutMs }: CompleteGlobalMcpServerAuthPayload,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const active = this.globalMcpOAuthFlows.get(flowId);
    if (active === undefined) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, `Unknown MCP OAuth flow: ${flowId}`);
    }
    try {
      await active.flow.complete({
        signal: options.signal,
        timeoutMs: timeoutMs ?? DEFAULT_GLOBAL_MCP_AUTH_TIMEOUT_MS,
      });
    } finally {
      this.globalMcpOAuthFlows.delete(flowId);
    }
  }

  async cancelGlobalMcpServerAuth(
    payload: CancelGlobalMcpServerAuthPayload,
  ): Promise<void> {
    return this.cancelMcpServerAuth(payload);
  }

  async cancelMcpServerAuth({ flowId }: CancelGlobalMcpServerAuthPayload): Promise<void> {
    const active = this.globalMcpOAuthFlows.get(flowId);
    if (active === undefined) return;
    this.globalMcpOAuthFlows.delete(flowId);
    await active.flow.cancel();
  }

  async resetGlobalMcpServerAuth({ name, cwd }: GlobalMcpServerNamePayload): Promise<void> {
    // The legacy name-based surface resolves through the registry too, so a
    // plugin runtime name works here as well.
    await this.appMcpServerDescriptorReset(await this.resolveLegacyNamedAppMcpServer(name, cwd));
  }

  async resetMcpServerAuth({ locator, cwd }: McpServerLocatorPayload): Promise<void> {
    await this.appMcpServerDescriptorReset(await this.resolveAppMcpServer(locator, cwd));
  }

  private async appMcpServerDescriptorReset(
    server: AppMcpServerRuntimeDescriptor,
  ): Promise<void> {
    const config = requireRemoteMcpConfig(server.runtimeName, server.config);
    // The invalidation event propagates into live sessions via the shared
    // OAuth service's event stream.
    await this.mcpOAuth.invalidate(server.runtimeName, config.url);
  }

  async inspectAppMcpServers({
    targets,
    cwd,
  }: InspectAppMcpServersPayload): Promise<readonly AppMcpServerInspection[]> {
    const catalog = await this.appMcpServerDescriptors(cwd);
    const descriptors = selectAppMcpServerDescriptors(catalog, targets);
    const inspections = await this.inspectAppMcpServerDescriptors(descriptors, catalog);
    return inspections.map(sanitizeAppMcpServerInspection);
  }

  /** The registry catalog in the locator-addressed shape, with full configs. */
  private async appMcpServerDescriptors(
    cwd?: string,
  ): Promise<readonly AppMcpServerRuntimeDescriptor[]> {
    await this.awaitMcpRegistryReady();
    return (await this.mcpRegistry.list({ cwd })).map((entry) => this.appMcpServerDescriptor(entry));
  }

  private appMcpServerDescriptor(entry: McpRegistryEntry): AppMcpServerRuntimeDescriptor {
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
      origin: locator.source,
      config: entry.config,
      enabled: entry.config.enabled !== false,
      editable: entry.mutable,
    };
  }

  private async resolveAppMcpServer(
    locator: McpServerLocator,
    cwd?: string,
  ): Promise<AppMcpServerRuntimeDescriptor> {
    const catalog = await this.appMcpServerDescriptors(cwd);
    const server = selectAppMcpServerDescriptors(catalog, [locator])[0]!;
    this.requireUnambiguousRuntimeName(catalog, server);
    return server;
  }

  /**
   * Legacy name-only auth/reset resolution: exactly one enabled entry may own
   * the runtime name — with a collision the caller cannot tell which
   * credential the OAuth flow acts on, so reject like the locator path does
   * instead of silently picking the first registry match.
   */
  private async resolveLegacyNamedAppMcpServer(
    name: string,
    cwd?: string,
  ): Promise<AppMcpServerRuntimeDescriptor> {
    await this.awaitMcpRegistryReady();
    // get() first, preserving its not-found error for unknown names.
    await this.mcpRegistry.get(name, { cwd });
    const catalog = await this.appMcpServerDescriptors(cwd);
    const matches = catalog.filter((candidate) => candidate.runtimeName === name);
    // The sole enabled owner wins over disabled shadows (matching the runtime
    // and the connection-test path); ambiguity is then judged among the
    // remaining enabled entries.
    const descriptor = matches.find((candidate) => candidate.enabled) ?? matches[0]!;
    this.requireUnambiguousRuntimeName(catalog, descriptor);
    return descriptor;
  }

  /**
   * A runtime name shared by another enabled entry makes the OAuth credential
   * identity ambiguous; refuse to guess.
   */
  private requireUnambiguousRuntimeName(
    catalog: readonly AppMcpServerRuntimeDescriptor[],
    server: AppMcpServerRuntimeDescriptor,
  ): void {
    const conflict = catalog.find(
      (candidate) =>
        candidate.serverId !== server.serverId &&
        candidate.enabled &&
        candidate.runtimeName === server.runtimeName,
    );
    if (conflict !== undefined) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `MCP runtime name "${server.runtimeName}" is shared by multiple enabled servers; use the locator-addressed RPC instead`,
      );
    }
  }

  /**
   * Inspection = registry catalog + a batched real-connection probe of every
   * OAuth candidate (one throwaway manager for all). A runtime name shared by
   * a global and a plugin entry cannot be probed unambiguously and is
   * reported `unavailable`; a stored-but-rejected grant is `oauth-expired`.
   */
  private async inspectAppMcpServerDescriptors(
    descriptors: readonly AppMcpServerRuntimeDescriptor[],
    catalog: readonly AppMcpServerRuntimeDescriptor[],
  ): Promise<readonly AppMcpServerRuntimeInspection[]> {
    const runtimeNameCounts = new Map<string, number>();
    for (const server of new Map(catalog.map((item) => [item.serverId, item])).values()) {
      // Disabled entries cannot hold a connection, so they cannot collide.
      if (!server.enabled) continue;
      runtimeNameCounts.set(server.runtimeName, (runtimeNameCounts.get(server.runtimeName) ?? 0) + 1);
    }
    const credentialStates = new Map<string, McpOAuthTokenState>();
    const probeConfigs = Object.create(null) as Record<string, McpServerConfig>;
    for (const server of descriptors) {
      if (!isOAuthProbeCandidate(server)) continue;
      if (runtimeNameCounts.get(server.runtimeName) !== 1) continue;
      const config = requireRemoteMcpConfig(server.runtimeName, server.config);
      credentialStates.set(
        server.serverId,
        this.mcpOAuth.tokenState(server.runtimeName, config.url),
      );
      probeConfigs[server.runtimeName] = server.config;
    }
    let manager: McpConnectionManager | undefined;
    try {
      if (Object.keys(probeConfigs).length > 0) {
        manager = new McpConnectionManager({
          oauthService: this.mcpOAuth,
          defaultStartupTimeoutMs: resolveMcpStartupTimeoutMs(this.config.mcp?.startupTimeoutMs),
          defaultToolTimeoutMs: resolveMcpToolTimeoutMs(this.config.mcp?.toolTimeoutMs),
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

  async testGlobalMcpServer(
    { name, server, cwd }: TestGlobalMcpServerPayload,
  ): Promise<GlobalMcpServerTestResult> {
    const target = await this.resolveMcpTestTarget(name, server, cwd);
    return this.withGlobalMcpServerProbe(target, cwd, (manager) =>
      standaloneMcpTestResult(target.name, manager),
    );
  }

  /**
   * Test target resolution: an inline `server` config probes as-is (nothing
   * has to be saved first); a bare `name` goes through the unified registry,
   * so plugin and project-layer servers are testable too.
   */
  private async resolveMcpTestTarget(
    name: string | undefined,
    server: GlobalMcpServerConfig | undefined,
    cwd: string | undefined,
  ): Promise<GlobalMcpServerConfig> {
    if (server !== undefined) {
      if (name !== undefined && name !== server.name) {
        throw new KimiError(
          ErrorCodes.REQUEST_INVALID,
          'Pass either an MCP server name or an inline server config, not both',
        );
      }
      const parsed = McpServerConfigSchema.safeParse(server);
      if (!parsed.success) {
        throw new KimiError(
          ErrorCodes.CONFIG_INVALID,
          `Invalid MCP server "${server.name}": ${parsed.error.message}`,
        );
      }
      return { name: server.name, ...parsed.data };
    }
    if (name === undefined) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        'Pass an MCP server name or an inline server config',
      );
    }
    await this.awaitMcpRegistryReady();
    // A name-only probe is only meaningful when one enabled entry owns the
    // runtime name; under a collision the UI cannot tell which server Test
    // acts on, so reject like the auth paths do.
    const matches = (await this.mcpRegistry.list({ cwd })).filter((entry) => entry.name === name);
    if (matches.length === 0) {
      throw new KimiError(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" was not found`);
    }
    const enabled = matches.filter((entry) => entry.config.enabled !== false);
    if (enabled.length > 1) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `MCP runtime name "${name}" is shared by multiple enabled servers`,
      );
    }
    // Probe the entry the runtime would actually run: the sole enabled match
    // owns the name (an enabled plugin outranks the file layers, which list
    // first). When every match is disabled, fall back to the first entry so
    // the probe reports it as disabled.
    const entry = enabled[0] ?? matches[0]!;
    return { name: entry.name, ...entry.config };
  }

  private async withGlobalMcpServerProbe<T>(
    server: GlobalMcpServerConfig,
    cwd: string | undefined,
    inspect: (manager: McpConnectionManager) => T,
  ): Promise<T> {
    const manager = new McpConnectionManager({
      stdioCwd: cwd,
      oauthService: this.mcpOAuth,
      defaultStartupTimeoutMs: resolveMcpStartupTimeoutMs(this.config.mcp?.startupTimeoutMs),
      defaultToolTimeoutMs: resolveMcpToolTimeoutMs(this.config.mcp?.toolTimeoutMs),
    });
    try {
      await manager.connectAll({ [server.name]: mcpConfigWithoutName(server) });
      return inspect(manager);
    } finally {
      await manager.shutdown();
    }
  }

  private async mcpServerAuthState(
    entry: McpRegistryEntry,
    cwd: string | undefined,
    verify: boolean | undefined,
  ): Promise<GlobalMcpServerAuthState> {
    const server = entry.config;
    // A disabled server never participates in OAuth; keep the historical
    // classification instead of reporting oauth-required or probing it.
    if (server.enabled === false) return 'not-applicable';
    if (server.transport === 'stdio') return 'not-applicable';
    if (server.bearerTokenEnvVar !== undefined) return 'bearer-token';
    // Keep status classification aligned with the existing connection manager:
    // unmarked static headers are not treated as OAuth credentials.
    if (server.headers !== undefined && server.auth !== 'oauth') return 'not-applicable';
    if (server.transport !== 'http' && server.auth !== 'oauth') return 'not-applicable';
    const tokens = this.mcpOAuth.tokenState(entry.name, server.url);
    const offline = (): GlobalMcpServerAuthState => {
      if (tokens.hasTokens) {
        // An expired grant with a refresh token recovers on the next connect;
        // without one the credential is dead and must be re-created.
        return !tokens.expired || tokens.hasRefreshToken ? 'oauth-authorized' : 'oauth-expired';
      }
      return server.auth === 'oauth' ? 'oauth-required' : 'not-applicable';
    };

    const probe = (): Promise<GlobalMcpServerAuthState> =>
      this.withGlobalMcpServerProbe({ name: entry.name, ...server }, cwd, (manager) => {
        const status = manager.get(entry.name)?.status;
        // A clean connect only proves OAuth-authorized when a grant exists;
        // a server that never challenges is simply not applicable.
        if (status === 'connected') return tokens.hasTokens ? 'oauth-authorized' : 'not-applicable';
        if (status === 'needs-auth') return tokens.hasTokens ? 'oauth-expired' : 'oauth-required';
        return offline();
      });

    if (verify === true) {
      // Online verification: a real connection probe settles states the
      // offline view cannot distinguish (revoked grant, dead refresh token).
      return probe();
    }
    if (verify === false) return offline();
    if (tokens.hasTokens) return offline();
    if (server.auth === 'oauth') return 'oauth-required';
    // Unpinned auth with no stored grant: probe once to detect whether the
    // server challenges at all.
    return this.withGlobalMcpServerProbe({ name: entry.name, ...server }, cwd, (manager) =>
      manager.get(entry.name)?.status === 'needs-auth' ? 'oauth-required' : 'not-applicable',
    );
  }

  async addSessionMcpServer({
    sessionId,
    server,
    persist,
  }: SessionScopedPayload<AddSessionMcpServerPayload>): Promise<McpServerInfo> {
    const session = this.requireSession(sessionId);
    // Normalize once: the persisted store trims names, so the store write,
    // the live connect, and cross-session reconciliation must all agree on
    // the same server identity.
    const name = normalizeServerName(server.name);
    const existing = session.mcp.get(name);
    // A session-local (non-persist) add is caller injection, which shadows
    // every registry source at startup — plugins included — so it passes
    // here and reconciles untouched later. A persisted add is a user-level
    // write, which must not hide behind a read-only plugin owner.
    if (persist === true && existing?.source === 'plugin') {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `MCP server "${name}" is contributed by a plugin; update the plugin manifest instead`,
      );
    }
    const parsed = McpServerConfigSchema.safeParse(server);
    if (!parsed.success) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Invalid MCP server "${server.name}": ${parsed.error.message}`,
      );
    }
    let source: McpServerSource = 'caller';
    if (persist === true) {
      await this.awaitMcpRegistryReady();
      // Resolve with this session's cwd: persisting over a project-layer
      // shadow or a plugin entry would silently replace what the session
      // runs, so reject it the same way the global add path does. A mutable
      // user-level duplicate falls through to the store's own error.
      const registryEntry = await this.resolveMcpRegistryEntry(name, session.metadata.workDir);
      if (registryEntry !== undefined) {
        this.throwReadOnlyMcpServer(registryEntry);
      }
      await this.globalMcpConfig.add({ ...server, name });
      source = 'global';
    }
    await session.mcp.connect(name, parsed.data, source);
    if (persist === true) {
      // A persisted add is a global write: every other live session learns
      // about it through the same reconciliation path as a management-plane
      // add. The requesting session was connected explicitly above.
      await this.reconcileMcpServerInSessions([name], 'persist-add', sessionId);
    }
    const entry = session.mcp.get(name);
    if (entry === undefined) {
      throw new KimiError(
        ErrorCodes.MCP_SERVER_NOT_FOUND,
        `MCP server "${name}" was not connected`,
      );
    }
    return entry;
  }

  prompt({ sessionId, ...payload }: SessionAgentPayload<PromptPayload>) {
    return this.sessionApi(sessionId).prompt(payload);
  }

  runShellCommand({ sessionId, ...payload }: SessionAgentPayload<RunShellCommandPayload>) {
    return this.sessionApi(sessionId).runShellCommand(payload);
  }

  cancelShellCommand({ sessionId, ...payload }: SessionAgentPayload<CancelShellCommandPayload>) {
    return this.sessionApi(sessionId).cancelShellCommand(payload);
  }

  steer({ sessionId, ...payload }: SessionAgentPayload<SteerPayload>) {
    return this.sessionApi(sessionId).steer(payload);
  }

  cancel({ sessionId, ...payload }: SessionAgentPayload<CancelPayload>) {
    return this.sessionApi(sessionId).cancel(payload);
  }

  undoHistory({ sessionId, ...payload }: SessionAgentPayload<UndoHistoryPayload>) {
    return this.sessionApi(sessionId).undoHistory(payload);
  }

  async setModel({
    sessionId,
    ...payload
  }: SessionAgentPayload<SetModelPayload>): Promise<SetModelResult> {
    this.reloadProviderManager();
    return this.sessionApi(sessionId).setModel(payload);
  }

  setThinking({ sessionId, ...payload }: SessionAgentPayload<SetThinkingPayload>) {
    return this.sessionApi(sessionId).setThinking(payload);
  }

  setPermission({ sessionId, ...payload }: SessionAgentPayload<SetPermissionPayload>) {
    return this.sessionApi(sessionId).setPermission(payload);
  }

  getModel({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getModel(payload);
  }

  enterPlan({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).enterPlan(payload);
  }

  cancelPlan({ sessionId, ...payload }: SessionAgentPayload<CancelPlanPayload>) {
    return this.sessionApi(sessionId).cancelPlan(payload);
  }

  clearPlan({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).clearPlan(payload);
  }

  enterSwarm({ sessionId, ...payload }: SessionAgentPayload<EnterSwarmPayload>) {
    return this.sessionApi(sessionId).enterSwarm(payload);
  }

  exitSwarm({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).exitSwarm(payload);
  }

  getSwarmMode({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getSwarmMode(payload);
  }

  beginCompaction({ sessionId, ...payload }: SessionAgentPayload<BeginCompactionPayload>) {
    return this.sessionApi(sessionId).beginCompaction(payload);
  }

  cancelCompaction({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).cancelCompaction(payload);
  }

  registerTool({ sessionId, ...payload }: SessionAgentPayload<RegisterToolPayload>) {
    return this.sessionApi(sessionId).registerTool(payload);
  }

  unregisterTool({ sessionId, ...payload }: SessionAgentPayload<UnregisterToolPayload>) {
    return this.sessionApi(sessionId).unregisterTool(payload);
  }

  setActiveTools({ sessionId, ...payload }: SessionAgentPayload<SetActiveToolsPayload>) {
    return this.sessionApi(sessionId).setActiveTools(payload);
  }

  stopBackground({ sessionId, ...payload }: SessionAgentPayload<StopBackgroundPayload>) {
    return this.sessionApi(sessionId).stopBackground(payload);
  }

  detachBackground({ sessionId, ...payload }: SessionAgentPayload<DetachBackgroundPayload>) {
    return this.sessionApi(sessionId).detachBackground(payload);
  }

  clearContext({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).clearContext(payload);
  }

  importContext({ sessionId, ...payload }: SessionAgentPayload<ImportContextPayload>) {
    return this.sessionApi(sessionId).importContext(payload);
  }

  activateSkill({
    sessionId,
    ...payload
  }: SessionAgentPayload<ActivateSkillPayload>): Promise<void> {
    return this.sessionApi(sessionId).activateSkill(payload);
  }

  activatePluginCommand({
    sessionId,
    ...payload
  }: SessionAgentPayload<ActivatePluginCommandPayload>): Promise<void> {
    return this.sessionApi(sessionId).activatePluginCommand(payload);
  }

  getBackgroundOutput({ sessionId, ...payload }: SessionAgentPayload<GetBackgroundOutputPayload>) {
    return this.sessionApi(sessionId).getBackgroundOutput(payload);
  }

  getContext({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getContext(payload);
  }

  getConfig({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getConfig(payload);
  }

  getPermission({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getPermission(payload);
  }

  getPlan({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getPlan(payload);
  }

  getUsage({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getUsage(payload);
  }

  getTools({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getTools(payload);
  }

  getBackground({ sessionId, ...payload }: SessionAgentPayload<GetBackgroundPayload>) {
    return this.sessionApi(sessionId).getBackground(payload);
  }

  updateSessionMetadata({ sessionId, ...payload }: UpdateSessionMetadataRequest): Promise<void> {
    return this.sessionApi(sessionId).updateSessionMetadata(payload);
  }

  getSessionMetadata({ sessionId, ...payload }: SessionScopedPayload<EmptyPayload>): SessionMeta {
    return this.sessionApi(sessionId).getSessionMetadata(payload);
  }

  listSkills({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): Promise<readonly SkillSummary[]> {
    return this.sessionApi(sessionId).listSkills(payload);
  }

  /**
   * List the skills available for a workspace working directory without
   * requiring a session. Mirrors `Session.loadSkills` exactly (same roots,
   * same discovery order, same built-ins) so the result matches what a new
   * session created in `workDir` would see. Used to populate the composer
   * skill menu before a session exists.
   */
  async listWorkspaceSkills({
    workDir,
  }: ListWorkspaceSkillsPayload): Promise<readonly SkillSummary[]> {
    const cwd = requiredWorkDir('listWorkspaceSkills', workDir);
    await this.pluginsReady;
    const skills = this.resolveSessionSkillConfig(this.reloadProviderManager());
    const roots = await resolveSkillRoots({
      paths: {
        userHomeDir: skills.userHomeDir ?? this.userHomeDir,
        brandHomeDir: skills.brandHomeDir ?? this.homeDir,
        workDir: cwd,
      },
      explicitDirs: skills.explicitDirs,
      extraDirs: skills.extraDirs,
      pluginSkillRoots: skills.pluginSkillRoots,
      mergeAllAvailableSkills: skills.mergeAllAvailableSkills,
      builtinDir: skills.builtinDir,
    });
    const registry = new SessionSkillRegistry({});
    await registry.loadRoots(roots);
    registerBuiltinSkills(registry);
    return registry.listSkills().map(summarizeSkill);
  }

  listPluginCommands({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): readonly PluginCommandDef[] {
    return this.sessionApi(sessionId).listPluginCommands(payload);
  }

  listMcpServers({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): readonly McpServerInfo[] {
    return this.sessionApi(sessionId).listMcpServers(payload);
  }

  getMcpStartupMetrics({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): Promise<McpStartupMetrics> {
    return this.sessionApi(sessionId).getMcpStartupMetrics(payload);
  }

  reconnectMcpServer({
    sessionId,
    ...payload
  }: SessionScopedPayload<ReconnectMcpServerPayload>): Promise<void> {
    return this.sessionApi(sessionId).reconnectMcpServer(payload);
  }

  generateAgentsMd({ sessionId, ...payload }: SessionScopedPayload<EmptyPayload>): Promise<void> {
    return this.sessionApi(sessionId).generateAgentsMd(payload);
  }

  getSessionWarnings({ sessionId, ...payload }: SessionScopedPayload<EmptyPayload>): Promise<readonly SessionWarning[]> {
    return this.sessionApi(sessionId).getSessionWarnings(payload);
  }

  applyPersistedSecondaryModel({ sessionId }: SessionScopedPayload<EmptyPayload>): void {
    // Apply the same fully resolved snapshot the provider manager reads. In
    // particular, keep every persisted recipe patch and the synthesized
    // `__secondary__` entry instead of exposing an incomplete setter payload.
    const config = this.withPrintModeDefaults(this.reloadProviderManager());
    this.requireSession(sessionId).setSecondaryModelConfig(config);
  }

  waitForBackgroundTasksOnPrint({ sessionId, ...payload }: SessionScopedPayload<EmptyPayload>): Promise<void> {
    return this.sessionApi(sessionId).waitForBackgroundTasksOnPrint(payload);
  }

  handlePrintMainTurnCompleted({ sessionId, ...payload }: SessionScopedPayload<EmptyPayload>): Promise<'finish' | 'continue'> {
    return this.sessionApi(sessionId).handlePrintMainTurnCompleted(payload);
  }

  addAdditionalDir({
    sessionId,
    ...payload
  }: SessionScopedPayload<AddAdditionalDirPayload>): Promise<AddAdditionalDirResult> {
    return this.requireSession(sessionId).addAdditionalDir(payload.path, payload.persist);
  }

  startBtw({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>): Promise<string> {
    return this.sessionApi(sessionId).startBtw(payload);
  }

  createGoal({
    sessionId,
    ...payload
  }: SessionAgentPayload<CreateGoalPayload>): Promise<GoalSnapshot> {
    return Promise.resolve(this.sessionApi(sessionId).createGoal(payload));
  }

  getGoal({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>): Promise<GoalToolResult> {
    return Promise.resolve(this.sessionApi(sessionId).getGoal(payload));
  }

  pauseGoal({
    sessionId,
    ...payload
  }: SessionAgentPayload<EmptyPayload>): Promise<GoalSnapshot> {
    return Promise.resolve(this.sessionApi(sessionId).pauseGoal(payload));
  }

  resumeGoal({
    sessionId,
    ...payload
  }: SessionAgentPayload<EmptyPayload>): Promise<GoalSnapshot> {
    return Promise.resolve(this.sessionApi(sessionId).resumeGoal(payload));
  }

  cancelGoal({
    sessionId,
    ...payload
  }: SessionAgentPayload<EmptyPayload>): Promise<GoalSnapshot> {
    return Promise.resolve(this.sessionApi(sessionId).cancelGoal(payload));
  }

  getCronTasks({
    sessionId,
    ...payload
  }: SessionAgentPayload<EmptyPayload>): Promise<GetCronTasksResult> {
    return Promise.resolve(this.sessionApi(sessionId).getCronTasks(payload));
  }

  async installPlugin(payload: InstallPluginPayload): Promise<PluginSummary> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    const record = await this.plugins.install(payload.source);
    await this.syncPluginMcpServersInSessions();
    return this.plugins.summaries().find((s) => s.id === record.id)!;
  }

  async listPlugins(_: EmptyPayload): Promise<readonly PluginSummary[]> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    return this.plugins.summaries();
  }

  async setPluginEnabled({ id, enabled }: SetPluginEnabledPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.setEnabled(id, enabled);
    await this.syncPluginMcpServersInSessions();
  }

  async setPluginMcpServerEnabled({
    id,
    server,
    enabled,
  }: SetPluginMcpServerEnabledPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.setMcpServerEnabled(id, server, enabled);
    await this.syncPluginMcpServersInSessions();
  }

  async removePlugin({ id }: RemovePluginPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.remove(id);
    await this.syncPluginMcpServersInSessions();
  }

  async reloadPlugins(_: EmptyPayload): Promise<ReloadPluginsResult> {
    let summary: ReloadPluginsResult;
    try {
      summary = await this.plugins.reload();
      this.pluginsLoadError = undefined;
    } catch (error) {
      this.pluginsLoadError = error instanceof Error ? error : new Error(String(error));
      throw new KimiError(
        ErrorCodes.PLUGIN_LOAD_FAILED,
        `Failed to reload plugins: ${this.pluginsLoadError.message}`,
        { cause: error, details: { kimiHomeDir: this.homeDir } },
      );
    }
    // Live sessions pick up the reloaded plugin contributions here — the same
    // point where plugin skills take effect: system prompts refresh, and the
    // MCP connection set is reconciled (added / removed / changed servers).
    // Install / enable / disable / remove without a reload leave live prompts
    // unchanged (their MCP sync happens in the mutators themselves).
    const pluginSystemPrompts = this.plugins.enabledSystemPrompts();
    for (const session of this.sessions.values()) {
      await session.setPluginSystemPrompts(pluginSystemPrompts);
    }
    await this.syncPluginMcpServersInSessions();
    return summary;
  }

  async getPluginInfo({ id }: GetPluginInfoPayload): Promise<PluginInfo> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    const info = this.plugins.info(id);
    if (info === undefined) {
      throw new KimiError(
        ErrorCodes.PLUGIN_NOT_FOUND,
        `Plugin "${id}" is not installed`,
        { details: { id } },
      );
    }
    return info;
  }

  private assertPluginsLoaded(): void {
    if (this.pluginsLoadError === undefined) return;
    throw new KimiError(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Plugin state failed to load: ${this.pluginsLoadError.message}. ` +
        `Fix the file at ${this.homeDir}/plugins/installed.json and run /plugins reload.`,
      { cause: this.pluginsLoadError, details: { kimiHomeDir: this.homeDir } },
    );
  }

  private async resolveRuntime(config: KimiConfig): Promise<ToolServices> {
    if (this.runtime !== undefined) return this.runtime;
    const runtime = await createRuntimeConfig({
      config,
      kimiRequestHeaders: this.kimiRequestHeaders,
      resolveOAuthTokenProvider: this.resolveOAuthTokenProvider,
    });
    this.runtime = runtime;
    return runtime;
  }

  private getKaos(): Promise<Kaos> {
    this.kaos ??= LocalKaos.create().catch((error: unknown) => {
      if (error instanceof KaosShellNotFoundError) {
        throw new KimiError(ErrorCodes.SHELL_GIT_BASH_NOT_FOUND, error.message);
      }
      throw error;
    });
    return this.kaos;
  }

  private resolveSessionSkillConfig(config: KimiConfig): SessionSkillConfig {
    const explicitDirs = this.skillDirs.length > 0 ? this.skillDirs : undefined;
    return {
      userHomeDir: this.userHomeDir,
      brandHomeDir: this.homeDir,
      explicitDirs,
      extraDirs: config.extraSkillDirs,
      pluginSkillRoots: this.plugins.pluginSkillRoots(),
      mergeAllAvailableSkills: config.mergeAllAvailableSkills,
    };
  }

  private resolveProviderManager(sessionId: string): ProviderManager {
    return new ProviderManager({
      config: () => this.config,
      kimiRequestHeaders: this.kimiRequestHeaders,
      resolveOAuthTokenProvider: this.resolveOAuthTokenProvider,
      promptCacheKey: sessionId,
    });
  }

  private mergePluginMcpConfig(base: SessionMcpConfig | undefined): SessionMcpConfig | undefined {
    // Plugin entries arrive with all contributor-side transforms applied
    // (runtime rename, env/cwd constraints, managed Kimi env); disabled ones
    // stay out of sessions entirely, matching historical behavior.
    const pluginEntries = this.plugins
      .mcpServerEntries({ managedEnv: this.managedKimiCodeEnvForPlugins() })
      .filter((entry) => entry.config.enabled !== false);
    if (pluginEntries.length === 0) return base;
    const servers: Record<string, McpServerConfig> = { ...base?.servers };
    const sources: Record<string, McpServerSource> = { ...base?.sources };
    for (const entry of pluginEntries) {
      // Caller injection is explicit per-session intent and shadows every
      // registry source — including plugins. The live-session reconciliation
      // makes the same call, so init and sync stay consistent.
      if (sources[entry.name] === 'caller') continue;
      servers[entry.name] = entry.config;
      sources[entry.name] = 'plugin';
    }
    return { servers, sources };
  }

  /**
   * Registry lookup for management guards: a name that is not configured
   * anywhere resolves to `undefined`, but a resolution error (e.g. a
   * malformed project config file) propagates — writing over an unknown
   * state is worse than surfacing the error to the caller.
   */
  private async resolveMcpRegistryEntry(
    name: string,
    cwd: string | undefined,
  ): Promise<McpRegistryEntry | undefined> {
    try {
      return await this.mcpRegistry.get(name, { cwd });
    } catch (error) {
      if (error instanceof KimiError && error.code === ErrorCodes.MCP_SERVER_NOT_FOUND) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * What a live session should currently run for `name`: the registry's
   * runtime target (enabled plugin > project > user file); caller-sourced
   * entries are handled by the reconciliation callers themselves.
   *
   * "Not configured anywhere" resolves to `undefined`, but resolution errors
   * (e.g. a malformed project config file) propagate: treating them as "no
   * target" would tear down healthy connections or misreport a still-present
   * server as unconfigured.
   */
  private async resolveMcpRuntimeTarget(
    name: string,
    cwd: string | undefined,
  ): Promise<McpRegistryEntry | undefined> {
    return this.mcpRegistry.resolveRuntimeTarget(name, { cwd });
  }

  private managedKimiCodeEnvForPlugins(): Record<string, string> {
    const provider = this.config.providers[KIMI_CODE_PROVIDER_NAME];
    const envBaseUrl = process.env[KIMI_CODE_BASE_URL_ENV];
    const envOAuthHost = process.env[KIMI_CODE_OAUTH_HOST_ENV] ?? process.env[KIMI_OAUTH_HOST_ENV];
    const hasEnvOverride = envBaseUrl !== undefined || envOAuthHost !== undefined;
    const baseUrl =
      envBaseUrl !== undefined ? envBaseUrl.replace(/\/+$/, '') : provider?.baseUrl;
    const oauthHost = hasEnvOverride ? envOAuthHost : provider?.oauth?.oauthHost;
    const env: Record<string, string> = {};
    if (baseUrl !== undefined) env[KIMI_CODE_BASE_URL_ENV] = baseUrl;
    if (oauthHost !== undefined) env[KIMI_CODE_OAUTH_HOST_ENV] = oauthHost;
    return env;
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session "${sessionId}" was not found`, {
        details: { sessionId },
      });
    }
    return session;
  }

  private sessionApi(sessionId: string): SessionAPIImpl {
    return new SessionAPIImpl(this.requireSession(sessionId));
  }

  private reloadProviderManager(): KimiConfig {
    return this.reloadRuntimeConfig();
  }

  private readConfigForWrite(): KimiConfig {
    return readConfigFileForUpdate(this.configPath);
  }

  private reloadRuntimeConfig(): KimiConfig {
    const loaded = loadRuntimeConfigSafe(this.configPath);
    if (loaded.fileWarnings.length > 0) {
      // Keep the last good config: adopting a salvaged config mid-run could
      // silently drop providers or models a live session depends on.
      this.configWarnings = [
        ...loaded.fileWarnings,
        ...loaded.envWarnings,
        'config.toml has errors; keeping the previously loaded configuration.',
      ];
      log.warn('config reload degraded; keeping previous config', {
        warnings: loaded.fileWarnings,
      });
      return this.config;
    }
    this.configWarnings = loaded.envWarnings;
    return this.setRuntimeConfig(loaded.config);
  }

  private setRuntimeConfig(config: KimiConfig): KimiConfig {
    this.config = config;
    this.experimentalFlags.setConfigOverrides(config.experimental);
    this.imageLimits.setConfig(config.image);
    return this.config;
  }

  /**
   * Config bound to a newly created/resumed session. In print mode (`kimi -p`,
   * v1) the print-mode defaults are merged in; explicit user config wins. The
   * raw `this.config` is left untouched so `getKimiConfig` and config writes
   * still round-trip the user's file values.
   */
  private withPrintModeDefaults(config: KimiConfig): KimiConfig {
    return this.printMode ? applyPrintModeConfigDefaults(config) : config;
  }

  private clearRuntimeCache(): void {
    if (this.runtimeOverride !== undefined) return;
    this.runtime = undefined;
  }

  private async refreshSessionRuntimeConfig(
    session: Session,
    config: KimiConfig,
  ): Promise<void> {
    const api = new SessionAPIImpl(session);
    // A session migrated from an external tool carries no model, and any
    // session may reference a model alias that no longer exists in config.toml.
    // Try the session's own model first, then fall back to the configured
    // default, so resume degrades gracefully instead of hard-failing.
    const requested = (await api.getModel({ agentId: 'main' })).trim();
    const fallback = config.defaultModel?.trim() ?? '';
    const candidates = [...new Set([requested, fallback].filter((model) => model.length > 0))];
    for (const model of candidates) {
      try {
        await api.setModel({ agentId: 'main', model });
        await session.flushMetadata();
        return;
      } catch (error) {
        // Skip a candidate only when the alias is genuinely absent from
        // config (a stale or migrated model) — that is the graceful-degrade
        // case. A *configured* alias that fails to resolve (missing provider,
        // no credentials, bad max_context_size) is an actionable config error
        // the user must see; surface it instead of silently swapping models.
        const aliasMissing = config.models?.[model] === undefined;
        if (
          aliasMissing &&
          error instanceof KimiError &&
          error.code === ErrorCodes.CONFIG_INVALID
        ) {
          continue;
        }
        throw error;
      }
    }
  }
}

function requireRemoteMcpConfig(name: string, config: McpServerConfig): McpRemoteServerConfig {
  if (config.transport !== 'stdio') return config;
  throw new KimiError(
    ErrorCodes.REQUEST_INVALID,
    `MCP server "${name}" does not use a remote transport`,
  );
}

function requireOAuthMcpConfig(name: string, input: McpServerConfig): McpRemoteServerConfig {
  const config = requireRemoteMcpConfig(name, input);
  if (config.bearerTokenEnvVar !== undefined) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${name}" uses a static bearer token`,
    );
  }
  if (config.headers !== undefined && config.auth !== 'oauth') {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${name}" uses static headers and is not marked for OAuth`,
    );
  }
  return config;
}

function mcpServerId(locator: McpServerLocator): string {
  if (locator.source === 'global') return `global:${encodeURIComponent(locator.name)}`;
  return `plugin:${encodeURIComponent(locator.pluginId)}:${encodeURIComponent(locator.serverName)}`;
}

function describeMcpServerLocator(locator: McpServerLocator): string {
  if (locator.source === 'global') return locator.name;
  return `${locator.pluginId}/${locator.serverName}`;
}

function selectAppMcpServerDescriptors(
  catalog: readonly AppMcpServerRuntimeDescriptor[],
  targets?: readonly McpServerLocator[],
): readonly AppMcpServerRuntimeDescriptor[] {
  if (targets === undefined) return catalog;
  const byId = new Map(catalog.map((server) => [server.serverId, server]));
  return targets.map((target) => {
    const server = byId.get(mcpServerId(target));
    if (server !== undefined) return server;
    throw new KimiError(
      ErrorCodes.MCP_SERVER_NOT_FOUND,
      `MCP server "${describeMcpServerLocator(target)}" was not found`,
    );
  });
}

/**
 * States decidable without connecting: anything pinned (stdio, bearer token,
 * static non-OAuth headers) or disabled never enters the OAuth probe.
 */
function configuredMcpAuthState(
  server: AppMcpServerRuntimeDescriptor,
): GlobalMcpServerAuthState | undefined {
  if (!server.enabled || server.config.enabled === false) return 'not-applicable';
  if (server.config.transport === 'stdio') return 'not-applicable';
  if (server.config.bearerTokenEnvVar !== undefined) return 'bearer-token';
  if (server.config.headers !== undefined && server.config.auth !== 'oauth') {
    return 'not-applicable';
  }
  return undefined;
}

/** Inspection-time descriptor: the wire shape but with the full config. */
type AppMcpServerRuntimeDescriptor = Omit<AppMcpServerDescriptor, 'config'> & {
  readonly config: McpServerConfig;
};

type AppMcpServerRuntimeInspection = AppMcpServerRuntimeDescriptor &
  Pick<AppMcpServerInspection, 'authStatus' | 'checkedAt' | 'error'>;

function isOAuthProbeCandidate(server: AppMcpServerRuntimeDescriptor): boolean {
  return configuredMcpAuthState(server) === undefined;
}

function sanitizeAppMcpServerInspection(
  server: AppMcpServerRuntimeInspection,
): AppMcpServerInspection {
  return { ...server, config: sanitizeAppMcpServerConfig(server.config) };
}

function sanitizeAppMcpServerConfig(config: McpServerConfig): AppMcpServerConfig {
  return toMcpServerConfigView(config);
}


function mcpConfigWithoutName(server: GlobalMcpServerConfig): McpServerConfig {
  const { name: _name, ...config } = server;
  return config;
}

/** Flatten a registry entry into the wire shape of the unified management view. */
function toManagedServerInfo(entry: McpRegistryEntry): McpManagedServerInfo {
  // Read-only entries (plugin / project-layer) report key lists instead of
  // literal secret-bearing values; mutable user-level entries keep the full
  // values so edit UIs can prefill them.
  const config = entry.mutable ? entry.config : toMcpServerConfigView(entry.config);
  return {
    name: entry.name,
    ...config,
    source: entry.source,
    origin: entry.origin,
    mutable: entry.mutable,
    plugin: entry.plugin,
  } as McpManagedServerInfo;
}

function standaloneMcpTestResult(
  name: string,
  manager: McpConnectionManager,
): GlobalMcpServerTestResult {
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

async function createRuntimeConfig(input: {
  readonly config: KimiConfig;
  readonly kimiRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
}): Promise<ToolServices> {
  const localFetcher = new LocalFetchURLProvider();
  const searchService = withServiceEnv(
    input.config.services?.moonshotSearch,
    WEB_SEARCH_BASE_URL_ENV,
    WEB_SEARCH_API_KEY_ENV,
  );
  const fetchService = withServiceEnv(
    input.config.services?.moonshotFetch,
    WEB_FETCH_BASE_URL_ENV,
    WEB_FETCH_API_KEY_ENV,
  );

  return {
    urlFetcher:
      fetchService?.baseUrl === undefined
        ? localFetcher
        : new MoonshotFetchURLProvider({
            baseUrl: fetchService.baseUrl,
            localFallback: localFetcher,
            defaultHeaders: input.kimiRequestHeaders,
            ...serviceCredentials(fetchService, input.resolveOAuthTokenProvider),
          }),
    webSearcher:
      searchService?.baseUrl === undefined
        ? undefined
        : new MoonshotWebSearchProvider({
            baseUrl: searchService.baseUrl,
            defaultHeaders: input.kimiRequestHeaders,
            ...serviceCredentials(searchService, input.resolveOAuthTokenProvider),
          }),
  };
}

/**
 * Resolve `KIMI_WEB_SEARCH_*` / `KIMI_WEB_FETCH_*` without mixing credentials
 * across service origins. An env base URL starts a fresh service entry so a
 * persisted API key, OAuth token, or custom header cannot reach the env
 * endpoint. An env API key without an env base URL keeps the configured
 * endpoint and headers, but replaces both configured credential forms.
 * Blank env values are treated as unset.
 */
function withServiceEnv(
  service: MoonshotServiceConfig | undefined,
  baseUrlEnv: string,
  apiKeyEnv: string,
): MoonshotServiceConfig | undefined {
  const envBaseUrl = nonEmptyString(process.env[baseUrlEnv]);
  const envApiKey = nonEmptyString(process.env[apiKeyEnv]);
  if (envBaseUrl !== undefined) {
    return { baseUrl: envBaseUrl, apiKey: envApiKey };
  }
  if (envApiKey === undefined) return service;
  if (service === undefined) return { apiKey: envApiKey };
  const { apiKey: _apiKey, oauth: _oauth, ...rest } = service;
  return { ...rest, apiKey: envApiKey };
}

function serviceCredentials(
  service: MoonshotServiceConfig,
  resolveOAuthTokenProvider: OAuthTokenProviderResolver | undefined,
): {
  readonly apiKey?: string | undefined;
  readonly tokenProvider?: BearerTokenProvider | undefined;
  readonly customHeaders?: Record<string, string> | undefined;
} {
  const apiKey = nonEmptyString(service.apiKey);
  return {
    apiKey,
    tokenProvider:
      service.oauth !== undefined
        ? resolveOAuthTokenProvider?.(KIMI_CODE_PROVIDER_NAME, service.oauth)
        : undefined,
    customHeaders: service.customHeaders,
  };
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function requiredWorkDir(operation: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KimiError(ErrorCodes.REQUEST_WORK_DIR_REQUIRED, `${operation} requires workDir`);
  }
  return normalizeWorkDir(value);
}

function createSessionId(): string {
  return `session_${randomUUID()}`;
}

function withAdditionalDirs<T>(
  result: T,
  session: Session,
): T & { readonly additionalDirs: readonly string[] } {
  return {
    ...result,
    additionalDirs: session.getAdditionalDirs(),
  };
}

function telemetryErrorReason(error: unknown): string {
  if (error instanceof KimiError) return error.code;
  if (error instanceof Error && error.name.length > 0) return error.name;
  return typeof error;
}

function clientTelemetryProperties(client: ClientTelemetryInfo | undefined): TelemetryProperties {
  if (client === undefined) return {};
  // Emit a fixed key set (null when the client did not provide a field) so
  // `session_started` has a stable schema across clients, matching the harness
  // producer in `kimi-harness.ts`. Other session events also inherit these as
  // context properties, so they share the same stable client-attribution shape.
  return {
    client_id: client.id ?? null,
    client_name: client.name ?? null,
    client_version: client.version ?? null,
    ui_mode: client.uiMode ?? null,
  };
}

async function resumeSessionResult(
  summary: SessionSummary,
  session: Session,
  warning?: string,
  includeSubagents = false,
  replayTurnLimit?: number,
): Promise<ResumeSessionResult> {
  if (includeSubagents) {
    const persistedAgentIds = Object.keys(session.metadata.agents).filter(
      (agentId) => agentId !== 'main',
    );
    const resumedAgents = await Promise.allSettled(
      persistedAgentIds.map((agentId) => session.ensureAgentResumed(agentId)),
    );
    for (const [index, result] of resumedAgents.entries()) {
      if (result.status === 'fulfilled') continue;
      session.log.warn('persisted subagent replay unavailable during session resume', {
        agentId: persistedAgentIds[index],
        error: result.reason,
      });
    }
  }
  const api = new SessionAPIImpl(session);
  const agents: Record<string, ResumedAgentState> = {};
  for (const [agentId, entry] of session.agents) {
    if (!(entry instanceof Agent)) continue;
    const agent = entry;
    const config = await api.getConfig({ agentId });
    const context = await api.getContext({ agentId });
    const permission = await api.getPermission({ agentId });
    const plan = await api.getPlan({ agentId });
    const swarmMode = await api.getSwarmMode({ agentId });
    const usage = await api.getUsage({ agentId });
    agents[agentId] = {
      type: agent.type,
      config,
      context,
      replay: limitAgentReplayByTurns(agent.replayBuilder.buildResult(), replayTurnLimit),
      permission,
      plan,
      swarmMode,
      usage,
      tools: await api.getTools({ agentId }),
      toolStore: agent.tools.storeData(),
      background: agent.background.list(false),
    };
  }
  return withAdditionalDirs(
    {
      ...summary,
      sessionMetadata: api.getSessionMetadata({}),
      agents,
      warning,
    },
    session,
  );
}

async function warnIfLogFlushFails(
  exportLog: Logger,
  message: string,
  flush: () => Promise<boolean>,
): Promise<void> {
  try {
    if (await flush()) return;
    exportLog.warn(message);
  } catch (error) {
    exportLog.warn(message, { error });
  }
  try {
    await flush();
  } catch {}
}
