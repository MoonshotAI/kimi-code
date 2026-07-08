/**
 * Error facade — aggregates every domain's error contribution into the unified
 * `ErrorCodes` const and re-exports the error primitives.
 *
 * Importing this module registers every domain's codes (each domain self-
 * registers on import). Throw sites and cross-domain consumers should import
 * from here: `import { ErrorCodes, KimiError } from '#/errors'`.
 */

import { CoreErrors } from '#/_base/errors/codes';
import { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
import { AuthErrors } from '#/app/auth/errors';
import { TaskErrors } from '#/agent/task/errors';
import { ChatProviderErrors } from '#/app/protocol/errors';
import { ConfigErrors } from '#/app/config/errors';
import { FileErrors } from '#/app/file/fileService';
import { FsErrors } from '#/session/sessionFs/errors';
import { FullCompactionErrors } from '#/agent/fullCompaction/errors';
import { GoalErrors } from '#/agent/goal/errors';
import { LoopErrors } from '#/agent/loop/errors';
import { McpErrors } from '#/agent/mcp/errors';
import { MessageLegacyErrors } from '#/app/messageLegacy/errors';
import { ModelCatalogErrors } from '#/app/modelCatalog/errors';
import { PluginErrors } from '#/app/plugin/errors';
import { ProfileErrors } from '#/agent/profile/errors';
import { PromptErrors } from '#/agent/prompt/errors';
import { PromptLegacyErrors } from '#/agent/promptLegacy/errors';
import { SessionExportErrors } from '#/app/sessionExport/errors';
import { SessionErrors } from '#/session/errors';
import { SkillErrors } from '#/app/skillCatalog/errors';
import { TerminalErrors } from '#/os/interface/terminalErrors';
import { TurnErrors } from '#/agent/turn/errors';
import { UsageErrors } from '#/agent/usage/errors';
import { WireRecordErrors } from '#/agent/wireRecord/errors';

export * from '#/_base/errors/codes';
export * from '#/_base/errors/errorMessage';
export * from '#/_base/errors/errors';
export * from '#/_base/errors/serialize';
export * from '#/_base/errors/unexpectedError';
export { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
export { AuthErrors } from '#/app/auth/errors';
export { TaskErrors } from '#/agent/task/errors';
export { ChatProviderErrors } from '#/app/protocol/errors';
export { ConfigErrors } from '#/app/config/errors';
export { FileErrors } from '#/app/file/fileService';
export { FsErrors } from '#/session/sessionFs/errors';
export { FullCompactionErrors } from '#/agent/fullCompaction/errors';
export { GoalErrors } from '#/agent/goal/errors';
export { LoopErrors } from '#/agent/loop/errors';
export { McpErrors } from '#/agent/mcp/errors';
export { MessageLegacyErrors } from '#/app/messageLegacy/errors';
export { ModelCatalogErrors } from '#/app/modelCatalog/errors';
export { PluginErrors } from '#/app/plugin/errors';
export { ProfileErrors } from '#/agent/profile/errors';
export { PromptErrors } from '#/agent/prompt/errors';
export { PromptLegacyErrors } from '#/agent/promptLegacy/errors';
export { SessionExportErrors } from '#/app/sessionExport/errors';
export { SessionErrors } from '#/session/errors';
export { SkillErrors } from '#/app/skillCatalog/errors';
export { TerminalErrors } from '#/os/interface/terminalErrors';
export { TurnErrors } from '#/agent/turn/errors';
export { UsageErrors } from '#/agent/usage/errors';
export { WireRecordErrors } from '#/agent/wireRecord/errors';

export const ErrorCodes = {
  ...CoreErrors.codes,
  ...AgentLifecycleErrors.codes,
  ...AuthErrors.codes,
  ...TaskErrors.codes,
  ...ChatProviderErrors.codes,
  ...ConfigErrors.codes,
  ...FileErrors.codes,
  ...FsErrors.codes,
  ...FullCompactionErrors.codes,
  ...GoalErrors.codes,
  ...LoopErrors.codes,
  ...McpErrors.codes,
  ...MessageLegacyErrors.codes,
  ...ModelCatalogErrors.codes,
  ...PluginErrors.codes,
  ...ProfileErrors.codes,
  ...PromptErrors.codes,
  ...PromptLegacyErrors.codes,
  ...SessionExportErrors.codes,
  ...SessionErrors.codes,
  ...SkillErrors.codes,
  ...TerminalErrors.codes,
  ...TurnErrors.codes,
  ...UsageErrors.codes,
  ...WireRecordErrors.codes,
} as const;
