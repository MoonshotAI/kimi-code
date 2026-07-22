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
export * from '#/wire/wire';
export * from '#/wire/wireService';
export * from '#/wire/record';
export * from '#/wire/migration/migration';
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
export * from '#/kosong/contract/capability';
export * from '#/kosong/contract/errors';
export * from '#/kosong/contract/message';
export * from '#/kosong/contract/messageHelpers';
export * from '#/kosong/contract/tool';
export * from '#/kosong/contract/usage';
export * from '#/kosong/contract/provider';
export * from '#/kosong/contract/generate';
export * from '#/kosong/contract/requestTrace';
export type {
  ExtraBody,
  GenerationKwargs,
  KimiThinkingConfig,
} from '#/kosong/provider/providers/kimi/kimi.contrib';

export * from '#/app/sessionIndex/sessionIndex';
export * from '#/app/sessionIndex/sessionIndexService';
export * from '#/session/sessionMetadata/sessionMetadata';
export * from '#/session/sessionMetadata/sessionMetadataService';
export * from '#/session/sessionToolPolicy/sessionToolPolicy';
export * from '#/session/sessionToolPolicy/sessionToolPolicyService';
export * from '#/app/config/config';
export * from '#/app/config/configService';
import '#/kosong/provider/configSection';
export * from '#/kosong/provider/provider';
export * from '#/kosong/provider/providerService';
export * from '#/kosong/provider/providerDefinition';
export * from '#/kosong/provider/protocolAdapterRegistry';
import '#/app/skillCatalog/configSection';
import '#/kosong/protocol/errors';
export * from '#/kosong/protocol/errors';
export * from '#/kosong/protocol/protocol';
export * from '#/kosong/protocol/protocolBase';
export * from '#/kosong/protocol/protocolTrait';
import '#/kosong/model/configSection';
import '#/kosong/model/envOverlay';
import '#/kosong/model/thinking';
export * from '#/kosong/model/completionBudget';
export * from '#/kosong/model/hostRequestHeaders';
export * from '#/kosong/model/model';
export * from '#/kosong/model/model.types';
export * from '#/kosong/model/modelService';
export * from '#/kosong/model/thinking';
export * from '#/kosong/model/catalog';
export * from '#/kosong/model/catalogService';
export * from '#/kosong/model/modelRequester';
import '#/kosong/model/errors';
import '#/kosong/model/discoveryConfigSection';
// `ModelCatalogConfig` / `MODEL_CATALOG_SECTION` live in the configSection
// side-effect module but the edge (kap-server's refresh scheduler) consumes
// them from the package root — re-export here.
export * from '#/kosong/model/discoveryConfigSection';
export * from '#/kosong/model/discovery';
export * from '#/kosong/model/discoveryService';
// kosong wire composition roots — importing these modules registers the four
// protocol bases and every provider definition (kimi + the canonical vendor
// endpoints); without them the adapter registry stays empty.
import '#/kosong/provider/bases/anthropic/index';
import '#/kosong/provider/bases/google-genai/index';
import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
export * from '#/app/agentProfileCatalog/agentProfileCatalog';
export * from '#/app/agentProfileCatalog/agentProfileCatalogService';
export * from '#/app/agentProfileCatalog/profile-shared';
export * from '#/app/agentProfileCatalog/promptPrefix';
export {
  registerAgentProfile,
  getAgentProfileContributions,
  _clearAgentProfileContributionsForTests,
} from '#/app/agentProfileCatalog/contribution';
export * from '#/app/agentFileCatalog/types';
export * from '#/app/agentFileCatalog/paths';
export * from '#/app/agentFileCatalog/agentRoots';
export * from '#/app/agentFileCatalog/agentFile';
export * from '#/app/agentFileCatalog/agentFileDiscovery';
export * from '#/app/agentFileCatalog/agentProfileFromFile';
export * from '#/app/agentFileCatalog/configSection';
export * from '#/app/agentFileCatalog/agentProfileSource';
export * from '#/app/agentFileCatalog/agentCatalogRuntimeOptions';
export * from '#/app/agentFileCatalog/userFileAgentSource';
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
export * from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
export * from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalogService';
export * from '#/session/sessionAgentProfileCatalog/projectFileAgentSource';
export * from '#/session/sessionAgentProfileCatalog/extraFileAgentSource';
export * from '#/session/sessionAgentProfileCatalog/explicitFileAgentSource';
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

export * from '#/agent/activityView/activityView';
import '#/agent/activityView/activityViewService';
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
export * from '#/agent/goal/goalDeadlineScheduler';
import '#/agent/goal/goalDeadlineSchedulerService';
export * from '#/agent/goal/goal';
export * from '#/agent/goal/goalService';
export * from '#/agent/goal/types';
import '#/agent/swarm/tools/agent-swarm';
export * from '#/agent/swarm/swarm';
export * from '#/agent/swarm/swarmService';
export * from '#/agent/usage/usage';
export * from '#/agent/usage/usageService';
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
import '#/agent/toolPolicy/configSection';
export * from '#/agent/toolPolicy/configSection';
export * from '#/agent/toolPolicy/evaluate';
export * from '#/agent/toolPolicy/toolPolicy';
export * from '#/agent/toolPolicy/toolPolicyService';

import '#/agent/task/configSection';
export {
  resolveAgentTaskConfig,
  resolvePrintBackgroundMode,
  type AgentTaskConfig,
  type PrintBackgroundMode,
} from '#/agent/task/configSection';
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
export * from '#/session/agentLifecycle/mainAgent';
export * from '#/session/mcp/sessionMcp';
export * from '#/session/mcp/sessionMcpService';
export * from '#/session/subagent/subagent';
export * from '#/session/subagent/subagentService';
export * from '#/session/subagent/tools/subagent-task';
export { AGENT_RUN_PROMPT_ORIGIN } from '#/session/subagent/runAgentTurn';
export * from '#/session/subagent/mirrorAgentRun';
import '#/session/subagent/configSection';
import '#/session/subagent/tools/agent';
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
export * from '#/agent/media/kimiFileUrl';
export * from '#/agent/media/videoUpload';
export * from '#/agent/media/videoResolver';
export * from '#/agent/media/videoResolverService';
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
export * from '#/agent/profile/profile';
export * from '#/agent/profile/profileService';
export * from '#/agent/profile/context';
export * from '#/agent/prompt/prompt';
export * from '#/agent/prompt/promptService';
import '#/app/messageLegacy/errors';
export * from '#/app/messageLegacy/messageLegacy';
export * from '#/app/messageLegacy/messageLegacyService';
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
