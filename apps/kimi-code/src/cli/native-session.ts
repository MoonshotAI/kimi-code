/**
 * native-session.ts — a `TuiSession`-shaped facade over the native Rust engine.
 *
 * This is the keystone translation layer: it wraps {@link NativeSessionAdapter}
 * (which speaks the engine's snake_case wire shapes) and presents the SDK
 * `Session` surface the interactive TUI consumes, so the TUI can hold a native
 * engine session in place of the agent-core harness `Session`.
 *
 * Scope (ON by default since the Rust session surface reached parity; opt out
 * with `KIMI_SESSION_ENGINE_TUI=0`):
 *  - Engine-backed methods are translated for real (wire -> SDK types):
 *    getStatus, getUsage, listSkills, listMcpServers, getSessionWarnings,
 *    getGoal + goal lifecycle, setModel/setThinking/setPermission/setPlanMode/
 *    setSwarmMode, steer, prompt, cancel, runShellCommand, addAdditionalDir,
 *    updateMetadata, compact, onEvent (already SDK Event), setApprovalHandler.
 *  - Fresh and resumed sessions are both native: `createNativeTuiSession`
 *    restores a persisted engine session (`session/load`) and synthesizes a
 *    replayable `ResumedSessionState` from the restored history, so
 *    `hydrateFromReplay` renders the transcript without the harness.
 *  - Side-question (`btw`) turns stamp their events with the side-agent id,
 *    so the btw panel routes them by `event.agentId`.
 *  - Methods the engine cannot back yet DEGRADE CLEARLY: they return empty /
 *    no-op, or reject with a "not available under the native engine yet"
 *    message. They are deliberately NOT faked. Subsequent rounds add the
 *    engine RPCs / host delegation that removes each degradation.
 */
import type {
  AgentContextData,
  AgentReplayRecord,
  ResumedAgentState,
  SwarmModeTrigger,
} from '@moonshot-ai/kimi-code-sdk';
import type {
  AddAdditionalDirOptions,
  AddAdditionalDirResult,
  ApprovalHandler,
  ApprovalRequest,
  BackgroundTaskInfo,
  CompactOptions,
  CreateGoalInput,
  Event,
  GetCronTasksResult,
  GoalSnapshot,
  GoalToolResult,
  JsonObject,
  McpServerInfo,
  McpStartupMetrics,
  PermissionMode,
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  PromptInput,
  ReloadSessionOptions,
  ReloadSummary,
  ResumedSessionState,
  ResumedSessionSummary,
  Session,
  SessionPlan,
  SessionStatus,
  SessionSummary,
  SessionUsage,
  SkillSummary,
  ThinkingEffort,
  Unsubscribe,
} from '@moonshot-ai/kimi-code-sdk';

/** `SessionWarning` is not re-exported from the SDK root; derive it from the
 *  `Session` surface so it stays in sync without guessing its module. */
type SessionWarning = Awaited<ReturnType<Session['getSessionWarnings']>>[number];

import { resolve } from 'pathe';

import type { TuiSession } from '#/tui/tui-session';

import {
  NativeSessionAdapter,
  nativeEngineOpsFromRustLoop,
  type EngineSessionRecord,
  type NativePermissionMode,
  type RustLoopSessionApi,
} from './native-session-adapter';
import {
  mapBackgroundTask,
  mapContextMessage,
  mapMcpServer,
  mapPluginInfo,
  mapPluginSummary,
  mapSkill,
  mapStatus,
  mapUsage,
  promptText,
} from '@moonshot-ai/kimi-code-sdk/rust';
import type { SessionClientFactoryOptions, SessionClientHandle } from '@moonshot-ai/kimi-code-sdk/rust';

/** The rust-loop surface the native TUI session factory needs. */
export interface NativeTuiRustLoop extends RustLoopSessionApi {
  createSessionClient(
    options: SessionClientFactoryOptions & {
      nativeLlm?: unknown;
      mcpServers?: unknown;
      hooks?: unknown;
    },
  ): Promise<SessionClientHandle | null>;
}

/** Inputs to build + start a native TUI session. */
export interface NativeTuiSessionInit {
  readonly sessionId: string;
  readonly workDir: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly goalEnabled?: boolean;
  readonly homedir?: string;
  readonly nativeLlm?: unknown;
  readonly mcpServers?: unknown;
  readonly hooks?: unknown;
  /** Interactive default is `manual` so the host approval UI gates tools. */
  readonly permissionMode?: NativePermissionMode;
}

/** Feature gate for the interactive TUI's native-engine sessions. ON by
 *  default (`KIMI_SESSION_ENGINE_TUI=0` opts out); every call site
 *  (startup, resume, picker, btw panel) must route through this instead of
 *  re-reading the env var. Any native-session failure falls back to the
 *  harness, so the default can never hard-break startup. */
export function isNativeTuiEngineEnabled(): boolean {
  return process.env['KIMI_SESSION_ENGINE_TUI'] !== '0';
}

/** Non-terminal background-task statuses (for the `activeOnly` filter). */
const ACTIVE_BG_STATUSES = new Set(['running', 'queued', 'starting']);

/**
 * A native-engine session presented on the SDK `Session` surface the TUI uses.
 * Constructed via {@link createNativeTuiSession} after the engine session has
 * started.
 */
export class NativeSession implements TuiSession {
  readonly id: string;
  readonly workDir: string;
  summary?: SessionSummary | undefined;
  /** Active side-question agent id; prompts route to it while set. */
  private btwAgentId: string | null = null;
  /** Captured resume snapshot (set when the session was created by resume). */
  private readonly resumeState: ResumedSessionState | undefined;

  constructor(
    private readonly adapter: NativeSessionAdapter,
    init: { id: string; workDir: string },
    resumeState?: ResumedSessionState,
  ) {
    this.id = init.id;
    this.workDir = init.workDir;
    this.resumeState = resumeState;
    const now = Date.now();
    this.summary = {
      id: init.id,
      workDir: init.workDir,
      sessionDir: init.workDir,
      createdAt: now,
      updatedAt: now,
      metadata: {},
      additionalDirs: [],
    };
  }

  // ── Events + reverse-RPC handlers ──────────────────────────────────────
  onEvent(listener: (event: Event) => void): Unsubscribe {
    return this.adapter.onEvent(listener);
  }

  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    if (handler === undefined) {
      this.adapter.setApprovalHandler(undefined);
      return;
    }
    // Upgrade the engine's {toolName,toolCallId,args} into an SDK
    // ApprovalRequest, then downgrade the ApprovalResponse to the yes/no the
    // engine gate expects. Approval scope memory lives host-side (the SDK
    // handler decides); the engine only needs allow/deny.
    this.adapter.setApprovalHandler(async (req) => {
      const request: ApprovalRequest = {
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        action: req.toolName,
        display: { kind: 'generic', summary: req.toolName, detail: req.args },
      };
      const response = await handler(request);
      return response.decision === 'approved';
    });
  }

  // AskUserQuestion runs host-side and the engine never issues a question
  // reverse-RPC yet; store nothing and no-op. (Round 5 delegates this to host.)
  setQuestionHandler(): void {}

  // ── Resume / reload ────────────────────────────────────────────────────
  getResumeState(): ResumedSessionState | undefined {
    return this.resumeState;
  }

  async reloadSession(_options?: ReloadSessionOptions): Promise<ResumedSessionSummary> {
    // Engine-side reload restores persisted context + goal; the summary is
    // rebuilt from the local session metadata (agents stay empty — native
    // children are single-shot and not resumable).
    const found = await this.adapter.reloadSession();
    if (!found) {
      throw new Error('Session not found for reload');
    }
    const base = this.summary ?? {
      id: this.id,
      workDir: this.workDir,
      sessionDir: '',
      createdAt: 0,
      updatedAt: 0,
    };
    return {
      ...base,
      sessionMetadata: {
        createdAt: String(base.createdAt ?? 0),
        updatedAt: String(base.updatedAt ?? 0),
        title: base.title ?? this.id,
        isCustomTitle: false,
        ...(base.workDir !== undefined ? { workDir: base.workDir } : {}),
        agents: {},
        custom: {},
      },
      agents: {},
      warning: undefined,
    };
  }

  // ── Turn driving ────────────────────────────────────────────────────────
  async prompt(input: string | PromptInput): Promise<void> {
    // An active side-question routes prompts to the child agent.
    await this.adapter.prompt(promptText(input), this.btwAgentId ?? undefined);
  }

  async steer(input: string | PromptInput): Promise<void> {
    await this.adapter.steer(promptText(input));
  }

  // `Session.swarm` parity: enter swarm mode (one-shot task trigger) and run
  // the prompt; the run_prompt boundary auto-exits after the turn.
  async swarm(input: string | PromptInput): Promise<void> {
    await this.adapter.setSwarmMode(true, 'task');
    await this.prompt(input);
  }

  async cancel(): Promise<void> {
    await this.adapter.cancel();
  }

  // ── Shell ────────────────────────────────────────────────────────────────
  async runShellCommand(
    command: string,
    options?: { commandId?: string },
  ): Promise<{ stdout: string; stderr: string; isError?: boolean; backgrounded?: boolean }> {
    // Pass the commandId through so the engine streams `shell.output` events
    // for it. stderr is folded into stdout by the native runner, so it rides
    // on `stdout`.
    const r = await this.adapter.runShellCommand(command, undefined, options?.commandId);
    if (r.unavailable) {
      return { stdout: '', stderr: '', isError: true };
    }
    return { stdout: r.output ?? '', stderr: '', isError: r.isError };
  }

  // Cancel a streaming `!` shell command by its commandId.
  async cancelShellCommand(commandId: string): Promise<void> {
    await this.adapter.cancelShellCommand(commandId);
  }

  // ── Session-level actions ─────────────────────────────────────────────────
  async init(): Promise<void> {
    await this.adapter.init();
  }

  async getSessionWarnings(): Promise<readonly SessionWarning[]> {
    return this.adapter.getSessionWarnings();
  }

  async addAdditionalDir(
    path: string,
    options?: AddAdditionalDirOptions,
  ): Promise<AddAdditionalDirResult> {
    const dirs = await this.adapter.addAdditionalDir(path);
    const additionalDirs = dirs ?? [];
    if (this.summary !== undefined) {
      this.summary = { ...this.summary, additionalDirs };
    }
    return {
      additionalDirs,
      projectRoot: this.workDir,
      configPath: '',
      persisted: options?.persist ?? true,
    };
  }

  async startBtw(): Promise<string> {
    const btwId = await this.adapter.startBtw();
    if (btwId === null) {
      throw new Error('Side-question agent unavailable under the native engine.');
    }
    this.btwAgentId = btwId;
    return btwId;
  }

  /** End the active side-question conversation (prompts resume on main). */
  async endBtw(): Promise<void> {
    await this.adapter.endBtw();
    this.btwAgentId = null;
  }

  // ── Runtime mode / config ──────────────────────────────────────────────────
  async setModel(model: string): Promise<void> {
    await this.adapter.setModel(model);
  }

  async setThinking(effort: ThinkingEffort): Promise<void> {
    await this.adapter.setThinking(effort);
  }

  async setPermission(mode: PermissionMode): Promise<void> {
    await this.adapter.setPermission(mode);
  }

  async updateMetadata(patch: JsonObject): Promise<void> {
    const merged = await this.adapter.updateMetadata(patch as Record<string, unknown>);
    if (this.summary !== undefined && merged !== null) {
      this.summary = { ...this.summary, metadata: merged as JsonObject };
    }
  }

  /** /title: native sessions rename via the metadata patch (engine-owned). */
  async renameSession(title: string): Promise<void> {
    await this.updateMetadata({ title } as JsonObject);
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    // Rejects on re-enter (engine "Already in plan mode"), mirroring the SDK.
    await this.adapter.setPlanMode(enabled);
  }

  async setSwarmMode(enabled: boolean, trigger: SwarmModeTrigger): Promise<void> {
    await this.adapter.setSwarmMode(enabled, trigger);
  }

  // ── Plan (engine plan-file state machine) ─────────────────────────────────
  async getPlan(): Promise<SessionPlan> {
    const plan = await this.adapter.getPlan();
    if (plan === null) return null;
    return { id: plan.id, content: plan.content, path: plan.path };
  }

  async clearPlan(): Promise<void> {
    await this.adapter.clearPlan();
  }

  // ── Context ────────────────────────────────────────────────────────────────
  async compact(options: CompactOptions = {}): Promise<void> {
    await this.adapter.compact(options.instruction);
  }

  async cancelCompaction(): Promise<void> {}

  async undoHistory(count: number = 1): Promise<void> {
    // Rejects (propagates) when the engine cannot satisfy the count in full,
    // matching the SDK's throwing contract the TUI's undo command relies on.
    await this.adapter.undoHistory(count);
  }

  async clearContext(): Promise<void> {
    await this.adapter.clearContext();
  }

  async importContext(content: string, source: string): Promise<void> {
    await this.adapter.importContext(content, source);
  }

  async getContext(): Promise<AgentContextData> {
    const data = await this.adapter.getContext();
    if (data === null) {
      return { history: [], tokenCount: 0 };
    }
    return {
      history: data.history.map(mapContextMessage),
      tokenCount: data.token_count,
    };
  }

  // ── Status / usage ──────────────────────────────────────────────────────────
  async getUsage(): Promise<SessionUsage> {
    const usage = await this.adapter.getUsage();
    return mapUsage(usage) ?? {};
  }

  async getStatus(): Promise<SessionStatus> {
    const status = await this.adapter.getStatus();
    if (status === null) {
      throw new Error('Session status is unavailable.');
    }
    return mapStatus(status);
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  async listSkills(): Promise<readonly SkillSummary[]> {
    return (await this.adapter.listSkills()).map(mapSkill);
  }

  async activateSkill(name: string, args?: string): Promise<void> {
    await this.adapter.activateSkill(name, args);
  }

  // ── Plugin commands (model-facing) ─────────────────────────────────────────
  async listPluginCommands(): Promise<readonly PluginCommandDef[]> {
    // Aggregate command defs across installed plugins.
    const plugins = await this.adapter.listPlugins();
    const out: PluginCommandDef[] = [];
    for (const plugin of plugins) {
      const commands = await this.adapter.listPluginCommands(plugin.id);
      for (const command of commands) {
        out.push({
          pluginId: plugin.id,
          name: command.name,
          description: command.description,
          body: command.body,
          path: '',
        });
      }
    }
    return out;
  }

  async activatePluginCommand(
    pluginId: string,
    commandName: string,
    args?: string,
  ): Promise<void> {
    await this.adapter.activatePluginCommand(this.id, pluginId, commandName, args);
  }

  // ── Goal lifecycle ──────────────────────────────────────────────────────────
  async createGoal(input: CreateGoalInput): Promise<GoalSnapshot> {
    const snapshot = await this.adapter.createGoal({
      objective: input.objective,
      replace: input.replace,
    });
    return this.requireGoal(snapshot);
  }

  async getGoal(): Promise<GoalToolResult> {
    const { goal } = await this.adapter.getGoal();
    // The engine serializes `GoalSnapshot` camelCase (serde rename_all), so
    // the wire shape IS the SDK contract — no legacy snake→camel mapping.
    return { goal: goal as GoalSnapshot | null };
  }

  async pauseGoal(): Promise<GoalSnapshot> {
    return this.requireGoal(await this.adapter.pauseGoal());
  }

  async resumeGoal(): Promise<GoalSnapshot> {
    return this.requireGoal(await this.adapter.resumeGoal());
  }

  async cancelGoal(): Promise<GoalSnapshot> {
    return this.requireGoal(await this.adapter.cancelGoal());
  }

  private requireGoal(snapshot: unknown): GoalSnapshot {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new Error('No active goal.');
    }
    return snapshot as GoalSnapshot;
  }

  // ── Cron (engine-global CronManager) ──────────────────────────────────────
  async getCronTasks(): Promise<GetCronTasksResult> {
    const tasks = await this.adapter.getCronTasks();
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        cron: t.cron,
        recurring: t.recurring,
        createdAt: t.created_at,
        lastFiredAt: t.last_fired_at ?? undefined,
        nextFireAt: t.next_fire_at ?? null,
      })),
    };
  }

  // ── MCP ──────────────────────────────────────────────────────────────────
  async listMcpServers(): Promise<readonly McpServerInfo[]> {
    return (await this.adapter.listMcpServers()).map(mapMcpServer);
  }

  async getMcpStartupMetrics(): Promise<McpStartupMetrics> {
    const durationMs = await this.adapter.getMcpStartupMetrics();
    return { durationMs };
  }

  async reconnectMcpServer(name: string): Promise<void> {
    await this.adapter.reconnectMcpServer(name);
  }

  // ── Plugin management (host plugin registry; Round 5) ─────────────────────
  async listPlugins(): Promise<readonly PluginSummary[]> {
    const plugins = await this.adapter.listPlugins();
    return plugins.map(mapPluginSummary);
  }

  async installPlugin(source: string): Promise<PluginSummary> {
    const summary = await this.adapter.installPlugin(source);
    if (summary === null) {
      throw new Error('Plugin installation is unavailable');
    }
    return mapPluginSummary(summary);
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    await this.adapter.setPluginEnabled(id, enabled);
  }

  async setPluginMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    await this.adapter.setPluginMcpServerEnabled(id, server, enabled);
  }

  async removePlugin(id: string): Promise<void> {
    await this.adapter.removePlugin(id);
  }

  async reloadPlugins(): Promise<ReloadSummary> {
    await this.adapter.reloadPlugins();
    return { added: [], removed: [], errors: [] };
  }

  async getPluginInfo(id: string): Promise<PluginInfo> {
    const info = await this.adapter.getPluginInfo(id);
    if (info === null) {
      throw new Error(`Plugin not found: ${id}`);
    }
    return mapPluginInfo(info);
  }

  // ── Background tasks (engine-global BackgroundManager) ────────────────────
  // list/output/stop/detach ride bg/list, bg/output, bg/stop, bg/detach. `detachBackgroundTask`
  // still needs a `bg/detach` engine RPC (tracked separately).
  async listBackgroundTasks(
    options: { activeOnly?: boolean; limit?: number } = {},
  ): Promise<readonly BackgroundTaskInfo[]> {
    let tasks = (await this.adapter.listBackgroundTasks()).map(mapBackgroundTask);
    if (options.activeOnly === true) {
      tasks = tasks.filter((t) => ACTIVE_BG_STATUSES.has(String(t.status)));
    }
    if (typeof options.limit === 'number' && options.limit >= 0) {
      tasks = tasks.slice(0, options.limit);
    }
    return tasks;
  }

  async getBackgroundTaskOutput(taskId: string): Promise<string> {
    return this.adapter.getBackgroundTaskOutput(taskId);
  }

  async stopBackgroundTask(taskId: string, options?: { reason?: string }): Promise<void> {
    await this.adapter.stopBackgroundTask(taskId, options?.reason);
  }

  async detachBackgroundTask(taskId: string): Promise<BackgroundTaskInfo | undefined> {
    const raw = await this.adapter.detachBackgroundTask(taskId);
    return raw === null ? undefined : mapBackgroundTask(raw);
  }

  async waitForBackgroundTasksOnPrint(): Promise<void> {}

  handlePrintMainTurnCompleted(): Promise<'finish' | 'continue'> {
    return Promise.resolve('finish');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async close(): Promise<void> {
    await this.adapter.save();
  }
}

/**
 * Build a `TuiSession` over the native engine. Pass `resume` to restore a
 * persisted engine session: the engine loads its context + goal under the
 * resumed id (an active goal comes back paused), and the TUI receives a
 * replayable `ResumedSessionState` synthesized from the restored history so
 * `hydrateFromReplay` renders the transcript natively. Returns null when the
 * engine is unavailable (no stdio binary), so the caller falls back to the
 * harness.
 */
export async function createNativeTuiSession(
  rustLoop: NativeTuiRustLoop,
  init: NativeTuiSessionInit,
  resume?: { sessionId: string },
): Promise<NativeSession | null> {
  const sessionId = resume?.sessionId ?? init.sessionId;
  const adapter = new NativeSessionAdapter({
    createClient: (clientOptions) =>
      rustLoop.createSessionClient({
        sessionId: clientOptions.sessionId,
        systemPrompt: clientOptions.systemPrompt,
        model: clientOptions.model,
        goalEnabled: clientOptions.goalEnabled,
        homedir: clientOptions.homedir,
        nativeLlm: init.nativeLlm,
        mcpServers: init.mcpServers,
        hooks: init.hooks,
        permissionMode: clientOptions.permissionMode,
        onEvent: clientOptions.onEvent,
        lifecycle: clientOptions.lifecycle,
      }),
    engine: nativeEngineOpsFromRustLoop(rustLoop),
  });

  const started = await adapter.start({
    sessionId,
    systemPrompt: init.systemPrompt,
    model: init.model,
    goalEnabled: init.goalEnabled ?? true,
    homedir: init.homedir ?? init.workDir,
    nativeLlm: init.nativeLlm,
    // Interactive mode: `manual` so gated tools route to the host approval UI
    // wired via `setApprovalHandler`.
    permissionMode: init.permissionMode ?? 'manual',
  });
  if (!started) return null;

  let resumeState: ResumedSessionState | undefined;
  if (resume !== undefined) {
    const found = await adapter.reloadSession();
    // A resumed id that is not in the engine store is not this engine's
    // session — report unavailable so the caller falls back to the harness.
    if (!found) return null;
    resumeState = await buildResumedSessionState(adapter, {
      sessionId,
      workDir: init.workDir,
    });
  }

  return new NativeSession(adapter, { id: sessionId, workDir: init.workDir }, resumeState);
}

/**
 * List persisted engine sessions (SDK `listSessions` parity for the native
 * store). The engine records the workdir at session creation; pass `workDir`
 * to restrict to sessions created under that directory, or omit it to list
 * every persisted engine session (used by the picker's "all" scope).
 */
export async function listNativeSessions(
  rustLoop: NativeTuiRustLoop,
  workDir?: string,
): Promise<EngineSessionRecord[]> {
  const result = await rustLoop.sessionList(50, 0);
  const sessions = result?.sessions ?? [];
  const normalized = workDir === undefined ? undefined : resolve(workDir);
  return sessions
    .filter(
      (s) =>
        normalized === undefined ||
        (s.work_dir !== undefined && s.work_dir !== '' && resolve(s.work_dir) === normalized),
    )
    .toSorted((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

/** Build a replayable resume snapshot from the engine's restored state. */
async function buildResumedSessionState(
  adapter: NativeSessionAdapter,
  init: { sessionId: string; workDir: string },
): Promise<ResumedSessionState> {
  const [status, context, usage, plan, background] = await Promise.all([
    adapter.getStatus(),
    adapter.getContext(),
    adapter.getUsage(),
    adapter.getPlan(),
    adapter.listBackgroundTasks(),
  ]);
  const history = context === null ? [] : context.history.map(mapContextMessage);
  // The engine persists the context (not a record journal); replay records
  // are synthesized from it so the transcript renderer needs no new RPCs.
  const replay: AgentReplayRecord[] = history.map((message, index) => ({
    type: 'message',
    time: index,
    message,
  }));
  const now = Date.now();
  const main: ResumedAgentState = {
    type: 'main',
    config: {
      cwd: init.workDir,
      modelAlias: status?.model ?? undefined,
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: status?.max_context_tokens ?? 0,
      },
      thinkingEffort: status?.thinking_effort ?? 'off',
      systemPrompt: '',
    },
    context: { history, tokenCount: context?.token_count ?? 0 },
    replay,
    permission: { mode: (status?.permission ?? 'manual') as PermissionMode, rules: [] },
    plan: plan === null ? null : { id: plan.id, content: plan.content, path: plan.path },
    swarmMode: status?.swarm_mode ?? false,
    usage: mapUsage(usage) ?? {},
    tools: [],
    background: background.map(mapBackgroundTask),
  };
  return {
    sessionMetadata: {
      createdAt: String(now),
      updatedAt: String(now),
      title: init.sessionId,
      isCustomTitle: false,
      workDir: init.workDir,
      agents: {},
      custom: {},
    },
    agents: { main },
    warning: undefined,
  };
}
