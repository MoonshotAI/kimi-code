export const telemetryCoverageTierRoots = ['app', 'session', 'agent', 'workspace', 'features'] as const;

export const telemetryPseudoDomains = ['host'] as const;

export const telemetryDomainExemptions: Readonly<Record<string, string>> = {
  'app/agentIdentity': 'Config-derived snapshot built once; no IO, state machine, or failure branches.',
  'app/agentProfileCatalog':
    'Type definitions, pure functions, and static built-in profile loading; no IO or user decisions.',
  'app/authLegacy':
    'Read-only aggregate facade over config and oauth status; authentication events belong to app/auth.',
  'app/bashParser': 'Stateless parse adapter over tree-sitter-bash; no IO or lifecycle.',
  'app/bootstrap': 'Pure value carriers (path derivation, env reads) and scope creation functions.',
  'app/edit': 'Thin file-edit adapter; failures return to the Edit tool and are covered by tool_call.',
  'app/event': 'Pure pub/sub plumbing with no business semantics.',
  'app/feature': 'Thin DI unit management shell; no user-perceivable behavior.',
  'app/flag': 'In-memory flag resolution (env > config > default); no IO or lifecycle.',
  'app/gateway': 'Thin delegate to prompt/loop services; turn events are emitted by the owning domains.',
  'app/hostFolderBrowser': 'Stateless readdir proxy; errors map to typed RPC errors.',
  'app/mcpRegistry': 'Read-only aggregation of config and plugin queries; no writes or failure branches.',
  'app/projectLocalConfig': 'Interface declaration only; implementation lives in persistence backends.',
  'app/remoteControl': 'Flag definition registration only; no runtime logic.',
  'app/sessionManager':
    'Resume failures funnel to session_load_failed via sessionLookup; lifecycle events are owned by workspace/sessionLifecycle.',
  'app/sessionLegacy': 'Read-only aggregate proxy; resume failures are covered by session_load_failed.',
  'app/state': 'StateRegistry subclass with no business logic.',
  'app/task': 'Generic task-handle primitive; background task events live in agent/task.',
  'app/telemetry': 'Telemetry infrastructure itself; it cannot instrument itself.',
  'app/workspaceAliases': 'Stateless resolution proxy over IWorkspaceService and the session index.',
  'app/workspaceSessions': 'Read-only aggregate facade over workspace aliases and the session index.',
  'session/approval': 'Thin delegate to features/interaction; resolution events are emitted by agent/toolApproval.',
  'session/mcp': 'Type seeds and a merged view; connection events are emitted by workspace/workspaceMcp.',
  'session/question':
    'Thin delegate; resolution events are emitted by the ask-user-question tool (agent/tools).',
  'session/sessionActivity': 'Pure in-memory fold of already-instrumented turn and activity events.',
  'session/sessionAgentProfileCatalog':
    'In-memory registry merge projection; diagnostics go through log and inspect surfaces.',
  'session/sessionContext': 'Pure data carrier (sessionId/workspaceId/cwd) plus seed factory.',
  'session/sessionInstructions': 'Interface declaration and DI seed helper only.',
  'session/sessionLog':
    'Thin adapter over FileLogWriter; it is the logging substrate telemetry itself relies on.',
  'session/sessionToolPolicy': 'Simple disabled-tools preference persistence; changes broadcast via onDidChange.',
  'session/sessionToolPolicyGate': 'No-op implementation with no behavior to observe.',
  'session/state': 'StateRegistry subclass with no business logic.',
  'session/tokenCounting':
    'Pure in-memory token estimation bookkeeping; size signals are covered by loop and compaction events.',
  'session/usage':
    'Pure in-memory usage accumulator; consumption signals are covered by llmRequester and loop events.',
  'session/workspaceInfo': 'Interface declaration and scope seed factory only.',
  'agent/activityView':
    'Read-only projection of loop, task, compaction, and approval events that are instrumented at the source.',
  'agent/agentContext': 'In-memory agent model lease registry; anomalies route to onUnexpectedError.',
  'agent/command': 'Thin dispatcher over command contributions; real work is instrumented by owning domains.',
  'agent/contextMemory':
    'In-memory history mutation API; lifecycle operations are instrumented by owner domains (undo, compaction, loop).',
  'agent/interruptionReminder':
    'Fixed-text reminder injection on user_cancelled; the interrupt itself is covered by turn_interrupted.',
  'agent/modeMutex':
    'Mode mutual-exclusion wiring over the event bus; mode transitions are owned by features/plan, features/swarm, and features/tower.',
  'agent/permissionPolicy': 'Stateless policy evaluation chain; decisions are recorded by permissionGate.',
  'agent/permissionRules': 'Thin state wrapper; approval persistence is recorded by permission_approval_result.',
  'agent/plugin': 'Reminder reconcile and render logic; plugin install/enable events belong to app/plugin.',
  'agent/replayBuilder': 'Pure type definitions.',
  'agent/scopeContext': 'Stateless plumbing (scope key and frozen context factory).',
  'agent/state': 'StateRegistry subclass for replayable key bookkeeping.',
  'agent/tokenCounting': 'Contracts and wire event definitions only; counting logic lives in session/tokenCounting.',
  'agent/toolActivation': 'Tool registration bookkeeping; policy-blocked calls surface via tool_call.',
  'agent/toolPolicy': 'Pure policy evaluation; guard interceptions are recorded via tool_call.',
  'agent/toolRegistry': 'In-memory Map registry with no IO or failure degradation.',
  'workspace/state': 'StateRegistry subclass with no business logic.',
  'workspace/workspaceContext': 'Pure data interface plus seed factory.',
  'workspace/workspaceDirs': 'Thin state holder over project-local config; failures propagate to session creation.',
  'workspace/workspaceGit': 'Pass-through proxy to IGitService; git subprocess telemetry belongs to app/git.',
  'workspace/workspaceInstructions':
    'AGENTS.md snapshot loader with fs watch; reload failures degrade to prior content with log.warn.',
  'workspace/workspaceMcpConfig':
    'Config aggregation with fingerprint diff; connection outcomes are covered by workspaceMcp events.',
  'features/dateChange': 'Date disclosure computation and reminder injection; no IO or decisions.',
  'features/debugEvents': 'Read-only introspection for the /api/v1/debug surface.',
  'features/tokenCounting': 'Pure feature assembly; counting logic lives in session/tokenCounting.',
  'features/usage': 'Pure feature assembly; usage logic lives in session/usage.',
  _base: 'DI kernel and base utilities below the telemetry layer; activation failures surface as sticky Failed units.',
  debug: 'Read-only introspection views for the /api/v1/debug surface.',
  kosong:
    'LLM HTTP errors translate and bubble to api_error in agent/llmRequester; instrumenting here would double-count.',
  os: 'Host capability implementations; failures bubble to caller domains (mcp_failed, tool_call, fs fallbacks).',
  runtime:
    'Runtime registry and host shells; failures throw typed RuntimeError to callers and state changes publish via onDidChange.',
  state: 'State definitions and the event dispatcher pipeline; restore failures are covered by session_load_failed.',
  tool: 'Stateless tool utilities (path access, args validation, output accumulation); rejections surface via tool_call.',
};

export const telemetryDomainKnownGaps: Readonly<Record<string, string>> = {
  'app/auth':
    'Login funnel: oauth_login_finished (provider, status, duration_ms), oauth_models_refresh_finished, auth_ensure_ready_failed.',
  'app/capability': 'Install funnel: capability_install_started / capability_install_ended (outcome, duration_ms).',
  'app/config': 'Config health: config_load_failed, config_persist_blocked, config_migration_applied.',
  'app/file': 'Upload health: file_saved (outcome, size_bytes), file_blob_missing (index/blob divergence).',
  'app/git': 'Subprocess health: git_spawn_failed, git_command_timeout, git_command_duration.',
  'app/kosongConfig': 'Provider config: config_persist_failed, provider_models_refreshed, provider_catalog_import.',
  'app/mcpConfig': 'Credential store: mcp_oauth_store_read_failed (silent credential loss).',
  'app/mcpManagement': 'Server management: mcp_server_test, mcp_auth_flow_completed, mcp_server_config_mutated.',
  'app/plugin': 'Plugin lifecycle: plugin_install, plugin_reload, plugin_update_check.',
  'app/sessionExport': 'Export health: session_export (success, duration_ms, entries_count).',
  'app/sessionIndex':
    'Read model health: session_index_degraded, session_index_projected, session_index_mirror_give_up.',
  'app/web': 'Managed fetch fallback: web_fetch_fallback (silent local degradation).',
  'app/workspace':
    'Workspace lifecycle: workspace_created, workspace_deleted, workspace_catalog_rebuilt, workspace_root_invalid.',
  'session/agentLifecycle': 'Creation failure: agent_create_failed (stage, error_type).',
  'session/sessionMetadata': 'Metadata health: session_meta_load_failed, session_meta_migrated.',
  'session/sessionTitle':
    'Title generation: session_title_generated, session_title_generation_failed (experiment evaluation).',
  'session/terminal': 'Terminal lifecycle: terminal_spawn_failed, terminal_exited.',
  'session/workspaceContext': 'Security boundary: workspace_path_denied (path escape attempts).',
  'agent/blob': 'Media storage: blob_read_failed (silent media loss), blob_offloaded.',
  'agent/mcp': 'MCP tool calls: mcp_tool_reconnect, mcp_tool_name_collision.',
  'agent/pluginCommand': 'Adoption: plugin_command (plugin_id, command_name).',
  'agent/runtime': 'Runtime lifecycle: agent_runtime_failed (phase), agent_runtime_restored (duration_ms).',
  'agent/runtimeBinding': 'Binding decisions: agent_runtime_binding_changed, agent_runtime_binding_rejected.',
  'agent/shellCommand':
    'Execution bypasses tool_call: shell_command_finished (duration_ms, is_error, backgrounded).',
  'agent/stepRetry': 'Retry behavior: turn_step_retrying, turn_step_retry_exhausted.',
  'agent/toolResultTruncation':
    'Truncation: tool_result_truncated (size distribution), tool_result_spill_save_failed.',
  'agent/toolSelect': 'Dynamic tool loading: tool_select_load (to_load_count, unknown_count).',
  'agent/userTool': 'Adoption: user_tool_registered.',
  'workspace/workspaceAgentProfileLoader': 'Profile loading: agent_profile_load_failed (source, fatal).',
  'workspace/workspaceInstance': 'Materialization: workspace_materialized (duration_ms), workspace_materialize_failed.',
  'workspace/workspaceTrust':
    'Trust decisions: workspace_trust_changed, workspace_trust_read_failed (fail-closed silently).',
  'features/btw': 'Adoption: btw_started.',
  'features/externalHooks':
    'Hook execution: external_hook_executed (outcome), external_hook_blocked (security decisions).',
  'features/interaction': 'Orphan interactions: interaction_cancelled (kind, reason, pending_duration_ms).',
  'features/reminder': 'Injection health: reminder_provider_failed (silent context-injection failure).',
  'features/sessionInit': '/init run: session_init (outcome, duration_ms).',
  'features/staleGuard': 'Guard hits: stale_guard_blocked (reason).',
  'features/swarm':
    'Batch runs: agent_swarm_batch_finished (outcome distribution), agent_swarm_rate_limit_mode_entered.',
  'features/todo': 'Reminder strategy: todo_list_reminder_shown.',
  'features/tower':
    'Tower governance: tower_mode_entered, tower_spawn_denied, tower_rate_limit_paused, tower_worktree_escape_denied, tower_worktree_setup_warning.',
  mcpCore: 'Runtime connection health: mcp_server_dropped, mcp_oauth_refresh_failed.',
  persistence: 'Store health: query_store_rebuilt (silent corruption recovery).',
  program: 'Generation failures: program_generation_failed (stage).',
};
