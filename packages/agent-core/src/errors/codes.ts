/**
 * Error codes for Kimi Core's public error protocol.
 *
 * `ErrorCodes` is the source of truth for every code Kimi Core may emit.
 * Downstream consumers (SDK, RPC clients, telemetry, agent-facing docs)
 * should depend on these string values rather than on class identity.
 *
 * Codes follow `domain.reason`. Adding a code is a minor change; renaming
 * or removing one is a major change.
 */
export const ErrorCodes = {
  CONFIG_INVALID: 'config.invalid',

  SESSION_NOT_FOUND: 'session.not_found',
  SESSION_ALREADY_EXISTS: 'session.already_exists',
  SESSION_ID_INVALID: 'session.id_invalid',
  SESSION_ID_REQUIRED: 'session.id_required',
  SESSION_ID_EMPTY: 'session.id_empty',
  SESSION_TITLE_EMPTY: 'session.title_empty',
  SESSION_STATE_NOT_FOUND: 'session.state_not_found',
  SESSION_STATE_INVALID: 'session.state_invalid',
  SESSION_FORK_ACTIVE_TURN: 'session.fork_active_turn',
  SESSION_EXPORT_NOT_FOUND: 'session.export_not_found',
  SESSION_EXPORT_MISSING_VERSION: 'session.export_missing_version',
  SESSION_CLOSED: 'session.closed',
  SESSION_PERMISSION_MODE_INVALID: 'session.permission_mode_invalid',
  SESSION_THINKING_EMPTY: 'session.thinking_empty',
  SESSION_MODEL_EMPTY: 'session.model_empty',
  SESSION_PLAN_MODE_INVALID: 'session.plan_mode_invalid',
  SESSION_APPROVAL_HANDLER_ERROR: 'session.approval_handler_error',
  SESSION_QUESTION_HANDLER_ERROR: 'session.question_handler_error',
  SESSION_INIT_FAILED: 'session.init_failed',

  AGENT_NOT_FOUND: 'agent.not_found',
  TURN_AGENT_BUSY: 'turn.agent_busy',

  GOAL_ALREADY_EXISTS: 'goal.already_exists',
  GOAL_NOT_FOUND: 'goal.not_found',
  GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
  GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
  GOAL_STATUS_INVALID: 'goal.status_invalid',
  GOAL_METADATA_RESERVED: 'goal.metadata_reserved',
  GOAL_NOT_RESUMABLE: 'goal.not_resumable',

  MODEL_NOT_CONFIGURED: 'model.not_configured',
  MODEL_CONFIG_INVALID: 'model.config_invalid',
  AUTH_LOGIN_REQUIRED: 'auth.login_required',

  CONTEXT_OVERFLOW: 'context.overflow',
  LOOP_MAX_STEPS_EXCEEDED: 'loop.max_steps_exceeded',
  PROVIDER_API_ERROR: 'provider.api_error',
  PROVIDER_RATE_LIMIT: 'provider.rate_limit',
  PROVIDER_AUTH_ERROR: 'provider.auth_error',
  PROVIDER_CONNECTION_ERROR: 'provider.connection_error',

  SKILL_NOT_FOUND: 'skill.not_found',
  SKILL_TYPE_UNSUPPORTED: 'skill.type_unsupported',
  SKILL_NAME_EMPTY: 'skill.name_empty',

  RECORDS_WRITE_FAILED: 'records.write_failed',
  COMPACTION_FAILED: 'compaction.failed',
  COMPACTION_UNABLE: 'compaction.unable',

  BACKGROUND_TASK_ID_EMPTY: 'background.task_id_empty',
  MCP_SERVER_NOT_FOUND: 'mcp.server_not_found',
  MCP_SERVER_DISABLED: 'mcp.server_disabled',
  MCP_STARTUP_FAILED: 'mcp.startup_failed',
  MCP_TOOL_NAME_COLLISION: 'mcp.tool_name_collision',

  PLUGIN_NOT_FOUND: 'plugin.not_found',
  PLUGIN_LOAD_FAILED: 'plugin.load_failed',

  REQUEST_INVALID: 'request.invalid',
  REQUEST_WORK_DIR_REQUIRED: 'request.work_dir_required',
  REQUEST_PROMPT_INPUT_EMPTY: 'request.prompt_input_empty',

  SHELL_GIT_BASH_NOT_FOUND: 'shell.git_bash_not_found',

  NOT_IMPLEMENTED: 'not_implemented',
  INTERNAL: 'internal',
} as const;

export type KimiErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface KimiErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  /**
   * Whether the code is a stable public contract. `false` reserves the
   * right to rename or remove without a major version bump.
   */
  readonly public: boolean;
  readonly action?: string;
}

export const KIMI_ERROR_INFO = {
  'config.invalid': {
    title: 'Invalid configuration',
    retryable: false,
    public: true,
    action: 'Check config.toml and provider/model settings.',
  },

  'session.not_found': {
    title: 'Session not found',
    retryable: false,
    public: true,
    action: 'Check the session id or list available sessions.',
  },
  'session.already_exists': {
    title: 'Session already exists',
    retryable: false,
    public: true,
    action: 'Use a different session id or remove the existing session first.',
  },
  'session.id_invalid': {
    title: 'Invalid session id',
    retryable: false,
    public: true,
    action: 'Use a session id without path-traversal characters.',
  },
  'session.id_required': {
    title: 'Session id required',
    retryable: false,
    public: true,
    action: 'Provide a session id when calling this method.',
  },
  'session.id_empty': {
    title: 'Session id is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty session id.',
  },
  'session.title_empty': {
    title: 'Session title is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty session title.',
  },
  'session.state_not_found': {
    title: 'Session state missing',
    retryable: false,
    public: true,
    action: 'The session directory is corrupted or missing state.json.',
  },
  'session.state_invalid': {
    title: 'Session state invalid',
    retryable: false,
    public: true,
    action: 'The session state.json is corrupted; remove the session or repair the file.',
  },
  'session.fork_active_turn': {
    title: 'Cannot fork session during active turn',
    retryable: true,
    public: true,
    action: 'Wait for the active turn to complete before forking.',
  },
  'session.export_not_found': {
    title: 'Session export directory missing',
    retryable: false,
    public: true,
    action: 'The session has not been persisted to disk yet.',
  },
  'session.export_missing_version': {
    title: 'Export version is missing',
    retryable: false,
    public: true,
    action: 'Provide a version when exporting the session.',
  },
  'session.closed': {
    title: 'Session is closed',
    retryable: false,
    public: true,
    action: 'Create a new session.',
  },
  'session.permission_mode_invalid': {
    title: 'Invalid permission mode',
    retryable: false,
    public: true,
    action: 'Use one of: yolo / manual / auto.',
  },
  'session.thinking_empty': {
    title: 'Thinking value is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty thinking option.',
  },
  'session.model_empty': {
    title: 'Model is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty model identifier.',
  },
  'session.plan_mode_invalid': {
    title: 'Invalid plan mode',
    retryable: false,
    public: true,
    action: 'Provide a boolean plan mode.',
  },
  'session.approval_handler_error': {
    title: 'Approval handler threw',
    retryable: false,
    public: true,
    action: 'Inspect the SDK approval handler for an unhandled exception.',
  },
  'session.question_handler_error': {
    title: 'Question handler threw',
    retryable: false,
    public: true,
    action: 'Inspect the SDK question handler for an unhandled exception.',
  },
  'session.init_failed': {
    title: 'Session init failed',
    retryable: false,
    public: false,
    action: 'Review the init failure details and try again.',
  },

  'agent.not_found': {
    title: 'Agent not found',
    retryable: false,
    public: true,
    action: 'Check the agent id or list available agents.',
  },
  'turn.agent_busy': {
    title: 'Agent is busy',
    retryable: true,
    public: true,
    action: 'Wait for the current turn to finish or steer it.',
  },

  'goal.already_exists': {
    title: 'A goal is already active',
    retryable: false,
    public: true,
    action: 'Use `/goal replace <objective>` to replace the current goal.',
  },
  'goal.not_found': {
    title: 'No goal found',
    retryable: false,
    public: true,
    action: 'Start a goal with `/goal <objective>` first.',
  },
  'goal.objective_empty': {
    title: 'Goal objective is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty objective.',
  },
  'goal.objective_too_long': {
    title: 'Goal objective is too long',
    retryable: false,
    public: true,
    action: 'Keep the objective under 4000 characters; reference long details by file path.',
  },
  'goal.status_invalid': {
    title: 'Invalid goal status transition',
    retryable: false,
    public: true,
    action: 'Use a status allowed for this actor (complete, blocked, or impossible).',
  },
  'goal.metadata_reserved': {
    title: 'Goal metadata is reserved',
    retryable: false,
    public: true,
    action: 'Do not write metadata.custom.goal directly; use the goal lifecycle methods.',
  },
  'goal.not_resumable': {
    title: 'Goal is not resumable',
    retryable: false,
    public: true,
    action: 'Only paused goals can be resumed.',
  },

  'model.not_configured': {
    title: 'No model configured',
    retryable: false,
    public: true,
    action: 'Set a default model in config.toml or via setModel.',
  },
  'model.config_invalid': {
    title: 'Invalid model configuration',
    retryable: false,
    public: true,
    action: 'Check the model and provider entries in config.toml.',
  },
  'auth.login_required': {
    title: 'Login required',
    retryable: false,
    public: true,
    action: 'Run the login flow for the provider before retrying.',
  },

  'context.overflow': {
    title: 'Context window overflow',
    retryable: true,
    public: true,
    action: 'Compact the conversation or start a new session.',
  },
  'loop.max_steps_exceeded': {
    title: 'Turn exceeded max steps',
    retryable: false,
    public: true,
    action: 'Increase loop_control.max_steps_per_turn in config.toml or split the task.',
  },
  'provider.api_error': {
    title: 'Provider API error',
    retryable: false,
    public: true,
    action: 'Inspect details.statusCode / details.requestId; check provider status.',
  },
  'provider.rate_limit': {
    title: 'Provider rate limit',
    retryable: true,
    public: true,
    action: 'Retry after a delay or reduce request frequency.',
  },
  'provider.auth_error': {
    title: 'Provider authentication error',
    retryable: false,
    public: true,
    action: 'Re-authenticate with the provider.',
  },
  'provider.connection_error': {
    title: 'Provider connection error',
    retryable: true,
    public: true,
    action: 'Check network connectivity and retry.',
  },

  'skill.not_found': {
    title: 'Skill not found',
    retryable: false,
    public: true,
    action: 'List available skills via the skill registry.',
  },
  'skill.type_unsupported': {
    title: 'Skill type not supported',
    retryable: false,
    public: true,
    action: 'Only inline skills can be activated by the user.',
  },
  'skill.name_empty': {
    title: 'Skill name is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty skill name.',
  },

  'records.write_failed': {
    title: 'Failed to write records',
    retryable: true,
    public: true,
    action: 'Check disk space and permissions on the session directory.',
  },
  'compaction.failed': {
    title: 'Compaction failed',
    retryable: false,
    public: true,
    action: 'Inspect logs and consider increasing compaction limits.',
  },
  'compaction.unable': {
    title: 'Unable to compact',
    retryable: false,
    public: true,
    action: 'The current history has no prefix that can be compacted (e.g. only a pending user message). Start a new turn or session instead.',
  },

  'background.task_id_empty': {
    title: 'Background task id is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty task id.',
  },
  'mcp.server_not_found': {
    title: 'MCP server not found',
    retryable: false,
    public: true,
    action: 'List configured MCP servers and check the requested name.',
  },
  'mcp.server_disabled': {
    title: 'MCP server is disabled',
    retryable: false,
    public: true,
    action: 'Enable the MCP server entry in config before reconnecting.',
  },
  'mcp.startup_failed': {
    title: 'MCP server startup failed',
    retryable: true,
    public: true,
    action: 'Inspect the MCP server log or call reconnect once the server is healthy.',
  },
  'mcp.tool_name_collision': {
    title: 'MCP tool name collision',
    retryable: false,
    public: true,
    action: 'Rename one of the colliding MCP tools or servers so their qualified names are unique.',
  },

  'plugin.not_found': {
    title: 'Plugin not found',
    retryable: false,
    public: true,
    action: 'List installed plugins via /plugins and check the requested id.',
  },
  'plugin.load_failed': {
    title: 'Plugin state failed to load',
    retryable: true,
    public: true,
    action: 'Fix the installed.json file under $KIMI_CODE_HOME/plugins/ and run /plugins reload.',
  },

  'request.invalid': {
    title: 'Invalid request',
    retryable: false,
    public: true,
    action: 'Check the input shape matches the API contract.',
  },
  'request.work_dir_required': {
    title: 'workDir is required',
    retryable: false,
    public: true,
    action: 'Provide workDir in the request payload.',
  },
  'request.prompt_input_empty': {
    title: 'Prompt input is empty',
    retryable: false,
    public: true,
    action: 'Provide non-empty prompt input.',
  },

  'shell.git_bash_not_found': {
    title: 'Git Bash not found',
    retryable: false,
    public: true,
    action: 'Install Git for Windows from https://gitforwindows.org/ or set KIMI_SHELL_PATH to a bash.exe.',
  },

  not_implemented: {
    title: 'Not implemented',
    retryable: false,
    public: true,
    action: 'This feature is not implemented yet.',
  },
  internal: {
    title: 'Internal error',
    retryable: false,
    public: true,
    action: 'Inspect logs or report the issue with diagnostics.',
  },
} as const satisfies Record<KimiErrorCode, KimiErrorInfo>;
