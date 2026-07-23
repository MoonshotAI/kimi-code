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
  GlobalMcpConfigStore,
  McpConnectionManager,
  McpOAuthService,
  resolveMcpStartupTimeoutMs,
  resolveMcpToolTimeoutMs,
  resolveSessionMcpConfig,
  mergeCallerMcpServers,
  type BeginAuthorizationResult,
  type SessionMcpConfig,
} from '../mcp';
import { Session, type SessionMeta, type SessionSkillConfig } from '../session';
import { exportSessionDirectory } from '../session/export';
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
  GoalSnapshot,
  GoalToolResult,
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
  ListSessionsPayload,
  ListWorkspaceSkillsPayload,
  McpServerInfo,
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
  private readonly globalMcpOAuth: McpOAuthService;
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
    this.globalMcpOAuth = new McpOAuthService({ kimiHomeDir: this.homeDir });
    this.plugins = new PluginManager({ kimiHomeDir: this.homeDir });
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
      mcpConfig,
      experimentalFlags: this.experimentalFlags,
      imageLimits: this.imageLimits,
      telemetry: sessionTelemetry,
      pluginSessionStarts,
      pluginCommands,
      appVersion: this.appVersion,
      additionalDirs,
      drainAgentTasksOnStop: options.drainAgentTasksOnStop,
    });
    try {
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
      mcpConfig,
      experimentalFlags: this.experimentalFlags,
      imageLimits: this.imageLimits,
      telemetry: withTelemetryContext(this.telemetry, { sessionId: summary.id }),
      initializeMainAgent: false,
      pluginSessionStarts,
      pluginCommands,
      appVersion: this.appVersion,
      additionalDirs,
    });
    let warning: string | undefined;
    try {
      const resumeResult = await session.resume();
      warning = resumeResult.warning;
      await this.refreshSessionRuntimeConfig(session, config);
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
      { forcePluginSessionStartReminder: input.forcePluginSessionStartReminder },
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

  async listGlobalMcpServers(_input?: EmptyPayload): Promise<readonly GlobalMcpServerConfig[]> {
    return this.globalMcpConfig.list();
  }

  async addGlobalMcpServer(
    { server }: PutGlobalMcpServerPayload,
  ): Promise<readonly GlobalMcpServerConfig[]> {
    return this.globalMcpConfig.add(server);
  }

  async updateGlobalMcpServer(
    { server }: PutGlobalMcpServerPayload,
  ): Promise<readonly GlobalMcpServerConfig[]> {
    return this.globalMcpConfig.update(server);
  }

  async removeGlobalMcpServer(
    { name }: GlobalMcpServerNamePayload,
  ): Promise<readonly GlobalMcpServerConfig[]> {
    return this.globalMcpConfig.remove(name);
  }

  async beginGlobalMcpServerAuth(
    { name }: GlobalMcpServerNamePayload,
  ): Promise<BeginGlobalMcpServerAuthResult> {
    const server = await this.globalMcpConfig.get(name);
    const config = requireOAuthMcpServer(server);
    try {
      const flow = await this.globalMcpOAuth.beginAuthorization(server.name, config.url);
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
    { flowId }: CancelGlobalMcpServerAuthPayload,
  ): Promise<void> {
    const active = this.globalMcpOAuthFlows.get(flowId);
    if (active === undefined) return;
    this.globalMcpOAuthFlows.delete(flowId);
    await active.flow.cancel();
  }

  async resetGlobalMcpServerAuth({ name }: GlobalMcpServerNamePayload): Promise<void> {
    const server = await this.globalMcpConfig.get(name);
    const config = requireRemoteMcpServer(server);
    this.globalMcpOAuth.invalidate(server.name, config.url);
  }

  async testGlobalMcpServer(
    { name, cwd }: TestGlobalMcpServerPayload,
  ): Promise<GlobalMcpServerTestResult> {
    const server = await this.globalMcpConfig.get(name);
    const config = mcpConfigWithoutName(server);
    const manager = new McpConnectionManager({
      stdioCwd: cwd,
      oauthService: this.globalMcpOAuth,
      defaultStartupTimeoutMs: resolveMcpStartupTimeoutMs(this.config.mcp?.startupTimeoutMs),
      defaultToolTimeoutMs: resolveMcpToolTimeoutMs(this.config.mcp?.toolTimeoutMs),
    });
    try {
      await manager.connectAll({ [server.name]: config });
      return standaloneMcpTestResult(server.name, manager);
    } finally {
      await manager.shutdown();
    }
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
  }

  async setPluginMcpServerEnabled({
    id,
    server,
    enabled,
  }: SetPluginMcpServerEnabledPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.setMcpServerEnabled(id, server, enabled);
  }

  async removePlugin({ id }: RemovePluginPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.remove(id);
  }

  async reloadPlugins(_: EmptyPayload): Promise<ReloadPluginsResult> {
    try {
      const summary = await this.plugins.reload();
      this.pluginsLoadError = undefined;
      return summary;
    } catch (error) {
      this.pluginsLoadError = error instanceof Error ? error : new Error(String(error));
      throw new KimiError(
        ErrorCodes.PLUGIN_LOAD_FAILED,
        `Failed to reload plugins: ${this.pluginsLoadError.message}`,
        { cause: error, details: { kimiHomeDir: this.homeDir } },
      );
    }
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
    const pluginServers = this.withManagedKimiPluginEnv(this.plugins.enabledMcpServers());
    if (Object.keys(pluginServers).length === 0) return base;
    return {
      servers: {
        ...base?.servers,
        ...pluginServers,
      },
    };
  }

  private withManagedKimiPluginEnv(
    pluginServers: Record<string, McpServerConfig>,
  ): Record<string, McpServerConfig> {
    const managedEnv = this.managedKimiCodeEnvForPlugins();
    if (Object.keys(managedEnv).length === 0) return pluginServers;

    const out: Record<string, McpServerConfig> = {};
    for (const [name, server] of Object.entries(pluginServers)) {
      out[name] =
        server.transport === 'stdio'
          ? { ...server, env: { ...server.env, ...managedEnv } }
          : server;
    }
    return out;
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

function requireRemoteMcpServer(server: GlobalMcpServerConfig): McpRemoteServerConfig {
  const config = mcpConfigWithoutName(server);
  if (config.transport !== 'stdio') return config;
  throw new KimiError(
    ErrorCodes.REQUEST_INVALID,
    `MCP server "${server.name}" does not use a remote transport`,
  );
}

function requireOAuthMcpServer(server: GlobalMcpServerConfig): McpRemoteServerConfig {
  const config = requireRemoteMcpServer(server);
  if (config.bearerTokenEnvVar !== undefined) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${server.name}" uses a static bearer token`,
    );
  }
  if (config.headers !== undefined && config.auth !== 'oauth') {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${server.name}" uses static headers and is not marked for OAuth`,
    );
  }
  return config;
}

function mcpConfigWithoutName(server: GlobalMcpServerConfig): McpServerConfig {
  const { name: _name, ...config } = server;
  return config;
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
