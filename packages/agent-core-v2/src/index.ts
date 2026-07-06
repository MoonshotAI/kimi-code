/**
 * agent-core-v2 public surface — re-exports every domain barrel (grouped by
 * layer) so importing the package loads all scoped-registry registrations.
 */

export * from './_base/di/index';
export * from './errors';

export * from '#/_base/log';
export {
  IAgentWireService,
  ISessionWireService,
  type IWireService,
  type WireEmission,
} from '#/wire';
export * from '#/session/sessionLog';
export * from '#/app/telemetry';
export * from '#/app/bootstrap';
export * from '#/os/interface';
export * from '#/os/backends/node-local';
export * from '#/session/terminal';
export * from '#/app/task';
export { IEventService, IEventBus, type DomainEvent, type GlobalEvent } from '#/app/event';
export * from '#/app/llmProtocol';

export * from '#/app/sessionIndex';
export * from '#/session/sessionMetadata';
export * from '#/app/config';
export * from '#/app/provider';
export * from '#/app/platform';
export * from '#/app/protocol';
export * from '#/app/model';
export * from '#/app/modelCatalog';
export * from '#/app/agentProfileCatalog';
export * from '#/app/plugin';

export type { SkillSource } from '#/app/skillCatalog';
export * from '#/agent/skill';
export * from '#/app/skillCatalog';
export * from '#/session/sessionSkillCatalog';
export * from '#/agent/permissionGate';
import '#/app/flag';
export * from '#/app/flag';

import '#/agent/turn';
export * from '#/agent/plan';
export * from '#/agent/goal';
export * from '#/agent/swarm';
export * from '#/agent/usage';
export * from '#/agent/toolDedupe';

export * from '#/agent/task';
export * from '#/app/cron';
export * from '#/session/cron';

export * from '#/session/agentLifecycle';
export * from '#/app/sessionLifecycle';
export * from '#/app/sessionLegacy';
export * from '#/session/interaction';
export * from '#/session/sessionContext';
export * from '#/session/sessionActivity';

import '#/session/approval';
export { ISessionApprovalService } from '#/session/approval';
export * from '#/session/question';
export * from '#/agent/questionTools';
export * from '#/app/gateway';

export * from '#/session/workspaceContext';
export * from '#/app/workspaceRegistry';
export * from '#/session/process';
export * from '#/session/sessionFs';
export * from '#/app/hostFolderBrowser';
export * from '#/persistence/interface';
export * from '#/persistence/backends/node-fs';
export * from '#/persistence/backends/minidb';
export * from '#/persistence/backends/memory';
export * from '#/app/auth';
export * from '#/app/authLegacy';
export * from '#/app/file';
export * from '#/app/edit';
export * from '#/app/web';

// Ported agent services. These keep the current service boundaries during the migration.
export * from '#/agent/blob';
export * from '#/agent/contextMemory';
export * from '#/agent/systemReminder';
export * from '#/agent/contextProjector';
export * from '#/agent/contextSize';
export * from '#/agent/contextInjector';
export * from '#/agent/externalHooks';
export * from '#/agent/fullCompaction';
export * from '#/agent/llmRequester';
export * from '#/agent/loop';
export * from '#/agent/mcp';
export * from '#/agent/microCompaction';
export * from '#/agent/permissionMode';
export * from '#/agent/permissionPolicy';
export * from '#/agent/permissionRules';
export * from '#/agent/profile';
export * from '#/agent/prompt';
export * from '#/agent/promptLegacy';
export * from '#/app/messageLegacy';
export * from '#/agent/replayBuilder';
export * from '#/agent/rpc';
export * from '#/agent/scopeContext';
export * from '#/session/btw';
export * from '#/session/swarm';
export * from '#/session/todo';
export * from '#/agent/tool';
export * from '#/agent/toolExecutor';
import '#/agent/toolRegistry';
export {
  IAgentBuiltinToolsRegistrar,
  IAgentToolRegistryService,
  registerTool,
} from '#/agent/toolRegistry';
export type { ToolContribution, ToolContributionOptions } from '#/agent/toolRegistry';
export * from '#/agent/toolState';
export * from '#/agent/userTool';
export * from '#/agent/wireRecord';
