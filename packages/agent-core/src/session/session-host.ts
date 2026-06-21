import { join } from 'pathe';
import type { Kaos } from '@moonshot-ai/kaos';

import { ErrorCodes, KimiError } from '#/errors';
import type { SessionLogHandle } from '#/logging/types';
import { proxyWithExtraPayload } from '#/rpc/types';

import { Agent, type AgentOptions, type AgentType } from '../agent';
import type { SessionHookCtx } from '../agent/lifecycle';
import type { PermissionManagerOptions } from '../agent/permission';
import { parseBooleanEnv, resolveConfigValue } from '../config';
import type { IInstantiationService } from '../di';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import { abortError } from '../utils/abort';

import type { CreateAgentOptions, Session } from './index';
import { SubagentHostService } from './subagent-host';

const BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV = 'KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';
const ACTIVE_TURN_CLOSE_TIMEOUT_MS = 8_000;

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

export interface ResumedAgent {
  readonly agent: Agent;
  readonly warning?: string;
}

export type AgentEntry = Agent | Promise<ResumedAgent>;

/**
 * Dependencies a {@link SessionHost} needs from its owning {@link Session}.
 *
 * The host owns the agent registry + agent lifecycle but still reaches back to
 * the session for session-level concerns (metadata persistence, MCP shutdown,
 * the session log sink, the DI scope used to construct per-agent services, and
 * the `skillsReady` gate). Keeping these as explicit deps (rather than
 * duplicating them) is what lets this extraction stay behavior-identical while
 * `KimiCore.sessions` continues to hold `Session` (the switch to
 * `Map<string, SessionHost>` is deferred to M1.7b).
 */
export interface SessionHostDeps {
  readonly session: Session;
  readonly scope: IInstantiationService;
  readonly logHandle: SessionLogHandle | undefined;
  readonly skillsReady: () => Promise<void>;
}

/**
 * Owns a session's agent registry and the lifecycle of the agents within it
 * (create / resume / close / closeForReload). {@link Session} keeps its
 * identity (id, options, lifecycle service, MCP, persistence, metadata) and
 * delegates agent management to an internal `SessionHost` instance.
 */
export class SessionHost {
  readonly agents = new Map<string, AgentEntry>();
  private agentIdCounter = 0;
  private toolKaos: Kaos;

  constructor(private readonly deps: SessionHostDeps) {
    this.toolKaos = deps.session.options.kaos;
  }

  /**
   * Back-ref to the owning {@link Session}. Exposed so that `KimiCore.sessions`
   * (which now holds `SessionHost`) can reach session-owned concerns
   * (metadata, log, MCP, lifecycle services) without maintaining a parallel
   * `Map<string, Session>`.
   */
  get session(): Session {
    return this.deps.session;
  }

  setToolKaos(kaos: Kaos): void {
    this.toolKaos = kaos;
    for (const agent of this.readyAgents()) {
      agent.setKaos(kaos.withCwd(agent.config.cwd));
    }
    this.refreshAgentBuiltinTools();
  }

  /**
   * Fires a session-scoped lifecycle hook, but only when the owning session
   * has a stable id. Ephemeral sessions (`options.id === undefined`) have no
   * id to identify them in the hook ctx, so their session hooks are skipped.
   */
  private async fireSessionHook(
    fire: (ctx: SessionHookCtx) => Promise<void>,
  ): Promise<void> {
    const sessionId = this.session.options.id;
    if (sessionId === undefined) return;
    await fire({ sessionId });
  }

  async createMain(): Promise<Agent> {
    await this.fireSessionHook((ctx) => this.session.lifecycle.fireSessionWillStart(ctx));
    const { agent } = await this.createAgent({ type: 'main' }, {
      profile: DEFAULT_AGENT_PROFILES['agent'],
    });
    await this.triggerSessionStart('startup');
    await this.fireSessionHook((ctx) => this.session.lifecycle.fireSessionDidStart(ctx));
    return agent;
  }

  async resume(): Promise<{ warning?: string }> {
    await this.fireSessionHook((ctx) => this.session.lifecycle.fireSessionWillStart(ctx));
    await this.deps.skillsReady();
    this.session.log.info('session resume', { app_version: this.session.options.appVersion });
    const { agents } = await this.session.readMetadata();
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
    await this.fireSessionHook((ctx) => this.session.lifecycle.fireSessionDidStart(ctx));
    return { warning };
  }

  async close(): Promise<void> {
    await this.fireSessionHook((ctx) => this.session.lifecycle.fireSessionWillClose(ctx));
    try {
      await Promise.allSettled(
        Array.from(this.readyAgents(), async (agent) => {
          await agent.dispose();
          await agent.cron?.stop();
        }),
      );
      await this.cancelActiveTurnsOnClose();
      await this.stopBackgroundTasksOnExit();
      await this.session.flushMetadata();
      await this.triggerSessionEnd('exit');
    } finally {
      try {
        await this.session.mcp.shutdown();
      } finally {
        await this.deps.logHandle?.close();
      }
    }
    await this.fireSessionHook((ctx) => this.session.lifecycle.fireSessionDidClose(ctx));
  }

  async closeForReload(): Promise<void> {
    await this.fireSessionHook((ctx) => this.session.lifecycle.fireSessionWillClose(ctx));
    try {
      await Promise.allSettled(
        Array.from(this.readyAgents(), async (agent) => {
          await agent.dispose();
          await agent.cron?.stop();
        }),
      );
      await this.session.flushMetadata();
    } finally {
      try {
        await this.session.mcp.shutdown();
      } finally {
        await this.deps.logHandle?.close();
      }
    }
    await this.fireSessionHook((ctx) => this.session.lifecycle.fireSessionDidClose(ctx));
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
        if (task.kind === 'agent' && task.agentId !== undefined) {
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
      this.session.log.debug('active turn wait unavailable during session close', {
        agentType: agent.type,
        agentHomedir: agent.homedir,
        error,
      });
      return;
    }

    agent.turn.cancel(undefined, abortError('Session closed'));
    const settled = await waitForSettlementOrTimeout(waitForTurn, ACTIVE_TURN_CLOSE_TIMEOUT_MS);
    if (!settled) {
      this.session.log.warn('timed out waiting for active turn to cancel during session close', {
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
      configValue: this.session.options.background?.keepAliveOnExit,
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
    await this.deps.skillsReady();
    const type = config.type ?? 'main';
    const id = type === 'main' ? 'main' : this.nextGeneratedAgentId();
    const homedir = config.homedir ?? join(this.session.options.homedir, 'agents', id);
    const parentAgentId = options.parentAgentId ?? null;
    const agent = this.instantiateAgent(id, homedir, type, config, parentAgentId);
    if (options.profile) {
      await this.bootstrapAgentProfile(agent, options.profile);
    }

    this.agents.set(id, agent);
    if (options.persistMetadata !== false) {
      this.session.metadata.agents[id] = {
        homedir,
        type,
        parentAgentId,
        swarmItem: options.swarmItem,
      };
      void this.session.writeMetadata();
    }

    return { id, agent };
  }

  async ensureAgentResumed(id: string): Promise<Agent> {
    const entry = this.agents.get(id);
    if (entry !== undefined) return (await this.resolveAgentEntry(entry)).agent;
    if (this.session.metadata.agents[id] === undefined) {
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
      this.session.systemContextKaos(agent.kaos.getcwd()),
      this.session.options.kimiHomeDir,
    );
    agent.useProfile(profile, context);
  }

  get hasActiveTurn(): boolean {
    for (const agent of this.readyAgents()) {
      if (agent.turn.hasActiveTurn) return true;
    }
    return false;
  }

  refreshAgentBuiltinTools(): void {
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
    return new Agent({
      ...config,
      id,
      type,
      kaos: this.toolKaos.withCwd(cwd),
      toolServices: this.session.options.toolServices,
      config: this.session.options.config,
      homedir,
      skills: this.session.skills,
      rpc: proxyWithExtraPayload(this.session.rpc, { agentId: id }),
      modelProvider: this.session.options.providerManager,
      hookEngine: config.hookEngine ?? this.session.hookEngine,
      subagentHost:
        config.subagentHost ??
        this.deps.scope.createInstance(SubagentHostService, this.session, id),
      mcp: this.session.mcp,
      permission: this.permissionOptions(parentAgentId, config.permission),
      telemetry: this.session.telemetry,
      log: this.session.log.createChild({ agentId: id }),
      pluginSessionStarts: type === 'main' ? this.session.options.pluginSessionStarts : undefined,
      experimentalFlags: this.session.experimentalFlags,
      instantiationService: this.deps.scope,
    });
  }

  private permissionOptions(
    parentAgentId: string | null,
    input?: PermissionManagerOptions | undefined,
  ): PermissionManagerOptions {
    if (parentAgentId === null) {
      return {
        ...input,
        initialRules: input?.initialRules ?? this.session.options.permissionRules,
      };
    }
    return {
      ...input,
      parent: input?.parent ?? this.getReadyAgent(parentAgentId)?.permission?.unwrap(),
    };
  }

  getReadyAgent(id: string): Agent | undefined {
    const entry = this.agents.get(id);
    return entry instanceof Agent ? entry : undefined;
  }

  *readyAgents(): Iterable<Agent> {
    for (const entry of this.agents.values()) {
      if (entry instanceof Agent) yield entry;
    }
  }

  private async resolveAgentEntry(entry: AgentEntry): Promise<ResumedAgent> {
    if (entry instanceof Agent) return { agent: entry };
    return entry;
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
    if (entry !== undefined) return this.resolveAgentEntry(entry);

    const promise = this.resumePersistedAgent(id, stack);
    this.agents.set(id, promise);
    return promise;
  }

  private async resumePersistedAgent(
    id: string,
    stack: readonly string[] = [],
  ): Promise<ResumedAgent> {
    await this.deps.skillsReady();
    const meta = this.session.metadata.agents[id];
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

  private nextGeneratedAgentId(): string {
    while (true) {
      const id = `agent-${this.agentIdCounter++}`;
      if (this.agents.has(id)) continue;
      if (this.session.metadata.agents[id] !== undefined) continue;
      return id;
    }
  }

  requireMainAgent(): Agent {
    const agent = this.getReadyAgent('main');
    if (agent === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    return agent;
  }

  private async triggerSessionStart(source: 'startup' | 'resume'): Promise<void> {
    await this.session.hookEngine.trigger('SessionStart', {
      matcherValue: source,
      inputData: { source },
    });
  }

  private async triggerSessionEnd(reason: 'exit'): Promise<void> {
    await this.session.hookEngine.trigger('SessionEnd', {
      matcherValue: reason,
      inputData: { reason },
    });
  }
}
