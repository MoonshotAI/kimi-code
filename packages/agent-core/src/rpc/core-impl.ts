import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { localKaos } from '@moonshot-ai/kaos';
import { ErrorCodes, KimiError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import { LocalFetchURLProvider } from '#/tools/providers/local-fetch-url';
import { MoonshotFetchURLProvider } from '#/tools/providers/moonshot-fetch-url';
import { MoonshotWebSearchProvider } from '#/tools/providers/moonshot-web-search';
import { detectEnvironmentFromNode } from '#/utils/environment';
import { getCoreVersion } from '#/version';
import type {
  ActivateSkillPayload,
  BeginCompactionPayload,
  CancelPayload,
  CancelPlanPayload,
  CloseSessionPayload,
  CoreAPI,
  CoreInfo,
  CreateSessionPayload,
  EmptyPayload,
  ExportSessionPayload,
  ExportSessionResult,
  ForkSessionPayload,
  GetBackgroundOutputPathPayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
  ListSessionsPayload,
  McpServerInfo,
  McpStartupMetrics,
  PromptPayload,
  ReconnectMcpServerPayload,
  RemoveKimiProviderPayload,
  RenameSessionPayload,
  ResumeSessionPayload,
  RegisterToolPayload,
  SetKimiConfigPayload,
  SetActiveToolsPayload,
  SetModelPayload,
  SetModelResult,
  SetPermissionPayload,
  SetThinkingPayload,
  SkillSummary,
  SteerPayload,
  StopBackgroundPayload,
  SessionSummary,
  UnregisterToolPayload,
  UpdateSessionMetadataPayload,
} from './core-api';
import type { CoreRPCClient } from './client';
import type { ResumedAgentState, ResumeSessionResult } from './resumed';
import type { SDKRPC } from './sdk-api';
import { proxyWithExtraPayload } from './types';
import type { PromisableMethods } from '#/utils/types';

import { resolveSessionMcpConfig } from '../mcp';
import { Session, type SessionMeta, type SessionSkillConfig } from '../session';
import { SessionAPIImpl } from '../session/rpc';
import {
  ensureKimiHome,
  mergeConfigPatch,
  readConfigFile,
  resolveConfigPath,
  resolveKimiHome,
  writeConfigFile,
  type KimiConfig,
  type MoonshotServiceConfig,
} from '../config';
import { exportSessionDirectory } from '../session/export';
import { ProviderManager } from '../providers/provider-manager';
import {
  type BearerTokenProvider,
  type OAuthTokenProviderResolver,
} from '../providers/runtime-provider';
import type { Logger } from '../logging/types';
import type { RuntimeConfig } from '../runtime-types';
import { normalizeWorkDir, SessionStore } from '../session/store';
import { noopTelemetryClient, withTelemetryContext, type TelemetryClient } from '../telemetry';

const KIMI_CODE_PROVIDER_NAME = 'managed:kimi-code';

type AgentScopedPayload<T> = T & { readonly agentId: string };
type SessionScopedPayload<T> = T & { readonly sessionId: string };
type SessionAgentPayload<T> = SessionScopedPayload<AgentScopedPayload<T>>;
type RenameSessionRequest = SessionScopedPayload<RenameSessionPayload>;
type UpdateSessionMetadataRequest = SessionScopedPayload<UpdateSessionMetadataPayload>;

export interface KimiCoreOptions {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly runtime?: RuntimeConfig | undefined;
  readonly kimiRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient | undefined;
}

export class KimiCore implements PromisableMethods<CoreAPI> {
  readonly sdk: Promise<SDKRPC>;
  readonly homeDir: string;
  readonly configPath: string;
  readonly sessions = new Map<string, Session>();
  readonly telemetry: TelemetryClient;

  private runtime: RuntimeConfig | undefined;
  private readonly userHomeDir: string;
  private readonly kimiRequestHeaders: Record<string, string> | undefined;
  private readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver | undefined;
  private readonly skillDirs: readonly string[];
  private readonly providerManager: ProviderManager;
  private readonly sessionStore: SessionStore;

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
    this.runtime = options.runtime;
    this.kimiRequestHeaders = options.kimiRequestHeaders;
    this.resolveOAuthTokenProvider = options.resolveOAuthTokenProvider;
    this.skillDirs = options.skillDirs ?? [];
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    ensureKimiHome(this.homeDir);
    this.providerManager = new ProviderManager({
      config: readConfigFile(this.configPath),
      kimiRequestHeaders: this.kimiRequestHeaders,
      resolveOAuthTokenProvider: this.resolveOAuthTokenProvider,
    });
    this.sessionStore = new SessionStore(this.homeDir);

    this.sdk = rpcClient(this);
  }

  async createSession(input: CreateSessionPayload): Promise<SessionSummary> {
    const options = input;
    const workDir = requiredWorkDir('createSession', options.workDir);
    const config = this.reloadProviderManager();
    const id = options.id ?? createSessionId();
    const modelName = this.providerManager.resolveSelectedModel(options.model);
    const thinkingLevel = this.providerManager.resolveThinkingLevel(options.thinking);
    const permissionMode = options.permission ?? config.defaultPermissionMode;
    const mcpConfig = await resolveSessionMcpConfig({
      cwd: workDir,
      homeDir: this.homeDir,
    });
    const summary = await this.sessionStore.create({
      id,
      workDir,
    });
    const result: SessionSummary = {
      ...summary,
      metadata: options.metadata,
    };

    // Session ctor attaches its own log sink. If anything in the setup-after-
    // ctor block throws, `session.close()` releases the sink (and mcp).
    const session = new Session({
      runtime: await this.resolveRuntime(config),
      id,
      homedir: summary.sessionDir,
      kimiHomeDir: this.homeDir,
      rpc: proxyWithExtraPayload(await this.sdk, { sessionId: summary.id }),
      cwd: workDir,
      providerManager: this.providerManager,
      background: config.background,
      hooks: config.hooks,
      permissionRules: config.permission?.rules,
      skills: this.resolveSessionSkillConfig(config),
      mcpConfig,
      telemetry: withTelemetryContext(this.telemetry, { sessionId: summary.id }),
    });
    try {
      session.metadata = {
        ...session.metadata,
        createdAt: new Date(summary.createdAt).toISOString(),
        updatedAt: new Date(summary.updatedAt).toISOString(),
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
        cwd: workDir,
        modelAlias: modelName,
        thinkingLevel,
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
    return result;
  }

  getCoreInfo(): CoreInfo {
    return { version: getCoreVersion() };
  }

  async closeSession({ sessionId }: CloseSessionPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.close();
      this.sessions.delete(sessionId);
    }
  }

  async resumeSession(input: ResumeSessionPayload): Promise<ResumeSessionResult> {
    const summary = await this.sessionStore.get(input.sessionId);
    const active = this.sessions.get(summary.id);
    if (active !== undefined) {
      return resumeSessionResult(summary, active);
    }

    const config = this.reloadProviderManager();
    const mcpConfig = await resolveSessionMcpConfig({
      cwd: summary.workDir,
      homeDir: this.homeDir,
    });
    const session = new Session({
      runtime: await this.resolveRuntime(config),
      id: summary.id,
      homedir: summary.sessionDir,
      kimiHomeDir: this.homeDir,
      rpc: proxyWithExtraPayload(await this.sdk, { sessionId: summary.id }),
      cwd: summary.workDir,
      providerManager: this.providerManager,
      background: config.background,
      hooks: config.hooks,
      permissionRules: config.permission?.rules,
      skills: this.resolveSessionSkillConfig(config),
      mcpConfig,
      telemetry: withTelemetryContext(this.telemetry, { sessionId: summary.id }),
      initializeMainAgent: false,
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
    return resumeSessionResult(summary, session, warning);
  }

  async forkSession(input: ForkSessionPayload): Promise<ResumeSessionResult> {
    const source = await this.sessionStore.get(input.sessionId);
    const active = this.sessions.get(source.id);
    if (active !== undefined) {
      await active.flushMetadata();
    }

    const id = input.id ?? createSessionId();
    await this.sessionStore.fork({
      sourceId: source.id,
      targetId: id,
      title: input.title,
      metadata: input.metadata,
    });
    return this.resumeSession({ sessionId: id });
  }

  async listSessions(input: ListSessionsPayload): Promise<readonly SessionSummary[]> {
    const options = input;
    return this.sessionStore.list({
      ...options,
      workDir: requiredWorkDir('listSessions', options.workDir),
    });
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

  async getKimiConfig(input: EmptyPayload = {}): Promise<KimiConfig> {
    void input;
    return readConfigFile(this.configPath);
  }

  async setKimiConfig(input: SetKimiConfigPayload): Promise<KimiConfig> {
    const config = mergeConfigPatch(readConfigFile(this.configPath), input);
    await writeConfigFile(this.configPath, config);
    const updated = readConfigFile(this.configPath);
    this.providerManager.updateConfig(updated);
    return updated;
  }

  async removeKimiProvider(input: RemoveKimiProviderPayload): Promise<KimiConfig> {
    const config = readConfigFile(this.configPath);
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
    const updated = readConfigFile(this.configPath);
    this.providerManager.updateConfig(updated);
    return updated;
  }

  prompt({ sessionId, ...payload }: SessionAgentPayload<PromptPayload>) {
    return this.sessionApi(sessionId).prompt(payload);
  }

  steer({ sessionId, ...payload }: SessionAgentPayload<SteerPayload>) {
    return this.sessionApi(sessionId).steer(payload);
  }

  cancel({ sessionId, ...payload }: SessionAgentPayload<CancelPayload>) {
    return this.sessionApi(sessionId).cancel(payload);
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

  clearContext({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).clearContext(payload);
  }

  activateSkill({
    sessionId,
    ...payload
  }: SessionAgentPayload<ActivateSkillPayload>): Promise<void> {
    return this.sessionApi(sessionId).activateSkill(payload);
  }

  getBackgroundOutput({ sessionId, ...payload }: SessionAgentPayload<GetBackgroundOutputPayload>) {
    return this.sessionApi(sessionId).getBackgroundOutput(payload);
  }

  getBackgroundOutputPath({
    sessionId,
    ...payload
  }: SessionAgentPayload<GetBackgroundOutputPathPayload>) {
    return this.sessionApi(sessionId).getBackgroundOutputPath(payload);
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

  private async resolveRuntime(config: KimiConfig): Promise<RuntimeConfig> {
    if (this.runtime !== undefined) return this.runtime;
    const runtime = await createRuntimeConfig({
      config,
      kimiRequestHeaders: this.kimiRequestHeaders,
      resolveOAuthTokenProvider: this.resolveOAuthTokenProvider,
    });
    this.runtime = runtime;
    return runtime;
  }

  private resolveSessionSkillConfig(config: KimiConfig): SessionSkillConfig {
    const explicitDirs = this.skillDirs.length > 0 ? this.skillDirs : undefined;
    return {
      userHomeDir: this.userHomeDir,
      explicitDirs,
      extraDirs: config.extraSkillDirs,
      mergeAllAvailableSkills: config.mergeAllAvailableSkills,
    };
  }

  private sessionApi(sessionId: string): SessionAPIImpl {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session "${sessionId}" was not found`, {
        details: { sessionId },
      });
    }
    return new SessionAPIImpl(session);
  }

  private reloadProviderManager(): KimiConfig {
    const config = readConfigFile(this.configPath);
    this.providerManager.updateConfig(config);
    return config;
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
    // No candidate resolved (the replayed alias and the configured default are
    // both invalid/unset). Clear the stale alias so the session is honestly
    // model-less — the TUI then prompts for a model instead of showing a
    // selection whose next prompt fails with a config error. Not persisted:
    // `refreshSessionRuntimeConfig` re-derives this on every resume.
    if (requested.length > 0) {
      session.agents.get('main')?.config.update({ modelAlias: undefined });
    }
  }
}

async function createRuntimeConfig(input: {
  readonly config: KimiConfig;
  readonly kimiRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
}): Promise<RuntimeConfig> {
  const localFetcher = new LocalFetchURLProvider();
  const searchService = input.config.services?.moonshotSearch;
  const fetchService = input.config.services?.moonshotFetch;

  return {
    kaos: localKaos,
    osEnv: await detectEnvironmentFromNode(),
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

function telemetryErrorReason(error: unknown): string {
  if (error instanceof KimiError) return error.code;
  if (error instanceof Error && error.name.length > 0) return error.name;
  return typeof error;
}

async function resumeSessionResult(
  summary: SessionSummary,
  session: Session,
  warning?: string,
): Promise<ResumeSessionResult> {
  const api = new SessionAPIImpl(session);
  const agents: Record<string, ResumedAgentState> = {};
  for (const [agentId, agent] of session.agents) {
    const config = await api.getConfig({ agentId });
    const context = await api.getContext({ agentId });
    const permission = await api.getPermission({ agentId });
    const plan = await api.getPlan({ agentId });
    const usage = await api.getUsage({ agentId });
    agents[agentId] = {
      type: agent.type,
      config,
      context,
      replay: agent.replayBuilder.buildResult(),
      permission,
      plan,
      usage,
      tools: await api.getTools({ agentId }),
      toolStore: agent.tools.storeData(),
      background: agent.background.list(false),
    };
  }
  return {
    ...summary,
    sessionMetadata: api.getSessionMetadata({}),
    agents,
    warning,
  };
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
