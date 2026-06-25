import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'pathe';
import { KaosShellNotFoundError, LocalKaos, type Kaos } from '@moonshot-ai/kaos';
import {
  createKimiDefaultHeaders,
  KIMI_CODE_PROVIDER_NAME,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-oauth';
import type { SessionWarning } from '@moonshot-ai/protocol';

import {
  Disposable,
  type IDisposable,
  IInstantiationService,
  registerSingleton,
  SyncDescriptor,
} from '../../di';
import { ErrorCodes, KimiError } from '../../errors';
import { SessionStore } from '../../session/store';
import type {
  AddAdditionalDirPayload,
  AddAdditionalDirResult,
  ClientTelemetryInfo,
  SessionAPI,
  SessionSummary,
} from '../../rpc';
import {
  appendWorkspaceAdditionalDir,
  loadRuntimeConfigSafe,
  normalizeAdditionalDirs,
  readWorkspaceAdditionalDirs,
  resolveWorkspaceAdditionalDirs,
  type KimiConfig,
  type MoonshotServiceConfig,
} from '../../config';
import { resolveThinkingLevel } from '../../agent/config/thinking';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
} from '../../profile';
import {
  registerBuiltinSkills,
  resolveSkillRoots,
  SessionSkillRegistry,
  summarizeSkill,
} from '../../skill';
import {
  ProviderManager,
  type BearerTokenProvider,
  type OAuthTokenProviderResolver,
} from '../../session/provider-manager';
import { LocalFetchURLProvider } from '../../tools/providers/local-fetch-url';
import { MoonshotFetchURLProvider } from '../../tools/providers/moonshot-fetch-url';
import { MoonshotWebSearchProvider } from '../../tools/providers/moonshot-web-search';
import type { ToolServices } from '../../tools/support/services';
import { createManagedAuthFacade } from '../auth/managedAuth';
import {
  noopTelemetryClient,
  withTelemetryContext,
  withTelemetryProperties,
  type TelemetryClient,
  type TelemetryProperties,
} from '../../telemetry';
import {
  createAgentRuntime,
  IEventBus,
  IAgentRPCService,
  IMcpRuntimeService,
  ISubagentHost,
  ITurnRunner,
  type AgentRuntime,
  type AgentRuntimeType,
  type AgentRuntimeOptions,
  type ISessionRPCService,
} from '../agent';
import { IProfileService } from '../agent/profile/profile';
import { IEnvironmentService } from '../environment/environment';
import {
  type AgentRuntimeCreateSessionOptions,
  type AgentRuntimeForkSessionOptions,
  AgentRuntimeTodoError,
  IAgentRuntimeService,
} from './agentRuntime';
import { IEventService } from '../event/event';

interface AgentMetaState {
  readonly homedir: string;
  readonly type: AgentRuntimeType;
}

interface SessionState {
  readonly agents: Record<string, AgentMetaState>;
}

interface CachedRuntime {
  readonly runtime: AgentRuntime;
  readonly eventSubscription: IDisposable;
}

interface CachedSessionRuntime {
  readonly summary: SessionSummary;
  state: SessionState;
  additionalDirs: readonly string[];
  readonly skills: SessionSkillRegistry;
  readonly rpc: ISessionRPCService;
  readonly agents: Map<string, Promise<CachedRuntime | undefined>>;
}

type AgentScopedPayload<T extends keyof SessionAPI> = Parameters<SessionAPI[T]>[0];

export interface AgentRuntimeServiceOptions {
  readonly telemetry?: TelemetryClient | undefined;
  readonly kimiRequestHeaders?: Record<string, string> | undefined;
  readonly identity?: KimiHostIdentity | undefined;
  readonly skillDirs?: readonly string[] | undefined;
}

export class AgentRuntimeService
  extends Disposable
  implements IAgentRuntimeService
{
  declare readonly _serviceBrand: undefined;

  private readonly store: SessionStore;
  private readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver;
  private readonly telemetry: TelemetryClient;
  private readonly kimiRequestHeaders: Record<string, string> | undefined;
  private readonly skillDirs: readonly string[];
  private readonly sessions = new Map<string, Promise<CachedSessionRuntime | undefined>>();
  private kaos: Promise<Kaos> | undefined;
  private configValue: KimiConfig | undefined;
  private runtimeTools: ToolServices | undefined;

  constructor(
    options: AgentRuntimeServiceOptions = {},
    @IEnvironmentService private readonly env: IEnvironmentService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
    this.store = new SessionStore(env.homeDir);
    this.resolveOAuthTokenProvider = createManagedAuthFacade(env).resolveOAuthTokenProvider;
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.kimiRequestHeaders =
      options.kimiRequestHeaders ?? defaultKimiRequestHeaders(env.homeDir, options.identity);
    this.skillDirs = options.skillDirs ?? [];
  }

  async createSession(
    options: AgentRuntimeCreateSessionOptions,
  ): Promise<SessionSummary> {
    const id = options.id ?? createSessionId();
    const additionalDirs = await this.resolveSessionAdditionalDirs(
      options.workDir,
      options.additionalDirs,
    );
    const created = await this.store.create({ id, workDir: options.workDir });
    const agentHomedir = join(created.sessionDir, 'agents', 'main');
    const now = new Date().toISOString();
    await writeSessionState(created.sessionDir, {
      createdAt: now,
      updatedAt: now,
      title: options.title?.trim() || 'New Session',
      isCustomTitle: options.title !== undefined && options.title.trim().length > 0,
      agents: {
        main: {
          homedir: agentHomedir,
          type: 'main',
          parentAgentId: null,
        },
      },
      custom: options.metadata === undefined ? {} : { ...options.metadata },
    });

    const session = await this.getCachedSession(created.id);
    if (session === undefined) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Session "${created.id}" state is not available`,
      );
    }
    session.additionalDirs = additionalDirs;
    const runtime = await this.createRuntimeForSession(
      session,
      {
        homedir: agentHomedir,
        type: 'main',
      },
      'main',
    );
    try {
      await this.initializeFreshMainRuntime(runtime, created, {
        ...options,
        additionalDirs,
      });
      await runtime.flush();
      this.cacheRuntime(session, 'main', runtime);
      this.trackSessionStarted(created.id, options.client);
      return await this.store.get(created.id);
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  }

  async forkSession(
    options: AgentRuntimeForkSessionOptions,
  ): Promise<SessionSummary> {
    const source = await this.store.get(options.sourceId);
    await this.assertForkableAndFlush(source.id);
    const id = options.id ?? createSessionId();
    await this.store.fork({
      sourceId: source.id,
      targetId: id,
      title: options.title,
      metadata: options.metadata,
    });
    return this.store.get(id);
  }

  async get(sessionId: string, agentId = 'main'): Promise<AgentRuntime | undefined> {
    const session = await this.getCachedSession(sessionId);
    if (session === undefined) return undefined;
    const cached = await this.getCachedAgent(session, agentId);
    return cached?.runtime;
  }

  async require(sessionId: string, agentId = 'main'): Promise<AgentRuntime> {
    const runtime = await this.get(sessionId, agentId);
    if (runtime !== undefined) return runtime;
    throw new AgentRuntimeTodoError(
      'packages/agent-core/src/services/agentRuntime/agentRuntimeService.ts:require',
      `Runtime for session "${sessionId}" agent "${agentId}" is not available through services/agent.`,
    );
  }

  async getRPC(
    sessionId: string,
    agentId = 'main',
  ): Promise<IAgentRPCService | undefined> {
    const runtime = await this.get(sessionId, agentId);
    return runtime?.get(IAgentRPCService);
  }

  async requireRPC(sessionId: string, agentId = 'main'): Promise<IAgentRPCService> {
    const runtime = await this.require(sessionId, agentId);
    return runtime.get(IAgentRPCService);
  }

  async getSessionRPC(sessionId: string): Promise<ISessionRPCService | undefined> {
    const session = await this.getCachedSession(sessionId);
    return session?.rpc;
  }

  async requireSessionRPC(sessionId: string): Promise<ISessionRPCService> {
    const rpc = await this.getSessionRPC(sessionId);
    if (rpc !== undefined) return rpc;
    throw new AgentRuntimeTodoError(
      'packages/agent-core/src/services/agentRuntime/agentRuntimeService.ts:requireSessionRPC',
      `Session RPC for session "${sessionId}" is not available through services/agent.`,
    );
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary | undefined> {
    try {
      return await this.store.get(sessionId);
    } catch {
      return undefined;
    }
  }

  listSessionSummaries(options: {
    readonly workDir?: string;
    readonly includeArchive?: boolean;
  } = {}): Promise<readonly SessionSummary[]> {
    return this.store.list(options);
  }

  async forget(sessionId: string, agentId = 'main'): Promise<void> {
    const session = await this.sessions.get(sessionId);
    const cached = await session?.agents.get(agentId);
    session?.agents.delete(agentId);
    cached?.eventSubscription.dispose();
    await cached?.runtime.close();
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    const cached = [...this.sessions.values()];
    this.sessions.clear();
    for (const entry of cached) {
      void entry.then((session) => this.closeSessionRuntime(session)).catch(() => undefined);
    }
    super.dispose();
  }

  private getCachedSession(
    sessionId: string,
  ): Promise<CachedSessionRuntime | undefined> {
    let cached = this.sessions.get(sessionId);
    if (cached === undefined) {
      cached = this.createSessionRuntime(sessionId).catch((error: unknown) => {
        this.sessions.delete(sessionId);
        if (isNotFoundError(error)) return undefined;
        throw error;
      });
      this.sessions.set(sessionId, cached);
    }
    return cached;
  }

  private getCachedAgent(
    session: CachedSessionRuntime,
    agentId: string,
  ): Promise<CachedRuntime | undefined> {
    let cached = session.agents.get(agentId);
    if (cached === undefined) {
      cached = this.createRuntimeForCachedAgent(session, agentId);
      session.agents.set(agentId, cached);
    }
    return cached;
  }

  private async createRuntimeForCachedAgent(
    session: CachedSessionRuntime,
    agentId: string,
  ): Promise<CachedRuntime | undefined> {
    try {
      if (session.state.agents[agentId] === undefined) {
        await this.refreshSessionState(session);
      }
      const runtime = await this.createRuntime(session, agentId);
      if (runtime === undefined) {
        session.agents.delete(agentId);
      }
      return runtime;
    } catch (error) {
      session.agents.delete(agentId);
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }

  private async refreshSessionState(session: CachedSessionRuntime): Promise<void> {
    const state = await readSessionState(session.summary.sessionDir);
    if (state !== undefined) {
      session.state = state;
    }
  }

  private async assertForkableAndFlush(sessionId: string): Promise<void> {
    const cached = await this.cachedForSession(sessionId);
    for (const entry of cached) {
      if (entry.runtime.get(ITurnRunner).getActiveTurn() === undefined) continue;
      throw new KimiError(
        ErrorCodes.SESSION_FORK_ACTIVE_TURN,
        `Session "${sessionId}" cannot be forked while a turn is running`,
        { details: { sessionId } },
      );
    }
    await Promise.all(cached.map((entry) => entry.runtime.flush()));
  }

  private async cachedForSession(sessionId: string): Promise<readonly CachedRuntime[]> {
    const session = await this.sessions.get(sessionId);
    if (session === undefined) return [];
    const pending = [...session.agents.values()];
    const resolved = await Promise.all(pending);
    return resolved.filter((entry): entry is CachedRuntime => entry !== undefined);
  }

  private async createSessionRuntime(
    sessionId: string,
  ): Promise<CachedSessionRuntime | undefined> {
    const summary = await this.store.get(sessionId);
    const state = await readSessionState(summary.sessionDir);
    if (state === undefined) return undefined;
    const config = this.loadRuntimeConfig();
    const skills = await this.createSkillRegistry(summary, config);
    const additionalDirs = await this.resolveSessionAdditionalDirs(summary.workDir);
    return {
      summary,
      state,
      additionalDirs,
      skills,
      rpc: this.createSessionRPC(summary.id, skills),
      agents: new Map(),
    };
  }

  private createSessionRPC(
    sessionId: string,
    skills: SessionSkillRegistry,
  ): ISessionRPCService {
    return {
      renameSession: (payload: AgentScopedPayload<'renameSession'>) =>
        this.store.rename(sessionId, payload.title),
      updateSessionMetadata: (payload: AgentScopedPayload<'updateSessionMetadata'>) =>
        this.store.updateMetadata(sessionId, payload.metadata),
      getSessionMetadata: (_payload: AgentScopedPayload<'getSessionMetadata'>) =>
        this.store.getMetadata(sessionId),
      listSkills: (_payload: AgentScopedPayload<'listSkills'>) =>
        skills.listSkills().map(summarizeSkill),
      listMcpServers: async (_payload: AgentScopedPayload<'listMcpServers'>) => {
        const runtime = await this.require(sessionId, 'main');
        return runtime.get(IMcpRuntimeService).list();
      },
      getMcpStartupMetrics: async (_payload: AgentScopedPayload<'getMcpStartupMetrics'>) => {
        const runtime = await this.require(sessionId, 'main');
        const mcpRuntime = runtime.get(IMcpRuntimeService);
        await mcpRuntime.waitForInitialLoad();
        return { durationMs: mcpRuntime.initialLoadDurationMs() };
      },
      reconnectMcpServer: async (payload: AgentScopedPayload<'reconnectMcpServer'>) => {
        const runtime = await this.require(sessionId, 'main');
        await runtime.get(IMcpRuntimeService).reconnect(payload.name);
      },
      generateAgentsMd: async (_payload: AgentScopedPayload<'generateAgentsMd'>) => {
        const runtime = await this.require(sessionId, 'main');
        await runtime.get(ISubagentHost).generateAgentsMd();
      },
      getSessionWarnings: (_payload: AgentScopedPayload<'getSessionWarnings'>) =>
        this.getSessionWarnings(sessionId),
      addAdditionalDir: (payload: AgentScopedPayload<'addAdditionalDir'>) =>
        this.addAdditionalDir(sessionId, payload),
      prompt: ({ agentId, ...payload }: AgentScopedPayload<'prompt'>) =>
        this.callAgentRPC(sessionId, agentId, 'prompt', payload),
      steer: ({ agentId, ...payload }: AgentScopedPayload<'steer'>) =>
        this.callAgentRPC(sessionId, agentId, 'steer', payload),
      cancel: ({ agentId, ...payload }: AgentScopedPayload<'cancel'>) =>
        this.callAgentRPC(sessionId, agentId, 'cancel', payload),
      undoHistory: ({ agentId, ...payload }: AgentScopedPayload<'undoHistory'>) =>
        this.callAgentRPC(sessionId, agentId, 'undoHistory', payload),
      setThinking: ({ agentId, ...payload }: AgentScopedPayload<'setThinking'>) =>
        this.callAgentRPC(sessionId, agentId, 'setThinking', payload),
      setPermission: ({ agentId, ...payload }: AgentScopedPayload<'setPermission'>) =>
        this.callAgentRPC(sessionId, agentId, 'setPermission', payload),
      setModel: ({ agentId, ...payload }: AgentScopedPayload<'setModel'>) =>
        this.callAgentRPC(sessionId, agentId, 'setModel', payload),
      getModel: ({ agentId, ...payload }: AgentScopedPayload<'getModel'>) =>
        this.callAgentRPC(sessionId, agentId, 'getModel', payload),
      enterPlan: ({ agentId, ...payload }: AgentScopedPayload<'enterPlan'>) =>
        this.callAgentRPC(sessionId, agentId, 'enterPlan', payload),
      cancelPlan: ({ agentId, ...payload }: AgentScopedPayload<'cancelPlan'>) =>
        this.callAgentRPC(sessionId, agentId, 'cancelPlan', payload),
      clearPlan: ({ agentId, ...payload }: AgentScopedPayload<'clearPlan'>) =>
        this.callAgentRPC(sessionId, agentId, 'clearPlan', payload),
      enterSwarm: ({ agentId, ...payload }: AgentScopedPayload<'enterSwarm'>) =>
        this.callAgentRPC(sessionId, agentId, 'enterSwarm', payload),
      exitSwarm: ({ agentId, ...payload }: AgentScopedPayload<'exitSwarm'>) =>
        this.callAgentRPC(sessionId, agentId, 'exitSwarm', payload),
      getSwarmMode: ({ agentId, ...payload }: AgentScopedPayload<'getSwarmMode'>) =>
        this.callAgentRPC(sessionId, agentId, 'getSwarmMode', payload),
      beginCompaction: ({ agentId, ...payload }: AgentScopedPayload<'beginCompaction'>) =>
        this.callAgentRPC(sessionId, agentId, 'beginCompaction', payload),
      cancelCompaction: ({ agentId, ...payload }: AgentScopedPayload<'cancelCompaction'>) =>
        this.callAgentRPC(sessionId, agentId, 'cancelCompaction', payload),
      registerTool: ({ agentId, ...payload }: AgentScopedPayload<'registerTool'>) =>
        this.callAgentRPC(sessionId, agentId, 'registerTool', payload),
      unregisterTool: ({ agentId, ...payload }: AgentScopedPayload<'unregisterTool'>) =>
        this.callAgentRPC(sessionId, agentId, 'unregisterTool', payload),
      setActiveTools: ({ agentId, ...payload }: AgentScopedPayload<'setActiveTools'>) =>
        this.callAgentRPC(sessionId, agentId, 'setActiveTools', payload),
      stopBackground: ({ agentId, ...payload }: AgentScopedPayload<'stopBackground'>) =>
        this.callAgentRPC(sessionId, agentId, 'stopBackground', payload),
      detachBackground: ({ agentId, ...payload }: AgentScopedPayload<'detachBackground'>) =>
        this.callAgentRPC(sessionId, agentId, 'detachBackground', payload),
      clearContext: ({ agentId, ...payload }: AgentScopedPayload<'clearContext'>) =>
        this.callAgentRPC(sessionId, agentId, 'clearContext', payload),
      activateSkill: ({ agentId, ...payload }: AgentScopedPayload<'activateSkill'>) =>
        this.callAgentRPC(sessionId, agentId, 'activateSkill', payload),
      startBtw: ({ agentId, ...payload }: AgentScopedPayload<'startBtw'>) =>
        this.callAgentRPC(sessionId, agentId, 'startBtw', payload),
      createGoal: ({ agentId, ...payload }: AgentScopedPayload<'createGoal'>) =>
        this.callAgentRPC(sessionId, agentId, 'createGoal', payload),
      getGoal: ({ agentId, ...payload }: AgentScopedPayload<'getGoal'>) =>
        this.callAgentRPC(sessionId, agentId, 'getGoal', payload),
      pauseGoal: ({ agentId, ...payload }: AgentScopedPayload<'pauseGoal'>) =>
        this.callAgentRPC(sessionId, agentId, 'pauseGoal', payload),
      resumeGoal: ({ agentId, ...payload }: AgentScopedPayload<'resumeGoal'>) =>
        this.callAgentRPC(sessionId, agentId, 'resumeGoal', payload),
      cancelGoal: ({ agentId, ...payload }: AgentScopedPayload<'cancelGoal'>) =>
        this.callAgentRPC(sessionId, agentId, 'cancelGoal', payload),
      getBackgroundOutput: ({
        agentId,
        ...payload
      }: AgentScopedPayload<'getBackgroundOutput'>) =>
        this.callAgentRPC(sessionId, agentId, 'getBackgroundOutput', payload),
      getContext: ({ agentId, ...payload }: AgentScopedPayload<'getContext'>) =>
        this.callAgentRPC(sessionId, agentId, 'getContext', payload),
      getConfig: ({ agentId, ...payload }: AgentScopedPayload<'getConfig'>) =>
        this.callAgentRPC(sessionId, agentId, 'getConfig', payload),
      getPermission: ({ agentId, ...payload }: AgentScopedPayload<'getPermission'>) =>
        this.callAgentRPC(sessionId, agentId, 'getPermission', payload),
      getPlan: ({ agentId, ...payload }: AgentScopedPayload<'getPlan'>) =>
        this.callAgentRPC(sessionId, agentId, 'getPlan', payload),
      getUsage: ({ agentId, ...payload }: AgentScopedPayload<'getUsage'>) =>
        this.callAgentRPC(sessionId, agentId, 'getUsage', payload),
      getTools: ({ agentId, ...payload }: AgentScopedPayload<'getTools'>) =>
        this.callAgentRPC(sessionId, agentId, 'getTools', payload),
      getBackground: ({ agentId, ...payload }: AgentScopedPayload<'getBackground'>) =>
        this.callAgentRPC(sessionId, agentId, 'getBackground', payload),
    };
  }

  private async callAgentRPC<K extends keyof IAgentRPCService>(
    sessionId: string,
    agentId: string,
    method: K,
    payload: Parameters<IAgentRPCService[K]>[0],
  ): Promise<Awaited<ReturnType<IAgentRPCService[K]>>> {
    const rpc = await this.requireRPC(sessionId, agentId);
    return await rpc[method](payload as never) as Awaited<ReturnType<IAgentRPCService[K]>>;
  }

  private async addAdditionalDir(
    sessionId: string,
    payload: AddAdditionalDirPayload,
  ): Promise<AddAdditionalDirResult> {
    const session = await this.requireCachedSession(sessionId);
    const cwd = session.summary.workDir;
    const kaos = (await this.getKaos()).withCwd(cwd);
    if (payload.persist) {
      const result = await appendWorkspaceAdditionalDir(
        kaos,
        cwd,
        payload.path,
        session.additionalDirs,
      );
      const additionalDirs = normalizeAdditionalDirs([
        ...session.additionalDirs,
        ...result.additionalDirs,
      ]);
      await this.setSessionAdditionalDirs(session, additionalDirs);
      return { ...result, additionalDirs, persisted: true };
    }

    const workspace = await readWorkspaceAdditionalDirs(kaos, cwd);
    const additionalDirs = await resolveWorkspaceAdditionalDirs(kaos, cwd, [payload.path]);
    const nextAdditionalDirs = normalizeAdditionalDirs([
      ...session.additionalDirs,
      ...additionalDirs,
    ]);
    await this.setSessionAdditionalDirs(session, nextAdditionalDirs);
    return {
      projectRoot: workspace.projectRoot,
      configPath: workspace.configPath,
      additionalDirs: nextAdditionalDirs,
      persisted: false,
    };
  }

  private async getSessionWarnings(sessionId: string): Promise<readonly SessionWarning[]> {
    const session = await this.requireCachedSession(sessionId);
    try {
      const kaos = (await this.getKaos()).withCwd(session.summary.workDir);
      const context = await prepareSystemPromptContext(kaos, this.env.homeDir, {
        additionalDirs: session.additionalDirs,
      });
      if (context.agentsMdWarning === undefined) return [];
      return [
        {
          code: 'agents-md-oversized',
          message: context.agentsMdWarning,
          severity: 'warning',
        },
      ];
    } catch {
      return [];
    }
  }

  private async requireCachedSession(sessionId: string): Promise<CachedSessionRuntime> {
    const session = await this.getCachedSession(sessionId);
    if (session !== undefined) return session;
    throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session "${sessionId}" was not found`, {
      details: { sessionId },
    });
  }

  private async setSessionAdditionalDirs(
    session: CachedSessionRuntime,
    additionalDirs: readonly string[],
  ): Promise<void> {
    session.additionalDirs = normalizeAdditionalDirs(additionalDirs);
    const cached = await Promise.all(session.agents.values());
    for (const entry of cached) {
      entry?.runtime.setAdditionalDirs(session.additionalDirs);
    }
  }

  private async createRuntime(
    session: CachedSessionRuntime,
    agentId: string,
  ): Promise<CachedRuntime | undefined> {
    const meta = session.state.agents[agentId];
    if (meta === undefined) return undefined;

    const runtime = await this.createRuntimeForSession(session, meta, agentId);
    const eventSubscription = this.subscribeRuntimeEvents(runtime, session.summary.id, agentId);
    try {
      await runtime.restore();
    } catch (error) {
      eventSubscription.dispose();
      await runtime.close().catch(() => undefined);
      throw error;
    }
    return { runtime, eventSubscription };
  }

  private async createRuntimeForSession(
    session: CachedSessionRuntime,
    meta: AgentMetaState,
    agentId = 'main',
  ): Promise<AgentRuntime> {
    const summary = session.summary;
    const config = this.loadRuntimeConfig();
    const modelProvider = new ProviderManager({
      config: () => this.configValue ?? config,
      kimiRequestHeaders: this.kimiRequestHeaders,
      resolveOAuthTokenProvider: this.resolveOAuthTokenProvider,
      promptCacheKey: summary.id,
    });
    const kaos = await this.getKaos();
    const toolServices = await this.resolveRuntimeTools(config);
    return createAgentRuntime(this.instantiation, {
      sessionId: summary.id,
      agentId,
      type: meta.type,
      homedir: meta.homedir,
      cwd: summary.workDir,
      kaos: kaos.withCwd(summary.workDir),
      config: () => this.configValue ?? config,
      modelProvider,
      toolServices,
      skills: session.skills,
      additionalDirs: session.additionalDirs,
      telemetry: this.telemetry,
      cron: false,
      background: false,
    } satisfies AgentRuntimeOptions);
  }

  private async initializeFreshMainRuntime(
    runtime: AgentRuntime,
    summary: SessionSummary,
    options: AgentRuntimeCreateSessionOptions,
  ): Promise<void> {
    const config = this.loadRuntimeConfig();
    const profile = DEFAULT_AGENT_PROFILES['agent'];
    if (profile !== undefined) {
      const kaos = (await this.getKaos()).withCwd(summary.workDir);
      const preparedContext = await prepareSystemPromptContext(
        kaos,
        this.env.homeDir,
        { additionalDirs: options.additionalDirs ?? [] },
      );
      runtime.get(IProfileService).useProfile(profile, {
        osEnv: kaos.osEnv,
        cwd: summary.workDir,
        ...preparedContext,
      });
    }
    const model = options.model ?? config.defaultModel;
    if (model !== undefined && model.trim().length > 0) {
      try {
        runtime.get(IProfileService).setModel(model);
      } catch (error) {
        if (options.model !== undefined || !isConfigInvalidError(error)) {
          throw error;
        }
      }
    }
    const thinking = resolveThinkingLevel(options.thinking, config);
    runtime.get(IProfileService).setThinking(thinking);
  }

  private cacheRuntime(
    session: CachedSessionRuntime,
    agentId: string,
    runtime: AgentRuntime,
  ): void {
    const eventSubscription = this.subscribeRuntimeEvents(runtime, session.summary.id, agentId);
    session.agents.set(agentId, Promise.resolve({ runtime, eventSubscription }));
  }

  private async closeSessionRuntime(
    session: CachedSessionRuntime | undefined,
  ): Promise<void> {
    if (session === undefined) return;
    const cached = [...session.agents.values()];
    session.agents.clear();
    const resolved = await Promise.allSettled(cached);
    await Promise.all(
      resolved.map(async (result) => {
        if (result.status !== 'fulfilled') return;
        result.value?.eventSubscription.dispose();
        await result.value?.runtime.close();
      }),
    );
  }

  private subscribeRuntimeEvents(
    runtime: AgentRuntime,
    sessionId: string,
    agentId: string,
  ): IDisposable {
    return runtime.get(IEventBus).on((event) => {
      this.eventService.publish({ ...event, sessionId, agentId });
    });
  }

  private loadRuntimeConfig(): KimiConfig {
    const loaded = loadRuntimeConfigSafe(this.env.configPath);
    if (loaded.fileError !== undefined) {
      throw loaded.fileError;
    }
    this.configValue = loaded.config;
    this.runtimeTools = undefined;
    return loaded.config;
  }

  private async resolveRuntimeTools(config: KimiConfig): Promise<ToolServices> {
    if (this.runtimeTools !== undefined) return this.runtimeTools;
    const localFetcher = new LocalFetchURLProvider();
    const searchService = config.services?.moonshotSearch;
    const fetchService = config.services?.moonshotFetch;
    this.runtimeTools = {
      urlFetcher:
        fetchService?.baseUrl === undefined
          ? localFetcher
          : new MoonshotFetchURLProvider({
              baseUrl: fetchService.baseUrl,
              localFallback: localFetcher,
              defaultHeaders: this.kimiRequestHeaders,
              ...serviceCredentials(fetchService, this.resolveOAuthTokenProvider),
            }),
      webSearcher:
        searchService?.baseUrl === undefined
          ? undefined
          : new MoonshotWebSearchProvider({
              baseUrl: searchService.baseUrl,
              defaultHeaders: this.kimiRequestHeaders,
              ...serviceCredentials(searchService, this.resolveOAuthTokenProvider),
            }),
    };
    return this.runtimeTools;
  }

  private async resolveSessionAdditionalDirs(
    workDir: string,
    additionalDirs: readonly string[] = [],
  ): Promise<readonly string[]> {
    const kaos = await this.getKaos();
    const localWorkspaceDirs = await readWorkspaceAdditionalDirs(kaos, workDir);
    const callerAdditionalDirs = await resolveWorkspaceAdditionalDirs(
      kaos,
      workDir,
      additionalDirs,
    );
    return normalizeAdditionalDirs([
      ...localWorkspaceDirs.additionalDirs,
      ...callerAdditionalDirs,
    ]);
  }

  private async createSkillRegistry(
    summary: SessionSummary,
    config: KimiConfig,
  ): Promise<SessionSkillRegistry> {
    const registry = new SessionSkillRegistry({ sessionId: summary.id });
    const roots = await resolveSkillRoots({
      paths: {
        userHomeDir: homedir(),
        brandHomeDir: this.env.homeDir,
        workDir: summary.workDir,
      },
      explicitDirs: this.skillDirs.length > 0 ? this.skillDirs : undefined,
      extraDirs: config.extraSkillDirs,
      mergeAllAvailableSkills: config.mergeAllAvailableSkills,
    });
    await registry.loadRoots(roots);
    registerBuiltinSkills(registry);
    return registry;
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

  private trackSessionStarted(
    sessionId: string,
    client: ClientTelemetryInfo | undefined,
  ): void {
    const properties = clientTelemetryProperties(client);
    if (Object.keys(properties).length === 0) return;
    withTelemetryProperties(
      withTelemetryContext(this.telemetry, { sessionId }),
      properties,
    ).track('session_started', { resumed: false });
  }
}

async function readSessionState(sessionDir: string): Promise<SessionState | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const agents = parsed['agents'];
  if (!isRecord(agents)) return undefined;

  const result: Record<string, AgentMetaState> = {};
  for (const [agentId, entry] of Object.entries(agents)) {
    if (!isRecord(entry)) continue;
    const homedir = entry['homedir'];
    const type = entry['type'];
    if (typeof homedir !== 'string') continue;
    if (type !== 'main' && type !== 'sub' && type !== 'independent') continue;
    result[agentId] = { homedir, type };
  }
  return { agents: result };
}

interface FreshSessionState {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly isCustomTitle: boolean;
  readonly agents: {
    readonly main: {
      readonly homedir: string;
      readonly type: 'main';
      readonly parentAgentId: null;
    };
  };
  readonly custom: Record<string, unknown>;
}

async function writeSessionState(
  sessionDir: string,
  state: FreshSessionState,
): Promise<void> {
  await writeFile(
    join(sessionDir, 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}

function createSessionId(): string {
  return `session_${randomUUID()}`;
}

function serviceCredentials(
  service: MoonshotServiceConfig,
  resolveOAuthTokenProvider: OAuthTokenProviderResolver,
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
        ? resolveOAuthTokenProvider(KIMI_CODE_PROVIDER_NAME, service.oauth)
        : undefined,
    customHeaders: service.customHeaders,
  };
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function defaultKimiRequestHeaders(
  homeDir: string,
  identity: KimiHostIdentity | undefined,
): Record<string, string> | undefined {
  if (identity === undefined) return undefined;
  return createKimiDefaultHeaders({
    homeDir,
    ...identity,
  });
}

function clientTelemetryProperties(
  client: ClientTelemetryInfo | undefined,
): TelemetryProperties {
  if (client === undefined) return {};
  const properties: Record<string, string> = {};
  addNonEmpty(properties, 'client_id', client.id);
  addNonEmpty(properties, 'client_name', client.name);
  addNonEmpty(properties, 'client_version', client.version);
  addNonEmpty(properties, 'ui_mode', client.uiMode);
  return properties;
}

function addNonEmpty(
  target: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  const trimmed = value?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    target[key] = trimmed;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConfigInvalidError(error: unknown): boolean {
  return error instanceof KimiError && error.code === ErrorCodes.CONFIG_INVALID;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof KimiError && error.code === ErrorCodes.SESSION_NOT_FOUND;
}

registerSingleton(
  IAgentRuntimeService,
  new SyncDescriptor(AgentRuntimeService, [{}], true),
);
