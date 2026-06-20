import { homedir } from 'node:os';
import type { Kaos } from '@moonshot-ai/kaos';

import { ErrorCodes, KimiError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import type { Logger, SessionLogHandle } from '#/logging/types';
import type { KimiConfig, SDKSessionRPC } from '#/rpc';

import type { Agent, AgentOptions, AgentType } from '../agent';
import { ILifecycleService, LifecycleService } from '../agent/lifecycle';
import { HookService, IHookService, type HookDef } from './hooks';
import { SessionRepository } from './sessionRepository';
import type { PermissionRule } from '../agent/permission';
import { type BackgroundConfig } from '../config';
import { makeErrorPayload } from '../errors';
import {
  McpConnectionService,
  McpOAuthService,
  IMcpConnectionService,
  type McpServerEntry,
  type SessionMcpConfig,
} from '../mcp';
import type { EnabledPluginSessionStart } from '../plugin';
import {
  DEFAULT_INIT_PROMPT,
  loadAgentsMd,
  type ResolvedAgentProfile,
} from '../profile';
import type { IProviderService } from './provider-manager';
import {
  registerBuiltinSkills,
  SkillRegistryService,
  resolveSkillRoots,
  summarizeSkill,
  ISkillRegistryService,
  type SkillRoot,
  type SkillSummary,
} from '../skill';
import { noopTelemetryClient, type TelemetryClient } from '../telemetry';
import { SessionHost, type AgentEntry } from './session-host';
import type { ToolServices } from '../tools/support/services';
import { FlagResolver, type ExperimentalFlagResolver } from '../flags';
import {
  InstantiationService,
  ServiceCollection,
  SyncDescriptor,
  type IInstantiationService,
} from '../di';

export interface SessionOptions {
  readonly kaos: Kaos;
  readonly persistenceKaos?: Kaos;
  readonly config?: KimiConfig;
  readonly id?: string | undefined;
  readonly homedir: string;
  readonly kimiHomeDir?: string;
  readonly rpc: SDKSessionRPC;
  readonly toolServices?: ToolServices;
  readonly initializeMainAgent?: boolean | undefined;
  readonly providerManager?: IProviderService | undefined;
  readonly background?: BackgroundConfig | undefined;
  readonly hooks?: readonly HookDef[];
  readonly permissionRules?: readonly PermissionRule[];
  readonly skills?: SessionSkillConfig;
  readonly mcpConfig?: SessionMcpConfig;
  readonly telemetry?: TelemetryClient | undefined;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  readonly appVersion?: string;
  readonly experimentalFlags?: ExperimentalFlagResolver;
  readonly instantiationService?: IInstantiationService | undefined;
}

export interface SessionSkillConfig {
  readonly userHomeDir?: string;
  /** Brand data dir (KIMI_CODE_HOME); user brand skills live under `<brandHomeDir>/skills`. */
  readonly brandHomeDir?: string;
  readonly explicitDirs?: readonly string[];
  readonly extraDirs?: readonly string[];
  readonly pluginSkillRoots?: readonly SkillRoot[];
  readonly mergeAllAvailableSkills?: boolean;
  readonly builtinDir?: string;
}

export interface AgentMeta {
  readonly homedir: string;
  readonly type: AgentType;
  readonly parentAgentId: string | null;
  readonly swarmItem?: string;
}

export interface CreateAgentOptions {
  readonly profile?: ResolvedAgentProfile;
  readonly parentAgentId?: string;
  readonly swarmItem?: string;
  readonly persistMetadata?: boolean;
}

export interface SessionMeta {
  createdAt: string;
  updatedAt: string;
  title: string;
  isCustomTitle: boolean;
  lastPrompt?: string;
  forkedFrom?: string;
  agents: Record<string, AgentMeta>;
  custom: Record<string, any>;
}

export class Session {
  readonly rpc: SDKSessionRPC;
  readonly telemetry: TelemetryClient;
  readonly skills: ISkillRegistryService;
  private readonly scope: IInstantiationService;
  readonly mcp: IMcpConnectionService;
  readonly lifecycle: ILifecycleService;
  readonly log: Logger;
  private readonly logHandle: SessionLogHandle | undefined;
  readonly hookEngine: IHookService;
  readonly experimentalFlags: ExperimentalFlagResolver;
  private persistenceKaos: Kaos;
  private readonly sessionRepository: SessionRepository;
  private readonly skillsReady: Promise<void>;
  /**
   * Owns the agent registry + agent lifecycle for this session. Exposed so a
   * future `KimiCore.sessions` switch (M1.7b) can hold the host directly; for
   * now `KimiCore.sessions` still holds `Session` and delegates here.
   */
  readonly host: SessionHost;
  metadata: SessionMeta = {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'New Session',
    isCustomTitle: false,
    agents: {},
    custom: {},
  };

  constructor(public readonly options: SessionOptions) {
    // Attach the per-session log sink up front so the constructor's
    // fire-and-forget `loadSkills` / `loadMcpServers` failures (and
    // anything else that races) land in the session log, not just global.
    this.logHandle =
      options.id === undefined
        ? undefined
        : getRootLogger().attachSession({
          sessionId: options.id,
          sessionDir: options.homedir,
        });
    this.log =
      this.logHandle?.logger ??
      (options.id === undefined ? log : log.createChild({ sessionId: options.id }));
    this.rpc = options.rpc;
    this.experimentalFlags = options.experimentalFlags ?? new FlagResolver();
    const sessionServices = new ServiceCollection();
    sessionServices.set(
      IHookService,
      new SyncDescriptor(HookService, [
        options.hooks,
        { cwd: options.kaos.getcwd(), sessionId: options.id },
      ]),
    );
    sessionServices.set(
      ISkillRegistryService,
      new SyncDescriptor(SkillRegistryService, [{ sessionId: options.id }]),
    );
    sessionServices.set(
      IMcpConnectionService,
      new SyncDescriptor(McpConnectionService, [
        {
          oauthService: new McpOAuthService({ kimiHomeDir: options.kimiHomeDir }),
          log: this.log,
        },
      ]),
    );
    sessionServices.set(ILifecycleService, new SyncDescriptor(LifecycleService, []));
    this.scope = (options.instantiationService ?? new InstantiationService(undefined, true)).createChild(
      sessionServices,
    );
    this.hookEngine = this.scope.invokeFunction((accessor) => accessor.get(IHookService));
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.persistenceKaos = options.persistenceKaos ?? options.kaos;
    this.sessionRepository = new SessionRepository(options.homedir, this.persistenceKaos);
    this.skills = this.scope.invokeFunction((accessor) => accessor.get(ISkillRegistryService));
    this.mcp = this.scope.invokeFunction((accessor) => accessor.get(IMcpConnectionService));
    this.lifecycle = this.scope.invokeFunction((accessor) => accessor.get(ILifecycleService));
    this.mcp.onStatusChange((entry) => {
      this.onMcpServerStatusChange(entry);
    });
    this.skillsReady = this.loadSkills()
      .catch((error: unknown) => {
        this.log.error('skills load failed', error);
      })
      .then(() => {
        this.host.refreshAgentBuiltinTools();
      });
    void this.loadMcpServers().catch((error: unknown) => {
      this.emitInitialMcpLoadError(error);
    });
    this.host = new SessionHost({
      session: this,
      scope: this.scope,
      logHandle: this.logHandle,
      skillsReady: this.skillsReady,
    });
  }


  get agents(): Map<string, AgentEntry> {
    return this.host.agents;
  }

  setToolKaos(kaos: Kaos): void {
    this.host.setToolKaos(kaos);
  }

  /**
   * Kaos used by session-internal bootstrap (AGENTS.md context, cwd listing)
   * and metadata persistence. Always backed by the persistence sink (typically
   * the local filesystem) so a transient ACP-side failure on system files like
   * `AGENTS.md` never blocks `bootstrapAgentProfile` — tool calls still route
   * through `agent.kaos` and continue to honor the ACP bridge.
   */
  systemContextKaos(cwd: string): Kaos {
    return this.persistenceKaos.withCwd(cwd);
  }

  /**
   * Agent registry + lifecycle are owned by the internal {@link SessionHost}.
   * The methods below preserve `Session`'s public surface and forward to the
   * host so all call sites (`KimiCore`, `SessionAPIImpl`, subagent host, tests)
   * keep behaving identically.
   */
  createMain(): Promise<Agent> {
    return this.host.createMain();
  }

  resume(): Promise<{ warning?: string }> {
    return this.host.resume();
  }

  close(): Promise<void> {
    return this.host.close();
  }

  closeForReload(): Promise<void> {
    return this.host.closeForReload();
  }

  createAgent(
    config: Partial<AgentOptions>,
    options: CreateAgentOptions = {},
  ): Promise<{ readonly id: string; readonly agent: Agent }> {
    return this.host.createAgent(config, options);
  }

  ensureAgentResumed(id: string): Promise<Agent> {
    return this.host.ensureAgentResumed(id);
  }

  getReadyAgent(id: string): Agent | undefined {
    return this.host.getReadyAgent(id);
  }

  readyAgents(): Iterable<Agent> {
    return this.host.readyAgents();
  }

  async generateAgentsMd(): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.host.requireMainAgent();

    try {
      const handle = await mainAgent.subagentHost!.spawn({
        profileName: 'coder',
        parentToolCallId: 'generate-agents-md',
        prompt: DEFAULT_INIT_PROMPT,
        description: 'Initialize AGENTS.md',
        runInBackground: false,
        signal: new AbortController().signal,
      });
      await handle.completion;

      const agentsMd = await loadAgentsMd(mainAgent.kaos, this.options.kimiHomeDir);
      mainAgent.context.appendSystemReminder(initCompletionReminder(agentsMd), {
        kind: 'injection',
        variant: 'init',
      });
      await mainAgent.records.flush();
    } catch (error) {
      throw new KimiError(
        ErrorCodes.SESSION_INIT_FAILED,
        error instanceof Error ? error.message : 'Init failed',
        { cause: error },
      );
    }
  }

  get hasActiveTurn(): boolean {
    for (const agent of this.readyAgents()) {
      if (agent.turn.hasActiveTurn) return true;
    }
    return false;
  }

  writeMetadata() {
    return this.sessionRepository.write(this.metadata);
  }

  async readMetadata() {
    this.metadata = await this.sessionRepository.read();
    return this.metadata;
  }

  async flushMetadata() {
    await this.skillsReady;
    await this.sessionRepository.flush();
    await Promise.all(Array.from(this.readyAgents()).map((agent) => agent.records.flush()));
  }

  async listSkills(): Promise<readonly SkillSummary[]> {
    await this.skillsReady;
    return this.skills.listSkills().map(summarizeSkill);
  }

  private async loadSkills(): Promise<void> {
    const roots = await resolveSkillRoots({
      paths: {
        userHomeDir: this.options.skills?.userHomeDir ?? homedir(),
        brandHomeDir: this.options.skills?.brandHomeDir ?? this.options.kimiHomeDir,
        workDir: this.options.kaos.getcwd(),
      },
      explicitDirs: this.options.skills?.explicitDirs,
      extraDirs: this.options.skills?.extraDirs,
      pluginSkillRoots: this.options.skills?.pluginSkillRoots,
      mergeAllAvailableSkills: this.options.skills?.mergeAllAvailableSkills,
      builtinDir: this.options.skills?.builtinDir,
    });
    await this.skills.loadRoots(roots);
    registerBuiltinSkills(this.skills);
  }

  private async loadMcpServers(): Promise<void> {
    const servers = this.options.mcpConfig?.servers;
    if (servers === undefined || Object.keys(servers).length === 0) return;
    await this.mcp.connectAll(servers);
    const entries = this.mcp.list().filter((entry) => entry.status !== 'disabled');
    const totalCount = entries.length;
    if (totalCount === 0) return;

    const connectedCount = entries.filter((entry) => entry.status === 'connected').length;
    if (connectedCount > 0) {
      this.telemetry.track('mcp_connected', {
        server_count: connectedCount,
        total_count: totalCount,
      });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.telemetry.track('mcp_failed', {
        failed_count: failedCount,
        total_count: totalCount,
      });
    }
  }

  private emitInitialMcpLoadError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('mcp initial load failed', error);
    void this.rpc.emitEvent({
      type: 'error',
      agentId: 'main',
      ...makeErrorPayload(ErrorCodes.MCP_STARTUP_FAILED, message),
    });
  }

  private onMcpServerStatusChange(entry: McpServerEntry): void {
    // Always surface server-level status changes to clients so the TUI/SDK
    // can keep its dashboard in sync, even before the main agent exists.
    void this.rpc.emitEvent({
      type: 'mcp.server.status',
      agentId: 'main',
      server: {
        name: entry.name,
        transport: entry.transport,
        status: entry.status,
        toolCount: entry.toolCount,
        error: entry.error,
      },
    });
  }
}

export * from './subagent-host';

function initCompletionReminder(agentsMd: string): string {
  const latest =
    agentsMd.trim().length === 0
      ? 'No AGENTS.md content was found after `/init` completed.'
      : agentsMd;
  return [
    'The user just ran `/init` slash command.',
    'The system has analyzed the codebase and generated an `AGENTS.md` file.',
    '',
    'Latest AGENTS.md file content:',
    latest,
  ].join('\n');
}
