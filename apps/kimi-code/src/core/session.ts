/**
 * Session-level facade for the v2 engine (`#/core`).
 *
 * `CoreSession` is the TUI's single session object. Every method resolves the
 * target Agent/Session-scope service through the DI accessors
 * (`handle.accessor.get(IXxxService)`) and forwards with at most a light
 * projection. It owns the merged `SessionEvent` stream (`attachSessionEvents`),
 * the approval/question sub-objects layered over the interaction kernel, and a
 * synchronous `summary` snapshot kept fresh from `session.meta.updated`
 * events. Session re-creation (reload/resume/fork) is a harness concern and is
 * intentionally not part of this class.
 */

import {
  ensureMainAgent,
  IAgentContextSizeService,
  IAgentFullCompactionService,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentMcpService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentRPCService,
  IAgentSwarmService,
  IAgentTaskService,
  IAgentUsageService,
  IConfigService,
  IModelResolver,
  ISessionApprovalService,
  ISessionBtwService,
  ISessionContext,
  ISessionInitService,
  ISessionInteractionService,
  ISessionMetadata,
  ISessionQuestionService,
  ISessionSkillCatalog,
  ISessionWorkspaceCommandService,
  MAIN_AGENT_ID,
  summarizeSkill,
  type ContentPart,
  type ContextMessage,
  type IAgentScopeHandle,
  type Interaction,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { CoreError, CoreErrorCodes } from './errors';
import { attachSessionEvents } from './events';
import type {
  AgentTaskInfo,
  ApprovalResponse,
  CoreApprovalRequest,
  CoreQuestionRequest,
  CoreSessionSummary,
  CreateGoalInput,
  GoalToolResult,
  McpServerEntry,
  PendingApproval,
  PendingQuestion,
  PermissionMode,
  PlanData,
  PromptPart,
  QuestionResult,
  ResumedSessionState,
  SessionEvent,
  SessionMeta,
  SessionStatus,
  SessionWarning,
  ShellCommandResult,
  SkillSummary,
  SwarmModeTrigger,
  UsageStatus,
  WorkspaceAdditionalDirsResult,
} from './types';

export interface CoreSessionInit {
  readonly id: string;
  readonly handle: ISessionScopeHandle;
  readonly app: Scope;
  /** Initial summary snapshot projected by the harness at create/resume time. */
  readonly summary: CoreSessionSummary;
  /** Injected by the harness on resume/fork; `undefined` for fresh sessions. */
  readonly resumeState?: ResumedSessionState;
  /** Harness deregistration callback (includes the lifecycle close). */
  readonly onClose: () => Promise<void>;
}

export interface CoreApprovals {
  list(): readonly PendingApproval[];
  onDidChangePending(listener: () => void): () => void;
  onDidResolve(listener: (id: string) => void): () => void;
  decide(id: string, response: ApprovalResponse): void;
}

export interface CoreQuestions {
  list(): readonly PendingQuestion[];
  onDidChangePending(listener: () => void): () => void;
  onDidResolve(listener: (id: string) => void): () => void;
  answer(id: string, result: Exclude<QuestionResult, null>): void;
  dismiss(id: string): void;
}

export class CoreSession {
  readonly id: string;
  readonly approvals: CoreApprovals;
  readonly questions: CoreQuestions;

  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private detachEvents: (() => void) | undefined;
  private closed = false;
  private summarySnapshot: CoreSessionSummary;

  constructor(private readonly init: CoreSessionInit) {
    this.id = init.id;
    this.summarySnapshot = init.summary;
    this.approvals = this.buildApprovals();
    this.questions = this.buildQuestions();
    this.detachEvents = attachSessionEvents({
      session: init.handle,
      sessionId: init.id,
      app: init.app,
      emit: (event) => this.deliver(event),
    });
  }

  /** Working directory frozen at session creation (`ISessionContext.cwd`). */
  get workDir(): string {
    return this.init.handle.accessor.get(ISessionContext).cwd;
  }

  /**
   * Synchronous summary snapshot. `ISessionMetadata.read()` is async, but the
   * TUI reads `session.summary` synchronously, so the harness injects the
   * initial projection and `session.meta.updated` events keep it fresh.
   */
  get summary(): CoreSessionSummary {
    return this.summarySnapshot;
  }

  // -- Conversation flow ----------------------------------------------------

  // `prompt`/`steer` both go through the native `IAgentPromptService` (the
  // promptLegacy surface is gone): `enqueue` keeps the FIFO queue a prompt
  // sent mid-turn relies on, and `inject` steers content into the active turn
  // (or opens a fresh one when the queue drained between the TUI's check and
  // the call). Wire-shaped parts are converted to v2-native `ContentPart`s at
  // this boundary — the TUI's paste path already compressed any base64 image,
  // so the conversion is a pure re-shape (mirrors kap-server's
  // `contentToCoreParts`). Everything else that mutates a turn
  // (`cancel`/`runShellCommand`/`undoHistory`/`activateSkill`/`setPermission`/
  // `getContext`/`cancelCompaction`) goes through the native `IAgentRPCService`.
  async prompt(parts: readonly PromptPart[], options?: { agentId?: string }): Promise<void> {
    const agent = await this.agent(options?.agentId);
    await agent.accessor.get(IAgentPromptService).enqueue({
      message: {
        role: 'user',
        content: toCoreParts(parts),
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
  }

  async steer(parts: readonly PromptPart[], options?: { agentId?: string }): Promise<void> {
    const agent = await this.agent(options?.agentId);
    await agent.accessor.get(IAgentPromptService).inject({
      role: 'user',
      content: toCoreParts(parts),
      toolCalls: [],
      origin: { kind: 'user' },
    });
  }

  async cancel(options?: { agentId?: string }): Promise<void> {
    // `/init` runs outside the main agent's loop turns (sessionInit spawns a
    // coder subagent), so the RPC turn cancel alone cannot reach it;
    // cancelInit is a no-op while idle and can be invoked unconditionally.
    this.init.handle.accessor.get(ISessionInitService).cancelInit();
    const agent = await this.agent(options?.agentId);
    await agent.accessor.get(IAgentRPCService).cancel({});
  }

  async runShellCommand(
    command: string,
    options: { commandId: string; agentId?: string },
  ): Promise<ShellCommandResult> {
    const agent = await this.agent(options.agentId);
    return await agent.accessor
      .get(IAgentRPCService)
      .runShellCommand({ command, commandId: options.commandId });
  }

  async cancelShellCommand(commandId: string, options?: { agentId?: string }): Promise<void> {
    const agent = await this.agent(options?.agentId);
    await agent.accessor.get(IAgentRPCService).cancelShellCommand({ commandId });
  }

  /** Returns the number of history entries actually undone. */
  async undoHistory(count: number, options?: { agentId?: string }): Promise<number> {
    const agent = await this.agent(options?.agentId);
    return await agent.accessor.get(IAgentRPCService).undoHistory({ count });
  }

  async activateSkill(input: { name: string; args?: string; agentId?: string }): Promise<void> {
    const agent = await this.agent(input.agentId);
    await agent.accessor.get(IAgentRPCService).activateSkill({ name: input.name, args: input.args });
  }

  async activatePluginCommand(input: {
    pluginId: string;
    commandName: string;
    args?: string;
    agentId?: string;
  }): Promise<void> {
    const agent = await this.agent(input.agentId);
    await agent.accessor.get(IAgentRPCService).activatePluginCommand({
      pluginId: input.pluginId,
      commandName: input.commandName,
      args: input.args,
    });
  }

  // -- Modes ------------------------------------------------------------------

  async setModel(
    model: string,
    options?: { agentId?: string },
  ): Promise<{ model: string; providerName?: string }> {
    const agent = await this.agent(options?.agentId);
    return await agent.accessor.get(IAgentProfileService).setModel(model);
  }

  async setThinking(level: string, options?: { agentId?: string }): Promise<void> {
    const agent = await this.agent(options?.agentId);
    agent.accessor.get(IAgentProfileService).setThinking(level);
  }

  async setPermission(mode: PermissionMode, options?: { agentId?: string }): Promise<void> {
    const agent = await this.agent(options?.agentId);
    await agent.accessor.get(IAgentRPCService).setPermission({ mode });
  }

  async setPlanMode(on: boolean, options?: { agentId?: string }): Promise<void> {
    const agent = await this.agent(options?.agentId);
    const plan = agent.accessor.get(IAgentPlanService);
    if (on) await plan.enter();
    else plan.cancel();
  }

  async setSwarmMode(
    on: boolean,
    options?: { agentId?: string; trigger?: SwarmModeTrigger },
  ): Promise<void> {
    const agent = await this.agent(options?.agentId);
    const swarm = agent.accessor.get(IAgentSwarmService);
    if (on) swarm.enter(options?.trigger ?? 'manual');
    else swarm.exit();
  }

  /** Returns `false` when a compaction is already in flight. */
  async compact(instruction?: string): Promise<boolean> {
    const agent = await this.agent();
    return agent.accessor.get(IAgentFullCompactionService).begin({ source: 'manual', instruction });
  }

  async cancelCompaction(): Promise<void> {
    const agent = await this.agent();
    await agent.accessor.get(IAgentRPCService).cancelCompaction({});
  }

  async clearPlan(): Promise<void> {
    const agent = await this.agent();
    await agent.accessor.get(IAgentPlanService).clear();
  }

  async getPlan(): Promise<PlanData> {
    const agent = await this.agent();
    return await agent.accessor.get(IAgentPlanService).status();
  }

  // -- Queries ----------------------------------------------------------------

  async getStatus(): Promise<SessionStatus> {
    const main = await this.agent();
    const { accessor } = main;
    const profile = accessor.get(IAgentProfileService);
    const model = profile.getModel();
    const contextTokens = accessor.get(IAgentContextSizeService).get().size;
    // Aggregate from the main agent's native services instead of the v1
    // `ISessionLegacyService` wire projection. Mirror v1's
    // `resolveDefaultModelContextTokens`: when no model is bound yet (fresh
    // session), report the configured default model's context window; fall back
    // to 0 when none is configured or it cannot be resolved (e.g. auth not ready).
    let maxContextTokens = profile.getModelCapabilities().max_context_tokens ?? 0;
    if (model === '') {
      const defaultModel = accessor.get(IConfigService).get<string>('defaultModel');
      if (typeof defaultModel !== 'string' || defaultModel.length === 0) {
        maxContextTokens = 0;
      } else {
        try {
          maxContextTokens = accessor.get(IModelResolver).resolve(defaultModel).capabilities.max_context_tokens;
        } catch {
          maxContextTokens = 0;
        }
      }
    }
    return {
      model: model === '' ? undefined : model,
      thinkingEffort: profile.data().thinkingLevel,
      permission: accessor.get(IAgentPermissionModeService).mode,
      planMode: (await accessor.get(IAgentPlanService).status()) !== null,
      swarmMode: accessor.get(IAgentSwarmService).isActive,
      contextTokens,
      maxContextTokens,
      contextUsage: maxContextTokens > 0 ? contextTokens / maxContextTokens : 0,
      usage: accessor.get(IAgentUsageService).status(),
    };
  }

  async getContext(options?: { agentId?: string }): Promise<readonly ContextMessage[]> {
    const agent = await this.agent(options?.agentId);
    const data = await agent.accessor.get(IAgentRPCService).getContext({});
    return data.history;
  }

  async getUsage(options?: { agentId?: string }): Promise<UsageStatus> {
    const agent = await this.agent(options?.agentId);
    return agent.accessor.get(IAgentUsageService).status();
  }

  async getGoal(): Promise<GoalToolResult> {
    const agent = await this.agent();
    return agent.accessor.get(IAgentGoalService).getGoal();
  }

  async getSessionWarnings(): Promise<readonly SessionWarning[]> {
    // TODO(v2-gap): G-9/G-12 — v2 only tracks the AGENTS.md size warning
    // (profile-cached); other v1 warning sources have no v2 equivalent yet.
    const agent = await this.agent();
    const agentsMdWarning = agent.accessor.get(IAgentProfileService).getAgentsMdWarning();
    if (agentsMdWarning === undefined) return [];
    return [{ code: 'agents-md-oversized', message: agentsMdWarning, severity: 'warning' }];
  }

  async getMcpStartupMetrics(): Promise<{ durationMs: number | undefined }> {
    const agent = await this.agent();
    return { durationMs: agent.accessor.get(IAgentMcpService).initialLoadDurationMs() };
  }

  async listMcpServers(): Promise<readonly McpServerEntry[]> {
    const agent = await this.agent();
    return agent.accessor.get(IAgentMcpService).list();
  }

  async listSkills(): Promise<readonly SkillSummary[]> {
    const skills = this.init.handle.accessor.get(ISessionSkillCatalog);
    await skills.ready;
    return skills.catalog.listSkills().map((skill) => summarizeSkill(skill));
  }

  getResumeState(): ResumedSessionState | undefined {
    return this.init.resumeState;
  }

  async getSessionMetadata(): Promise<SessionMeta> {
    return await this.init.handle.accessor.get(ISessionMetadata).read();
  }

  // -- Goal / background tasks -------------------------------------------------

  async createGoal(input: CreateGoalInput): Promise<GoalToolResult> {
    const agent = await this.agent();
    return { goal: await agent.accessor.get(IAgentGoalService).createGoal(input) };
  }

  async pauseGoal(): Promise<GoalToolResult> {
    const agent = await this.agent();
    return { goal: await agent.accessor.get(IAgentGoalService).pauseGoal() };
  }

  async resumeGoal(): Promise<GoalToolResult> {
    const agent = await this.agent();
    return { goal: await agent.accessor.get(IAgentGoalService).resumeGoal() };
  }

  async cancelGoal(): Promise<GoalToolResult> {
    const agent = await this.agent();
    return { goal: await agent.accessor.get(IAgentGoalService).cancelGoal() };
  }

  async listBackgroundTasks(options?: {
    activeOnly?: boolean;
    limit?: number;
    agentId?: string;
  }): Promise<readonly AgentTaskInfo[]> {
    const agent = await this.agent(options?.agentId);
    return agent.accessor.get(IAgentTaskService).list(options?.activeOnly, options?.limit);
  }

  async getBackgroundTaskOutput(
    taskId: string,
    options?: { tail?: number; agentId?: string },
  ): Promise<string> {
    const agent = await this.agent(options?.agentId);
    return await agent.accessor.get(IAgentTaskService).readOutput(taskId, options?.tail);
  }

  /** Resolves with the terminal task info, or `undefined` for an unknown task. */
  async stopBackgroundTask(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
    const agent = await this.agent();
    return await agent.accessor.get(IAgentTaskService).stop(taskId, reason);
  }

  /** Resolves with the detached task info, or `undefined` when it already finished. */
  async detachBackgroundTask(taskId: string): Promise<AgentTaskInfo | undefined> {
    const agent = await this.agent();
    return agent.accessor.get(IAgentTaskService).detach(taskId);
  }

  // -- Orchestration -----------------------------------------------------------

  /** Fork the main agent into a side-question child; returns the child agent id. */
  async startBtw(): Promise<string> {
    return await this.init.handle.accessor.get(ISessionBtwService).start();
  }

  async addAdditionalDir(input: {
    path: string;
    persist?: boolean;
  }): Promise<WorkspaceAdditionalDirsResult> {
    return await this.init.handle.accessor
      .get(ISessionWorkspaceCommandService)
      .addAdditionalDir({ path: input.path, persist: input.persist });
  }

  async generateAgentsMd(): Promise<void> {
    // `/init` runs on the session-scoped init service: it spawns a child agent
    // with the init profile and mirrors its run onto the main agent's event
    // stream, so the TUI renders it like any other turn.
    await this.init.handle.accessor.get(ISessionInitService).generateAgentsMd();
  }

  // -- Events / interactions / lifecycle ----------------------------------------

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * @internal Inject an event into this session's stream. Used by the harness
   * to re-emit `session.meta.updated` after a rename — v2's `setTitle` does
   * not publish a global event. Goes through the same delivery path as engine
   * events so the summary snapshot stays in sync.
   */
  emitEvent(event: SessionEvent): void {
    this.deliver(event);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachEvents?.();
    this.detachEvents = undefined;
    this.listeners.clear();
    await this.init.onClose();
  }

  // -- Internals -----------------------------------------------------------------

  /** Single delivery path for engine and harness-injected events. */
  private deliver(event: SessionEvent): void {
    this.applySummaryEvent(event);
    // Snapshot so listeners unsubscribing/subscribing mid-dispatch do not
    // affect this delivery round.
    const snapshot = [...this.listeners];
    for (const listener of snapshot) listener(event);
  }

  /** Resolve the target agent handle; the main agent is created lazily. */
  private async agent(agentId?: string): Promise<IAgentScopeHandle> {
    const id = agentId ?? MAIN_AGENT_ID;
    if (id === MAIN_AGENT_ID) return await ensureMainAgent(this.init.handle);
    const handle = this.init.handle.accessor.get(IAgentLifecycleService).getHandle(id);
    if (handle === undefined) {
      throw new CoreError(
        CoreErrorCodes.AGENT_NOT_FOUND,
        `Agent "${id}" was not found in session "${this.id}"`,
      );
    }
    return handle;
  }

  /** Keep the synchronous summary snapshot in step with `session.meta.updated`. */
  private applySummaryEvent(event: SessionEvent): void {
    // `session.meta.updated` is an app-bus projection (not part of the agent-bus
    // DomainEvent union); after the type guard it narrows to the meta arm, whose
    // optional `title`/`patch` are readable directly.
    if (event.type !== 'session.meta.updated') return;
    const patchTitle = event.patch?.['title'];
    const patchLastPrompt = event.patch?.['lastPrompt'];
    const nextTitle =
      typeof event.title === 'string'
        ? event.title
        : typeof patchTitle === 'string'
          ? patchTitle
          : undefined;
    const lastPrompt = typeof patchLastPrompt === 'string' ? patchLastPrompt : undefined;
    if (nextTitle === undefined && lastPrompt === undefined) return;
    this.summarySnapshot = {
      ...this.summarySnapshot,
      title: nextTitle ?? this.summarySnapshot.title,
      lastPrompt: lastPrompt ?? this.summarySnapshot.lastPrompt,
    };
  }

  private buildApprovals(): CoreApprovals {
    const kernel = this.init.handle.accessor.get(ISessionInteractionService);
    const approvals = this.init.handle.accessor.get(ISessionApprovalService);
    const project = (i: Interaction): PendingApproval => {
      const payload = i.payload as CoreApprovalRequest;
      return {
        id: i.id,
        agentId: i.origin.agentId ?? payload.agentId ?? MAIN_AGENT_ID,
        request: payload,
      };
    };
    return {
      list: () => kernel.listPending('approval').map(project),
      onDidChangePending: (listener) => {
        const d = kernel.onDidChangePending(() => listener());
        return () => d.dispose();
      },
      onDidResolve: (listener) => {
        const d = kernel.onDidResolve(({ id }) => listener(id));
        return () => d.dispose();
      },
      decide: (id, response) => approvals.decide(id, response),
    };
  }

  private buildQuestions(): CoreQuestions {
    const kernel = this.init.handle.accessor.get(ISessionInteractionService);
    const questions = this.init.handle.accessor.get(ISessionQuestionService);
    const project = (i: Interaction): PendingQuestion => ({
      id: i.id,
      // TODO(v2-gap): G-20 — `QuestionRequest` carries no agentId; fall back to
      // the interaction origin, then main.
      agentId: i.origin.agentId ?? MAIN_AGENT_ID,
      request: i.payload as CoreQuestionRequest,
    });
    return {
      list: () => kernel.listPending('question').map(project),
      onDidChangePending: (listener) => {
        const d = kernel.onDidChangePending(() => listener());
        return () => d.dispose();
      },
      onDidResolve: (listener) => {
        const d = kernel.onDidResolve(({ id }) => listener(id));
        return () => d.dispose();
      },
      answer: (id, result) => questions.answer(id, result),
      dismiss: (id) => questions.dismiss(id),
    };
  }
}

/**
 * Convert wire-shaped prompt parts to v2-native `ContentPart`s. Pure re-shape:
 * text passes through, url sources stay urls, and base64 sources become
 * data-URL `*_url` parts (mirrors kap-server's `contentToCoreParts`). Inline
 * images arrive already compressed by the TUI's paste path.
 */
function toCoreParts(parts: readonly PromptPart[]): ContentPart[] {
  const converted: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      converted.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      const url =
        part.source.kind === 'url'
          ? part.source.url
          : `data:${part.source.media_type};base64,${part.source.data}`;
      converted.push({ type: 'image_url', imageUrl: { url } });
    } else if (part.type === 'video') {
      const url =
        part.source.kind === 'url'
          ? part.source.url
          : `data:${part.source.media_type};base64,${part.source.data}`;
      converted.push({ type: 'video_url', videoUrl: { url } });
    }
  }
  return converted;
}
