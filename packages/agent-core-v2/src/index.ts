/**
 * agent-core-v2 public surface — re-exports every domain barrel (grouped by
 * layer) so importing the package loads all scoped-registry registrations.
 */

export * from './_base/di/index';
export * from './errors';

export * from '#/app/log';
export * from '#/session/sessionLog';
export * from '#/app/telemetry';
export * from '#/app/bootstrap';
export * from '#/app/hostFs';
export { IEventService, type DomainEvent } from '#/app/event';
export * from '#/app/chatProvider';

export * from '#/app/session-index';
export * from '#/session/session-metadata';
export * from '#/app/config';
export * from '#/app/provider';
export * from '#/app/model';
export * from '#/app/modelCatalog';
export * from '#/session/modelRuntime';
export * from '#/app/plugin';

export type { SkillSource } from '#/app/globalSkillCatalog';
export * from '#/agent/skill';
export * from '#/app/globalSkillCatalog';
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

export * from '#/agent/background';
import '#/agent/cron';

export * from '#/session/agent-lifecycle';
export * from '#/app/session-lifecycle';
export * from '#/app/sessionLegacy';
export * from '#/session/interaction';
export * from '#/session/session-context';
export * from '#/session/session-activity';
export * from '#/session/session';

export * from '#/agent/eventSink';
import '#/session/approval';
export { ISessionApprovalService } from '#/session/approval';
export * from '#/session/question';
export * from '#/agent/questionTools';
export * from '#/app/gateway';

export * from '#/session/workspaceContext';
export * from '#/app/workspaceRegistry';
export * from '#/app/hostFolderBrowser';
export * from '#/app/hostEnvironment';
export * from '#/session/execContext';
export * from '#/session/agentFs';
export * from '#/session/process';
export * from '#/session/terminal';
export * from '#/app/storage';
export * from '#/app/filestore';
export * from '#/app/auth';
export * from '#/app/authLegacy';

// Ported agent services. These keep the current service boundaries during the migration.
export * from '#/agent/blobStore';
export * from '#/agent/contextMemory';
export * from '#/agent/systemReminder';
export * from '#/agent/contextProjector';
export * from '#/agent/contextSize';
export * from '#/agent/contextInjector';
export * from '#/agent/eventSink';
export * from '#/agent/externalHooks';
export * from '#/agent/fullCompaction';
export * from '#/agent/llmRequestLog';
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
export * from '#/agent/agentTool';
export * from '#/agent/todoList';
export * from '#/agent/tool';
export * from '#/agent/toolExecutor';
import '#/agent/toolRegistry';
export { IAgentToolRegistryService } from '#/agent/toolRegistry';
export * from '#/agent/toolStore';
export * from '#/agent/userTool';
export * from '#/agent/wireRecord';
export * from '#/agent/fileTools';
export * from '#/agent/shellTools';
