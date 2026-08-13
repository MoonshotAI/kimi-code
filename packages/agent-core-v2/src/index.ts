/**
 * agent-core-v2 public surface — re-exports every domain barrel (grouped by
 * layer) so importing the package loads all scoped-registry registrations.
 */

export * from '#/_base/di/descriptors';
export * from '#/_base/di/errors';
export * from '#/_base/di/graph';
export * from '#/_base/di/instantiation';
export * from '#/_base/di/instantiationService';
export * from '#/_base/di/lifecycle';
export * from '#/_base/di/scope';
export * from './app/scopes';
export * from '#/_base/di/serviceCollection';
export * from '#/_base/di/cascadeEngine';
export * from '#/_base/di/dependencyGraph';
export * from '#/_base/lifecycle/ledger';
export {
  collection,
  isCollectionToken,
  type CollectionChange,
  type CollectionRecord,
  type CollectionToken,
  type CollectionView,
} from '#/_base/di/collection';
export {
  FiberProtocolError,
  FiberState,
  ScopeUnits,
  ServiceRecipeError,
  setFiberEventResolver,
  type ConfigSchema,
  type Fiber,
  type FiberHandle,
  type FiberProvideOptions,
  type RecipeStatics,
  type ServiceRecipe,
} from '#/_base/di/fiber';
export { Service } from '#/_base/di/service';
export * from './errors';

export * from '#/_base/log/log';
export * from '#/_base/log/logConfig';
export * from '#/_base/log/formatter';
export * from '#/_base/log/fileLog';
export * from '#/_base/log/logService';
export * from '#/wire/wire';
export * from '#/wire/wireService';
export * from '#/wire/wireContribution';
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
export * from '#/os/interface/hostClock';
export * from '#/os/interface/hostEnvironment';
export * from '#/os/interface/hostFileSystem';
export * from '#/os/interface/hostFsWatch';
export * from '#/os/interface/hostProcess';
export * from '#/os/interface/terminal';
export * from '#/os/interface/terminalErrors';
export * from '#/os/backends/node-local/hostClockService';
export * from '#/os/backends/node-local/hostEnvironmentService';
export * from '#/os/backends/node-local/hostFsService';
export * from '#/os/backends/node-local/hostFsWatchService';
export * from '#/os/backends/node-local/hostProcessService';
export * from '#/os/backends/node-local/hostTerminalService';
export * from '#/agent/tools/os/bash/bash';
import '#/agent/tools/os/bash/bashTool';
export * from '#/agent/tools/os/glob/glob';
import '#/agent/tools/os/glob/globTool';
export * from '#/agent/tools/os/grep/grep';
import '#/agent/tools/os/grep/grepTool';
export * from '#/agent/tools/os/read/read';
import '#/agent/tools/os/read/readTool';
export * from '#/agent/tools/os/write/write';
import '#/agent/tools/os/write/writeTool';
export * from '#/os/interface/terminal';
export * from '#/os/interface/terminalErrors';
export * from '#/os/backends/node-local/hostTerminalService';
export * from '#/session/terminal/terminalService';
export * from '#/app/task/task';
import '#/app/task/taskService';
export { TaskService } from '#/app/task/taskService';
import '#/app/event/eventBusService';
import '#/app/event/eventService';
import '#/app/event/fiberEventResolver';
export { IEventBus, type DomainEvent } from '#/app/event/eventBus';
export { IEventService, type DomainEvent as GlobalEvent } from '#/app/event/event';
export * from '#/_base/state/stateRegistry';
export * from '#/_base/contribution/registry';
export * from '#/app/state/appState';
import '#/app/state/appStateService';
export * from '#/workspace/state/workspaceState';
import '#/workspace/state/workspaceStateService';
export * from '#/session/state/sessionState';
import '#/session/state/sessionStateService';
export * from '#/agent/state/agentState';
import '#/agent/state/agentStateService';
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
export * from '#/app/sessionIndex/sessionIndexMirrorService';
export * from '#/session/sessionMetadata/sessionMetadata';
export * from '#/session/sessionMetadata/sessionMetadataService';
export * from '#/session/sessionMetadata/promptMetadata';
export * from '#/session/sessionActivity/sessionActivity';
export * from '#/session/sessionActivity/sessionActivityService';
export * from '#/session/sessionActivity/sessionOutcomeMirror';
export * from '#/session/sessionActivity/sessionOutcomeMirrorService';
export * from '#/session/sessionTitle/agentTitlePromptSource';
import '#/session/sessionTitle/agentTitlePromptSourceService';
export * from '#/session/sessionTitle/sessionTitle';
export * from '#/session/sessionTitle/sessionTitleService';
import '#/session/sessionTitle/flag';
export * from '#/session/sessionToolPolicy/sessionToolPolicy';
export * from '#/session/sessionToolPolicy/sessionToolPolicyService';
export * from '#/app/config/config';
export * from '#/app/config/configService';
export * from '#/app/config/configSectionContributions';
import '#/app/kosongConfig/configSection';
export * from '#/kosong/provider/provider';
export * from '#/kosong/provider/providerService';
export * from '#/kosong/provider/providerDefinition';
export * from '#/kosong/provider/protocolAdapterRegistry';
import '#/app/skillCatalog/configSection';
import '#/app/agentIdentity/configSection';
export * from '#/app/agentIdentity/configSection';
export * from '#/app/agentIdentity/agentIdentity';
export * from '#/app/agentIdentity/agentIdentityService';
import '#/kosong/protocol/errors';
export * from '#/kosong/protocol/errors';
export * from '#/kosong/protocol/protocol';
export * from '#/kosong/protocol/protocolBase';
export * from '#/kosong/protocol/protocolTrait';
import '#/app/kosongConfig/envOverlay';
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
export {
  MODEL_CATALOG_SECTION,
  ModelCatalogConfigSchema,
  type ModelCatalogConfig,
} from '#/app/kosongConfig/configSection';
export * from '#/app/kosongConfig/kosongConfig';
export * from '#/app/kosongConfig/kosongConfigService';
export * from '#/kosong/model/modelOAuth';
export * from '#/app/kosongConfig/oauthTokenAdapter';
export * from '#/app/kosongConfig/hostRequestHeadersAdapter';
export * from '#/app/kosongConfig/discovery';
export * from '#/app/kosongConfig/discoveryService';
export * from '#/app/kosongConfig/errors';
export * from '#/app/kosongConfig/modelsDevImport';
export * from '#/app/kosongConfig/modelsDevImportService';
export * from '#/app/kosongConfig/modelsDevUpstream';
export * from '#/app/kosongConfig/modelsDev';
import '#/kosong/provider/bases/anthropic/index';
import '#/kosong/provider/bases/google-genai/index';
import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
export * from '#/app/agentProfileCatalog/agentProfileCatalog';
export * from '#/app/agentProfileCatalog/agentProfileContribution';
export * from '#/app/agentProfileCatalog/agentProfileRegistry';
export * from '#/app/agentProfileCatalog/agentProfileRegistryService';
export * from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
export * from '#/app/agentProfileCatalog/builtinAgentProfileLoaderService';
export * from '#/app/agentProfileCatalog/profile-shared';
export * from '#/app/agentProfileCatalog/promptPrefix';
export {
  registerAgentProfile,
  getAgentProfileContributions,
  _clearAgentProfileContributionsForTests,
} from '#/app/agentProfileCatalog/contribution';
export * from '#/workspace/workspaceAgentProfileLoader/configSection';
export { parseAgentFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';
export { resolveAgentPath } from '#/workspace/workspaceAgentProfileLoader/internal/paths';
export * from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
export * from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoaderService';
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
export * from '#/app/capability/capability';
export * from '#/app/capability/capabilityService';
export * from '#/app/capability/errors';
export * from '#/app/capability/types';
export * from '#/app/feature/featureManager';
export * from '#/app/feature/featureServiceContribution';
import '#/app/feature/featureManagerService';
export * from '#/features/feature';
export * from '#/features/featureAssembly';
export * from '#/features/featureRegistry';
import '#/features/featureAssemblyService';
export * from '#/agent/command/agentCommand';
export * from '#/agent/command/commandContribution';
import '#/agent/command/agentCommandService';
export * from '#/debug/index';
export * from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
export * from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoaderService';

export type { SkillSource } from '#/app/skillCatalog/types';
export * from '#/agent/tools/skill/skill';
import '#/agent/tools/skill/skillTool';
export * from '#/agent/skill/skill';
export * from '#/agent/skill/skillService';
export * from '#/app/skillCatalog/types';
export * from '#/app/skillCatalog/configSection';
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
export * from '#/session/sessionSkillCatalog/skillCatalogData';
export * from '#/session/sessionSkillCatalog/skillCatalogService';
export * from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
export * from '#/session/sessionAgentProfileCatalog/agentProfileCatalogSeed';
export * from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalogService';
export * from '#/session/sessionInstructions/instructionsProvider';
export * from '#/session/workspaceInfo/workspaceInfo';
export * from '#/workspace/workspaceDirs/workspaceDirs';
export * from '#/workspace/workspaceDirs/workspaceDirsService';
export * from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';
export * from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalogService';
export * from '#/workspace/workspaceSkillCatalog/extraFileSkillSource';
export * from '#/workspace/workspaceSkillCatalog/explicitFileSkillSource';
export * from '#/workspace/workspaceSkillCatalog/rootFileSkillSource';
export * from '#/workspace/workspaceSkillCatalog/pluginSkillSource';
export * from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
export * from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoaderService';
export * from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
export * from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoaderService';
export * from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
export * from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoaderService';
export * from '#/workspace/workspaceInstructions/workspaceInstructions';
export * from '#/workspace/workspaceInstructions/workspaceInstructionsService';
export * from '#/agent/permissionGate/permissionGate';
export * from '#/agent/permissionGate/permissionGateService';
export * from '#/agent/toolApproval/toolApproval';
export * from '#/agent/toolApproval/toolApprovalService';
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
export * from '#/features/btw/btw';
export * from '#/features/btw/btwService';
import '#/features/btw/btwFeature';
import '#/features/plan/profile/plan';
export * from '#/features/plan/tools/enter-plan-mode/enter-plan-mode';
import '#/features/plan/tools/enter-plan-mode/enterPlanModeTool';
export * from '#/features/plan/tools/exit-plan-mode/exit-plan-mode';
import '#/features/plan/tools/exit-plan-mode/exitPlanModeTool';
export * from '#/features/plan/configSection';
export * from '#/features/plan/plan';
export * from '#/features/plan/planOps';
export * from '#/features/plan/planService';
import '#/features/plan/planFeature';
export * from '#/features/debugEvents/debugEvents';
export * from '#/features/debugEvents/debugEventsService';
import '#/features/debugEvents/debugEventsFeature';
export * from '#/features/swarm/agent/swarm';
export * from '#/features/swarm/agent/swarmService';
export * from '#/features/swarm/session/sessionSwarm';
export * from '#/features/swarm/session/sessionSwarmService';
export * from '#/features/swarm/tools/agent-swarm/agent-swarm';
import '#/features/swarm/tools/agent-swarm/agentSwarmTool';
import '#/features/swarm/swarmFeature';
export * from '#/agent/tools/goal/create-goal/create-goal';
import '#/agent/tools/goal/create-goal/createGoalTool';
export * from '#/agent/tools/goal/get-goal/get-goal';
import '#/agent/tools/goal/get-goal/getGoalTool';
export * from '#/agent/tools/goal/set-goal-budget/set-goal-budget';
import '#/agent/tools/goal/set-goal-budget/setGoalBudgetTool';
export * from '#/agent/tools/goal/update-goal/update-goal';
import '#/agent/tools/goal/update-goal/updateGoalTool';
export * from '#/agent/goal/goalDeadlineScheduler';
import '#/agent/goal/goalDeadlineSchedulerService';
export * from '#/agent/goal/goal';
export * from '#/agent/goal/goalService';
export * from '#/agent/goal/types';
export * from '#/agent/usage/usage';
export * from '#/agent/usage/usageService';
export * from '#/agent/toolDedupe/toolDedupe';
export * from '#/agent/toolDedupe/toolDedupeService';
export * from '#/agent/agentsMdReminder/agentsMdReminder';
export * from '#/agent/agentsMdReminder/agentsMdReminderService';
import '#/agent/toolSelect/flag';
export * from '#/agent/tools/select-tools/select-tools';
import '#/agent/tools/select-tools/selectToolsTool';
export * from '#/agent/toolSelect/dynamicTools';
export * from '#/agent/toolSelect/toolSelect';
export * from '#/agent/toolSelect/toolSelectService';
export * from '#/agent/toolSelect/toolSelectAnnouncements';
export * from '#/agent/toolSelect/toolSelectAnnouncementsService';
export * from '#/agent/toolSelect/toolSelectSchemas';
export * from '#/agent/toolSelect/toolSelectSchemasService';
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
export * from '#/agent/task/printDefaults';
export * from '#/agent/tools/task/task-list/task-list';
import '#/agent/tools/task/task-list/taskListTool';
export * from '#/agent/tools/task/task-output/task-output';
import '#/agent/tools/task/task-output/taskOutputTool';
export * from '#/agent/tools/task/task-stop/task-stop';
import '#/agent/tools/task/task-stop/taskStopTool';
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
export * from '#/agent/tools/cron/cron-create/cron-create';
import '#/agent/tools/cron/cron-create/cronCreateTool';
export * from '#/agent/tools/cron/cron-list/cron-list';
import '#/agent/tools/cron/cron-list/cronListTool';
export * from '#/agent/tools/cron/cron-delete/cron-delete';
import '#/agent/tools/cron/cron-delete/cronDeleteTool';

import '#/session/agentLifecycle/profile/profiles';
export * from '#/session/agentLifecycle/agentLifecycle';
export * from '#/session/agentLifecycle/agentLifecycleService';
export * from '#/session/agentLifecycle/mainAgent';
export * from '#/session/mcp/sessionMcpHandle';
import '#/app/mcpConfig/configSection';
export {
  MCP_SECTION,
  McpSectionSchema,
  type McpSection,
} from '#/app/mcpConfig/configSection';
export * from '#/app/mcpConfig/oauthStore';
export * from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
export * from '#/workspace/workspaceMcpConfig/workspaceMcpConfigService';
export * from '#/workspace/workspaceMcp/workspaceMcp';
export * from '#/workspace/workspaceMcp/workspaceMcpService';
export * from '#/session/subagent/subagent';
export * from '#/session/subagent/subagentService';
import '#/session/subagent/flag';
export * from '#/session/subagent/subagentModelsValidation';
import '#/session/subagent/subagentModelsValidationService';
export * from '#/agent/tools/agent/subagent-task';
export { AGENT_RUN_PROMPT_ORIGIN } from '#/session/subagent/runAgentTurn';
export * from '#/session/subagent/mirrorAgentRun';
import '#/session/subagent/configSection';
export * from '#/agent/tools/agent/agent';
import '#/agent/tools/agent/agentTool';
export * from '#/app/workspaceLifecycle/workspaceLifecycle';
export * from '#/app/workspaceLifecycle/workspaceLifecycleService';
export * from '#/app/workspaceLifecycle/sessionLookup';
export * from '#/workspace/workspaceContext/workspaceContext';
export * from '#/workspace/sessionLifecycle/sessionLifecycle';
export * from '#/workspace/sessionLifecycle/sessionLifecycleService';
export * from '#/workspace/sessionLifecycle/internal/addressing';
export * from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
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
export * from '#/session/interaction/interactionOps';
export * from '#/session/interaction/interactionService';
export * from '#/session/sessionContext/sessionContext';

import '#/session/approval/approval';
import '#/session/approval/approvalService';
export {
  ISessionApprovalService,
  type ApprovalDecision,
  type ApprovalRequest as SessionApprovalRequest,
  type ApprovalResponse as SessionApprovalResponse,
} from '#/session/approval/approval';
export * from '#/session/question/question';
export * from '#/session/question/questionService';
export * from '#/agent/tools/ask-user-question/ask-user-question';
import '#/agent/tools/ask-user-question/askUserQuestionTool';
export * from '#/app/gateway/gateway';
export * from '#/app/gateway/gatewayService';

export * from '#/session/workspaceContext/workspaceContext';
export * from '#/session/workspaceContext/workspaceContextService';
export * from '#/app/projectLocalConfig/projectLocalConfig';
export * from '#/app/workspace/workspace';
export * from '#/app/workspace/workspaceService';
export * from '#/app/workspace/workspaceAlias';
export * from '#/app/workspace/workspacePersistence';
export * from '#/app/workspace/fileWorkspacePersistence';
export * from '#/app/workspaceAliases/workspaceAliases';
import '#/app/workspaceAliases/workspaceAliasesService';
export * from '#/app/workspaceSessions/workspaceSessions';
import '#/app/workspaceSessions/workspaceSessionsService';
import '#/app/git/gitService';
export * from '#/app/bashParser/bashParser';
import '#/app/bashParser/bashParserService';
export * from '#/session/process/processRunner';
export * from '#/session/process/processRunnerService';
export * from '#/workspace/workspaceProcess/workspaceProcessRunnerService';
export * from '#/workspace/workspaceFs/internal/errors';
export * from '#/workspace/workspaceFs/fs';
export * from '#/workspace/workspaceFs/fsService';
export * from '#/workspace/workspaceFs/fsWatch';
export * from '#/workspace/workspaceFs/fsWatchService';
export * from '#/session/agentLifecycle/profile/gitContext';
export * from '#/workspace/workspaceFs/internal/rgLocator';
export * from '#/workspace/workspaceFs/internal/runRg';
export * from '#/workspace/workspaceGit/workspaceGit';
export * from '#/workspace/workspaceGit/workspaceGitService';
export * from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
export * from '#/session/sessionToolPolicyGate/sessionToolPolicyGateService';
export * from '#/workspace/workspaceToolPolicy/workspaceToolPolicy';
export * from '#/workspace/workspaceToolPolicy/workspaceToolPolicyService';
export * from '#/workspace/workspaceTrust/workspaceTrust';
export * from '#/workspace/workspaceTrust/workspaceTrustService';
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
export * from '#/persistence/backends/node-fs/projectLocalConfigService';
import '#/persistence/backends/minidb/flag';
export * from '#/persistence/backends/minidb/miniDbQueryStore';
export * from '#/persistence/backends/memory/inMemoryStorageService';
export * from '#/agent/tools/web-search/web-search';
import '#/agent/tools/web-search/webSearchTool';
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
export * from '#/agent/tools/edit/edit';
import '#/agent/tools/edit/editTool';
export * from '#/app/externalHooksRunner/externalHooksRunner';
export * from '#/app/externalHooksRunner/externalHooksRunnerService';
export * from '#/agent/tools/fetch-url/fetch-url';
import '#/agent/tools/fetch-url/fetchUrlTool';
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
export * from '#/agent/contextMemory/conversationUndoParticipants';
export * from '#/agent/contextMemory/conversationTime';
export * from '#/agent/contextMemory/loopEventFold';
export * from '#/agent/contextMemory/messageId';
export * from '#/agent/contextMemory/contextTranscript';
export * from '#/agent/contextMemory/types';
export * from '#/agent/systemReminder/systemReminder';
export * from '#/agent/systemReminder/systemReminderService';
export * from '#/features/dateChange/dateChange';
export * from '#/features/dateChange/dateChangeService';
import '#/features/dateChange/dateChangeFeature';
export * from '#/agent/contextProjector/contextProjector';
export * from '#/agent/contextProjector/contextProjectorService';
export * from '#/agent/tokenCounting/tokenCounting';
export * from '#/agent/tokenCounting/tokenCountingOps';
export * from '#/agent/tokenCounting/tokenCountingService';
export * from '#/agent/contextInjector/contextInjector';
export * from '#/agent/contextInjector/contextInjectorService';
export * from '#/agent/plugin/agentPlugin';
export * from '#/agent/plugin/agentPluginOps';
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
export * from '#/agent/llmRequester/llmRequestOps';
export * from '#/_base/utils/promise';
export * from '#/_base/utils/retry';
export * from '#/_base/utils/timer';
import '#/agent/loop/configSection';
export * from '#/agent/loop/loop';
export * from '#/agent/loop/loopService';
export * from '#/agent/loop/loopContinuation';
export * from '#/agent/loop/loopContinuationService';
export * from '#/agent/interruptionReminder/interruptionReminder';
export * from '#/agent/interruptionReminder/interruptionReminderService';
export * from '#/agent/interruptionReminder/interruptionReminderOps';
export * from '#/agent/mcp/mcp';
export * from '#/agent/mcp/mcpService';
export * from '#/agent/mcp/mcpDiscoveryOps';
export * from '#/mcpCore/config-schema';
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
import '#/agent/permissionRules/configSection';
export * from '#/agent/permissionRules/permissionRules';
export * from '#/agent/permissionRules/matchesRule';
export * from '#/agent/permissionRules/permissionRulesService';
export * from '#/agent/pluginCommand/pluginCommand';
export * from '#/agent/pluginCommand/pluginCommandService';
export * from '#/agent/profile/profile';
export * from '#/agent/profile/profileService';
export * from '#/agent/profile/context';
export * from '#/agent/prompt/prompt';
export * from '#/agent/prompt/promptService';
export * from '#/agent/prompt/promptMetadataText';
export * from '#/agent/replayBuilder/types';
// `replayBuilder/types` inlines its own `SessionSummary`; keep the barrel's
// `SessionSummary` pinned to the session-index one (explicit re-export wins
// over the ambiguous `export *` pair).
export { type SessionSummary } from '#/app/sessionIndex/sessionIndex';
export * from '#/agent/undo/undo';
export * from '#/agent/undo/undoService';
export * from '#/agent/shellCommand/shellCommand';
export * from '#/agent/shellCommand/shellCommandService';
export * from '#/agent/scopeContext/scopeContext';
export * from '#/agent/stepRetry/stepRetry';
export * from '#/agent/stepRetry/stepRetryService';
export * from '#/features/sessionInit/sessionInit';
export * from '#/features/sessionInit/sessionInitService';
export * from '#/features/sessionInit/profile/init';
import '#/features/sessionInit/sessionInitFeature';
export * from '#/session/todo/todoItem';
export * from '#/session/todo/todoListReminder';
export * from '#/session/todo/sessionTodo';
export * from '#/session/todo/sessionTodoService';
export * from '#/agent/tools/todo-list/todo-list';
import '#/agent/tools/todo-list/todoListTool';
export * from '#/tool/toolContract';
export * from '#/agent/toolExecutor/toolHooks';
export * from '#/agent/toolExecutor/toolExecutor';
export * from '#/agent/toolExecutor/toolExecutorService';
export * from '#/agent/toolResultTruncation/toolResultTruncation';
import '#/agent/toolResultTruncation/toolResultTruncationService';
import '#/agent/toolActivation/toolActivationService';
import '#/agent/toolRegistry/toolContribution';
import '#/agent/toolRegistry/toolRegistry';
import '#/agent/toolRegistry/toolRegistryService';
export { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
export { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
export { registerAgentToolService, AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
export type { AgentToolContributionOptions } from '#/agent/toolRegistry/toolContribution';
export * from '#/agent/userTool/userTool';
export * from '#/agent/userTool/userToolOps';
export * from '#/agent/userTool/userToolService';
