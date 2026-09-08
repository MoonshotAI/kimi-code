import { CoreErrors } from '#/_base/errors/codes';
import type { KimiErrorPayload } from '#/_base/errors/serialize';
import { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
import { AuthErrors } from '#/app/auth/errors';
import { TaskErrors } from '#/agent/task/errors';
import { ProtocolErrors } from '#/llm-adapter/protocol/errors';
import { ConfigErrors } from '#/app/config/errors';
import { CapabilityErrors } from '#/app/capability/errors';
import { CronErrors } from '#/features/cron/errors';
import { DebugErrors } from '#/debug/errors';
import { EventErrors } from '#/app/event/errors';
import { FileErrors } from '#/app/file/fileService';
import { FsErrors } from '#/workspace/workspaceFs/internal/errors';
import { FullCompactionErrors } from '#/agent/fullCompaction/errors';
import { GoalErrors } from '#/features/goal/errors';
import { LoopErrors } from '#/agent/loop/errors';
import { McpErrors } from '#/mcpCore/errors';
import { ModelCatalogErrors } from '#/llm-adapter/model/errors';
import { OsFsErrors } from '#/os/interface/hostFsErrors';
import { OsProcessErrors } from '#/os/interface/hostProcess';
import { PluginErrors } from '#/app/plugin/errors';
import { ProfileErrors } from '#/agent/profile/errors';
import { PromptErrors } from '#/agent/prompt/errors';
import { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
import { SessionExportErrors } from '#/app/sessionExport/errors';
import { SessionErrors } from '#/session/errors';
import { SkillErrors } from '#/features/skill/catalog/errors';
import { StateErrors } from '#/state/errors';
import { StorageErrors } from '#/persistence/interface/storage';
import { TerminalErrors } from '#/os/interface/terminalErrors';
import { UsageErrors } from '#/agent/usage/errors';
import { WebErrors } from '#/app/web/errors';
import { WireErrors } from '#/wire/errors';
import { WorkspaceErrors } from '#/app/workspace/errors';

export * from '#/_base/errors/codes';
export * from '#/_base/errors/errorMessage';
export * from '#/_base/errors/errors';
export * from '#/_base/errors/serialize';
export * from '#/_base/errors/unexpectedError';
export { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
export { AuthErrors } from '#/app/auth/errors';
export { TaskErrors } from '#/agent/task/errors';
export { ProtocolErrors } from '#/llm-adapter/protocol/errors';
export { ConfigErrors } from '#/app/config/errors';
export { CapabilityErrors } from '#/app/capability/errors';
export { CronErrors } from '#/features/cron/errors';
export { DebugErrors } from '#/debug/errors';
export { FileErrors } from '#/app/file/fileService';
export { FsErrors } from '#/workspace/workspaceFs/internal/errors';
export { FullCompactionErrors } from '#/agent/fullCompaction/errors';
export { GoalErrors } from '#/features/goal/errors';
export { LoopErrors } from '#/agent/loop/errors';
export { McpErrors } from '#/mcpCore/errors';
export { ModelCatalogErrors } from '#/llm-adapter/model/errors';
export { OsFsErrors } from '#/os/interface/hostFsErrors';
export { OsProcessErrors } from '#/os/interface/hostProcess';
export { PluginErrors } from '#/app/plugin/errors';
export { ProfileErrors } from '#/agent/profile/errors';
export { PromptErrors } from '#/agent/prompt/errors';
export { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
export { SessionExportErrors } from '#/app/sessionExport/errors';
export { SessionErrors } from '#/session/errors';
export { SkillErrors } from '#/features/skill/catalog/errors';
export { StorageErrors } from '#/persistence/interface/storage';
export { TerminalErrors } from '#/os/interface/terminalErrors';
export { UsageErrors } from '#/agent/usage/errors';
export { WebErrors } from '#/app/web/errors';
export { WireErrors } from '#/wire/errors';
export { WorkspaceErrors } from '#/app/workspace/errors';
export { EventErrors } from '#/app/event/errors';
export { StateErrors } from '#/state/errors';

export const ErrorCodes = {
  ...CoreErrors.codes,
  ...AgentLifecycleErrors.codes,
  ...AuthErrors.codes,
  ...TaskErrors.codes,
  ...ProtocolErrors.codes,
  ...ConfigErrors.codes,
  ...CapabilityErrors.codes,
  ...CronErrors.codes,
  ...DebugErrors.codes,
  ...FileErrors.codes,
  ...FsErrors.codes,
  ...FullCompactionErrors.codes,
  ...GoalErrors.codes,
  ...LoopErrors.codes,
  ...McpErrors.codes,
  ...ModelCatalogErrors.codes,
  ...OsFsErrors.codes,
  ...OsProcessErrors.codes,
  ...PluginErrors.codes,
  ...ProfileErrors.codes,
  ...PromptErrors.codes,
  ...ModelsDevImportErrors.codes,
  ...SessionExportErrors.codes,
  ...SessionErrors.codes,
  ...SkillErrors.codes,
  ...StorageErrors.codes,
  ...TerminalErrors.codes,
  ...UsageErrors.codes,
  ...WebErrors.codes,
  ...WireErrors.codes,
  ...WorkspaceErrors.codes,
  ...EventErrors.codes,
  ...StateErrors.codes,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type KimiErrorCode =
  | 'config.invalid'
  | 'config.persist_blocked'
  | 'session.not_found'
  | 'session.already_exists'
  | 'session.id_invalid'
  | 'session.id_required'
  | 'session.id_empty'
  | 'session.title_empty'
  | 'session.state_not_found'
  | 'session.state_invalid'
  | 'session.fork_active_turn'
  | 'session.undo_unavailable'
  | 'session.export_not_found'
  | 'session.export_missing_version'
  | 'session.export_output_conflict'
  | 'session.export_too_large'
  | 'session.closed'
  | 'session.permission_mode_invalid'
  | 'session.thinking_empty'
  | 'session.model_empty'
  | 'session.plan_mode_invalid'
  | 'session.approval_handler_error'
  | 'session.question_handler_error'
  | 'session.init_failed'
  | 'agent.not_found'
  | 'agent.already_exists'
  | 'agent.already_running'
  | 'agent.not_a_subagent'
  | 'agent.not_owned'
  | 'agent.type_not_allowed'
  | 'agent.max_tokens_exceeded'
  | 'turn.agent_busy'
  | 'goal.already_exists'
  | 'goal.not_found'
  | 'goal.objective_empty'
  | 'goal.objective_too_long'
  | 'goal.status_invalid'
  | 'goal.metadata_reserved'
  | 'goal.not_resumable'
  | 'goal.unsupported_agent'
  | 'model.not_configured'
  | 'model.config_invalid'
  | 'profile.thinking_alias_conflict'
  | 'profile.unknown'
  | 'profile.already_bound'
  | 'profile.not_bound'
  | 'model.not_found'
  | 'auth.login_required'
  | 'auth.provisioning_required'
  | 'auth.token_missing'
  | 'auth.token_unauthorized'
  | 'auth.model_not_resolved'
  | 'context.overflow'
  | 'loop.max_steps_exceeded'
  | 'provider.api_error'
  | 'provider.filtered'
  | 'provider.rate_limit'
  | 'provider.auth_error'
  | 'provider.connection_error'
  | 'provider.overloaded'
  | 'provider.not_found'
  | 'skill.not_found'
  | 'skill.type_unsupported'
  | 'skill.name_empty'
  | 'skill.parse_failed'
  | 'skill.nested_too_deep'
  | 'records.write_failed'
  | 'compaction.failed'
  | 'compaction.unable'
  | 'task.task_id_empty'
  | 'task.limit_exceeded'
  | 'usage.turn_id_conflict'
  | 'mcp.server_not_found'
  | 'mcp.server_disabled'
  | 'mcp.startup_failed'
  | 'mcp.tool_name_collision'
  | 'mcp.oauth_failed'
  | 'message.not_found'
  | 'plugin.not_found'
  | 'plugin.load_failed'
  | 'request.invalid'
  | 'request.work_dir_required'
  | 'request.prompt_input_empty'
  | 'prompt.id_conflict'
  | 'prompt.not_found'
  | 'prompt.already_completed'
  | 'session.busy'
  | 'shell.git_bash_not_found'
  | 'workspace.not_found'
  | 'terminal.not_found'
  | 'file.not_found'
  | 'file.too_large'
  | 'fs.path_not_found'
  | 'fs.permission_denied'
  | 'fs.path_escapes'
  | 'fs.is_directory'
  | 'fs.is_binary'
  | 'fs.too_large'
  | 'fs.already_exists'
  | 'fs.too_many_results'
  | 'fs.grep_timeout'
  | 'fs.git_unavailable'
  | 'os.fs.not_found'
  | 'os.fs.is_directory'
  | 'os.fs.not_directory'
  | 'os.fs.already_exists'
  | 'os.fs.permission_denied'
  | 'os.fs.not_empty'
  | 'os.fs.unavailable'
  | 'os.fs.unknown'
  | 'os.process.spawn_failed'
  | 'os.process.kill_failed'
  | 'storage.not_found'
  | 'storage.decode_failed'
  | 'storage.corrupted'
  | 'storage.io_failed'
  | 'storage.locked'
  | 'storage.permission_denied'
  | 'storage.disk_full'
  | 'wire.duplicate_op'
  | 'wire.cycle'
  | 'wire.unknown_record'
  | 'wire.migration_missing'
  | 'cron.expression_invalid'
  | 'web.invalid_url'
  | 'web.private_address'
  | 'web.fetch_failed'
  | 'validation.failed'
  | 'not_implemented'
  | 'internal';

export interface ErrorEvent {
  readonly type: 'error';
  readonly code: KimiErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly cause?: KimiErrorPayload;
}

export interface WarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly code?: string;
}
