import {
  ErrorCodes,
  KimiError,
  type AgentContextData,
  type KimiErrorCode,
  type SwarmModeTrigger,
} from '@moonshot-ai/agent-core';

import { type ApprovalHandler, type Event, type QuestionHandler } from '#/events';
import type { SDKRpcClientBase } from '#/rpc';
import type {
  BackgroundTaskInfo,
  CompactOptions,
  CreateGoalInput,
  GoalSnapshot,
  GoalToolResult,
  McpServerInfo,
  McpStartupMetrics,
  PermissionMode,
  PluginInfo,
  PluginSummary,
  PromptInput,
  ReloadSummary,
  ResumedSessionState,
  ResumedSessionSummary,
  SessionPlan,
  SessionStatus,
  SessionSummary,
  SessionUsage,
  SkillSummary,
  Unsubscribe,
} from '#/types';

const MAIN_AGENT_ID = 'main';

export interface SessionOptions {
  readonly id: string;
  readonly workDir: string;
  readonly summary?: SessionSummary | undefined;
  readonly resumeState?: ResumedSessionState | undefined;
  readonly rpc: SDKRpcClientBase;
  readonly onClose?: (() => void | Promise<void>) | undefined;
}

export class Session {
  readonly id: string;
  readonly workDir: string;
  summary?: SessionSummary | undefined;
  private resumeState: ResumedSessionState | undefined;

  private readonly rpc: SDKRpcClientBase;
  private readonly onClose?: (() => void | Promise<void>) | undefined;
  private closed = false;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.workDir = options.workDir;
    this.summary = options.summary;
    this.resumeState = options.resumeState ?? resumeStateFromSummary(options.summary);
    this.rpc = options.rpc;
    this.onClose = options.onClose;
  }

  getResumeState(): ResumedSessionState | undefined {
    this.ensureOpen();
    return this.resumeState;
  }

  async reloadSession(): Promise<ResumedSessionSummary> {
    this.ensureOpen();
    const summary = await this.rpc.reloadSession({ sessionId: this.id });
    this.summary = summary;
    this.resumeState = resumeStateFromSummary(summary);
    return summary;
  }

  onEvent(listener: (event: Event) => void): Unsubscribe {
    this.ensureOpen();
    return this.rpc.onEvent((event) => {
      if (event.sessionId === this.id) {
        listener(event);
      }
    });
  }

  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.ensureOpen();
    this.rpc.setApprovalHandler(this.id, handler);
  }

  setQuestionHandler(handler: QuestionHandler | undefined): void {
    this.ensureOpen();
    this.rpc.setQuestionHandler(this.id, handler);
  }

  async prompt(input: string | PromptInput): Promise<void> {
    this.ensureOpen();
    await this.rpc.prompt({
      sessionId: this.id,
      input: normalizePromptInput(input),
    });
  }

  async steer(input: string | PromptInput): Promise<void> {
    this.ensureOpen();
    await this.rpc.steer({
      sessionId: this.id,
      input: normalizePromptInput(input),
    });
  }

  async swarm(input: string | PromptInput): Promise<void> {
    this.ensureOpen();
    await this.rpc.swarm({
      sessionId: this.id,
      input: normalizePromptInput(input),
    });
  }

  async init(): Promise<void> {
    this.ensureOpen();
    await this.rpc.generateAgentsMd({ sessionId: this.id });
  }

  async startBtw(): Promise<string> {
    this.ensureOpen();
    return this.rpc.startBtw({ sessionId: this.id });
  }

  async cancel(): Promise<void> {
    this.ensureOpen();
    await this.rpc.cancel({ sessionId: this.id });
  }

  async setModel(model: string): Promise<void> {
    this.ensureOpen();
    const normalized = normalizeRequiredString(
      model,
      'Session model cannot be empty',
      ErrorCodes.SESSION_MODEL_EMPTY,
    );
    await this.rpc.setModel({ sessionId: this.id, model: normalized });
  }

  async setThinking(level: string): Promise<void> {
    this.ensureOpen();
    const normalized = normalizeRequiredString(
      level,
      'Session thinking level cannot be empty',
      ErrorCodes.SESSION_THINKING_EMPTY,
    );
    await this.rpc.setThinking({ sessionId: this.id, level: normalized });
  }

  async setPermission(mode: PermissionMode): Promise<void> {
    this.ensureOpen();
    if (!isPermissionMode(mode)) {
      throw new KimiError(
        ErrorCodes.SESSION_PERMISSION_MODE_INVALID,
        'Session permission mode must be yolo, manual, or auto',
      );
    }
    await this.rpc.setPermission({ sessionId: this.id, mode });
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    this.ensureOpen();
    if (typeof enabled !== 'boolean') {
      throw new KimiError(
        ErrorCodes.SESSION_PLAN_MODE_INVALID,
        'Session plan mode must be a boolean',
      );
    }
    await this.rpc.setPlanMode({ sessionId: this.id, enabled });
  }

  async setSwarmMode(enabled: boolean, trigger: SwarmModeTrigger): Promise<void> {
    this.ensureOpen();
    if (typeof enabled !== 'boolean') {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        'Session swarm mode must be a boolean',
      );
    }
    if (enabled) {
      await this.rpc.setSwarmMode({ sessionId: this.id, enabled: true, trigger });
    } else {
      await this.rpc.setSwarmMode({ sessionId: this.id, enabled: false });
    }
  }

  async getPlan(): Promise<SessionPlan> {
    this.ensureOpen();
    return this.rpc.getPlan({ sessionId: this.id });
  }

  async clearPlan(): Promise<void> {
    this.ensureOpen();
    await this.rpc.clearPlan({ sessionId: this.id });
  }

  async compact(options: CompactOptions = {}): Promise<void> {
    this.ensureOpen();
    const instruction = normalizeOptionalString(options.instruction);
    await this.rpc.compact({
      sessionId: this.id,
      ...(instruction !== undefined ? { instruction } : {}),
    });
  }

  async cancelCompaction(): Promise<void> {
    this.ensureOpen();
    await this.rpc.cancelCompaction({ sessionId: this.id });
  }

  async undoHistory(count: number = 1): Promise<void> {
    this.ensureOpen();
    await this.rpc.undoHistory({ sessionId: this.id, count });
  }

  async getContext(): Promise<AgentContextData> {
    this.ensureOpen();
    return this.rpc.getContext({ sessionId: this.id });
  }

  async getUsage(): Promise<SessionUsage> {
    this.ensureOpen();
    return this.rpc.getUsage({ sessionId: this.id });
  }

  async getStatus(): Promise<SessionStatus> {
    this.ensureOpen();
    return this.rpc.getStatus({ sessionId: this.id });
  }

  async listSkills(): Promise<readonly SkillSummary[]> {
    this.ensureOpen();
    return this.rpc.listSkills({ sessionId: this.id });
  }

  /**
   * List background tasks for this session's interactive agent.
   *
   * Defaults to all tasks (including terminal/lost). Pass
   * `{ activeOnly: true }` to filter to non-terminal entries.
   */
  async listBackgroundTasks(
    options: { activeOnly?: boolean; limit?: number } = {},
  ): Promise<readonly BackgroundTaskInfo[]> {
    this.ensureOpen();
    return this.rpc.listBackgroundTasks({
      sessionId: this.id,
      activeOnly: options.activeOnly,
      limit: options.limit,
    });
  }

  /**
   * Read a background task's captured output. Returns the in-memory
   * ring buffer if available, otherwise falls back to the persisted
   * `<sessionDir>/tasks/<taskId>/output.log`. `tail` caps the returned
   * string to that many trailing characters.
   */
  async getBackgroundTaskOutput(
    taskId: string,
    options: { tail?: number } = {},
  ): Promise<string> {
    this.ensureOpen();
    const trimmedTaskId = normalizeRequiredString(
      taskId,
      'Task id cannot be empty',
      ErrorCodes.BACKGROUND_TASK_ID_EMPTY,
    );
    return this.rpc.getBackgroundTaskOutput({
      sessionId: this.id,
      taskId: trimmedTaskId,
      tail: options.tail,
    });
  }

  /**
   * Request a running background task to stop. Sends SIGTERM with a
   * grace period (handled by the core BPM); subscribers receive a
   * `background.task.terminated` event when the kill settles. Calls
   * for unknown or already-terminal task ids are no-ops at the core
   * level — this method does not throw in those cases.
   */
  async stopBackgroundTask(
    taskId: string,
    options: { reason?: string } = {},
  ): Promise<void> {
    this.ensureOpen();
    const trimmedTaskId = normalizeRequiredString(
      taskId,
      'Task id cannot be empty',
      ErrorCodes.BACKGROUND_TASK_ID_EMPTY,
    );
    await this.rpc.stopBackgroundTask({
      sessionId: this.id,
      taskId: trimmedTaskId,
      reason: options.reason,
    });
  }

  // --- Goal lifecycle ---------------------------------------------------
  // Deterministic user/host control surface. There is intentionally no
  // `updateGoal`: the goal's terminal status is decided by the model via the
  // in-conversation UpdateGoal tool (or the goal driver on budget/error), not
  // by the host.

  async createGoal(input: CreateGoalInput): Promise<GoalSnapshot> {
    this.ensureOpen();
    return this.rpc.createGoal({ sessionId: this.id, ...input });
  }

  async getGoal(): Promise<GoalToolResult> {
    this.ensureOpen();
    return this.rpc.getGoal({ sessionId: this.id });
  }

  async pauseGoal(): Promise<GoalSnapshot> {
    this.ensureOpen();
    return this.rpc.pauseGoal({ sessionId: this.id });
  }

  async resumeGoal(): Promise<GoalSnapshot> {
    this.ensureOpen();
    return this.rpc.resumeGoal({ sessionId: this.id });
  }

  async cancelGoal(): Promise<GoalSnapshot> {
    this.ensureOpen();
    return this.rpc.cancelGoal({ sessionId: this.id });
  }

  async listMcpServers(): Promise<readonly McpServerInfo[]> {
    this.ensureOpen();
    return this.rpc.listMcpServers({ sessionId: this.id });
  }

  async getMcpStartupMetrics(): Promise<McpStartupMetrics> {
    this.ensureOpen();
    return this.rpc.getMcpStartupMetrics({ sessionId: this.id });
  }

  async reconnectMcpServer(name: string): Promise<void> {
    this.ensureOpen();
    await this.rpc.reconnectMcpServer({ sessionId: this.id, name });
  }

  async listPlugins(): Promise<readonly PluginSummary[]> {
    this.ensureOpen();
    return this.rpc.listPlugins();
  }

  async installPlugin(source: string): Promise<PluginSummary> {
    this.ensureOpen();
    return this.rpc.installPlugin(source);
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    this.ensureOpen();
    await this.rpc.setPluginEnabled(id, enabled);
  }

  async setPluginMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    this.ensureOpen();
    await this.rpc.setPluginMcpServerEnabled(id, server, enabled);
  }

  async removePlugin(id: string): Promise<void> {
    this.ensureOpen();
    await this.rpc.removePlugin(id);
  }

  async reloadPlugins(): Promise<ReloadSummary> {
    this.ensureOpen();
    return this.rpc.reloadPlugins();
  }

  async getPluginInfo(id: string): Promise<PluginInfo> {
    this.ensureOpen();
    return this.rpc.getPluginInfo(id);
  }

  async activateSkill(name: string, args?: string | undefined): Promise<void> {
    this.ensureOpen();
    const skillName = normalizeRequiredString(
      name,
      'Skill name cannot be empty',
      ErrorCodes.SKILL_NAME_EMPTY,
    );
    const skillArgs = normalizeOptionalString(args);
    await this.rpc.activateSkill({
      sessionId: this.id,
      name: skillName,
      ...(skillArgs !== undefined ? { args: skillArgs } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.rpc.closeSession({ sessionId: this.id });
    } finally {
      this.rpc.clearSessionHandlers(this.id);
      await this.onClose?.();
    }
  }

  /** @internal */
  emitMetaUpdated(patch: { readonly title?: string | undefined }): void {
    this.emit({
      type: 'session.meta.updated',
      sessionId: this.id,
      agentId: MAIN_AGENT_ID,
      title: patch.title,
      patch,
    });
  }

  private emit(event: Event): void {
    this.rpc.receiveEvent(event);
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new KimiError(ErrorCodes.SESSION_CLOSED, 'Session is closed');
    }
  }
}

function normalizePromptInput(input: string | PromptInput): PromptInput {
  if (typeof input === 'string') {
    if (input.trim().length === 0) {
      throw new KimiError(ErrorCodes.REQUEST_PROMPT_INPUT_EMPTY, 'Prompt input cannot be empty');
    }
    return [{ type: 'text', text: input }];
  }

  if (input.length === 0) {
    throw new KimiError(ErrorCodes.REQUEST_PROMPT_INPUT_EMPTY, 'Prompt input cannot be empty');
  }

  for (const part of input) {
    switch (part.type) {
      case 'text':
        if (part.text.trim().length === 0) {
          throw new KimiError(
            ErrorCodes.REQUEST_PROMPT_INPUT_EMPTY,
            'Prompt input cannot contain empty text parts',
          );
        }
        break;
      case 'image_url':
        if (part.imageUrl.url.trim().length === 0) {
          throw new KimiError(
            ErrorCodes.REQUEST_PROMPT_INPUT_EMPTY,
            'Prompt input cannot contain empty image URLs',
          );
        }
        break;
      case 'video_url':
        if (part.videoUrl.url.trim().length === 0) {
          throw new KimiError(
            ErrorCodes.REQUEST_PROMPT_INPUT_EMPTY,
            'Prompt input cannot contain empty video URLs',
          );
        }
        break;
    }
  }
  return input;
}

function normalizeRequiredString(
  value: string,
  message: string,
  code: KimiErrorCode,
): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new KimiError(code, message);
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'yolo' || value === 'manual' || value === 'auto';
}

function resumeStateFromSummary(
  summary: SessionSummary | undefined,
): ResumedSessionState | undefined {
  if (!hasResumeState(summary)) return undefined;
  return {
    sessionMetadata: summary.sessionMetadata,
    agents: summary.agents,
    warning: summary.warning,
  };
}

function hasResumeState(
  summary: SessionSummary | undefined,
): summary is SessionSummary & ResumedSessionState {
  return (
    summary !== undefined &&
    typeof (summary as { readonly sessionMetadata?: unknown }).sessionMetadata === 'object' &&
    (summary as { readonly sessionMetadata?: unknown }).sessionMetadata !== null &&
    typeof (summary as { readonly agents?: unknown }).agents === 'object' &&
    (summary as { readonly agents?: unknown }).agents !== null
  );
}
