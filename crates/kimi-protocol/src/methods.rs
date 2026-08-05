    /// Run a single turn. Corresponds to `runTurn()` in the JS loop.
    pub const RUN_TURN: &str = "agent/run_turn";

    /// Cancel a running turn.
    pub const CANCEL_TURN: &str = "agent/cancel_turn";

    /// Session-owned agent surface (the phase-D thin-client protocol): the
    /// engine owns sessions, agents, goal driving, and persistence; the
    /// host only renders and answers `host/*` callbacks.
    pub const SESSION_CREATE: &str = "session/create";
    pub const SESSION_PROMPT: &str = "session/prompt";
    pub const SESSION_CANCEL: &str = "session/cancel";
    /// Destroy a session's agent + side agent, firing SessionEnd hooks. The
    /// persisted record (if any) is left intact for later `session/load`.
    pub const SESSION_DESTROY: &str = "session/destroy";
    /// Permanently delete a session's persisted record (SDK `deleteSession`).
    /// Unlike `session/destroy`, this removes the persisted record, not just
    /// the in-memory agent.
    pub const SESSION_DELETE: &str = "session/delete";
    /// Fork a persisted session under a new id, dropping goal state (SDK
    /// `forkSession`).
    pub const SESSION_FORK: &str = "session/fork";
    pub const SESSION_SAVE: &str = "session/save";
    pub const SESSION_LOAD: &str = "session/load";
    pub const SESSION_LIST: &str = "session/list";
    pub const SESSION_SET_MODEL: &str = "session/set_model";
    pub const SESSION_RUN_SHELL: &str = "session/run_shell";
    /// Cancel a running `!` shell command by its commandId.
    pub const SESSION_CANCEL_SHELL_COMMAND: &str = "session/cancel_shell_command";
    pub const SESSION_SET_THINKING: &str = "session/set_thinking";
    pub const SESSION_STEER: &str = "session/steer";
    pub const SESSION_ADD_DIR: &str = "session/add_additional_dir";
    pub const SESSION_REMOVE_DIR: &str = "session/remove_additional_dir";
    pub const SESSION_UPDATE_METADATA: &str = "session/update_metadata";
    /// Rename a session (persisted title; SDK `renameSession` parity).
    pub const SESSION_RENAME: &str = "session/rename";

    /// Goal lifecycle (deterministic user/host control surface). Terminal
    /// statuses stay model-owned (UpdateGoal tool / goal driver) — there is
    /// deliberately no `goal_update`, matching the SDK `Session` surface.
    pub const SESSION_GOAL_CREATE: &str = "session/goal_create";
    pub const SESSION_GOAL_GET: &str = "session/goal_get";
    pub const SESSION_GOAL_PAUSE: &str = "session/goal_pause";
    pub const SESSION_GOAL_RESUME: &str = "session/goal_resume";
    pub const SESSION_GOAL_CANCEL: &str = "session/goal_cancel";

    /// Toggle swarm mode: enter/exit the native `SwarmMode` state machine,
    /// applying the enter/exit reminders to the session context.
    pub const SESSION_SET_SWARM_MODE: &str = "session/set_swarm_mode";
    /// Toggle plan mode: set the permission gate's plan context + inject the
    /// plan-mode reminder — the engine side of SDK `setPlanMode`.
    pub const SESSION_SET_PLAN_MODE: &str = "session/set_plan_mode";

    /// Live session status snapshot (model, permission, context tokens,
    /// cumulative usage) — the engine side of the SDK `getStatus`.
    pub const SESSION_GET_STATUS: &str = "session/get_status";
    /// Per-server MCP views (name/transport/status/tool count/error) — the
    /// engine side of the SDK `listMcpServers`.
    pub const SESSION_LIST_MCP_SERVERS: &str = "session/list_mcp_servers";
    /// Cumulative token usage snapshot — the engine side of SDK `getUsage`.
    pub const SESSION_GET_USAGE: &str = "session/get_usage";
    /// Registered skills for the session — the engine side of SDK `listSkills`.
    pub const SESSION_LIST_SKILLS: &str = "session/list_skills";
    /// Session warnings (e.g. failed MCP servers) — the engine side of SDK
    /// `getSessionWarnings`.
    pub const SESSION_GET_WARNINGS: &str = "session/get_warnings";
    /// Manually compact the session context (requires a native-LLM summarizer)
    /// — the engine side of SDK `compact`.
    pub const SESSION_COMPACT: &str = "session/compact";
    /// List the session's pending tool approvals (web-facing approval cards).
    pub const SESSION_APPROVAL_LIST: &str = "session/approval_list";
    /// Resolve a pending tool approval (allow/deny) — the web decision path.
    pub const SESSION_APPROVAL_RESOLVE: &str = "session/approval_resolve";
    /// Full context snapshot (history + token count) — the engine side of SDK
    /// `getContext`.
    pub const SESSION_GET_CONTEXT: &str = "session/get_context";
    /// Clear the session's model context — the engine side of SDK
    /// `clearContext`.
    pub const SESSION_CLEAR_CONTEXT: &str = "session/clear_context";
    /// Append imported transcript text to the context — the engine side of SDK
    /// `importContext`.
    pub const SESSION_IMPORT_CONTEXT: &str = "session/import_context";
    /// Undo the last N user turns — the engine side of SDK `undoHistory`.
    pub const SESSION_UNDO_HISTORY: &str = "session/undo_history";
    /// Active plan snapshot (id/content/path or null) — the engine side of SDK
    /// `getPlan`.
    pub const SESSION_GET_PLAN: &str = "session/get_plan";
    /// Clear the active plan's file content — the engine side of SDK
    /// `clearPlan`.
    pub const SESSION_CLEAR_PLAN: &str = "session/clear_plan";
    /// Activate a skill (render its prompt + run a turn) — the engine side of
    /// SDK `activateSkill`.
    pub const SESSION_ACTIVATE_SKILL: &str = "session/activate_skill";
    /// Reconnect a single MCP server — the engine side of SDK
    /// `reconnectMcpServer`.
    pub const SESSION_RECONNECT_MCP_SERVER: &str = "session/reconnect_mcp_server";
    /// MCP startup timing ({ duration_ms }) — the engine side of SDK
    /// `getMcpStartupMetrics`.
    pub const SESSION_GET_MCP_STARTUP_METRICS: &str = "session/get_mcp_startup_metrics";
    /// Generate AGENTS.md via an init subagent — the engine side of SDK
    /// `Session.init` (`generateAgentsMd`).
    pub const SESSION_INIT: &str = "session/init";
    /// Spawn a side-question ("between turns") subagent — the engine side of
    /// SDK `Session.startBtw`. Returns the child agent id.
    pub const SESSION_START_BTW: &str = "session/start_btw";
    /// Destroy the active side-question subagent.
    pub const SESSION_END_BTW: &str = "session/end_btw";

    /// Health check.
    pub const HEALTH: &str = "agent/health";

    /// Working-tree git status ({ branch, ahead, behind, entries, ... }) —
    /// the engine side of the v2 `IGitService.status`.
    pub const GIT_STATUS: &str = "git/status";
    /// Diff of one repo-relative path against HEAD — the engine side of the
    /// v2 `IGitService.diff`.
    pub const GIT_DIFF: &str = "git/diff";

    /// Shutdown the agent process.
    pub const SHUTDOWN: &str = "agent/shutdown";

    /// LLM chat request (Rust → JS host proxy).
    pub const HOST_LLM_CHAT: &str = "host/llm_chat";

    /// Execute a tool call (Rust → JS host proxy).
    pub const HOST_EXECUTE_TOOL: &str = "host/execute_tool";

    /// Fire-and-forget event notification (Rust → JS host).
    /// Used by the native LLM / native tool paths to report step
    /// boundaries, streaming deltas, and natively-executed tool results
    /// so the host can record them in the transcript.
    pub const HOST_EVENT: &str = "host/event";

    // ── Tool hook methods (tool_call.rs lifecycle) ─────────────────────────────────
    /// Prepare a tool call for execution (Rust → JS host proxy).
    /// Analogous to TS `prepareToolExecution` hook.
    pub const HOST_PREPARE_TOOL: &str = "host/prepare_tool_execution";

    /// Authorize a tool call (Rust → JS host proxy).
    /// Analogous to TS `authorizeToolExecution` hook.
    pub const HOST_AUTHORIZE_TOOL: &str = "host/authorize_tool_execution";

    /// Finalize a tool result (Rust → JS host proxy).
    /// Analogous to TS `finalizeToolResult` hook.
    pub const HOST_FINALIZE_TOOL: &str = "host/finalize_tool_result";

    // ── Permission methods (host → engine, configure the native gate) ─────────────
    /// Get the current permission snapshot (`{ mode, rules }`).
    pub const PERMISSION_GET: &str = "permission/get";
    /// Set the permission mode (`manual` | `auto` | `yolo`).
    pub const PERMISSION_SET_MODE: &str = "permission/set_mode";
    /// Add a permission rule (allow/deny/ask; user or session scope).
    pub const PERMISSION_ADD_RULE: &str = "permission/add_rule";

    // ── Cron methods ────────────────────────────────────────────────────────────
    /// Create a new cron task.
    pub const CRON_CREATE: &str = "cron/create";
    /// Delete cron tasks by id.
    pub const CRON_DELETE: &str = "cron/delete";
    /// List all cron tasks.
    pub const CRON_LIST: &str = "cron/list";
    /// Get next fire time for a task.
    pub const CRON_GET_NEXT_FIRE: &str = "cron/get_next_fire";
    /// Rust → JS: a cron job fired.
    pub const CRON_FIRED: &str = "cron/fired";

    // ── Background task methods ──────────────────────────────────────────────────
    /// Register a new background task.
    pub const BG_REGISTER: &str = "bg/register";
    /// List all background tasks.
    pub const BG_LIST: &str = "bg/list";
    /// Get a specific background task.
    pub const BG_GET: &str = "bg/get";
    /// Stop a background task.
    pub const BG_STOP: &str = "bg/stop";
    /// Get output snapshot for a task.
    pub const BG_OUTPUT: &str = "bg/output";
    /// Append output to a task.
    pub const BG_APPEND_OUTPUT: &str = "bg/append_output";
    /// Settle a task (mark terminal).
    pub const BG_SETTLE: &str = "bg/settle";
    /// Rust → JS: background task event.
    pub const BG_EVENT: &str = "bg/event";
    /// Detach a task from its foreground tool call — the engine side of SDK
    /// `detachBackgroundTask`.
    pub const BG_DETACH: &str = "bg/detach";

    // ── Plugin methods ──────────────────────────────────────────────────────────
    /// List installed plugins (summary view) — the engine side of SDK
    /// `listPlugins`.
    pub const PLUGIN_LIST: &str = "plugin/list";
    /// Get one installed plugin's detail — the engine side of SDK
    /// `getPluginInfo`.
    pub const PLUGIN_GET: &str = "plugin/get";
    /// Install a plugin from a source (github repo / zip URL / local path) —
    /// the engine side of SDK `installPlugin`.
    pub const PLUGIN_INSTALL: &str = "plugin/install";
    /// Enable or disable an installed plugin — the engine side of SDK
    /// `setPluginEnabled`.
    pub const PLUGIN_SET_ENABLED: &str = "plugin/set_enabled";
    /// Toggle one of a plugin's MCP servers — the engine side of SDK
    /// `setPluginMcpServerEnabled`.
    pub const PLUGIN_SET_MCP_ENABLED: &str = "plugin/set_mcp_enabled";
    /// Remove an installed plugin — the engine side of SDK `removePlugin`.
    pub const PLUGIN_REMOVE: &str = "plugin/remove";
    /// Reload plugins from disk — the engine side of SDK `reloadPlugins`.
    pub const PLUGIN_RELOAD: &str = "plugin/reload";

    // ── Task domain methods ─────────────────────────────────────────────────────
    /// List tracked tasks (live + restored ghosts) — the engine side of the
    /// host's task registry surface.
    pub const TASK_LIST: &str = "task/list";

    // ── Config domain methods ───────────────────────────────────────────────────
    /// Read the global Kimi configuration (the engine's parsed `config.toml`).
    /// Secrets are NOT redacted here — the host projects and redacts for the
    /// wire. Stage 2a of the kap-server Rust migration.
    pub const CONFIG_GET: &str = "config/get";
    /// Merge a patch into the global configuration and write it back to disk
    /// (camelCase KimiConfig shape, `None` fields keep the base value).
    pub const CONFIG_SET: &str = "config/set";

    // ── Session export ──────────────────────────────────────────────────────────
    /// Export a session as a zip diagnostic archive (manifest + wire records +
    /// session files), returned base64-encoded. Stage 2c.
    pub const SESSION_EXPORT: &str = "session/export";

    // ── Session fs ──────────────────────────────────────────────────────────────
    /// Read-class filesystem action against the session workspace root
    /// (read/list/stat via the native toolset). Stage 2d.
    pub const SESSION_FS: &str = "session/fs";

    // ── Session tools ───────────────────────────────────────────────────────────
    /// Native tool definitions for the session workspace (engine built-ins).
    /// Stage 3d of the kap-server Rust migration (web `/tools` list).
    pub const SESSION_LIST_TOOLS: &str = "session/list_tools";
