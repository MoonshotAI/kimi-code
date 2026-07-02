/**
 * Error facade — aggregates every domain's error contribution into the unified
 * `ErrorCodes` const and re-exports the error primitives.
 *
 * Importing this module registers every domain's codes (each domain self-
 * registers on import). Throw sites and cross-domain consumers should import
 * from here: `import { ErrorCodes, KimiError } from '#/errors'`.
 */

import { CoreErrors } from '#/_base/errors';
import { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
import { AuthErrors } from '#/app/auth/errors';
import { BackgroundErrors } from '#/agent/background/errors';
import { ChatProviderErrors } from '#/app/protocol/errors';
import { ConfigErrors } from '#/app/config/errors';
import { FileErrors } from '#/app/filestore/errors';
import { FsErrors } from '#/session/agentFs/errors';
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
import { SessionErrors } from '#/session/session/errors';
import { SkillErrors } from '#/app/globalSkillCatalog/errors';
import { TerminalErrors } from '#/session/terminal/errors';
import { TurnErrors } from '#/agent/turn/errors';
import { WireRecordErrors } from '#/agent/wireRecord/errors';

export * from '#/_base/errors';
export { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
export { AuthErrors } from '#/app/auth/errors';
export { BackgroundErrors } from '#/agent/background/errors';
export { ChatProviderErrors } from '#/app/protocol/errors';
export { ConfigErrors } from '#/app/config/errors';
export { FileErrors } from '#/app/filestore/errors';
export { FsErrors } from '#/session/agentFs/errors';
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
export { SessionErrors } from '#/session/session/errors';
export { SkillErrors } from '#/app/globalSkillCatalog/errors';
export { TerminalErrors } from '#/session/terminal/errors';
export { TurnErrors } from '#/agent/turn/errors';
export { WireRecordErrors } from '#/agent/wireRecord/errors';

export const ErrorCodes = {
  ...CoreErrors.codes,
  ...AgentLifecycleErrors.codes,
  ...AuthErrors.codes,
  ...BackgroundErrors.codes,
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
  ...SessionErrors.codes,
  ...SkillErrors.codes,
  ...TerminalErrors.codes,
  ...TurnErrors.codes,
  ...WireRecordErrors.codes,
} as const;
