import { homedir } from 'node:os';
import { join } from 'pathe';

import { ErrorCodes, KimiError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import type { Logger, SessionLogHandle } from '#/logging/types';
import type { SDKSessionRPC } from '#/rpc';
import { proxyWithExtraPayload } from '#/rpc/types';

import { Agent, type AgentConfig, type AgentType } from '../agent';
import { HookEngine, type HookDef } from '../agent/hooks';
import type { PermissionManagerOptions, PermissionRule } from '../agent/permission';
import { parseBooleanEnv, resolveConfigValue, type BackgroundConfig } from '../config';
import { makeErrorPayload } from '../errors';
import {
  McpConnectionManager,
  McpOAuthService,
  type McpServerEntry,
  type SessionMcpConfig,
} from '../mcp';
import type { EnabledPluginSessionStart } from '../plugin';
import {
  DEFAULT_AGENT_PROFILES,
  DEFAULT_INIT_PROMPT,
  loadAgentsMd,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import type { ProviderManager } from '../providers/provider-manager';
import type { RuntimeConfig } from '../runtime-types';
import {
  registerBuiltinSkills,
  resolveSkillRoots,
  SkillRegistry,
  summarizeSkill,
  type SkillRoot,
  type SkillSummary,
} from '../skill';
import { noopTelemetryClient, type TelemetryClient } from '../telemetry';
import { SessionSubagentHost } from './subagent-host';

export interface SessionConfig {
  readonly runtime: RuntimeConfig;
  readonly id?: string | undefined;
  readonly homedir: string;
  readonly kimiHomeDir?: string;
  readonly rpc: SDKSessionRPC;
  readonly initializeMainAgent?: boolean | undefined;
  readonly providerManager?: ProviderManager | undefined;
  readonly background?: BackgroundConfig | undefined;
  readonly hooks?: readonly HookDef[];
  readonly permissionRules?: readonly PermissionRule[];
  readonly skills?: SessionSkillConfig;
  readonly mcpConfig?: SessionMcpConfig;
  readonly telemetry?: TelemetryClient | undefined;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
}

export interface SessionSkillConfig {
  readonly userHomeDir?: string;
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

const BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV = 'KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';

export class Session {
  readonly rpc: SDKSessionRPC;
  readonly telemetry: TelemetryClient;
  readonly skills: SkillRegistry;
  readonly agents: Map<string, Agent> = new Map();
  readonly mcp: McpConnectionManager;
  readonly log: Logger;
  private readonly logHandle: SessionLogHandle | undefined;
  readonly hookEngine: HookEngine;
  private agentIdCounter = 0;
  private readonly skillsReady: Promise<void>;
  metadata: SessionMeta = {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'New Session',
    isCustomTitle: false,
    agents: {},
    custom: {},
  };
  private writeMetadataPromise = Promise.resolve();

  constructor(public readonly config: SessionConfig) {
    // Attach the per-session log sink up front so the constructor's
    // fire-and-forget `loadSkills` / `loadMcpServers` failures (and
    // anything else that races) land in the session log, not just global.
    this.logHandle =
      config.id === undefined
        ? undefined
        : getRootLogger().attachSession({
            sessionId: config.id,
            sessionDir: config.homedir,
          });
    this.log =
      this.logHandle?.logger ??
      (config.id === undefined ? log : log.createChild({ sessionId: config.id }));
    this.rpc = config.rpc;
    this.hookEngine = new HookEngine(config.hooks, {
      cwd: config.runtime.kaos.getcwd(),
      sessionId: config.id,
    });
    this.telemetry = config.telemetry ?? noopTelemetryClient;
    this.skills = new SkillRegistry({ sessionId: config.id });
    this.mcp = new McpConnectionManager({
      oauthService: new McpOAuthService({ kimiHomeDir: config.kimiHomeDir }),
      log: this.log,
    });
    this.mcp.onStatusChange((entry) => {
      this.onMcpServerStatusChange(entry);
    });
    this.skillsReady = this.loadSkills()
      .catch((error: unknown) => {
        this.log.error('skills load failed', error);
      })
      .then(() => {
        this.refreshAgentBuiltinTools();
      });
    void this.loadMcpServers().catch((error: unknown) => {
      this.emitInitialMcpLoadError(error);
    });
  }

  async createMain() {
    const { agent } = await this.createAgent({ type: 'main' }, DEFAULT_AGENT_PROFILES['agent']);
    await this.triggerSessionStart('startup');
    return agent;
  }

  async resume(): Promise<{ warning?: string }> {
    await this.skillsReady;
    const { agents } = await this.readMetadata();
    this.agents.clear();
    let warning: string | undefined;
    const resumeTasks = Object.keys(agents).map(async (id) => {
      const agent = this.ensureResumeAgentInstantiated(id, agents);
      const result = await agent.resume();
      if (result.warning !== undefined && warning === undefined) {
        warning = result.warning;
      }
    });
    await Promise.all(resumeTasks);
    const resumeWarning = warning;
    // A session migrated from an external tool ships a wire without the
    // `config.update` bootstrap events a natively-created agent writes, so the
    // main agent comes back with an empty system prompt and no tools. Apply the
    // default profile so the resumed session is usable. Native sessions always
    // replay a non-empty system prompt and never enter this branch.
    const main = this.agents.get('main');
    const profile = DEFAULT_AGENT_PROFILES['agent'];
    if (main !== undefined && profile !== undefined && main.config.systemPrompt === '') {
      await this.bootstrapAgentProfile(main, profile);
    }
    await this.triggerSessionStart('resume');
    return { warning: resumeWarning };
  }

  async close(): Promise<void> {
    try {
      await this.stopBackgroundTasksOnExit();
      await this.flushMetadata();
      await this.triggerSessionEnd('exit');
    } finally {
      try {
        await this.mcp.shutdown();
      } finally {
        await this.logHandle?.close();
      }
    }
  }

  private async stopBackgroundTasksOnExit(): Promise<void> {
    const keepAliveOnExit = resolveConfigValue({
      env: process.env,
      envKey: BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV,
      configValue: this.config.background?.keepAliveOnExit,
      defaultValue: true,
      parseEnv: parseBooleanEnv,
    });
    if (keepAliveOnExit) return;
    await Promise.all(
      Array.from(this.agents.values(), (agent) =>
        agent.background.stopAll('Session closed'),
      ),
    );
  }

  async createAgent(
    config: Partial<AgentConfig>,
    profile?: ResolvedAgentProfile,
    parentAgentId?: string | undefined,
  ): Promise<{ readonly id: string; readonly agent: Agent }> {
    await this.skillsReady;
    const type = config.type ?? 'main';
    const id = type === 'main' ? 'main' : this.nextGeneratedAgentId();
    const homedir = config.homedir ?? join(this.config.homedir, 'agents', id);
    const agent = this.instantiateAgent(id, homedir, type, config, parentAgentId ?? null);
    if (profile) {
      await this.bootstrapAgentProfile(agent, profile);
    }

    this.agents.set(id, agent);
    this.metadata.agents[id] = {
      homedir,
      type,
      parentAgentId: parentAgentId ?? null,
    };
    void this.writeMetadata();

    return { id, agent };
  }

  /**
   * Applies a profile's derived config — cwd, system prompt, active tools — to
   * an agent. Fresh creation and resume-of-an-incomplete-wire both route
   * through here so the two paths cannot drift apart.
   */
  private async bootstrapAgentProfile(
    agent: Agent,
    profile: ResolvedAgentProfile,
  ): Promise<void> {
    const context = await prepareSystemPromptContext(agent.runtime.kaos);
    agent.useProfile(profile, context);
  }

  async generateAgentsMd(): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.requireMainAgent();

    try {
      const handle = await mainAgent.subagentHost!.spawn('coder', {
        parentToolCallId: 'generate-agents-md',
        prompt: DEFAULT_INIT_PROMPT,
        description: 'Initialize AGENTS.md',
        runInBackground: false,
        origin: { kind: 'system_trigger', name: 'init' },
        signal: new AbortController().signal,
      });
      await handle.completion;

      const agentsMd = await loadAgentsMd(mainAgent.runtime.kaos);
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
    for (const agent of this.agents.values()) {
      if (agent.turn.hasActiveTurn) return true;
    }
    return false;
  }

  protected get metadataPath() {
    return join(this.config.homedir, 'state.json');
  }

  writeMetadata() {
    const text = JSON.stringify(this.metadata, null, 2);
    const write = async () => {
      await this.config.runtime.kaos.mkdir(this.config.homedir, { parents: true, existOk: true });
      await this.config.runtime.kaos.writeText(this.metadataPath, text);
    };
    this.writeMetadataPromise = this.writeMetadataPromise.then(write, write);
    return this.writeMetadataPromise;
  }

  async readMetadata() {
    const text = await this.config.runtime.kaos.readText(this.metadataPath);
    this.metadata = JSON.parse(text);
    return this.metadata;
  }

  async flushMetadata() {
    await this.skillsReady;
    await this.writeMetadataPromise;
    await Promise.all(Array.from(this.agents.values()).map((agent) => agent.records.flush()));
  }

  async listSkills(): Promise<readonly SkillSummary[]> {
    await this.skillsReady;
    return this.skills.listSkills().map(summarizeSkill);
  }

  private async loadSkills(): Promise<void> {
    const roots = await resolveSkillRoots({
      paths: {
        userHomeDir: this.config.skills?.userHomeDir ?? homedir(),
        workDir: this.config.runtime.kaos.getcwd(),
      },
      explicitDirs: this.config.skills?.explicitDirs,
      extraDirs: this.config.skills?.extraDirs,
      pluginSkillRoots: this.config.skills?.pluginSkillRoots,
      mergeAllAvailableSkills: this.config.skills?.mergeAllAvailableSkills,
      builtinDir: this.config.skills?.builtinDir,
    });
    await this.skills.loadRoots(roots);
    registerBuiltinSkills(this.skills);
  }

  private async loadMcpServers(): Promise<void> {
    const servers = this.config.mcpConfig?.servers;
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

  private backgroundTaskTimeoutMs(): number | undefined {
    const timeoutS = this.config.background?.agentTaskTimeoutS;
    return timeoutS === undefined ? undefined : timeoutS * 1000;
  }

  private refreshAgentBuiltinTools(): void {
    for (const agent of this.agents.values()) {
      if (!agent.config.hasProvider) continue;
      agent.tools.initializeBuiltinTools();
    }
  }

  private instantiateAgent(
    id: string,
    homedir: string,
    type: AgentType,
    config: Partial<AgentConfig> = {},
    parentAgentId: string | null = null,
  ): Agent {
    return new Agent({
      ...config,
      type,
      runtime: this.config.runtime,
      homedir,
      skills: this.skills,
      rpc: proxyWithExtraPayload(this.rpc, { agentId: id }),
      providerManager: this.config.providerManager,
      sessionId: this.config.id,
      hookEngine: config.hookEngine ?? this.hookEngine,
      subagentHost:
        config.subagentHost ?? new SessionSubagentHost(this, id, this.backgroundTaskTimeoutMs()),
      mcp: this.mcp,
      backgroundMaxRunningTasks: this.config.background?.maxRunningTasks,
      backgroundSessionDir: homedir,
      permission: this.permissionOptions(parentAgentId, config.permission),
      telemetry: this.telemetry,
      log: this.log.createChild({ agentId: id }),
      pluginSessionStarts: type === 'main' ? this.config.pluginSessionStarts : undefined,
    });
  }

  private permissionOptions(
    parentAgentId: string | null,
    input?: PermissionManagerOptions | undefined,
  ): PermissionManagerOptions {
    if (parentAgentId === null) {
      return {
        ...input,
        initialRules: input?.initialRules ?? this.config.permissionRules,
      };
    }
    return {
      ...input,
      parent: input?.parent ?? this.agents.get(parentAgentId)?.permission,
    };
  }

  private ensureResumeAgentInstantiated(
    id: string,
    agents: Record<string, AgentMeta>,
    stack: readonly string[] = [],
  ): Agent {
    const existing = this.agents.get(id);
    if (existing !== undefined) return existing;
    if (stack.includes(id)) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Session agent parent chain contains a cycle: ${[...stack, id].join(' -> ')}`,
      );
    }

    const meta = agents[id];
    if (meta === undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, `Session agent "${id}" is missing`);
    }

    const parentAgentId = meta.parentAgentId ?? null;
    if (parentAgentId !== null) {
      this.ensureResumeAgentInstantiated(parentAgentId, agents, [...stack, id]);
    }

    const agent = this.instantiateAgent(id, meta.homedir, meta.type, {}, parentAgentId);
    this.agents.set(id, agent);
    return agent;
  }

  private nextGeneratedAgentId(): string {
    while (true) {
      const id = `agent-${this.agentIdCounter++}`;
      if (this.agents.has(id)) continue;
      if (this.metadata.agents[id] !== undefined) continue;
      return id;
    }
  }

  private requireMainAgent(): Agent {
    const agent = this.agents.get('main');
    if (agent === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    return agent;
  }

  private async triggerSessionStart(source: 'startup' | 'resume'): Promise<void> {
    await this.hookEngine.trigger('SessionStart', {
      matcherValue: source,
      inputData: { source },
    });
  }

  private async triggerSessionEnd(reason: 'exit'): Promise<void> {
    await this.hookEngine.trigger('SessionEnd', {
      matcherValue: reason,
      inputData: { reason },
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
