/**
 * agent-core-v2 public surface — re-exports every domain barrel (grouped by
 * layer) so importing the package loads all scoped-registry registrations.
 */

export * from '#/_base/di/descriptors';
export * from '#/_base/di/errors';
export * from '#/_base/di/extensions';
export * from '#/_base/di/graph';
export * from '#/_base/di/instantiation';
export * from '#/_base/di/instantiationService';
export * from '#/_base/di/lifecycle';
export * from '#/_base/di/scope';
export * from '#/_base/di/serviceCollection';
export * from './errors';

export * from '#/_base/log/log';
export * from '#/_base/log/logConfig';
export * from '#/_base/log/formatter';
export * from '#/_base/log/fileLog';
export * from '#/_base/log/logService';
export { IAgentWireService, ISessionWireService } from '#/wire/tokens';
export { type IWireService, type WireEmission } from '#/wire/wireService';
export { defineDerivedModel, type DerivedModelDef } from '#/wire/model';
export * from '#/session/sessionLog/sessionLogService';
export * from '#/app/telemetry/telemetry';
export * from '#/app/telemetry/events';
export * from '#/app/telemetry/telemetryService';
export * from '#/app/telemetry/agentTelemetryContext';
export * from '#/app/telemetry/agentTelemetryContextService';
export * from '#/app/telemetry/consoleAppender';
export * from '#/app/telemetry/cloudAppender';
export * from '#/app/bootstrap/bootstrap';
export * from '#/app/bootstrap/bootstrapService';
export * from '#/os/interface/hostEnvironment';
export * from '#/os/interface/hostFileSystem';
export * from '#/os/interface/hostFsWatch';
export * from '#/os/interface/hostProcess';
export * from '#/os/interface/terminal';
export * from '#/os/interface/terminalErrors';
export * from '#/os/backends/node-local/hostEnvironmentService';
export * from '#/os/backends/node-local/hostFsService';
export * from '#/os/backends/node-local/hostFsWatchService';
export * from '#/os/backends/node-local/hostProcessService';
export * from '#/os/backends/node-local/hostTerminalService';
export * from '#/os/backends/node-local/tools/bash';
export * from '#/os/backends/node-local/tools/glob';
export * from '#/os/backends/node-local/tools/grep';
export * from '#/os/backends/node-local/tools/read';
export * from '#/os/backends/node-local/tools/write';
export * from '#/os/interface/terminal';
export * from '#/os/interface/terminalErrors';
export * from '#/os/backends/node-local/hostTerminalService';
export * from '#/session/terminal/terminalService';
export * from '#/app/task/task';
import '#/app/task/taskService';
export { TaskService } from '#/app/task/taskService';
import '#/app/event/eventBusService';
import '#/app/event/eventService';
export { IEventBus, type DomainEvent } from '#/app/event/eventBus';
export { IEventService, type DomainEvent as GlobalEvent } from '#/app/event/event';
export * from '#/app/llmProtocol/capability';
export * from '#/app/llmProtocol/errors';
export * from '#/app/llmProtocol/finishReason';
export * from '#/app/llmProtocol/kimiOptions';
export * from '#/app/llmProtocol/message';
export * from '#/app/llmProtocol/messageHelpers';
export * from '#/app/llmProtocol/request';
export * from '#/app/llmProtocol/thinkingEffort';
export * from '#/app/llmProtocol/tool';
export * from '#/app/llmProtocol/usage';

export * from '#/app/sessionIndex/sessionIndex';
export * from '#/app/sessionIndex/sessionIndexService';
export * from '#/session/sessionMetadata/sessionMetadata';
export * from '#/session/sessionMetadata/sessionMetadataService';
export * from '#/app/config/config';
export * from '#/app/config/configService';
import '#/app/provider/configSection';
export * from '#/app/provider/provider';
export * from '#/app/provider/providerService';
import '#/app/platform/configSection';
export * from '#/app/platform/platform';
export * from '#/app/platform/platformService';
import '#/app/skillCatalog/configSection';
import '#/app/protocol/errors';
export type { ChatProvider } from '#/app/llmProtocol/provider';
export type { GenerateResult } from '#/app/llmProtocol/generate';
export { generate } from '#/app/llmProtocol/generate';
export * from '#/app/protocol/errors';
export * from '#/app/protocol/protocol';
export * from '#/app/protocol/protocolAdapterRegistry';
import '#/app/model/configSection';
import '#/app/model/envOverlay';
export * from '#/app/model/completionBudget';
export * from '#/app/model/hostRequestHeaders';
export * from '#/app/model/model';
export type {
  AuthProvider,
  LLMRequestInput,
  Model,
  LLMEvent as ModelRequestEvent,
} from '#/app/model/modelInstance';
export * from '#/app/model/modelOverrides';
export * from '#/app/model/modelResolver';
export * from '#/app/model/modelResolverService';
export * from '#/app/model/modelService';
export * from '#/app/model/thinking';
export * from '#/app/modelCatalog/configSection';
export * from '#/app/modelCatalog/modelCatalog';
export * from '#/app/modelCatalog/modelCatalogService';
export * from '#/app/agentProfileCatalog/agentProfileCatalog';
export * from '#/app/agentProfileCatalog/agentProfileCatalogService';
export * from '#/app/agentProfileCatalog/profile-shared';
export * from '#/app/agentProfileCatalog/promptPrefix';
export {
  registerAgentProfile,
  getAgentProfileContributions,
  _clearAgentProfileContributionsForTests,
} from '#/app/agentProfileCatalog/contribution';
export * from '#/app/plugin/types';
export * from '#/app/plugin/commands';
export * from '#/app/plugin/manifest';
export * from '#/app/plugin/store';
export * from '#/app/plugin/source';
export * from '#/app/plugin/github-resolver';
export * from '#/app/plugin/archive';
export * from '#/app/plugin/manager';
export * from '#/app/plugin/plugin';
export * from '#/app/plugin/pluginService';

export type { SkillSource } from '#/app/skillCatalog/types';
import '#/agent/skill/tools/skill';
export * from '#/agent/skill/skill';
export * from '#/agent/skill/skillService';
export * from '#/app/skillCatalog/types';
export * from '#/app/skillCatalog/configSection';
export * from '#/app/skillCatalog/skillCatalogRuntimeOptions';
export * from '#/app/skillCatalog/parser';
export * from '#/app/skillCatalog/registry';
export * from '#/app/skillCatalog/errors';
export * from '#/app/skillCatalog/skillDiscovery';
export * from '#/app/skillCatalog/inMemorySkillDiscovery';
export * from '#/app/skillCatalog/skillSource';
export * from '#/app/skillCatalog/skillRoots';
export * from '#/app/skillCatalog/builtin/builtin';
export * from '#/app/skillCatalog/builtinSkillSource';
export * from '#/app/skillCatalog/userFileSkillSource';
export * from '#/session/sessionSkillCatalog/skillCatalog';
export * from '#/session/sessionSkillCatalog/skillCatalogService';
export * from '#/session/sessionSkillCatalog/extraFileSkillSource';
export * from '#/session/sessionSkillCatalog/explicitFileSkillSource';
export * from '#/session/sessionSkillCatalog/workspaceFileSkillSource';
export * from '#/session/sessionSkillCatalog/pluginSkillSource';
export * from '#/agent/permissionGate/permissionGate';
export * from '#/agent/permissionGate/permissionGateService';
import '#/app/flag/flag';
import '#/app/flag/flagRegistry';
import '#/app/flag/flagRegistryService';
import '#/app/flag/flagService';
export * from '#/app/flag/flagRegistry';
export * from '#/app/flag/flagRegistryService';
export * from '#/app/flag/flag';
export * from '#/app/flag/flagService';

import '#/app/multiServer/flag';
export * from '#/app/multiServer/flag';

export * from '#/activity/activity';
export * from '#/activity/activityOps';
import '#/activity/agentActivityService';
import '#/activity/sessionActivityKernel';
import '#/agent/plan/profile/plan';
import '#/agent/plan/tools/enter-plan-mode';
import '#/agent/plan/tools/exit-plan-mode';
import '#/agent/plan/configSection';
export * from '#/agent/plan/plan';
export * from '#/agent/plan/planOps';
export * from '#/agent/plan/planService';
import '#/agent/goal/tools/create-goal';
import '#/agent/goal/tools/get-goal';
import '#/agent/goal/tools/set-goal-budget';
import '#/agent/goal/tools/update-goal';
export * from '#/agent/goal/goal';
export * from '#/agent/goal/goalService';
export * from '#/agent/goal/types';
import '#/agent/swarm/tools/agent-swarm';
export * from '#/agent/swarm/swarm';
export * from '#/agent/swarm/swarmService';
export * from '#/agent/usage/usage';
export * from '#/agent/usage/usageService';
export * from '#/agent/runtime/runtime';
export * from '#/agent/runtime/runtimeOps';
export * from '#/agent/runtime/runtimeService';
export * from '#/agent/toolDedupe/toolDedupe';
export * from '#/agent/toolDedupe/toolDedupeService';
import '#/agent/toolSelect/flag';
import '#/agent/faultInjection/flag';
import '#/agent/toolSelect/tools/select-tools';
export * from '#/agent/toolSelect/dynamicTools';
export * from '#/agent/toolSelect/toolSelect';
export * from '#/agent/toolSelect/toolSelectService';
export * from '#/agent/toolSelect/toolSelectAnnouncements';
export * from '#/agent/toolSelect/toolSelectAnnouncementsService';

import '#/agent/task/configSection';
import '#/agent/task/tools/task-list';
import '#/agent/task/tools/task-output';
import '#/agent/task/tools/task-stop';
export * from '#/agent/task/task';
export * from '#/agent/task/taskOps';
export * from '#/agent/task/taskService';
import '#/app/cron/configSection';
export * from '#/app/cron/cronTask';
export * from '#/app/cron/cronTaskPersistence';
export * from '#/app/cron/cronTaskPersistenceService';
export * from '#/app/cron/cron-expr';
export * from '#/app/cron/format';
export * from '#/app/cron/jitter';
export * from '#/app/cron/clock';
export * from '#/app/cron/configSection';
export * from '#/session/cron/sessionCronService';
export * from '#/session/cron/sessionCronServiceImpl';

import '#/session/agentLifecycle/profile/profiles';
export * from '#/session/agentLifecycle/agentLifecycle';
export * from '#/session/agentLifecycle/agentLifecycleService';
export * from '#/session/agentLifecycle/tools/subagent-task';
export { AGENT_RUN_PROMPT_ORIGIN } from '#/session/agentLifecycle/runAgentTurn';
export * from '#/session/agentLifecycle/mainAgent';
export * from '#/session/agentLifecycle/mirrorAgentRun';
import '#/session/agentLifecycle/tools/agent';
export * from '#/app/sessionLifecycle/sessionLifecycle';
export * from '#/app/sessionLifecycle/sessionLifecycleService';
export * from '#/session/externalHooks/externalHooks';
export * from '#/session/externalHooks/externalHooksService';
import '#/app/sessionExport/errors';
export * from '#/app/sessionExport/sessionExport';
export * from '#/app/sessionExport/sessionExportService';
export * from '#/app/sessionExport/manifest';
export * from '#/app/sessionExport/wire-scan';
export * from '#/app/sessionExport/zip';
export * from '#/app/sessionLegacy/sessionLegacy';
export * from '#/app/sessionLegacy/sessionLegacyService';
export * from '#/session/interaction/interaction';
export * from '#/session/interaction/interactionService';
export * from '#/session/sessionContext/sessionContext';
export * from '#/session/sessionActivity/sessionActivity';
export * from '#/session/sessionActivity/sessionActivityService';

import '#/session/approval/approval';
import '#/session/approval/approvalService';
export { ISessionApprovalService } from '#/session/approval/approval';
export * from '#/session/question/question';
export * from '#/session/question/questionService';
import '#/agent/questionTools/tools/ask-user';
export * from '#/app/gateway/gateway';
export * from '#/app/gateway/gatewayService';

export * from '#/session/workspaceContext/workspaceContext';
export * from '#/session/workspaceContext/workspaceContextService';
export * from '#/session/workspaceCommand/workspaceCommand';
export * from '#/session/workspaceCommand/workspaceCommandService';
export * from '#/app/workspaceLocalConfig/workspaceLocalConfig';
export * from '#/app/workspaceRegistry/workspaceRegistry';
export * from '#/app/workspaceRegistry/workspaceRegistryService';
export * from '#/app/workspaceRegistry/workspacePersistence';
export * from '#/app/workspaceRegistry/fileWorkspacePersistence';
import '#/app/workspaceRegistry/workspaceQueryService';
import '#/app/git/gitService';
export * from '#/session/process/processRunner';
export * from '#/session/process/processRunnerService';
export * from '#/session/sessionFs/errors';
export * from '#/session/sessionFs/fs';
export * from '#/session/sessionFs/fsService';
export * from '#/session/sessionFs/fsWatch';
export * from '#/session/sessionFs/fsWatchService';
export * from '#/session/sessionFs/gitContext';
export * from '#/session/sessionFs/rgLocator';
export * from '#/session/sessionFs/runRg';
export * from '#/app/hostFolderBrowser/hostFolderBrowser';
export * from '#/app/hostFolderBrowser/hostFolderBrowserService';
export * from '#/persistence/interface/storage';
export * from '#/persistence/interface/appendLogStore';
export * from '#/persistence/interface/atomicDocumentStore';
export * from '#/persistence/interface/queryStore';
export * from '#/persistence/interface/blobStore';
export * from '#/persistence/backends/node-fs/fileStorageService';
export * from '#/persistence/backends/node-fs/appendLogStore';
export * from '#/persistence/backends/node-fs/atomicDocumentStore';
export * from '#/persistence/backends/node-fs/blobStoreService';
export * from '#/persistence/backends/node-fs/workspaceLocalConfigService';
import '#/persistence/backends/minidb/flag';
export * from '#/persistence/backends/minidb/miniDbQueryStore';
export * from '#/persistence/backends/memory/inMemoryStorageService';
import '#/app/auth/webSearch/tools/web-search';
export * from '#/app/auth/auth';
export * from '#/app/auth/authService';
export * from '#/app/auth/configSection';
export * from '#/app/auth/webSearch/webSearch';
export * from '#/app/auth/webSearch/webSearchService';
export * from '#/app/auth/webSearch/providers/moonshot-web-search';
export * from '#/app/authLegacy/authLegacy';
export * from '#/app/authLegacy/authLegacyService';
export * from '#/app/file/fileService';
export * from '#/app/file/fileServiceImpl';
export {
  buildImageCompressionCaption,
  compressBase64ForModel,
  compressImageForModel,
  gateImageFormatParts,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
  READ_IMAGE_BYTE_BUDGET,
  resolveMaxImageEdgePx,
  resolveReadImageByteBudget,
  type ImageCompressionTelemetry,
} from '#/agent/media/image-compress';
export {
  MODEL_ACCEPTED_IMAGE_MIMES,
  buildImageConversionGuidance,
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  resolveEffectiveImageMime,
  unsupportedImageMimeFromUrl,
} from '#/agent/media/image-format-policy';
export {
  persistOriginalImage,
  sessionMediaOriginalsDir,
} from '#/agent/media/image-originals';
export * from '#/app/edit/fileEdit';
export * from '#/app/edit/fileEditService';
export * from '#/app/edit/editService';
export * from '#/app/edit/textModel';
export * from '#/app/edit/tools/edit';
export * from '#/app/externalHooksRunner/externalHooksRunner';
export * from '#/app/externalHooksRunner/externalHooksRunnerService';
import '#/app/web/tools/fetch-url';
export * from '#/app/web/web';
export * from '#/app/web/webService';
export * from '#/app/web/providers/local-fetch-url';
export * from '#/app/web/providers/moonshot-fetch-url';

export * from '#/agent/blob/agentBlobService';
export * from '#/agent/blob/agentBlobServiceImpl';
export * from '#/agent/contextMemory/contextMemory';
export * from '#/agent/contextMemory/contextMemoryService';
export * from '#/agent/contextMemory/contextOps';
export * from '#/agent/contextMemory/compactionHandoff';
export * from '#/agent/contextMemory/loopEventFold';
export * from '#/agent/contextMemory/messageId';
export * from '#/agent/contextMemory/messageProjection';
export * from '#/agent/contextMemory/contextTranscript';
export * from '#/agent/contextMemory/types';
export * from '#/agent/systemReminder/systemReminder';
export * from '#/agent/systemReminder/systemReminderService';
export * from '#/agent/contextProjector/contextProjector';
export * from '#/agent/contextProjector/contextProjectorService';
export * from '#/agent/contextSize/contextSize';
export * from '#/agent/contextSize/contextSizeOps';
export * from '#/agent/contextSize/contextSizeService';
export * from '#/agent/contextInjector/contextInjector';
export * from '#/agent/contextInjector/contextInjectorService';
export * from '#/agent/plugin/agentPlugin';
export * from '#/agent/plugin/agentPluginService';
import '#/agent/externalHooks/configSection';
export * from '#/agent/externalHooks/externalHooks';
export * from '#/agent/externalHooks/externalHooksService';
export * from '#/agent/fullCompaction/strategy';
export * from '#/agent/fullCompaction/fullCompaction';
export * from '#/agent/fullCompaction/fullCompactionService';
export * from '#/agent/fullCompaction/compactionOps';
export * from '#/agent/fullCompaction/types';
export * from '#/agent/llmRequester/llmRequester';
export * from '#/agent/llmRequester/llmRequesterService';
export * from '#/agent/faultInjection/faultInjection';
export * from '#/agent/faultInjection/faultInjectionService';
export * from '#/agent/llmRequester/llmRequestOps';
export * from '#/_base/utils/retry';
import '#/agent/loop/configSection';
export * from '#/agent/loop/loop';
export * from '#/agent/loop/loopService';
export * from '#/agent/loop/loopContinuation';
export * from '#/agent/loop/loopContinuationService';
export * from '#/agent/mcp/mcp';
export * from '#/agent/mcp/mcpService';
export * from '#/agent/mcp/mcpDiscoveryOps';
export * from '#/agent/mcp/config-schema';
export * from '#/agent/media/mediaTools';
export * from '#/agent/media/mediaToolsRegistrar';
export * from '#/agent/media/registerMediaTools';
import '#/agent/media/configSection';
export * from '#/agent/media/imageConfigBridge';
import '#/agent/permissionMode/configSection';
export * from '#/agent/permissionMode/permissionMode';
export * from '#/agent/permissionMode/permissionModeService';
export * from '#/agent/permissionPolicy/permissionPolicy';
export * from '#/agent/permissionPolicy/permissionPolicyService';
export * from '#/agent/permissionPolicy/types';
export * from '#/agent/permissionPolicy/policies/deny-all';
import '#/agent/permissionRules/configSection';
export * from '#/agent/permissionRules/permissionRules';
export * from '#/agent/permissionRules/matchesRule';
export * from '#/agent/permissionRules/permissionRulesService';
import '#/agent/profile/configSection';
export * from '#/agent/profile/profile';
export * from '#/agent/profile/profileService';
export * from '#/agent/profile/context';
export * from '#/agent/prompt/prompt';
export * from '#/agent/prompt/promptService';
import '#/app/messageLegacy/errors';
export * from '#/app/messageLegacy/messageLegacy';
export * from '#/app/messageLegacy/messageLegacyService';
export * from '#/agent/replayBuilder/replayTimelineModel';
export * from '#/agent/replayBuilder/types';
export * from '#/agent/shellCommand/shellCommand';
export * from '#/agent/shellCommand/shellCommandService';
export * from '#/agent/rpc/rpc';
export * from '#/agent/rpc/rpcService';
export * from '#/agent/rpc/prompt-metadata';
export * from '#/agent/scopeContext/scopeContext';
export * from '#/agent/stepRetry/stepRetry';
export * from '#/agent/stepRetry/stepRetryService';
export * from '#/session/btw/btw';
export * from '#/session/btw/btwService';
export * from '#/session/sessionInit/sessionInit';
export * from '#/session/sessionInit/sessionInitService';
export * from '#/session/sessionInit/profile/init';
export * from '#/session/swarm/sessionSwarm';
export * from '#/session/swarm/sessionSwarmService';
export * from '#/session/todo/todoItem';
export * from '#/session/todo/todoListReminder';
export * from '#/session/todo/sessionTodo';
export * from '#/session/todo/sessionTodoService';
export * from '#/session/todo/tools/todo-list';
export * from '#/tool/toolContract';
export * from '#/agent/toolExecutor/toolHooks';
export * from '#/agent/toolExecutor/toolExecutor';
export * from '#/agent/toolExecutor/toolExecutorService';
export * from '#/agent/toolResultTruncation/toolResultTruncation';
import '#/agent/toolResultTruncation/toolResultTruncationService';
import '#/agent/toolRegistry/builtinToolsRegistrar';
import '#/agent/toolRegistry/toolContribution';
import '#/agent/toolRegistry/toolRegistry';
import '#/agent/toolRegistry/toolRegistryService';
export { IAgentBuiltinToolsRegistrar } from '#/agent/toolRegistry/builtinToolsRegistrar';
export { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
export { registerTool } from '#/agent/toolRegistry/toolContribution';
export type { ToolContribution, ToolContributionOptions } from '#/agent/toolRegistry/toolContribution';
export * from '#/agent/userTool/userTool';
export * from '#/agent/userTool/userToolOps';
export * from '#/agent/userTool/userToolService';
export * from '#/agent/wireRecord/wireRecord';
export * from '#/agent/wireRecord/wireRecordService';
export * from '#/agent/wireRecord/metadataOps';
