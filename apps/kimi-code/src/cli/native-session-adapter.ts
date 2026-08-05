/**
 * native-session-adapter.ts — a session façade over the native Rust engine.
 *
 * This is the first slice of Track D (interactive adoption): it packages
 * {@link SessionEngineController} behind a small, host-facing surface that adds
 * the two things the controller lacks for interactive use — **dynamic**
 * `onEvent` (multiple listeners, subscribe/unsubscribe at any time) and
 * **dynamic** `setApprovalHandler` (set/replace after the session starts). The
 * TUI registers its event renderer and approval UI after `createSession`, so
 * these must be mutable post-start.
 *
 * Scope (deliberate): this backs the operations the engine's `session/*` and
 * `permission/*` RPCs support today — prompt, cancel, save, onEvent, approval,
 * permission mode. The full SDK `Session` surface (steer, runShellCommand,
 * setModel/setThinking, reloadSession, addAdditionalDir, swarm, …) needs new
 * engine RPCs + Agent features and is the tracked remainder before the TUI can
 * consume this in place of `harness.createSession`.
 *
 * Approval semantics: the adapter targets interactive/manual permission, where
 * a handler is set before prompting. When no handler is set, it allows (mirrors
 * the print pilot's `auto`); wire `permissionMode: 'manual'` + a handler for
 * real gating.
 */
import type { Event } from '@moonshot-ai/kimi-code-sdk';

import {
  SessionEngineController,
  type SessionClientFactory,
  type SessionEngineStartOptions,
  type SessionPromptOutcome,
  type ToolApprovalRequest,
} from '@moonshot-ai/kimi-code-sdk/rust';
import type {
  EngineMcpServerInfo,
  EnginePluginInfo,
  EnginePluginSummary,
  EngineSessionRecord,
  EngineSessionStatus,
  EngineSessionUsage,
  EngineSessionWarning,
  EngineSkillSummary,
} from '@moonshot-ai/kimi-code-sdk/rust';

// Engine wire shapes — single mirror in the SDK; re-exported so hosts that
// shaped their adapter signatures against these keep compiling unchanged.
export type {
  EngineMcpServerInfo,
  EnginePluginInfo,
  EnginePluginSummary,
  EngineSessionRecord,
  EngineSessionStatus,
  EngineSessionUsage,
  EngineSessionWarning,
  EngineSkillSummary,
} from '@moonshot-ai/kimi-code-sdk/rust';

export type NativePermissionMode = 'manual' | 'auto' | 'yolo';

/** A host approval decision callback: resolve true to allow, false to deny. */
export type NativeApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

/**
 * Session-scoped engine operations, shaped like the `rustLoop` session
 * functions (each takes the session id). Production wires this directly to
 * `rustLoop` (`sessionSetModel`/`sessionSetThinking`/`sessionRunShell`/
 * `sessionSetPermission`); tests pass a fake. The adapter supplies its own
 * session id at call time, so this can be injected before `start` resolves it.
 */
export interface SessionEngineOps {
  setModel?: (sessionId: string, model: string) => Promise<unknown>;
  setThinking?: (sessionId: string, effort: string | null) => Promise<unknown>;
  runShell?: (
    sessionId: string,
    command: string,
    timeoutS?: number,
    commandId?: string,
  ) => Promise<{ output: string | null; is_error: boolean; unavailable?: boolean } | null>;
  cancelShellCommand?: (
    sessionId: string,
    commandId: string,
  ) => Promise<{ cancelled: boolean } | null>;
  setPermissionMode?: (sessionId: string, mode: NativePermissionMode) => Promise<unknown>;
  steer?: (sessionId: string, input: { type: 'text'; text: string }[]) => Promise<unknown>;
  addAdditionalDir?: (sessionId: string, path: string) => Promise<{ success: boolean; additional_dirs: string[] } | null>;
  removeAdditionalDir?: (sessionId: string, path: string) => Promise<{ success: boolean; additional_dirs: string[] } | null>;
  updateMetadata?: (sessionId: string, metadata: Record<string, unknown>) => Promise<{ ok: boolean; metadata: Record<string, unknown> } | null>;
  goalCreate?: (
    sessionId: string,
    input: { objective: string; completionCriterion?: string; replace?: boolean },
  ) => Promise<EngineGoalSnapshot | null>;
  goalGet?: (sessionId: string) => Promise<{ goal: EngineGoalSnapshot | null } | null>;
  goalPause?: (sessionId: string, reason?: string) => Promise<EngineGoalSnapshot | null>;
  goalResume?: (sessionId: string, reason?: string) => Promise<EngineGoalSnapshot | null>;
  goalCancel?: (sessionId: string) => Promise<EngineGoalSnapshot | null>;
  setSwarmMode?: (
    sessionId: string,
    enabled: boolean,
    trigger?: 'manual' | 'task' | 'tool',
  ) => Promise<{ active: boolean } | null>;
  setPlanMode?: (sessionId: string, enabled: boolean) => Promise<{ plan_mode: boolean } | null>;
  getStatus?: (sessionId: string) => Promise<EngineSessionStatus | null>;
  listMcpServers?: (sessionId: string) => Promise<{ servers: EngineMcpServerInfo[] } | null>;
  listSkills?: (sessionId: string) => Promise<{ skills: EngineSkillSummary[] } | null>;
  getWarnings?: (sessionId: string) => Promise<{ warnings: EngineSessionWarning[] } | null>;
  getUsage?: (sessionId: string) => Promise<EngineSessionUsage | null>;
  compact?: (
    sessionId: string,
    instruction?: string,
  ) => Promise<{ compacted: boolean; summary?: string; tokens_before?: number; tokens_after?: number } | null>;
  getContext?: (sessionId: string) => Promise<EngineContextData | null>;
  clearContext?: (sessionId: string) => Promise<{ cleared: boolean } | null>;
  importContext?: (
    sessionId: string,
    content: string,
    source: string,
  ) => Promise<{ imported: boolean } | null>;
  undoHistory?: (
    sessionId: string,
    count: number,
  ) => Promise<{ undone_turns: number; cut_index: number | null } | null>;
  getPlan?: (sessionId: string) => Promise<EnginePlanInfo | null>;
  clearPlan?: (sessionId: string) => Promise<{ cleared: boolean } | null>;
  activateSkill?: (
    sessionId: string,
    name: string,
    args?: string,
  ) => Promise<{ stop_reason: string; steps: number } | null>;
  reconnectMcpServer?: (
    sessionId: string,
    name: string,
  ) => Promise<{ name: string; status: string; tool_count: number } | null>;
  getMcpStartupMetrics?: (sessionId: string) => Promise<{ duration_ms: number } | null>;
  /** Generate AGENTS.md via an init subagent (SDK `Session.init` parity). */
  init?: (sessionId: string) => Promise<{ ok: boolean } | null>;
  /** Process-global cron listing (SDK `getCronTasks`); session id ignored. */
  getCronTasks?: () => Promise<{ tasks: EngineCronTask[] } | null>;
  /** Process-global background-task output (SDK `getBackgroundTaskOutput`). */
  getBackgroundTaskOutput?: (taskId: string) => Promise<{ preview: string; error?: string } | null>;
  /** Process-global background-task stop (SDK `stopBackgroundTask`). */
  stopBackgroundTask?: (taskId: string, reason?: string) => Promise<{ ok: boolean } | null>;
  /** Process-global background-task listing (SDK `listBackgroundTasks`);
   *  returns the raw engine wire records (mapped to SDK by `NativeSession`). */
  listBackgroundTasks?: () => Promise<unknown[] | null>;
  /** Persisted engine sessions (SDK `listSessions` parity). */
  listSessions?: (
    limit?: number,
    offset?: number,
  ) => Promise<{ sessions: EngineSessionRecord[] } | null>;
  /** Installed-plugin summaries (SDK `listPlugins`). */
  listPlugins?: () => Promise<{ plugins: EnginePluginSummary[] } | null>;
  /** One installed plugin's detail (SDK `getPluginInfo`). */
  getPluginInfo?: (id: string) => Promise<EnginePluginInfo | null>;
  /** Install a plugin from a source (SDK `installPlugin`). */
  installPlugin?: (source: string) => Promise<EnginePluginSummary | null>;
  /** Enable or disable an installed plugin (SDK `setPluginEnabled`). */
  setPluginEnabled?: (id: string, enabled: boolean) => Promise<EnginePluginSummary | null>;
  /** Toggle one of a plugin's MCP servers (SDK `setPluginMcpServerEnabled`). */
  setPluginMcpServerEnabled?: (
    id: string,
    server: string,
    enabled: boolean,
  ) => Promise<EnginePluginInfo | null>;
  /** Remove an installed plugin (SDK `removePlugin`). */
  removePlugin?: (id: string) => Promise<{ removed: boolean } | null>;
  /** Reload plugins from disk (SDK `reloadPlugins`). */
  reloadPlugins?: () => Promise<{ ok: boolean } | null>;
  /** List a plugin's slash-style commands (SDK `listPluginCommands`). */
  listPluginCommands?: (pluginId: string) => Promise<EnginePluginCommand[]>;
  /** Activate a plugin command (SDK `activatePluginCommand`). */
  activatePluginCommand?: (
    sessionId: string,
    pluginId: string,
    commandName: string,
    args?: string,
  ) => Promise<unknown>;
  /** Detach a background task from its foreground tool call (SDK
   *  `detachBackgroundTask`); returns the raw engine wire record or null. */
  detachBackgroundTask?: (taskId: string) => Promise<Record<string, unknown> | null>;
}

/** Engine cron task wire shape (serde snake_case; SDK `CronTaskSnapshot`). */
export interface EngineCronTask {
  id: string;
  cron: string;
  recurring: boolean;
  created_at: number;
  last_fired_at?: number | null;
  next_fire_at?: number | null;
}

/** Engine plan info wire shape (SDK `PlanInfo` parity). */
export interface EnginePlanInfo {
  id: string;
  content: string;
  path: string;
}

/** Engine plugin slash-style command wire shape (SDK `PluginCommandDef` parity). */
export interface EnginePluginCommand {
  plugin_id: string;
  name: string;
  description: string;
  body: string;
}

/** Engine context snapshot wire shape (serde snake_case; messages stay
 *  snake_case and are mapped to the SDK shape by the higher `NativeSession`). */
export interface EngineContextData {
  history: Array<Record<string, unknown>>;
  token_count: number;
}

/** The engine's goal snapshot wire shape (serde form of `GoalSnapshot`). */
export interface EngineGoalSnapshot {
  goal_id: string;
  objective: string;
  status: string;
  [key: string]: unknown;
}

export interface NativeSessionAdapterOptions {
  /** Real: `rustLoop.createSessionClient`; a fake in tests. */
  readonly createClient: SessionClientFactory;
  /**
   * Session-scoped engine ops (production: `rustLoop`). Preferred over the
   * pre-bound setters below; called with this adapter's session id.
   */
  readonly engine?: SessionEngineOps;
  /**
   * Optional runtime permission-mode setter (engine `permission/set_mode`).
   * When omitted, `setPermission` is a no-op (mode is fixed at `start`).
   */
  readonly setPermissionMode?: (mode: NativePermissionMode) => Promise<void>;
  /**
   * Optional runtime model setter (engine `session/set_model`). Bound to the
   * session id by the caller. When omitted, `setModel` is a no-op.
   */
  readonly setModel?: (model: string) => Promise<void>;
  /**
   * Optional runtime reasoning-effort setter (engine `session/set_thinking`),
   * bound to the session id. When omitted, `setThinking` is a no-op.
   */
  readonly setThinking?: (effort: string | null) => Promise<void>;
  /**
   * Optional native `!` shell runner (engine `session/run_shell`), bound to the
   * session id. When omitted, `runShellCommand` reports unavailable so the host
   * runs it instead.
   */
  readonly runShell?: (
    command: string,
    timeoutS?: number,
  ) => Promise<{ output: string | null; isError: boolean; unavailable?: boolean }>;
  /** Optional tap on raw engine wire events (e.g. `session.goal.updated`). */
  readonly onRawEvent?: (event: unknown) => void;
  readonly agentId?: string;
}

/**
 * A session handle over the native engine with dynamic event/approval wiring.
 * Not (yet) a drop-in for the SDK `Session` — see the file header for the
 * remaining surface. Intended to be consumed by the interactive integration
 * layer once the engine RPC gaps are filled.
 */
export class NativeSessionAdapter {
  private readonly controller: SessionEngineController;
  private readonly listeners = new Set<(event: Event) => void>();
  private approvalHandler: NativeApprovalHandler | undefined;

  constructor(private readonly options: NativeSessionAdapterOptions) {
    this.controller = new SessionEngineController({
      createClient: options.createClient,
      emitEvent: (event) => {
        // Fan out to every current listener; a throwing listener must not
        // starve the others or the engine event pump.
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch {
            // Ignore a misbehaving renderer; keep delivering.
          }
        }
      },
      onRawEvent: options.onRawEvent,
      // Always provide an approver so manual-mode gating reaches the host; the
      // delegate reads the current handler (or allows when none is set).
      requestApproval: (request) =>
        this.approvalHandler === undefined
          ? Promise.resolve(true)
          : this.approvalHandler(request),
      agentId: options.agentId,
    });
  }

  /** Create the engine session and wire the sinks. False → engine unavailable. */
  start(init: SessionEngineStartOptions): Promise<boolean> {
    return this.controller.start(init);
  }

  get sessionId(): string | undefined {
    return this.controller.sessionId;
  }

  get isStarted(): boolean {
    return this.controller.isStarted;
  }

  /** Subscribe to translated SDK events; returns an unsubscribe function. */
  onEvent(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Set or clear the tool-approval handler (manual permission mode). */
  setApprovalHandler(handler: NativeApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  /** Run one prompt; goal continuations run inside the engine. */
  prompt(text: string, agentId?: string): Promise<SessionPromptOutcome | null> {
    return this.controller.prompt(text, agentId);
  }

  /** Spawn a side-question subagent; returns its id (`btw-<sessionId>`). */
  startBtw(): Promise<string | null> {
    return this.controller.startBtw();
  }

  /** Destroy the active side-question subagent. */
  endBtw(): Promise<boolean> {
    return this.controller.endBtw();
  }

  /** Stop the running prompt at the next step boundary. */
  cancel(): Promise<boolean> {
    return this.controller.cancel();
  }

  /** Persist context + goal under this session id. */
  save(): Promise<boolean> {
    return this.controller.save();
  }

  /**
   * Restore persisted context + goal via the engine's `session/load` (an active
   * goal comes back paused). Named `reloadSession` to match the SDK `Session`
   * surface the TUI expects.
   */
  reloadSession(): Promise<boolean> {
    return this.controller.load();
  }

  /** Change the engine's permission mode at runtime (no-op without a setter). */
  async setPermission(mode: NativePermissionMode): Promise<void> {
    const id = this.controller.sessionId;
    if (this.options.engine?.setPermissionMode !== undefined && id !== undefined) {
      await this.options.engine.setPermissionMode(id, mode);
      return;
    }
    await this.options.setPermissionMode?.(mode);
  }

  /** Switch the session's model from the next turn (no-op without a setter). */
  async setModel(model: string): Promise<void> {
    const id = this.controller.sessionId;
    if (this.options.engine?.setModel !== undefined && id !== undefined) {
      await this.options.engine.setModel(id, model);
      return;
    }
    await this.options.setModel?.(model);
  }

  /** Set reasoning effort from the next turn (no-op without a setter). */
  async setThinking(effort: string | null): Promise<void> {
    const id = this.controller.sessionId;
    if (this.options.engine?.setThinking !== undefined && id !== undefined) {
      await this.options.engine.setThinking(id, effort);
      return;
    }
    await this.options.setThinking?.(effort);
  }

  /**
   * Queue steer input; the engine drains it at the start of the next turn
   * (including a goal-continuation turn). No-op without an engine steer op.
   */
  async steer(text: string): Promise<void> {
    const id = this.controller.sessionId;
    if (this.options.engine?.steer !== undefined && id !== undefined) {
      await this.options.engine.steer(id, [{ type: 'text', text }]);
    }
  }

  /**
   * Run a user-initiated `!` shell command natively. Returns the combined
   * output and an error flag; `unavailable` true means no native runner is
   * wired (or the engine has no shell) — the caller should run it on the host.
   */
  async runShellCommand(
    command: string,
    timeoutS?: number,
    commandId?: string,
  ): Promise<{ output: string | null; isError: boolean; unavailable: boolean }> {
    const id = this.controller.sessionId;
    if (this.options.engine?.runShell !== undefined && id !== undefined) {
      const r = await this.options.engine.runShell(id, command, timeoutS, commandId);
      if (r === null) return { output: null, isError: false, unavailable: true };
      return { output: r.output, isError: r.is_error, unavailable: r.unavailable ?? false };
    }
    if (this.options.runShell === undefined) {
      return { output: null, isError: false, unavailable: true };
    }
    const result = await this.options.runShell(command, timeoutS);
    return { output: result.output, isError: result.isError, unavailable: result.unavailable ?? false };
  }

  /** Cancel a streaming `!` shell command by its commandId. */
  async cancelShellCommand(commandId: string): Promise<void> {
    const id = this.controller.sessionId;
    if (this.options.engine?.cancelShellCommand === undefined || id === undefined) return;
    await this.options.engine.cancelShellCommand(id, commandId);
  }

  /**
   * Add an additional directory to the session's workspace allowlist.
   * Returns the updated list of additional dirs, or null if the engine is
   * unavailable or the path is invalid.
   */
  async addAdditionalDir(path: string): Promise<string[] | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.addAdditionalDir !== undefined && id !== undefined) {
      const r = await this.options.engine.addAdditionalDir(id, path);
      if (r === null) return null;
      return r.success ? r.additional_dirs : null;
    }
    return null;
  }

  /**
   * Remove an additional directory from the session's workspace allowlist.
   * Returns the updated list of additional dirs, or null if the engine is
   * unavailable or the dir was not in the list.
   */
  async removeAdditionalDir(path: string): Promise<string[] | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.removeAdditionalDir !== undefined && id !== undefined) {
      const r = await this.options.engine.removeAdditionalDir(id, path);
      if (r === null) return null;
      return r.success ? r.additional_dirs : null;
    }
    return null;
  }

  /**
   * Shallow-merge a JSON object into the session's custom metadata.
   * Returns the merged metadata, or null if the engine is unavailable.
   */
  async updateMetadata(patch: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.updateMetadata !== undefined && id !== undefined) {
      const r = await this.options.engine.updateMetadata(id, patch);
      if (r === null) return null;
      return r.metadata;
    }
    return null;
  }

  // ── Goal lifecycle (SDK `Session` parity: createGoal/getGoal/…) ─────────
  // Each op forwards to the engine's `session/goal_*` RPC; a missing op or
  // unstarted session yields null so callers can fall back gracefully.

  /** Create (or with `replace` swap) the session goal as the user. */
  async createGoal(input: {
    objective: string;
    completionCriterion?: string;
    replace?: boolean;
  }): Promise<EngineGoalSnapshot | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.goalCreate === undefined || id === undefined) return null;
    return this.options.engine.goalCreate(id, input);
  }

  /** The current goal record (`{ goal: null }` when none). */
  async getGoal(): Promise<{ goal: EngineGoalSnapshot | null }> {
    const id = this.controller.sessionId;
    if (this.options.engine?.goalGet === undefined || id === undefined) return { goal: null };
    return (await this.options.engine.goalGet(id)) ?? { goal: null };
  }

  /** Pause the active goal as the user. */
  async pauseGoal(reason?: string): Promise<EngineGoalSnapshot | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.goalPause === undefined || id === undefined) return null;
    return this.options.engine.goalPause(id, reason);
  }

  /** Resume a paused goal as the user. */
  async resumeGoal(reason?: string): Promise<EngineGoalSnapshot | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.goalResume === undefined || id === undefined) return null;
    return this.options.engine.goalResume(id, reason);
  }

  /** Cancel the goal as the user. */
  async cancelGoal(): Promise<EngineGoalSnapshot | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.goalCancel === undefined || id === undefined) return null;
    return this.options.engine.goalCancel(id);
  }

  /**
   * Toggle swarm mode (SDK `setSwarmMode` parity). Returns whether the mode
   * is active afterwards, or null when the engine op is unavailable.
   */
  async setSwarmMode(
    enabled: boolean,
    trigger?: 'manual' | 'task' | 'tool',
  ): Promise<boolean | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.setSwarmMode === undefined || id === undefined) return null;
    const r = await this.options.engine.setSwarmMode(id, enabled, trigger);
    return r === null ? null : r.active;
  }

  /**
   * Toggle plan mode (SDK `setPlanMode` parity). Returns the plan-mode state
   * afterwards, or null when the engine op is unavailable. Rejects (propagates)
   * when re-entering an already-active plan mode.
   */
  async setPlanMode(enabled: boolean): Promise<boolean | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.setPlanMode === undefined || id === undefined) return null;
    const r = await this.options.engine.setPlanMode(id, enabled);
    return r === null ? null : r.plan_mode;
  }

  /**
   * Live session status snapshot (SDK `getStatus` parity). Null when the
   * engine op is unavailable — the caller keeps its own state then.
   */
  async getStatus(): Promise<EngineSessionStatus | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.getStatus === undefined || id === undefined) return null;
    return this.options.engine.getStatus(id);
  }

  /** Per-server MCP views (SDK `listMcpServers` parity); [] when unavailable. */
  async listMcpServers(): Promise<EngineMcpServerInfo[]> {
    const id = this.controller.sessionId;
    if (this.options.engine?.listMcpServers === undefined || id === undefined) return [];
    const r = await this.options.engine.listMcpServers(id);
    return r?.servers ?? [];
  }

  /** Registered skills (SDK `listSkills` parity); [] when unavailable. */
  async listSkills(): Promise<EngineSkillSummary[]> {
    const id = this.controller.sessionId;
    if (this.options.engine?.listSkills === undefined || id === undefined) return [];
    const r = await this.options.engine.listSkills(id);
    return r?.skills ?? [];
  }

  /** Session warnings (SDK `getSessionWarnings` parity); [] when unavailable. */
  async getSessionWarnings(): Promise<EngineSessionWarning[]> {
    const id = this.controller.sessionId;
    if (this.options.engine?.getWarnings === undefined || id === undefined) return [];
    const r = await this.options.engine.getWarnings(id);
    return r?.warnings ?? [];
  }

  /** Cumulative usage snapshot (SDK `getUsage` parity); null when unavailable. */
  async getUsage(): Promise<EngineSessionUsage | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.getUsage === undefined || id === undefined) return null;
    return this.options.engine.getUsage(id);
  }

  /**
   * Manually compact the context (SDK `compact` parity). Resolves to the
   * engine's report ({ compacted, summary, … }), or null when the engine op
   * is unavailable. Rejects (propagates) when the engine has no summarizer.
   */
  async compact(
    instruction?: string,
  ): Promise<{ compacted: boolean; summary?: string; tokens_before?: number; tokens_after?: number } | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.compact === undefined || id === undefined) return null;
    return this.options.engine.compact(id, instruction);
  }

  /** Full context snapshot (SDK `getContext` parity); null when unavailable. */
  async getContext(): Promise<EngineContextData | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.getContext === undefined || id === undefined) return null;
    return this.options.engine.getContext(id);
  }

  /** Clear the session's model context (SDK `clearContext` parity). */
  async clearContext(): Promise<boolean> {
    const id = this.controller.sessionId;
    if (this.options.engine?.clearContext === undefined || id === undefined) return false;
    const r = await this.options.engine.clearContext(id);
    return r?.cleared ?? false;
  }

  /** Append imported transcript text (SDK `importContext` parity). */
  async importContext(content: string, source: string): Promise<boolean> {
    const id = this.controller.sessionId;
    if (this.options.engine?.importContext === undefined || id === undefined) return false;
    const r = await this.options.engine.importContext(id, content, source);
    return r?.imported ?? false;
  }

  /**
   * Undo the last `count` user turns (SDK `undoHistory` parity). Rejects
   * (propagates) when the count is not fully available.
   */
  async undoHistory(count: number): Promise<void> {
    const id = this.controller.sessionId;
    if (this.options.engine?.undoHistory === undefined || id === undefined) return;
    await this.options.engine.undoHistory(id, count);
  }

  /** Active plan snapshot (SDK `getPlan` parity); null when no plan / unavailable. */
  async getPlan(): Promise<EnginePlanInfo | null> {
    const id = this.controller.sessionId;
    if (this.options.engine?.getPlan === undefined || id === undefined) return null;
    return this.options.engine.getPlan(id);
  }

  /** Clear the active plan's file content (SDK `clearPlan` parity). */
  async clearPlan(): Promise<void> {
    const id = this.controller.sessionId;
    if (this.options.engine?.clearPlan === undefined || id === undefined) return;
    await this.options.engine.clearPlan(id);
  }

  /**
   * Activate a skill (SDK `activateSkill` parity): the engine renders the skill
   * prompt and runs a turn. The turn's progress arrives via events; this
   * resolves when the turn completes.
   */
  async activateSkill(name: string, args?: string): Promise<void> {
    const id = this.controller.sessionId;
    if (this.options.engine?.activateSkill === undefined || id === undefined) return;
    await this.options.engine.activateSkill(id, name, args);
  }

  /** Reconnect a single MCP server (SDK `reconnectMcpServer` parity). */
  async reconnectMcpServer(name: string): Promise<void> {
    const id = this.controller.sessionId;
    if (this.options.engine?.reconnectMcpServer === undefined || id === undefined) return;
    await this.options.engine.reconnectMcpServer(id, name);
  }

  /** MCP startup connect duration in ms (SDK `getMcpStartupMetrics` parity). */
  async getMcpStartupMetrics(): Promise<number> {
    const id = this.controller.sessionId;
    if (this.options.engine?.getMcpStartupMetrics === undefined || id === undefined) return 0;
    const r = await this.options.engine.getMcpStartupMetrics(id);
    return r?.duration_ms ?? 0;
  }

  /** Generate AGENTS.md via an init subagent (SDK `Session.init` parity). */
  async init(): Promise<void> {
    const id = this.controller.sessionId;
    if (this.options.engine?.init === undefined || id === undefined) return;
    await this.options.engine.init(id);
  }

  /** Process-global cron listing (SDK `getCronTasks` parity); [] when unavailable. */
  async getCronTasks(): Promise<EngineCronTask[]> {
    if (this.options.engine?.getCronTasks === undefined) return [];
    const r = await this.options.engine.getCronTasks();
    return r?.tasks ?? [];
  }

  /** Background-task captured output (SDK `getBackgroundTaskOutput` parity). */
  async getBackgroundTaskOutput(taskId: string): Promise<string> {
    if (this.options.engine?.getBackgroundTaskOutput === undefined) return '';
    const r = await this.options.engine.getBackgroundTaskOutput(taskId);
    return r?.preview ?? '';
  }

  /** Request a background task to stop (SDK `stopBackgroundTask` parity). */
  async stopBackgroundTask(taskId: string, reason?: string): Promise<void> {
    if (this.options.engine?.stopBackgroundTask === undefined) return;
    await this.options.engine.stopBackgroundTask(taskId, reason);
  }

  /** Raw background-task wire records (SDK `listBackgroundTasks` parity); the
   *  higher `NativeSession` maps them onto the SDK union. */
  async listBackgroundTasks(): Promise<unknown[]> {
    if (this.options.engine?.listBackgroundTasks === undefined) return [];
    return (await this.options.engine.listBackgroundTasks()) ?? [];
  }

  /** Persisted engine sessions (SDK `listSessions` parity); [] when
   *  unavailable. Workdir filtering happens at the caller. */
  async listSessions(): Promise<EngineSessionRecord[]> {
    if (this.options.engine?.listSessions === undefined) return [];
    return (await this.options.engine.listSessions())?.sessions ?? [];
  }

  /** Installed-plugin summaries (SDK `listPlugins` parity). */
  async listPlugins(): Promise<EnginePluginSummary[]> {
    if (this.options.engine?.listPlugins === undefined) return [];
    return (await this.options.engine.listPlugins())?.plugins ?? [];
  }

  /** One installed plugin's detail (SDK `getPluginInfo` parity); null if unknown. */
  async getPluginInfo(id: string): Promise<EnginePluginInfo | null> {
    if (this.options.engine?.getPluginInfo === undefined) return null;
    return this.options.engine.getPluginInfo(id);
  }

  /** Install a plugin from a source (SDK `installPlugin` parity). */
  async installPlugin(source: string): Promise<EnginePluginSummary | null> {
    if (this.options.engine?.installPlugin === undefined) return null;
    return this.options.engine.installPlugin(source);
  }

  /** Enable or disable an installed plugin (SDK `setPluginEnabled` parity). */
  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    if (this.options.engine?.setPluginEnabled === undefined) return;
    await this.options.engine.setPluginEnabled(id, enabled);
  }

  /** Toggle one of a plugin's MCP servers (SDK `setPluginMcpServerEnabled` parity). */
  async setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    if (this.options.engine?.setPluginMcpServerEnabled === undefined) return;
    await this.options.engine.setPluginMcpServerEnabled(id, server, enabled);
  }

  /** Remove an installed plugin (SDK `removePlugin` parity). */
  async removePlugin(id: string): Promise<boolean> {
    if (this.options.engine?.removePlugin === undefined) return false;
    return (await this.options.engine.removePlugin(id))?.removed ?? false;
  }

  /** Reload plugins from disk (SDK `reloadPlugins` parity). */
  async reloadPlugins(): Promise<void> {
    if (this.options.engine?.reloadPlugins === undefined) return;
    await this.options.engine.reloadPlugins();
  }

  /** List a plugin's slash-style commands (SDK `listPluginCommands` parity). */
  async listPluginCommands(pluginId: string): Promise<EnginePluginCommand[]> {
    if (this.options.engine?.listPluginCommands === undefined) return [];
    return this.options.engine.listPluginCommands(pluginId);
  }

  /** Activate a plugin command (SDK `activatePluginCommand` parity). */
  async activatePluginCommand(
    sessionId: string,
    pluginId: string,
    commandName: string,
    args?: string,
  ): Promise<void> {
    if (this.options.engine?.activatePluginCommand === undefined) return;
    await this.options.engine.activatePluginCommand(sessionId, pluginId, commandName, args);
  }

  /** Detach a background task (SDK `detachBackgroundTask` parity); returns the
   *  raw engine wire record (mapped by `NativeSession`) or null. */
  async detachBackgroundTask(taskId: string): Promise<Record<string, unknown> | null> {
    if (this.options.engine?.detachBackgroundTask === undefined) return null;
    return this.options.engine.detachBackgroundTask(taskId);
  }
}

/**
 * The subset of the `@moonshot-ai/kimi-agent/rust-loop` module the adapter's
 * engine ops bind to. Declared structurally so callers can pass the real module
 * (or a fake in tests) without a hard import cycle.
 */
export interface RustLoopSessionApi {
  sessionSetModel(sessionId: string, model: string): Promise<unknown>;
  sessionSetThinking(sessionId: string, effort: string | null): Promise<unknown>;
  sessionRunShell(
    sessionId: string,
    command: string,
    timeoutS?: number,
    commandId?: string,
  ): Promise<{ output: string | null; is_error: boolean; unavailable?: boolean } | null>;
  sessionCancelShellCommand(
    sessionId: string,
    commandId: string,
  ): Promise<{ cancelled: boolean } | null>;
  sessionSteer(sessionId: string, input: { type: 'text'; text: string }[]): Promise<unknown>;
  sessionAddAdditionalDir(
    sessionId: string,
    path: string,
  ): Promise<{ success: boolean; additional_dirs: string[] } | null>;
  sessionRemoveAdditionalDir(
    sessionId: string,
    path: string,
  ): Promise<{ success: boolean; additional_dirs: string[] } | null>;
  sessionUpdateMetadata(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<{ ok: boolean; metadata: Record<string, unknown> } | null>;
  sessionGoalCreate(
    sessionId: string,
    input: { objective: string; completionCriterion?: string; replace?: boolean },
  ): Promise<EngineGoalSnapshot | null>;
  sessionGoalGet(sessionId: string): Promise<{ goal: EngineGoalSnapshot | null } | null>;
  sessionGoalPause(sessionId: string, reason?: string): Promise<EngineGoalSnapshot | null>;
  sessionGoalResume(sessionId: string, reason?: string): Promise<EngineGoalSnapshot | null>;
  sessionGoalCancel(sessionId: string): Promise<EngineGoalSnapshot | null>;
  sessionSetSwarmMode(
    sessionId: string,
    enabled: boolean,
    trigger?: 'manual' | 'task' | 'tool',
  ): Promise<{ active: boolean } | null>;
  sessionSetPlanMode(sessionId: string, enabled: boolean): Promise<{ plan_mode: boolean } | null>;
  sessionGetStatus(sessionId: string): Promise<EngineSessionStatus | null>;
  sessionListMcpServers(
    sessionId: string,
  ): Promise<{ servers: EngineMcpServerInfo[] } | null>;
  sessionListSkills(sessionId: string): Promise<{ skills: EngineSkillSummary[] } | null>;
  sessionGetWarnings(sessionId: string): Promise<{ warnings: EngineSessionWarning[] } | null>;
  sessionGetUsage(sessionId: string): Promise<EngineSessionUsage | null>;
  sessionCompact(
    sessionId: string,
    instruction?: string,
  ): Promise<{ compacted: boolean; summary?: string; tokens_before?: number; tokens_after?: number } | null>;
  sessionGetContext(sessionId: string): Promise<EngineContextData | null>;
  sessionClearContext(sessionId: string): Promise<{ cleared: boolean } | null>;
  sessionImportContext(
    sessionId: string,
    content: string,
    source: string,
  ): Promise<{ imported: boolean } | null>;
  sessionUndoHistory(
    sessionId: string,
    count: number,
  ): Promise<{ undone_turns: number; cut_index: number | null } | null>;
  sessionGetPlan(sessionId: string): Promise<EnginePlanInfo | null>;
  sessionClearPlan(sessionId: string): Promise<{ cleared: boolean } | null>;
  sessionActivateSkill(
    sessionId: string,
    name: string,
    args?: string,
  ): Promise<{ stop_reason: string; steps: number } | null>;
  sessionReconnectMcpServer(
    sessionId: string,
    name: string,
  ): Promise<{ name: string; status: string; tool_count: number } | null>;
  sessionGetMcpStartupMetrics(sessionId: string): Promise<{ duration_ms: number } | null>;
  sessionInit(sessionId: string): Promise<{ ok: boolean } | null>;
  cronList(): Promise<{ tasks: EngineCronTask[] } | null>;
  bgOutput(taskId: string): Promise<{ preview: string; error?: string } | null>;
  bgStop(taskId: string, reason?: string): Promise<{ ok: boolean } | null>;
  bgList(): Promise<unknown[] | null>;
  /** Persisted engine sessions (SDK `listSessions` parity). */
  sessionList(limit?: number, offset?: number): Promise<{ sessions: EngineSessionRecord[] } | null>;
  pluginList(): Promise<{ plugins: EnginePluginSummary[] } | null>;
  pluginGet(id: string): Promise<EnginePluginInfo | null>;
  pluginInstall(source: string): Promise<EnginePluginSummary | null>;
  pluginSetEnabled(id: string, enabled: boolean): Promise<EnginePluginSummary | null>;
  pluginSetMcpEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<EnginePluginInfo | null>;
  pluginRemove(id: string): Promise<{ removed: boolean } | null>;
  pluginReload(): Promise<{ ok: boolean } | null>;
  pluginListCommands(id: string): Promise<{ commands: EnginePluginCommand[] } | null>;
  pluginActivateCommand(input: {
    sessionId: string;
    pluginId: string;
    commandName: string;
    args?: string;
  }): Promise<{ accepted: boolean } | null>;
  bgDetach(taskId: string): Promise<Record<string, unknown> | null>;
  permissionSetMode(mode: NativePermissionMode): Promise<unknown>;
}

/**
 * Bind a `SessionEngineOps` to the real rust-loop session functions. This is
 * the production wiring: each op forwards the adapter's session id (permission
 * is process-wide, so its op ignores the id and drives the shared gate). Pass
 * the result as `NativeSessionAdapterOptions.engine`.
 */
export function nativeEngineOpsFromRustLoop(rustLoop: RustLoopSessionApi): SessionEngineOps {
  return {
    setModel: (sessionId, model) => rustLoop.sessionSetModel(sessionId, model),
    setThinking: (sessionId, effort) => rustLoop.sessionSetThinking(sessionId, effort),
    runShell: (sessionId, command, timeoutS, commandId) =>
      rustLoop.sessionRunShell(sessionId, command, timeoutS, commandId),
    cancelShellCommand: (sessionId, commandId) =>
      rustLoop.sessionCancelShellCommand(sessionId, commandId),
    steer: (sessionId, input) => rustLoop.sessionSteer(sessionId, input),
    addAdditionalDir: (sessionId, path) => rustLoop.sessionAddAdditionalDir(sessionId, path),
    removeAdditionalDir: (sessionId, path) => rustLoop.sessionRemoveAdditionalDir(sessionId, path),
    updateMetadata: (sessionId, metadata) => rustLoop.sessionUpdateMetadata(sessionId, metadata),
    goalCreate: (sessionId, input) => rustLoop.sessionGoalCreate(sessionId, input),
    goalGet: (sessionId) => rustLoop.sessionGoalGet(sessionId),
    goalPause: (sessionId, reason) => rustLoop.sessionGoalPause(sessionId, reason),
    goalResume: (sessionId, reason) => rustLoop.sessionGoalResume(sessionId, reason),
    goalCancel: (sessionId) => rustLoop.sessionGoalCancel(sessionId),
    setSwarmMode: (sessionId, enabled, trigger) =>
      rustLoop.sessionSetSwarmMode(sessionId, enabled, trigger),
    setPlanMode: (sessionId, enabled) => rustLoop.sessionSetPlanMode(sessionId, enabled),
    getStatus: (sessionId) => rustLoop.sessionGetStatus(sessionId),
    listMcpServers: (sessionId) => rustLoop.sessionListMcpServers(sessionId),
    listSkills: (sessionId) => rustLoop.sessionListSkills(sessionId),
    getWarnings: (sessionId) => rustLoop.sessionGetWarnings(sessionId),
    getUsage: (sessionId) => rustLoop.sessionGetUsage(sessionId),
    compact: (sessionId, instruction) => rustLoop.sessionCompact(sessionId, instruction),
    getContext: (sessionId) => rustLoop.sessionGetContext(sessionId),
    clearContext: (sessionId) => rustLoop.sessionClearContext(sessionId),
    importContext: (sessionId, content, source) =>
      rustLoop.sessionImportContext(sessionId, content, source),
    undoHistory: (sessionId, count) => rustLoop.sessionUndoHistory(sessionId, count),
    getPlan: (sessionId) => rustLoop.sessionGetPlan(sessionId),
    clearPlan: (sessionId) => rustLoop.sessionClearPlan(sessionId),
    activateSkill: (sessionId, name, args) =>
      rustLoop.sessionActivateSkill(sessionId, name, args),
    reconnectMcpServer: (sessionId, name) =>
      rustLoop.sessionReconnectMcpServer(sessionId, name),
    getMcpStartupMetrics: (sessionId) => rustLoop.sessionGetMcpStartupMetrics(sessionId),
    init: (sessionId) => rustLoop.sessionInit(sessionId),
    getCronTasks: () => rustLoop.cronList(),
    getBackgroundTaskOutput: (taskId) => rustLoop.bgOutput(taskId),
    stopBackgroundTask: (taskId, reason) => rustLoop.bgStop(taskId, reason),
    listBackgroundTasks: () => rustLoop.bgList(),
    listSessions: (limit, offset) => rustLoop.sessionList(limit, offset),
    listPlugins: () => rustLoop.pluginList(),
    getPluginInfo: (id) => rustLoop.pluginGet(id),
    installPlugin: (source) => rustLoop.pluginInstall(source),
    setPluginEnabled: (id, enabled) => rustLoop.pluginSetEnabled(id, enabled),
    setPluginMcpServerEnabled: (id, server, enabled) =>
      rustLoop.pluginSetMcpEnabled(id, server, enabled),
    removePlugin: (id) => rustLoop.pluginRemove(id),
    reloadPlugins: () => rustLoop.pluginReload(),
    listPluginCommands: (pluginId) =>
      rustLoop.pluginListCommands(pluginId).then((r) => r?.commands ?? []),
    activatePluginCommand: (sessionId, pluginId, commandName, args) =>
      rustLoop.pluginActivateCommand({ sessionId, pluginId, commandName, args }),
    detachBackgroundTask: (taskId) => rustLoop.bgDetach(taskId),
    // Permission mode is a process-wide gate; the session id is not part of the
    // engine RPC, so it is ignored here.
    setPermissionMode: (_sessionId, mode) => rustLoop.permissionSetMode(mode),
  };
}
