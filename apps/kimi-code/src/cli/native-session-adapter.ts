/**
 * native-session-adapter.ts — a session façade over `kimi-server-serve`.
 *
 * This is the first slice of Track D (interactive adoption): it packages the
 * pull-style engine RPC surface behind a small, host-facing surface with
 * **dynamic** `onEvent` (multiple listeners, subscribe/unsubscribe at any
 * time) and **dynamic** `setApprovalHandler` (set/replace after the session
 * starts). The TUI registers its event renderer and approval UI after
 * `createSession`, so these must be mutable post-start.
 *
 * Rewritten for the pull-style protocol (2026-08-09, G-1 `/rust` consumption
 * rewrite): the engine's turn loop runs inside `kimi-server-serve`, so the
 * old `SessionEngineController` (host-callback `authorize_tool` gate) is
 * gone. Events arrive as `[event] {json}` stderr lines (routed by
 * `session_id`), and tool approvals are decided through the shared
 * `ApprovalStore`: the engine publishes `session.approval.requested`, the
 * host handler decides, and `session/approval_resolve` feeds the decision
 * back into the waiting tool call. No handler → auto-allow (permission
 * `auto`), mirroring the old controller's behavior.
 *
 * Approval semantics: the adapter targets interactive/manual permission, where
 * a handler is set before prompting. When no handler is set, it allows
 * (mirrors the print pilot's `auto`); wire `permissionMode: 'manual'` + a
 * handler for real gating.
 */
import type { Event } from '@moonshot-ai/kimi-code-sdk';

import type {
  EngineMcpServerInfo,
  EnginePluginInfo,
  EnginePluginSummary,
  EngineSessionRecord,
  EngineSessionStatus,
  EngineSessionUsage,
  EngineSessionWarning,
  EngineSkillSummary,
  HookDefInput,
  McpServerInput,
  NativeLlmDef,
  NativeServerClientLike,
} from './native-server-client';

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
} from './native-server-client';

export type NativePermissionMode = 'manual' | 'auto' | 'yolo';

/** A host approval decision callback: resolve true to allow, false to deny. */
export type NativeApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

/** The engine tool-approval request the host is asked to decide on. */
export interface ToolApprovalRequest {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: unknown;
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

/** Session creation options (the engine-side subset the adapter forwards). */
export interface SessionEngineStartOptions {
  readonly sessionId: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly goalEnabled?: boolean;
  readonly homedir?: string;
  readonly nativeLlm?: unknown;
  readonly mcpServers?: McpServerInput[];
  readonly hooks?: HookDefInput[];
  /**
   * Native permission mode for the session gate. `auto`/`yolo` approve gated
   * tools locally (no host authorize round-trip); `manual` keeps interactive
   * approval on the host via `setApprovalHandler`.
   */
  readonly permissionMode?: NativePermissionMode;
}

/** The prompt outcome the engine reports at turn end. */
export interface SessionPromptOutcome {
  readonly stopReason: string;
  readonly steps: number;
  readonly totalTokens: number;
}

export interface NativeSessionAdapterOptions {
  /** The `kimi-server-serve` client (production) or a fake (tests). */
  readonly client: NativeServerClientLike;
  /** Optional tap on raw engine wire events (e.g. `session.goal.updated`). */
  readonly onRawEvent?: (event: unknown) => void;
  readonly agentId?: string;
}

/**
 * A session handle over `kimi-server-serve` with dynamic event/approval
 * wiring. Not (yet) a drop-in for the SDK `Session` — see the file header for
 * the remaining surface. Intended to be consumed by the interactive
 * integration layer.
 */
export class NativeSessionAdapter {
  private readonly client: NativeServerClientLike;
  private readonly listeners = new Set<(event: Event) => void>();
  private approvalHandler: NativeApprovalHandler | undefined;
  private sessionId: string | null = null;
  /** Agent id stamped onto engine events (side-agent turns switch this for
   *  the duration of their prompt; the wire carries no agent id). */
  private currentAgentId: string;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: NativeSessionAdapterOptions) {
    this.client = options.client;
    this.currentAgentId = options.agentId ?? 'main';
    // The event loop: every engine event line is filtered by session id,
    // stamped with the routing fields, and fanned out to listeners.
    this.unsubscribe = this.client.onEvent((raw) => {
      this.options.onRawEvent?.(raw);
      const event = raw as { type?: string; session_id?: string | null };
      const wireSessionId = event.session_id ?? null;
      if (wireSessionId !== null && this.sessionId !== null && wireSessionId !== this.sessionId) {
        return;
      }
      // Approval requests are resolved through the handler seam, not the
      // event stream; every other event is translated and delivered.
      if (event.type === 'session.approval.requested') {
        void this.handleApprovalRequested(raw);
        return;
      }
      const { session_id: _drop, ...payload } = event;
      this.emit({
        ...payload,
        sessionId: wireSessionId ?? this.sessionId ?? '',
        agentId: this.currentAgentId,
      } as never);
    });
  }

  /** Create the engine session under the server. True when created. */
  async start(init: SessionEngineStartOptions): Promise<boolean> {
    this.currentAgentId = this.options.agentId ?? 'main';
    const created = await this.client.sessionCreate({
      sessionId: init.sessionId,
      homedir: init.homedir,
      systemPrompt: init.systemPrompt,
      model: init.model,
      goalEnabled: init.goalEnabled,
      nativeLlm: init.nativeLlm as NativeLlmDef | undefined,
      mcpServers: init.mcpServers,
      hooks: init.hooks,
    });
    this.sessionId = created.session_id;
    // Permission mode is a process-wide gate shared by every session agent;
    // set it at start so the host's interactive mode applies from turn one.
    await this.client.call('permission/set_mode', { mode: init.permissionMode ?? 'manual' });
    return true;
  }

  get id(): string | undefined {
    return this.sessionId ?? undefined;
  }

  get isStarted(): boolean {
    return this.sessionId !== null;
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
  async prompt(text: string, agentId?: string): Promise<SessionPromptOutcome | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    // Events for a side-agent turn arrive in-band during its prompt RPC but
    // carry no agent id on the wire; stamp them with the driving agent id
    // for the duration of the call, then restore the main-agent stamp.
    const previousAgentId = this.currentAgentId;
    if (agentId !== undefined) {
      this.currentAgentId = agentId;
    }
    try {
      const result = (await this.client.sessionPrompt(sid, [{ type: 'text', text }], agentId)) as {
        stop_reason?: string;
        steps?: number;
        usage?: { total?: { total_tokens?: number } };
      } | null;
      if (result === null) return null;
      return {
        stopReason: result.stop_reason ?? '',
        steps: result.steps ?? 0,
        totalTokens: result.usage?.total?.total_tokens ?? 0,
      };
    } finally {
      if (agentId !== undefined) {
        this.currentAgentId = previousAgentId;
      }
    }
  }

  /** Spawn a side-question subagent; returns its id (`btw-<sessionId>`). */
  async startBtw(): Promise<string | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    const result = (await this.client.call('session/start_btw', { session_id: sid })) as {
      btw_id: string;
    } | null;
    return result?.btw_id ?? null;
  }

  /** Destroy the active side-question subagent. */
  async endBtw(): Promise<boolean> {
    const sid = this.sessionId;
    if (sid === null) return false;
    const result = (await this.client.call('session/end_btw', { session_id: sid })) as {
      ended: boolean;
    } | null;
    return result?.ended ?? false;
  }

  /** Stop the running prompt at the next step boundary. */
  async cancel(): Promise<boolean> {
    const sid = this.sessionId;
    if (sid === null) return false;
    const result = await this.client.sessionCancel(sid);
    return result?.cancelled ?? false;
  }

  /** Persist context + goal under this session id. */
  async save(): Promise<boolean> {
    const sid = this.sessionId;
    if (sid === null) return false;
    const result = (await this.client.call('session/save', { session_id: sid })) as {
      ok: boolean;
    } | null;
    return result?.ok ?? false;
  }

  /**
   * Restore persisted context + goal via the engine's `session/load` (an active
   * goal comes back paused). Named `reloadSession` to match the SDK `Session`
   * surface the TUI expects.
   */
  async reloadSession(): Promise<boolean> {
    const sid = this.sessionId;
    if (sid === null) return false;
    const result = (await this.client.call('session/load', { session_id: sid })) as {
      found: boolean;
    } | null;
    return result?.found ?? false;
  }

  /** Change the engine's permission mode at runtime (process-wide gate). */
  async setPermission(mode: NativePermissionMode): Promise<void> {
    await this.client.call('permission/set_mode', { mode });
  }

  /** Switch the session's model from the next turn. */
  async setModel(model: string): Promise<void> {
    const sid = this.sessionId;
    if (sid === null) return;
    await this.client.call('session/set_model', { session_id: sid, model });
  }

  /** Set reasoning effort from the next turn (`null` clears). */
  async setThinking(effort: string | null): Promise<void> {
    const sid = this.sessionId;
    if (sid === null) return;
    await this.client.call('session/set_thinking', { session_id: sid, effort });
  }

  /**
   * Queue steer input; the engine drains it at the start of the next turn
   * (including a goal-continuation turn).
   */
  async steer(text: string): Promise<void> {
    const sid = this.sessionId;
    if (sid === null) return;
    await this.client.call('session/steer', {
      session_id: sid,
      input: [{ type: 'text', text }],
    });
  }

  /**
   * Run a user-initiated `!` shell command natively. Returns the combined
   * output and an error flag; `unavailable` true means the engine has no
   * shell — the caller should run it on the host.
   */
  async runShellCommand(
    command: string,
    timeoutS?: number,
    commandId?: string,
  ): Promise<{ output: string | null; isError: boolean; unavailable: boolean }> {
    const sid = this.sessionId;
    if (sid === null) return { output: null, isError: false, unavailable: true };
    const result = (await this.client.call('session/run_shell', {
      session_id: sid,
      command,
      timeout_s: timeoutS ?? null,
      command_id: commandId ?? null,
    })) as { output: string | null; is_error: boolean; unavailable?: boolean } | null;
    if (result === null) return { output: null, isError: false, unavailable: true };
    return { output: result.output, isError: result.is_error, unavailable: result.unavailable ?? false };
  }

  /** Cancel a streaming `!` shell command by its commandId. */
  async cancelShellCommand(commandId: string): Promise<void> {
    const sid = this.sessionId;
    if (sid === null) return;
    await this.client.call('session/cancel_shell_command', { session_id: sid, command_id: commandId });
  }

  /**
   * Add an additional directory to the session's workspace allowlist.
   * Returns the updated list of additional dirs, or null when the engine is
   * unavailable or the path is invalid.
   */
  async addAdditionalDir(path: string): Promise<string[] | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    const result = (await this.client.call('session/add_additional_dir', {
      session_id: sid,
      path,
    })) as { success: boolean; additional_dirs: string[] } | null;
    if (result === null) return null;
    return result.success ? result.additional_dirs : null;
  }

  /**
   * Remove an additional directory from the session's workspace allowlist.
   * Returns the updated list of additional dirs, or null if the engine is
   * unavailable or the dir was not in the list.
   */
  async removeAdditionalDir(path: string): Promise<string[] | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    const result = (await this.client.call('session/remove_additional_dir', {
      session_id: sid,
      path,
    })) as { success: boolean; additional_dirs: string[] } | null;
    if (result === null) return null;
    return result.success ? result.additional_dirs : null;
  }

  /**
   * Shallow-merge a JSON object into the session's custom metadata.
   * Returns the merged metadata, or null when unavailable.
   */
  async updateMetadata(patch: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    const result = (await this.client.call('session/update_metadata', {
      session_id: sid,
      metadata: patch,
    })) as { ok: boolean; metadata: Record<string, unknown> } | null;
    return result?.metadata ?? null;
  }

  // ── Goal lifecycle (SDK `Session` parity: createGoal/getGoal/…) ─────────
  // Each op forwards to the engine's `session/goal_*` RPC; an unstarted
  // session yields null so callers can fall back gracefully.

  /** Create (or with `replace` swap) the session goal as the user. */
  async createGoal(input: {
    objective: string;
    completionCriterion?: string;
    replace?: boolean;
  }): Promise<EngineGoalSnapshot | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    return (await this.client.call('session/goal_create', {
      session_id: sid,
      objective: input.objective,
      completion_criterion: input.completionCriterion ?? null,
      replace: input.replace ?? false,
    })) as EngineGoalSnapshot | null;
  }

  /** The current goal record (`{ goal: null }` when none). */
  async getGoal(): Promise<{ goal: EngineGoalSnapshot | null }> {
    const sid = this.sessionId;
    if (sid === null) return { goal: null };
    return (await this.client.call('session/goal_get', { session_id: sid })) as {
      goal: EngineGoalSnapshot | null;
    };
  }

  /** Pause the active goal as the user. */
  async pauseGoal(reason?: string): Promise<EngineGoalSnapshot | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    return (await this.client.call('session/goal_pause', {
      session_id: sid,
      reason: reason ?? null,
    })) as EngineGoalSnapshot | null;
  }

  /** Resume a paused goal as the user. */
  async resumeGoal(reason?: string): Promise<EngineGoalSnapshot | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    return (await this.client.call('session/goal_resume', {
      session_id: sid,
      reason: reason ?? null,
    })) as EngineGoalSnapshot | null;
  }

  /** Cancel the goal as the user. */
  async cancelGoal(): Promise<EngineGoalSnapshot | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    return (await this.client.call('session/goal_cancel', { session_id: sid })) as
      | EngineGoalSnapshot
      | null;
  }

  /**
   * Toggle swarm mode (SDK `setSwarmMode` parity). Returns whether the mode
   * is active afterwards, or null when the session is unstarted.
   */
  async setSwarmMode(
    enabled: boolean,
    trigger?: 'manual' | 'task' | 'tool',
  ): Promise<boolean | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    const result = (await this.client.call('session/set_swarm_mode', {
      session_id: sid,
      enabled,
      trigger: trigger ?? null,
    })) as { active: boolean } | null;
    return result?.active ?? null;
  }

  /**
   * Toggle plan mode (SDK `setPlanMode` parity). Returns the plan-mode state
   * afterwards, or null when the session is unstarted. Rejects (propagates)
   * when re-entering an already-active plan mode.
   */
  async setPlanMode(enabled: boolean): Promise<boolean | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    const result = (await this.client.call('session/set_plan_mode', {
      session_id: sid,
      enabled,
    })) as { plan_mode: boolean } | null;
    return result?.plan_mode ?? null;
  }

  /** Live session status snapshot (SDK `getStatus` parity). Null when the
   *  session is unstarted — the caller keeps its own state then. */
  async getStatus(): Promise<EngineSessionStatus | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    return (await this.client.call('session/get_status', { session_id: sid })) as
      | EngineSessionStatus
      | null;
  }

  /** Per-server MCP views (SDK `listMcpServers` parity); [] when unstarted. */
  async listMcpServers(): Promise<EngineMcpServerInfo[]> {
    const sid = this.sessionId;
    if (sid === null) return [];
    const result = (await this.client.call('session/list_mcp_servers', { session_id: sid })) as {
      servers: EngineMcpServerInfo[];
    } | null;
    return result?.servers ?? [];
  }

  /** Registered skills (SDK `listSkills` parity); [] when unstarted. */
  async listSkills(): Promise<EngineSkillSummary[]> {
    const sid = this.sessionId;
    if (sid === null) return [];
    const result = (await this.client.call('session/list_skills', { session_id: sid })) as {
      skills: EngineSkillSummary[];
    } | null;
    return result?.skills ?? [];
  }

  /** Session warnings (SDK `getSessionWarnings` parity); [] when unstarted. */
  async getSessionWarnings(): Promise<EngineSessionWarning[]> {
    const sid = this.sessionId;
    if (sid === null) return [];
    const result = (await this.client.call('session/get_warnings', { session_id: sid })) as {
      warnings: EngineSessionWarning[];
    } | null;
    return result?.warnings ?? [];
  }

  /** Cumulative usage snapshot (SDK `getUsage` parity); null when unstarted. */
  async getUsage(): Promise<EngineSessionUsage | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    return (await this.client.call('session/get_usage', { session_id: sid })) as
      | EngineSessionUsage
      | null;
  }

  /**
   * Manually compact the context (SDK `compact` parity). Resolves to the
   * engine's report ({ compacted, summary, … }), or null when the session is
   * unstarted. Rejects (propagates) when the engine has no summarizer.
   */
  async compact(
    instruction?: string,
  ): Promise<{ compacted: boolean; summary?: string; tokens_before?: number; tokens_after?: number } | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    return (await this.client.call('session/compact', {
      session_id: sid,
      instruction: instruction ?? null,
    })) as {
      compacted: boolean;
      summary?: string;
      tokens_before?: number;
      tokens_after?: number;
    } | null;
  }

  /** Cancel an in-flight compaction (SDK `cancelCompaction` parity). */
  async cancelCompaction(): Promise<void> {
    const sid = this.sessionId;
    if (sid === null) return;
    await this.client.call('session/cancel_compaction', { session_id: sid });
  }

  /** Full context snapshot (SDK `getContext` parity); null when unstarted. */
  async getContext(): Promise<EngineContextData | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    return (await this.client.call('session/get_context', { session_id: sid })) as
      | EngineContextData
      | null;
  }

  /** Clear the session's model context (SDK `clearContext` parity). */
  async clearContext(): Promise<boolean> {
    const sid = this.sessionId;
    if (sid === null) return false;
    const result = (await this.client.call('session/clear_context', { session_id: sid })) as {
      cleared: boolean;
    } | null;
    return result?.cleared ?? false;
  }

  /** Append imported transcript text (SDK `importContext` parity). */
  async importContext(content: string, source: string): Promise<boolean> {
    const sid = this.sessionId;
    if (sid === null) return false;
    const result = (await this.client.call('session/import_context', {
      session_id: sid,
      content,
      source,
    })) as { imported: boolean } | null;
    return result?.imported ?? false;
  }

  /**
   * Undo the last `count` user turns (SDK `undoHistory` parity). Rejects
   * (propagates) when the count is not fully available.
   */
  async undoHistory(count: number): Promise<void> {
    const sid = this.sessionId;
    if (sid === null) return;
    await this.client.call('session/undo_history', { session_id: sid, count });
  }

  /** Active plan snapshot (SDK `getPlan` parity); null when no plan / unstarted. */
  async getPlan(): Promise<EnginePlanInfo | null> {
    const sid = this.sessionId;
    if (sid === null) return null;
    return (await this.client.call('session/get_plan', { session_id: sid })) as EnginePlanInfo | null;
  }

  /** Clear the active plan's file content (SDK `clearPlan` parity). */
  async clearPlan(): Promise<void> {
    const sid = this.sessionId;
    if (sid === null) return;
    await this.client.call('session/clear_plan', { session_id: sid });
  }

  /**
   * Activate a skill (SDK `activateSkill` parity): the engine renders the skill
   * prompt and runs a turn. The turn's progress arrives via events; this
   * resolves when the turn completes.
   */
  async activateSkill(name: string, args?: string): Promise<void> {
    const sid = this.sessionId;
    if (sid === null) return;
    await this.client.call('session/activate_skill', {
      session_id: sid,
      name,
      args: args ?? null,
    });
  }

  /** Reconnect a single MCP server (SDK `reconnectMcpServer` parity). */
  async reconnectMcpServer(name: string): Promise<void> {
    const sid = this.sessionId;
    if (sid === null) return;
    await this.client.call('session/reconnect_mcp_server', { session_id: sid, name });
  }

  /** MCP startup connect duration in ms (SDK `getMcpStartupMetrics` parity). */
  async getMcpStartupMetrics(): Promise<number> {
    const sid = this.sessionId;
    if (sid === null) return 0;
    const result = (await this.client.call('session/get_mcp_startup_metrics', {
      session_id: sid,
    })) as { duration_ms: number } | null;
    return result?.duration_ms ?? 0;
  }

  /** Generate AGENTS.md via an init subagent (SDK `Session.init` parity). */
  async init(): Promise<void> {
    const sid = this.sessionId;
    if (sid === null) return;
    await this.client.call('session/init', { session_id: sid });
  }

  /** Process-global cron listing (SDK `getCronTasks` parity); [] when unstarted. */
  async getCronTasks(): Promise<EngineCronTask[]> {
    const result = (await this.client.call('cron/list')) as { tasks: EngineCronTask[] } | null;
    return result?.tasks ?? [];
  }

  /** Background-task captured output (SDK `getBackgroundTaskOutput` parity). */
  async getBackgroundTaskOutput(taskId: string): Promise<string> {
    const result = (await this.client.call('bg/output', { task_id: taskId })) as {
      preview: string;
      error?: string;
    } | null;
    return result?.preview ?? '';
  }

  /** Request a background task to stop (SDK `stopBackgroundTask` parity). */
  async stopBackgroundTask(taskId: string, reason?: string): Promise<void> {
    await this.client.call('bg/stop', { task_id: taskId, reason: reason ?? null });
  }

  /** Raw background-task wire records (SDK `listBackgroundTasks` parity); the
   *  higher `NativeSession` maps them onto the SDK union. */
  async listBackgroundTasks(): Promise<unknown[]> {
    const result = (await this.client.call('bg/list')) as { tasks: unknown[] } | null;
    return result?.tasks ?? [];
  }

  /** Persisted engine sessions (SDK `listSessions` parity); [] when
   *  unavailable. Workdir filtering happens at the caller. */
  async listSessions(): Promise<EngineSessionRecord[]> {
    const result = (await this.client.call('session/list')) as {
      sessions: EngineSessionRecord[];
    } | null;
    return result?.sessions ?? [];
  }

  /** Installed-plugin summaries (SDK `listPlugins` parity). */
  async listPlugins(): Promise<EnginePluginSummary[]> {
    const result = (await this.client.call('plugin/list')) as {
      plugins: EnginePluginSummary[];
    } | null;
    return result?.plugins ?? [];
  }

  /** One installed plugin's detail (SDK `getPluginInfo` parity); null if unknown. */
  async getPluginInfo(id: string): Promise<EnginePluginInfo | null> {
    return (await this.client.call('plugin/get', { id })) as EnginePluginInfo | null;
  }

  /** Install a plugin from a source (SDK `installPlugin` parity). */
  async installPlugin(source: string): Promise<EnginePluginSummary | null> {
    return (await this.client.call('plugin/install', { source })) as EnginePluginSummary | null;
  }

  /** Enable or disable an installed plugin (SDK `setPluginEnabled` parity). */
  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    await this.client.call('plugin/set_enabled', { id, enabled });
  }

  /** Toggle one of a plugin's MCP servers (SDK `setPluginMcpServerEnabled` parity). */
  async setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    await this.client.call('plugin/set_mcp_enabled', { id, server, enabled });
  }

  /** Remove an installed plugin (SDK `removePlugin` parity). */
  async removePlugin(id: string): Promise<boolean> {
    const result = (await this.client.call('plugin/remove', { id })) as {
      removed: boolean;
    } | null;
    return result?.removed ?? false;
  }

  /** Reload plugins from disk (SDK `reloadPlugins` parity). */
  async reloadPlugins(): Promise<void> {
    await this.client.call('plugin/reload');
  }

  /** List a plugin's slash-style commands (SDK `listPluginCommands` parity). */
  async listPluginCommands(pluginId: string): Promise<EnginePluginCommand[]> {
    const result = (await this.client.call('plugin/list_commands', { id: pluginId })) as {
      commands: EnginePluginCommand[];
    } | null;
    return result?.commands ?? [];
  }

  /** Activate a plugin command (SDK `activatePluginCommand` parity). */
  async activatePluginCommand(
    sessionId: string,
    pluginId: string,
    commandName: string,
    args?: string,
  ): Promise<void> {
    await this.client.call('plugin/activate_command', {
      session_id: sessionId,
      plugin_id: pluginId,
      command_name: commandName,
      args: args ?? null,
    });
  }

  /** Detach a background task (SDK `detachBackgroundTask` parity); returns the
   *  raw engine wire record (mapped by `NativeSession`) or null. */
  async detachBackgroundTask(taskId: string): Promise<Record<string, unknown> | null> {
    const result = (await this.client.call('bg/detach', { task_id: taskId })) as
      | Record<string, unknown>
      | null;
    return result ?? null;
  }

  private async handleApprovalRequested(raw: Record<string, unknown>): Promise<void> {
    const approvalId = typeof raw['approval_id'] === 'string' ? raw['approval_id'] : undefined;
    if (approvalId === undefined) return;
    const handler = this.approvalHandler;
    // No host approver → permission `auto`: the decision is final, so the
    // engine gate does not fall back to host execution.
    if (handler === undefined) {
      await this.client.approvalResolve(approvalId, true);
      return;
    }
    // Fail closed: a throwing/cancelled approval prompt must deny, never
    // propagate into the engine's lifecycle RPC (which would hang or abort
    // the turn). This keeps the interactive seam safe when the host
    // approver errors.
    let allowed: boolean;
    try {
      allowed = await handler({
        toolName: typeof raw['tool_name'] === 'string' ? raw['tool_name'] : '',
        toolCallId: typeof raw['tool_call_id'] === 'string' ? raw['tool_call_id'] : '',
        args: raw['arguments'],
      });
    } catch {
      allowed = false;
    }
    await this.client.approvalResolve(approvalId, allowed);
  }

  private emit(event: Event): void {
    // Fan out to every current listener; a throwing listener must not
    // starve the others or the engine event pump.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore a misbehaving renderer; keep delivering.
      }
    }
  }
}
