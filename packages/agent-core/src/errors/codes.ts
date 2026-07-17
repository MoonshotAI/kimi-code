import { t } from './i18n/index';

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
  PROVIDER_FILTERED: 'provider.filtered',
  PROVIDER_RATE_LIMIT: 'provider.rate_limit',
  PROVIDER_AUTH_ERROR: 'provider.auth_error',
  PROVIDER_CONNECTION_ERROR: 'provider.connection_error',

  SKILL_NOT_FOUND: 'skill.not_found',
  SKILL_TYPE_UNSUPPORTED: 'skill.type_unsupported',
  SKILL_NAME_EMPTY: 'skill.name_empty',

  RECORDS_WRITE_FAILED: 'records.write_failed',
  COMPACTION_FAILED: 'compaction.failed',
  COMPACTION_UNABLE: 'compaction.unable',

  BACKGROUND_TASK_ID_EMPTY: 'task.task_id_empty',
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
  readonly titleKey: string;
  readonly retryable: boolean;
  /**
   * Whether the code is a stable public contract. `false` reserves the
   * right to rename or remove without a major version bump.
   */
  readonly public: boolean;
}

export const KIMI_ERROR_INFO = {
  'config.invalid': {
    titleKey: 'errors.configInvalid',
    retryable: false,
    public: true,
  },

  'session.not_found': {
    titleKey: 'errors.sessionNotFound',
    retryable: false,
    public: true,
  },
  'session.already_exists': {
    titleKey: 'errors.sessionAlreadyExists',
    retryable: false,
    public: true,
  },
  'session.id_invalid': {
    titleKey: 'errors.sessionIdInvalid',
    retryable: false,
    public: true,
  },
  'session.id_required': {
    titleKey: 'errors.sessionIdRequired',
    retryable: false,
    public: true,
  },
  'session.id_empty': {
    titleKey: 'errors.sessionIdEmpty',
    retryable: false,
    public: true,
  },
  'session.title_empty': {
    titleKey: 'errors.sessionTitleEmpty',
    retryable: false,
    public: true,
  },
  'session.state_not_found': {
    titleKey: 'errors.sessionStateNotFound',
    retryable: false,
    public: true,
  },
  'session.state_invalid': {
    titleKey: 'errors.sessionStateInvalid',
    retryable: false,
    public: true,
  },
  'session.fork_active_turn': {
    titleKey: 'errors.sessionForkActiveTurn',
    retryable: true,
    public: true,
  },
  'session.export_not_found': {
    titleKey: 'errors.sessionExportNotFound',
    retryable: false,
    public: true,
  },
  'session.export_missing_version': {
    titleKey: 'errors.sessionExportMissingVersion',
    retryable: false,
    public: true,
  },
  'session.closed': {
    titleKey: 'errors.sessionClosed',
    retryable: false,
    public: true,
  },
  'session.permission_mode_invalid': {
    titleKey: 'errors.sessionPermissionModeInvalid',
    retryable: false,
    public: true,
  },
  'session.thinking_empty': {
    titleKey: 'errors.sessionThinkingEmpty',
    retryable: false,
    public: true,
  },
  'session.model_empty': {
    titleKey: 'errors.sessionModelEmpty',
    retryable: false,
    public: true,
  },
  'session.plan_mode_invalid': {
    titleKey: 'errors.sessionPlanModeInvalid',
    retryable: false,
    public: true,
  },
  'session.approval_handler_error': {
    titleKey: 'errors.sessionApprovalHandlerError',
    retryable: false,
    public: true,
  },
  'session.question_handler_error': {
    titleKey: 'errors.sessionQuestionHandlerError',
    retryable: false,
    public: true,
  },
  'session.init_failed': {
    titleKey: 'errors.sessionInitFailed',
    retryable: false,
    public: false,
  },

  'agent.not_found': {
    titleKey: 'errors.agentNotFound',
    retryable: false,
    public: true,
  },
  'turn.agent_busy': {
    titleKey: 'errors.turnAgentBusy',
    retryable: true,
    public: true,
  },

  'goal.already_exists': {
    titleKey: 'errors.goalAlreadyExists',
    retryable: false,
    public: true,
  },
  'goal.not_found': {
    titleKey: 'errors.goalNotFound',
    retryable: false,
    public: true,
  },
  'goal.objective_empty': {
    titleKey: 'errors.goalObjectiveEmpty',
    retryable: false,
    public: true,
  },
  'goal.objective_too_long': {
    titleKey: 'errors.goalObjectiveTooLong',
    retryable: false,
    public: true,
  },
  'goal.status_invalid': {
    titleKey: 'errors.goalStatusInvalid',
    retryable: false,
    public: true,
  },
  'goal.metadata_reserved': {
    titleKey: 'errors.goalMetadataReserved',
    retryable: false,
    public: true,
  },
  'goal.not_resumable': {
    titleKey: 'errors.goalNotResumable',
    retryable: false,
    public: true,
  },

  'model.not_configured': {
    titleKey: 'errors.modelNotConfigured',
    retryable: false,
    public: true,
  },
  'model.config_invalid': {
    titleKey: 'errors.modelConfigInvalid',
    retryable: false,
    public: true,
  },
  'auth.login_required': {
    titleKey: 'errors.authLoginRequired',
    retryable: false,
    public: true,
  },

  'context.overflow': {
    titleKey: 'errors.contextOverflow',
    retryable: true,
    public: true,
  },
  'loop.max_steps_exceeded': {
    titleKey: 'errors.loopMaxStepsExceeded',
    retryable: false,
    public: true,
  },
  'provider.api_error': {
    titleKey: 'errors.providerApiError',
    retryable: false,
    public: true,
  },
  'provider.filtered': {
    titleKey: 'errors.providerFiltered',
    retryable: false,
    public: true,
  },
  'provider.rate_limit': {
    titleKey: 'errors.providerRateLimit',
    retryable: true,
    public: true,
  },
  'provider.auth_error': {
    titleKey: 'errors.providerAuthError',
    retryable: false,
    public: true,
  },
  'provider.connection_error': {
    titleKey: 'errors.providerConnectionError',
    retryable: true,
    public: true,
  },

  'skill.not_found': {
    titleKey: 'errors.skillNotFound',
    retryable: false,
    public: true,
  },
  'skill.type_unsupported': {
    titleKey: 'errors.skillTypeUnsupported',
    retryable: false,
    public: true,
  },
  'skill.name_empty': {
    titleKey: 'errors.skillNameEmpty',
    retryable: false,
    public: true,
  },

  'records.write_failed': {
    titleKey: 'errors.recordsWriteFailed',
    retryable: true,
    public: true,
  },
  'compaction.failed': {
    titleKey: 'errors.compactionFailed',
    retryable: false,
    public: true,
  },
  'compaction.unable': {
    titleKey: 'errors.compactionUnable',
    retryable: false,
    public: true,
  },

  'task.task_id_empty': {
    titleKey: 'errors.taskTaskIdEmpty',
    retryable: false,
    public: true,
  },
  'mcp.server_not_found': {
    titleKey: 'errors.mcpServerNotFound',
    retryable: false,
    public: true,
  },
  'mcp.server_disabled': {
    titleKey: 'errors.mcpServerDisabled',
    retryable: false,
    public: true,
  },
  'mcp.startup_failed': {
    titleKey: 'errors.mcpStartupFailed',
    retryable: true,
    public: true,
  },
  'mcp.tool_name_collision': {
    titleKey: 'errors.mcpToolNameCollision',
    retryable: false,
    public: true,
  },

  'plugin.not_found': {
    titleKey: 'errors.pluginNotFound',
    retryable: false,
    public: true,
  },
  'plugin.load_failed': {
    titleKey: 'errors.pluginLoadFailed',
    retryable: true,
    public: true,
  },

  'request.invalid': {
    titleKey: 'errors.requestInvalid',
    retryable: false,
    public: true,
  },
  'request.work_dir_required': {
    titleKey: 'errors.requestWorkDirRequired',
    retryable: false,
    public: true,
  },
  'request.prompt_input_empty': {
    titleKey: 'errors.requestPromptInputEmpty',
    retryable: false,
    public: true,
  },

  'shell.git_bash_not_found': {
    titleKey: 'errors.shellGitBashNotFound',
    retryable: false,
    public: true,
  },

  not_implemented: {
    titleKey: 'errors.notImplemented',
    retryable: false,
    public: true,
  },
  internal: {
    titleKey: 'errors.internal',
    retryable: false,
    public: true,
  },
} as const satisfies Record<KimiErrorCode, KimiErrorInfo>;

/** Resolve the localized title for an error code. */
export function resolveErrorTitle(code: KimiErrorCode): string {
  const info = KIMI_ERROR_INFO[code];
  return info ? t(info.titleKey) : code;
}

