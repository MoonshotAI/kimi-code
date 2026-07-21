/**
 * Error facade — aggregates every domain's error contribution into the unified
 * `ErrorCodes` const and re-exports the error primitives.
 *
 * Importing this module registers every domain's codes (each domain self-
 * registers on import). Throw sites and cross-domain consumers should import
 * from here: `import { ErrorCodes, Error2 } from '#/errors'`.
 */

import { CoreErrors } from '#/_base/errors/codes';
import { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
import { AuthErrors } from '#/app/auth/errors';
import { TaskErrors } from '#/agent/task/errors';
import { ProtocolErrors } from '#/kosong/protocol/errors';
import { ConfigErrors } from '#/app/config/errors';
import { FileErrors } from '#/app/file/fileService';
import { FsErrors } from '#/session/sessionFs/errors';
import { FullCompactionErrors } from '#/agent/fullCompaction/errors';
import { GoalErrors } from '#/agent/goal/errors';
import { LoopErrors } from '#/agent/loop/errors';
import { McpErrors } from '#/agent/mcp/errors';
import { MessageLegacyErrors } from '#/app/messageLegacy/errors';
import { ModelCatalogErrors } from '#/kosong/model/errors';
import { OsFsErrors } from '#/os/interface/hostFsErrors';
import { OsProcessErrors } from '#/os/interface/hostProcess';
import { PluginErrors } from '#/app/plugin/errors';
import { ProfileErrors } from '#/agent/profile/errors';
import { PromptErrors } from '#/agent/prompt/errors';
import { SessionExportErrors } from '#/app/sessionExport/errors';
import { SessionErrors } from '#/session/errors';
import { SkillErrors } from '#/app/skillCatalog/errors';
import { StorageErrors } from '#/persistence/interface/storage';
import { TerminalErrors } from '#/os/interface/terminalErrors';
import { UsageErrors } from '#/agent/usage/errors';
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
export { ProtocolErrors } from '#/kosong/protocol/errors';
export { ConfigErrors } from '#/app/config/errors';
export { FileErrors } from '#/app/file/fileService';
export { FsErrors } from '#/session/sessionFs/errors';
export { FullCompactionErrors } from '#/agent/fullCompaction/errors';
export { GoalErrors } from '#/agent/goal/errors';
export { LoopErrors } from '#/agent/loop/errors';
export { McpErrors } from '#/agent/mcp/errors';
export { MessageLegacyErrors } from '#/app/messageLegacy/errors';
export { ModelCatalogErrors } from '#/kosong/model/errors';
export { OsFsErrors } from '#/os/interface/hostFsErrors';
export { OsProcessErrors } from '#/os/interface/hostProcess';
export { PluginErrors } from '#/app/plugin/errors';
export { ProfileErrors } from '#/agent/profile/errors';
export { PromptErrors } from '#/agent/prompt/errors';
export { SessionExportErrors } from '#/app/sessionExport/errors';
export { SessionErrors } from '#/session/errors';
export { SkillErrors } from '#/app/skillCatalog/errors';
export { StorageErrors } from '#/persistence/interface/storage';
export { TerminalErrors } from '#/os/interface/terminalErrors';
export { UsageErrors } from '#/agent/usage/errors';
export { WireErrors } from '#/wire/errors';
export { WorkspaceErrors } from '#/app/workspace/errors';

export const ErrorCodes = {
  ...CoreErrors.codes,
  ...AgentLifecycleErrors.codes,
  ...AuthErrors.codes,
  ...TaskErrors.codes,
  ...ProtocolErrors.codes,
  ...ConfigErrors.codes,
  ...FileErrors.codes,
  ...FsErrors.codes,
  ...FullCompactionErrors.codes,
  ...GoalErrors.codes,
  ...LoopErrors.codes,
  ...McpErrors.codes,
  ...MessageLegacyErrors.codes,
  ...ModelCatalogErrors.codes,
  ...OsFsErrors.codes,
  ...OsProcessErrors.codes,
  ...PluginErrors.codes,
  ...ProfileErrors.codes,
  ...PromptErrors.codes,
  ...SessionExportErrors.codes,
  ...SessionErrors.codes,
  ...SkillErrors.codes,
  ...StorageErrors.codes,
  ...TerminalErrors.codes,
  ...UsageErrors.codes,
  ...WireErrors.codes,
  ...WorkspaceErrors.codes,
} as const;

/**
 * The closed union of every error code a Kimi domain may throw — derived from
 * the `ErrorCodes` aggregate rather than declared centrally, so each domain's
 * `errors.ts` is the single source of truth: adding or renaming a code is a
 * domain-local change with no central list to keep in sync.
 */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
