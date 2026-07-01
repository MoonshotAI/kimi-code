import { homedir } from 'node:os';
import { join } from 'pathe';
import type { Kaos } from '@moonshot-ai/kaos';
import type { SessionWarning } from '@moonshot-ai/protocol';

import { ErrorCodes, KimiError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import type { Logger, SessionLogHandle } from '#/logging/types';
import type { KimiConfig, SDKSessionRPC } from '#/rpc';
import { proxyWithExtraPayload } from '#/rpc/types';

import { Agent, type AgentOptions, type AgentType } from '../agent';
import { renderPluginSessionStartReminder } from '../agent/injection/plugin-session-start';
import { HookEngine, type HookDef } from './hooks';
import type { PermissionManagerOptions, PermissionRule } from '../agent/permission';
import {
  appendWorkspaceAdditionalDir,
  normalizeAdditionalDirs,
  parseBooleanEnv,
  readWorkspaceAdditionalDirs,
  resolveWorkspaceAdditionalDirs,
  resolveConfigValue,
  type BackgroundConfig,
  type WorkspaceAdditionalDirsLoadResult,
} from '../config';
import { makeErrorPayload } from '../errors';
import {
  McpConnectionManager,
  McpOAuthService,
  type McpServerEntry,
  type SessionMcpConfig,
} from '../mcp';
import type { EnabledPluginSessionStart, PluginCommandDef } from '../plugin';
import {
  DEFAULT_AGENT_PROFILES,
  DEFAULT_INIT_PROMPT,
  loadAgentsMd,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import type { ProviderManager } from './provider-manager';
import {
  registerBuiltinSkills,
  SessionSkillRegistry,
  resolveSkillRoots,
  summarizeSkill,
  type SkillRoot,
  type SkillSummary,
} from '../skill';
import { noopTelemetryClient, type TelemetryClient } from '../telemetry';
import { SessionSubagentHost } from './subagent-host';
import type { ToolServices } from '../tools/support/services';
import { FlagResolver, type ExperimentalFlagResolver } from '../flags';
import { abortError } from '../utils/abort';

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
  readonly providerManager?: ProviderManager | undefined;
  readonly background?: BackgroundConfig | undefined;
  readonly hooks?: readonly HookDef[];
  readonly permissionRules?: readonly PermissionRule[];
  readonly skills?: SessionSkillConfig;
  readonly mcpConfig?: SessionMcpConfig;
  readonly telemetry?: TelemetryClient | undefined;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  readonly pluginCommands?: readonly PluginCommandDef[];
  readonly appVersion?: string;
  readonly experimentalFlags?: ExperimentalFlagResolver;
  readonly additionalDirs?: readonly string[];
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

interface ResumedAgent {
  readonly agent: Agent;
  readonly warning?: string;
}

type AgentEntry = Agent | Promise<ResumedAgent> | Promise<DisposedAgent>;

interface DisposedAgent {
  readonly disposed: true;
}

const DISPOSING_TAG = Symbol('disposing');
type DisposingPromise = Promise<DisposedAgent> & { readonly [DISPOSING_TAG]: true };

function makeDisposingPromise(p: Promise<DisposedAgent>): DisposingPromise {
  return Object.assign(p, { [DISPOSING_TAG]: true } as const);
}

function isDisposingPromise(entry: unknown): entry is DisposingPromise {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    DISPOSING_TAG in (entry as Record<symbol, unknown>)
  );
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

const BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV = 'KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';
const ACTIVE_TURN_CLOSE_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_READY_SUBAGENTS = 64;

async function waitForSettlementOrTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export class Session {
  readonly rpc: SDKSessionRPC;
  readonly telemetry: TelemetryClient;
  readonly skills: SessionSkillRegistry;
  readonly agents: Map<string, AgentEntry> = new Map();
  readonly mcp: McpConnectionManager;
  readonly log: Logger;
  private readonly logHandle: SessionLogHandle | undefined;
  readonly hookEngine: HookEngine;
  readonly experimentalFlags: ExperimentalFlagResolver;
  private toolKaos: Kaos;
  private persistenceKaos: Kaos;
  private additionalDirs: readonly string[];
  private readonly pluginCommands: readonly PluginCommandDef[];
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
  private agentsMdWarning: string | undefined;

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
    this.hookEngine = new HookEngine(options.hooks, {
      cwd: options.kaos.getcwd(),
      sessionId: options.id,
    });
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.toolKaos = options.kaos;
    this.persistenceKaos = options.persistenceKaos ?? options.kaos;
    this.additionalDirs = normalizeAdditionalDirs(options.additionalDirs ?? []);
    this.pluginCommands = options.pluginCommands ?? [];
    this.skills = new SessionSkillRegistry({
      sessionId: options.id,
    });
    this.mcp = new McpConnectionManager({
      oauthService: new McpOAuthService({ kimiHomeDir: options.kimiHomeDir }),
      log: this.log,
      stdioCwd: options.kaos.getcwd(),
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


  setToolKaos(kaos: Kaos) {
    this.toolKaos = kaos;
    for (const agent of this.readyAgents()) {
      agent.setKaos(kaos.withCwd(agent.config.cwd));
    }
    this.refreshAgentBuiltinTools();
  }

  getAdditionalDirs(): readonly string[] {
    return this.additionalDirs;
  }

  async setAdditionalDirs(additionalDirs: readonly string[]): Promise<void> {
    this.additionalDirs = normalizeAdditionalDirs(additionalDirs);
    for (const agent of this.readyAgents()) {
      agent.setAdditionalDirs(this.additionalDirs);
    }
  }

  async addAdditionalDir(
    path: string,
    persist = true,
  ): Promise<WorkspaceAdditionalDirsLoadResult & { readonly persisted: boolean }> {
    const cwd = this.toolKaos.getcwd();
    const systemKaos = this.systemContextKaos(cwd);
    if (persist) {
      const result = await appendWorkspaceAdditionalDir(systemKaos, cwd, path, this.additionalDirs);
      const additionalDirs = normalizeAdditionalDirs([...this.additionalDirs, ...result.additionalDirs]);
      await this.setAdditionalDirs(additionalDirs);
      this.notifyAdditionalDirAdded(path, true, result.configPath);
      return { ...result, additionalDirs, persisted: true };
    }

    const workspace = await readWorkspaceAdditionalDirs(systemKaos, cwd);
    const additionalDirs = await resolveWorkspaceAdditionalDirs(systemKaos, cwd, [path]);
    const nextAdditionalDirs = normalizeAdditionalDirs([...this.additionalDirs, ...additionalDirs]);
    await this.setAdditionalDirs(nextAdditionalDirs);
    this.notifyAdditionalDirAdded(path, false, workspace.configPath);
    return {
      projectRoot: workspace.projectRoot,
      configPath: workspace.configPath,
      additionalDirs: nextAdditionalDirs,
      persisted: false,
    };
  }

  private notifyAdditionalDirAdded(path: string, persisted: boolean, configPath: string): void {
    const message = persisted
      ? `Added workspace directory:\n  ${path}\n  Saved to:\n  ${configPath}`
      : `Added workspace directory:\n  ${path}\n  For this session only`;
    this.requireMainAgent().context.appendLocalCommandStdout(message);
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

  async createMain() {
    const { agent } = await this.createAgent({ type: 'main' }, {
      profile: DEFAULT_AGENT_PROFILES['agent'],
    });
    await this.triggerSessionStart('startup');
    return agent;
  }

  async resume(): Promise<{ warning?: string }> {
    await this.skillsReady;
    this.log.info('session resume', { app_version: this.options.appVersion });
    const { agents } = await this.readMetadata();
    this.agents.clear();
    // Only the main agent is needed to reopen the session; subagents replay
    // lazily when an RPC or Agent(resume=...) call asks for their state.
    const { warning } =
      agents['main'] === undefined ? { warning: undefined } : await this.resumeAgent('main');
    // A session migrated from an external tool ships a wire without the
    // `config.update` bootstrap events a natively-created agent writes, so the
    // main agent comes back with an empty system prompt and no tools. Apply the
    // default profile so the resumed session is usable. Native sessions always
    // replay a non-empty system prompt and never enter this branch.
    const main = this.getReadyAgent('main');
    const profile = DEFAULT_AGENT_PROFILES['agent'];
    if (main !== undefined && profile !== undefined && main.config.systemPrompt === '') {
      await this.bootstrapAgentProfile(main, profile);
    }
    await this.triggerSessionStart('resume');
    return { warning };
  }

  async close(): Promise<void> {
    try {
      await Promise.allSettled(
        Array.from(this.readyAgents(), async (agent) => agent.cron?.stop()),
      );
      await this.cancelActiveTurnsOnClose();
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

  async closeForReload(): Promise<void> {
    try {
      await Promise.allSettled(
        Array.from(this.readyAgents(), async (agent) => agent.cron?.stop()),
      );
      await this.flushMetadata();
    } finally {
      try {
        await this.mcp.shutdown();
      } finally {
        await this.logHandle?.close();
      }
    }
  }

  private async cancelActiveTurnsOnClose(): Promise<void> {
    const backgroundAgentIds = this.activeBackgroundAgentIds();
    const cancellations: Array<Promise<void>> = [];
    for (const [agentId, entry] of this.agents) {
      if (!(entry instanceof Agent) || backgroundAgentIds.has(agentId)) continue;
      cancellations.push(this.cancelAgentTurnOnClose(entry));
    }
    await Promise.allSettled(cancellations);
  }

  private activeBackgroundAgentIds(): Set<string> {
    const agentIds = new Set<string>();
    for (const agent of this.readyAgents()) {
      for (const task of agent.background.list(true)) {
        if (task.kind === 'agent' && task.agentId !== undefined && task.detached !== false) {
          agentIds.add(task.agentId);
        }
      }
    }
    return agentIds;
  }

  private async cancelAgentTurnOnClose(agent: Agent): Promise<void> {
    if (!agent.turn.hasActiveTurn) return;

    let waitForTurn: Promise<unknown>;
    try {
      waitForTurn = agent.turn.waitForCurrentTurn();
    } catch (error: unknown) {
      this.log.debug('active turn wait unavailable during session close', {
        agentType: agent.type,
        agentHomedir: agent.homedir,
        error,
      });
      return;
    }

    agent.turn.cancel(undefined, abortError('Session closed'));
    const settled = await waitForSettlementOrTimeout(waitForTurn, ACTIVE_TURN_CLOSE_TIMEOUT_MS);
    if (!settled) {
      this.log.warn('timed out waiting for active turn to cancel during session close', {
        agentType: agent.type,
        agentHomedir: agent.homedir,
        timeoutMs: ACTIVE_TURN_CLOSE_TIMEOUT_MS,
      });
    }
  }

  private async stopBackgroundTasksOnExit(): Promise<void> {
    const keepAliveOnExit = resolveConfigValue({
      env: process.env,
      envKey: BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV,
      configValue: this.options.background?.keepAliveOnExit,
      defaultValue: false,
      parseEnv: parseBooleanEnv,
    });
    if (keepAliveOnExit) return;
    await Promise.all(
      Array.from(this.readyAgents(), async (agent) => {
        const activeTasks = agent.background.list(true);
        await Promise.all(
          activeTasks.map((task) =>
            agent.background.suppressTerminalNotification(task.taskId),
          ),
        );
        await agent.background.stopAll('Session closed');
      }),
    );
  }

  async createAgent(
    config: Partial<AgentOptions>,
    options: CreateAgentOptions = {},
  ): Promise<{ readonly id: string; readonly agent: Agent }> {
    await this.skillsReady;
    const type = config.type ?? 'main';
    const id = type === 'main' ? 'main' : this.nextGeneratedAgentId();
    const homedir = config.homedir ?? join(this.options.homedir, 'agents', id);
    const parentAgentId = options.parentAgentId ?? null;
    const agent = this.instantiateAgent(id, homedir, type, config, parentAgentId);
    if (options.profile) {
      await this.bootstrapAgentProfile(agent, options.profile);
    }

    this.agents.set(id, agent);
    if (options.persistMetadata !== false) {
      this.metadata.agents[id] = {
        homedir,
        type,
        parentAgentId,
        swarmItem: options.swarmItem,
      };
      void this.writeMetadata();
    }

    return { id, agent };
  }

  async ensureAgentResumed(id: string): Promise<Agent> {
    const entry = this.agents.get(id);
    if (entry !== undefined) {
      if (isDisposingPromise(entry)) {
        // Wait for disposal to complete, then fall through to
        // resumeAgent to replay persisted wire.
        try {
          await entry;
        } catch {
          // dispose() failed — fall through to replay persisted wire.
        }
        // Only delete if the map still holds this exact disposing
        // promise. A concurrent resumeAgent() may have already replaced
        // it with an in-flight resume promise or a resumed Agent.
        if (this.agents.get(id) === entry) {
          this.agents.delete(id);
        }
      } else {
        return (await this.resolveAgentEntry(entry)).agent;
      }
    }
    if (this.metadata.agents[id] === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Agent "${id}" was not found`);
    }
    return (await this.resumeAgent(id)).agent;
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
    const context = await prepareSystemPromptContext(
      this.systemContextKaos(agent.kaos.getcwd()),
      this.options.kimiHomeDir,
      { additionalDirs: this.additionalDirs },
    );
    agent.useProfile(profile, context, this.options.kimiHomeDir);
    const { agentsMdWarning } = context;
    if (agentsMdWarning !== undefined) {
      this.agentsMdWarning = agentsMdWarning;
      log.warn('AGENTS.md exceeds recommended size', { message: agentsMdWarning });
      agent.emitEvent({
        type: 'warning',
        message: agentsMdWarning,
        code: 'agents-md-oversized',
      });
    }
  }

  async getSessionWarnings(): Promise<readonly SessionWarning[]> {
    const warnings: SessionWarning[] = [];
    const agentsMdWarning = await this.computeAgentsMdWarning();
    if (agentsMdWarning !== undefined) {
      warnings.push({
        code: 'agents-md-oversized',
        message: agentsMdWarning,
        severity: 'warning',
      });
    }
    return warnings;
  }

  private async computeAgentsMdWarning(): Promise<string | undefined> {
    if (this.agentsMdWarning !== undefined) {
      return this.agentsMdWarning;
    }
    // Resumed sessions skip bootstrap when their system prompt is already set, so
    // the cached value may be missing; recompute on demand so the warning still
    // surfaces for long-lived sessions.
    try {
      const context = await prepareSystemPromptContext(
        this.systemContextKaos(this.toolKaos.getcwd()),
        this.options.kimiHomeDir,
        { additionalDirs: this.additionalDirs },
      );
      this.agentsMdWarning = context.agentsMdWarning;
    } catch (error) {
      log.warn('failed to compute AGENTS.md warning', { error });
    }
    return this.agentsMdWarning;
  }

  async generateAgentsMd(): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.requireMainAgent();

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

  /**
   * Appends a fresh `<plugin_session_start>` system reminder to the main agent
   * using the currently enabled plugins, then flushes records so the reminder is
   * persisted and visible on the wire. Used by the explicit `/reload` flow after
   * the session has been re-resumed with reloaded plugin state.
   *
   * When no plugin session start is currently resolvable but an earlier
   * When no plugin session start is currently resolvable but the context may still
   * carry stale plugin guidance — either an earlier `<plugin_session_start>`
   * reminder, or a compaction summary that may have folded one in — appends a
   * neutralizing reminder instead, so the model does not keep following stale
   * plugin instructions and the turn-loop injector does not dedup against them.
   */
  async appendPluginSessionStartReminder(): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.requireMainAgent();
    const reminder = renderPluginSessionStartReminder({
      sessionStarts: mainAgent.pluginSessionStarts,
      registry: mainAgent.skills?.registry,
      log: mainAgent.log,
    });
    if (reminder !== undefined) {
      mainAgent.context.appendSystemReminder(
        `${reminder}\n\nThis supersedes any earlier plugin_session_start reminder in this session.`,
        { kind: 'injection', variant: 'plugin_session_start' },
      );
    } else if (this.shouldNeutralizePluginSessionStart(mainAgent)) {
      mainAgent.context.appendSystemReminder(
        'There are currently no active plugin session starts. This supersedes any earlier plugin_session_start reminder in this session.',
        { kind: 'injection', variant: 'plugin_session_start' },
      );
    } else {
      return;
    }
    await mainAgent.records.flush();
  }

  private shouldNeutralizePluginSessionStart(mainAgent: Agent): boolean {
    return mainAgent.context.history.some((message) => {
      const kind = message.origin?.kind;
      if (kind === 'injection') {
        return message.origin?.variant === 'plugin_session_start';
      }
      // A compaction summary replaces earlier messages (including any plugin
      // session-start reminder) with a single summary that may still carry stale
      // plugin guidance, so the origin-only check above is not sufficient.
      return kind === 'compaction_summary';
    });
  }

  get hasActiveTurn(): boolean {
    for (const agent of this.readyAgents()) {
      if (agent.turn.hasActiveTurn) return true;
    }
    return false;
  }

  protected get metadataPath() {
    return join(this.options.homedir, 'state.json');
  }

  writeMetadata() {
    const text = JSON.stringify(this.metadata, null, 2);
    const write = async () => {
      await this.persistenceKaos.mkdir(this.options.homedir, { parents: true, existOk: true });
      await this.persistenceKaos.writeText(this.metadataPath, text);
    };
    this.writeMetadataPromise = this.writeMetadataPromise.then(write, write);
    return this.writeMetadataPromise;
  }

  async readMetadata() {
    const text = await this.persistenceKaos.readText(this.metadataPath);
    this.metadata = JSON.parse(text);
    return this.metadata;
  }

  async flushMetadata() {
    await this.skillsReady;
    await this.writeMetadataPromise;
    await Promise.all(Array.from(this.readyAgents()).map((agent) => agent.records.flush()));
  }

  async listSkills(): Promise<readonly SkillSummary[]> {
    await this.skillsReady;
    return this.skills.listSkills().map(summarizeSkill);
  }

  listPluginCommands(): readonly PluginCommandDef[] {
    return this.pluginCommands;
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

  private refreshAgentBuiltinTools(): void {
    for (const agent of this.readyAgents()) {
      if (!agent.config.hasProvider) continue;
      agent.tools.initializeBuiltinTools();
    }
  }

  private instantiateAgent(
    id: string,
    homedir: string,
    type: AgentType,
    config: Partial<AgentOptions> = {},
    parentAgentId: string | null = null,
  ): Agent {
    const parentAgent = parentAgentId !== null ? this.getReadyAgent(parentAgentId) : undefined;
    const cwd = parentAgent?.config.cwd ?? this.toolKaos.getcwd();
    let agent!: Agent;
    agent = new Agent({
      ...config,
      type,
      kaos: this.toolKaos.withCwd(cwd),
      toolServices: this.options.toolServices,
      config: this.options.config,
      homedir,
      skills: this.skills,
      rpc: proxyWithExtraPayload(this.rpc, { agentId: id }),
      modelProvider: this.options.providerManager,
      hookEngine: config.hookEngine ?? this.hookEngine,
      subagentHost: config.subagentHost ?? new SessionSubagentHost(this, id),
      mcp: this.mcp,
      permission: this.permissionOptions(parentAgentId, config.permission),
      telemetry: this.telemetry,
      log: this.log.createChild({ agentId: id }),
      pluginSessionStarts: type === 'main' ? this.options.pluginSessionStarts : undefined,
      pluginCommands: type === 'main' ? this.options.pluginCommands : undefined,
      experimentalFlags: this.experimentalFlags,
      additionalDirs: parentAgent?.getAdditionalDirs() ?? this.additionalDirs,
      systemPromptContextProvider: () =>
        prepareSystemPromptContext(
          this.systemContextKaos(agent.kaos.getcwd()),
          this.options.kimiHomeDir,
          { additionalDirs: agent.getAdditionalDirs() },
        ),
    });
    if (type === 'sub') {
      agent.background.onIdle(() => {
        void this.releaseIdleSubagent(id);
      });
    }
    return agent;
  }

  private permissionOptions(
    parentAgentId: string | null,
    input?: PermissionManagerOptions | undefined,
  ): PermissionManagerOptions {
    if (parentAgentId === null) {
      return {
        ...input,
        initialRules: input?.initialRules ?? this.options.permissionRules,
      };
    }
    return {
      ...input,
      parent: input?.parent ?? this.getReadyAgent(parentAgentId)?.permission,
    };
  }

  getReadyAgent(id: string): Agent | undefined {
    const entry = this.agents.get(id);
    return entry instanceof Agent ? entry : undefined;
  }

  async releaseIdleSubagent(id: string): Promise<void> {
    const entry = this.agents.get(id);
    if (!(entry instanceof Agent) || entry.type !== 'sub') return;
    if (!this.isPrunableReadySubagent(id, entry, this.readySubagentParentIds())) return;
    await this.pruneReadySubagents();
  }

  *readyAgents(): Iterable<Agent> {
    for (const entry of this.agents.values()) {
      if (entry instanceof Agent) yield entry;
    }
  }

  private async resolveAgentEntry(entry: AgentEntry): Promise<ResumedAgent> {
    if (entry instanceof Agent) return { agent: entry };
    const resolved = await entry;
    if ('disposed' in resolved) {
      throw new Error('Agent was disposed during pruning; retry resume');
    }
    return resolved as ResumedAgent;
  }

  private async pruneReadySubagents(): Promise<void> {
    // Loop until the total ready subagent count is within the cap. The
    // cap applies to ALL ready subagents, not just prunable leaf
    // candidates — in a nested workflow with many parent/child pairs,
    // checking only candidates.length would leave 64 protected parents
    // plus 64 prunable children (128 total) resident. Deleting a child
    // can make its parent prunable (it was protected only because a live
    // child referenced it), so recompute candidates each iteration.
    for (;;) {
      const parentIds = this.readySubagentParentIds();
      let readySubAgentCount = 0;
      const candidates: Array<{ readonly id: string; readonly agent: Agent }> = [];
      for (const [id, entry] of this.agents) {
        if (!(entry instanceof Agent)) continue;
        if (entry.type !== 'sub') continue;
        readySubAgentCount++;
        if (!this.isPrunableReadySubagent(id, entry, parentIds)) continue;
        candidates.push({ id, agent: entry });
      }
      if (readySubAgentCount <= DEFAULT_MAX_READY_SUBAGENTS) break;
      const candidate = candidates.shift();
      if (candidate === undefined) break;
      // Replace the live Agent with a tagged disposing promise so a
      // concurrent ensureAgentResumed / RPC path cannot grab the same
      // idle subagent and start a new turn while disposal is clearing
      // its tools. The promise resolves to a DisposedAgent sentinel so
      // ensureAgentResumed falls through to resumeAgent (replaying
      // persisted wire) only after disposal — and therefore
      // records.flush() — has completed.
      const disposing = makeDisposingPromise(
        candidate.agent.dispose().then((): DisposedAgent => ({ disposed: true })),
      );
      this.agents.set(candidate.id, disposing);
      try {
        await disposing;
      } catch {
        // dispose() failed (e.g. records.flush I/O error). Remove the
        // rejected placeholder so later ensureAgentResumed calls fall
        // through to resumeAgent instead of rethrowing the cleanup
        // failure forever.
      }
      // Only delete if the map still holds this exact disposing promise.
      // resumeAgent() may have replaced it with an in-flight resume
      // promise (or a fully resumed Agent) while we were awaiting
      // disposal — deleting that newer entry would drop the resumed
      // subagent from the live map.
      if (this.agents.get(candidate.id) === disposing) {
        this.agents.delete(candidate.id);
      }
    }
  }

  private readySubagentParentIds(): Set<string> {
    // Only protect parents of agents that are still live (or being resumed)
    // in memory. metadata.agents persists forever, so scanning it would keep
    // a parent id protected even after its child completed or was evicted,
    // defeating the ready-subagent cap in nested workflows.
    const parentIds = new Set<string>();
    for (const id of this.agents.keys()) {
      const meta = this.metadata.agents[id];
      if (meta?.parentAgentId !== null && meta?.parentAgentId !== undefined) {
        parentIds.add(meta.parentAgentId);
      }
    }
    return parentIds;
  }

  private isPrunableReadySubagent(
    id: string,
    agent: Agent,
    parentIds: ReadonlySet<string>,
  ): boolean {
    if (agent.type !== 'sub') return false;
    if (parentIds.has(id)) return false;
    if (agent.turn.hasActiveTurn) return false;
    // Don't prune agents with an in-flight compaction — the worker is
    // mutating context, and a buffered background-task notification may
    // still arrive. Disposing mid-compaction leaves the agent in an
    // inconsistent state.
    if (agent.fullCompaction.isCompacting) return false;
    // Don't prune non-persisted interactive subagents (e.g. /btw agents
    // created with persistMetadata: false). After disposal there is no
    // metadata.agents[id] entry for ensureAgentResumed to replay from,
    // so the next prompt in the still-open panel would fail with
    // agent-not-found.
    if (this.metadata.agents[id] === undefined) return false;
    return agent.background.list(true).length === 0;
  }

  private resumeAgent(
    id: string,
    stack: readonly string[] = [],
  ): Promise<ResumedAgent> {
    if (stack.includes(id)) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Session agent parent chain contains a cycle: ${[...stack, id].join(' -> ')}`,
      );
    }

    const entry = this.agents.get(id);
    if (entry !== undefined && entry instanceof Agent) {
      return this.resolveAgentEntry(entry);
    }
    // If the entry is a disposing promise, wait for it to complete then
    // fall through to replay persisted wire. For a normal in-flight
    // resume promise, return it directly — don't re-resume.
    if (entry !== undefined) {
      if (isDisposingPromise(entry)) {
        const promise = (async () => {
          try {
            await entry;
          } catch {
            // dispose() failed — fall through to replay persisted wire.
          }
          const resumed = this.resumePersistedAgent(id, stack);
          this.agents.set(id, resumed);
          return resumed;
        })();
        this.agents.set(id, promise);
        return promise;
      }
      return this.resolveAgentEntry(entry);
    }

    const promise = this.resumePersistedAgent(id, stack);
    this.agents.set(id, promise);
    return promise;
  }

  private async resumePersistedAgent(
    id: string,
    stack: readonly string[] = [],
  ): Promise<ResumedAgent> {
    await this.skillsReady;
    const meta = this.metadata.agents[id];
    if (meta === undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, `Session agent "${id}" is missing`);
    }

    const parentAgentId = meta.parentAgentId ?? null;
    const parent =
      parentAgentId === null
        ? undefined
        : await this.resumeAgent(parentAgentId, [...stack, id]);

    try {
      const agent = this.instantiateAgent(id, meta.homedir, meta.type, {}, parentAgentId);
      const result = await agent.resume();
      this.restoreAgentProfileHandle(agent, meta, parent?.agent);
      this.agents.set(id, agent);
      return { agent, warning: parent?.warning ?? result.warning };
    } catch (error) {
      const entry = this.agents.get(id);
      if (entry instanceof Promise) {
        this.agents.delete(id);
      }
      throw error;
    }
  }

  private restoreAgentProfileHandle(
    agent: Agent,
    meta: AgentMeta,
    parentAgent: Agent | undefined,
  ): void {
    if (agent.config.systemPrompt === '') return;
    const profile = this.resolvePersistedProfile(agent, meta, parentAgent);
    if (profile === undefined) return;
    agent.setActiveProfile(profile, this.options.kimiHomeDir);
  }

  private resolvePersistedProfile(
    agent: Agent,
    meta: AgentMeta,
    parentAgent: Agent | undefined,
  ): ResolvedAgentProfile | undefined {
    const profileName = agent.config.profileName;
    if (profileName === undefined) return undefined;
    if (meta.type === 'sub') {
      const parentProfileName = parentAgent?.config.profileName;
      return (
        DEFAULT_AGENT_PROFILES[parentProfileName ?? 'agent']?.subagents?.[profileName] ??
        DEFAULT_AGENT_PROFILES['agent']?.subagents?.[profileName]
      );
    }
    return DEFAULT_AGENT_PROFILES[profileName];
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
    const agent = this.getReadyAgent('main');
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
