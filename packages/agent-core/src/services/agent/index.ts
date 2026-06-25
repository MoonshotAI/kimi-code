export {
  createHooks,
  OrderedHookSlot,
  type HookHandler,
  type HookRegisterOptions,
  type Hooks,
  type HookSlot,
} from './hooks';
export type {
  ContextMessage,
  LLMEvent,
  LLMRequestOverrides,
  PromptOrigin,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolInfo,
  ToolOutput,
  ToolResult,
  ToolSource,
  Turn,
  TurnResult,
  TurnStepContext,
  WireRecord,
  WireRecordMap,
} from './types';
export type {
  ApprovalResponse,
  PermissionApprovalResultRecord,
  PermissionMode,
  PermissionPolicyContext,
  PermissionRule,
  ApprovalResponse as PermissionApprovalResponse,
} from '../../agent/permission';
export type { Agent } from '../../agent';
export { PermissionManager } from '../../agent/permission';
export { PermissionModeInjector } from '../../agent/injection/permission-mode';
export {
  matchPermissionRule,
  parsePattern,
  type PermissionRuleMatchExecution,
} from '../../agent/permission/matches-rule';
export { AgentSwarmExclusiveDenyPermissionPolicy } from '../../agent/permission/policies/agent-swarm-exclusive-deny';
export { AutoModeApprovePermissionPolicy } from '../../agent/permission/policies/auto-mode-approve';
export { AutoModeAskUserQuestionDenyPermissionPolicy } from '../../agent/permission/policies/auto-mode-ask-user-question-deny';
export { FallbackAskPermissionPolicy } from '../../agent/permission/policies/fallback-ask';
export { createPermissionDecisionPolicies } from '../../agent/permission/policies';
export { SwarmModeAgentSwarmApprovePermissionPolicy } from '../../agent/permission/policies/swarm-mode-agent-swarm-approve';
export { YoloModeApprovePermissionPolicy } from '../../agent/permission/policies/yolo-mode-approve';
export {
  renderModelToolSkillPrompt,
  renderUserSlashSkillPrompt,
} from '../../agent/skill/prompt';
export type {
  RenderModelToolSkillPromptInput,
  RenderSkillPromptInput,
  SkillPromptTrigger,
} from '../../agent/skill/prompt';
export { ToolCallDeduplicator, __testing as toolDedupTesting } from '../../agent/turn/tool-dedup';

export { IAgentRPCService, ISessionRPCService } from './rpc/rpc';
export { AgentRPCService } from './rpc/rpcService';

export { IEventBus } from './eventBus/eventBus';
export { EventBusService } from './eventBus/eventBusService';

export {
  BLOBREF_PROTOCOL,
  IBlobStoreService,
  MISSING_MEDIA_PLACEHOLDER,
} from './blobStore/blobStore';
export type { BlobStoreServiceOptions } from './blobStore/blobStore';
export { BlobStoreService } from './blobStore/blobStoreService';

export { AGENT_WIRE_PROTOCOL_VERSION, IWireRecord } from './wireRecord/wireRecord';
export type {
  PersistedWireRecord,
  WireRecordBlobSelector,
  WireRecordBlobTarget,
  WireRecordMetadata,
  WireRecordPersistence,
  WireRecordRegisterOptions,
  WireRecordRestoredContext,
  WireRecordRestoreOptions,
  WireRecordRestoreResult,
  WireRecordRestoringContext,
  WireRecordServiceOptions,
} from './wireRecord/wireRecord';
export { WireRecordService } from './wireRecord/wireRecordService';
export {
  FileSystemWireRecordPersistence,
  InMemoryWireRecordPersistence,
} from './wireRecord/persistence';
export type {
  FileSystemWireRecordPersistenceOptions,
  InMemoryWireRecordPersistenceOptions,
} from './wireRecord/persistence';
export {
  applyWireMigrations,
  isNewerWireVersion,
  migrateWireRecord,
  migrateWireRecordBatch,
  migrateWireRecords,
  resolveWireMigrations,
  type WireMigration,
  type WireMigrationRecord,
} from './wireRecord/migration';
export {
  BlobStore,
  isBlobRef,
} from '../../agent/records/blobref';
export {
  FileSystemAgentRecordPersistence,
  InMemoryAgentRecordPersistence,
} from '../../agent/records';
export type {
  AgentRecord,
  AgentRecordPersistence,
  AgentRecordOf,
} from '../../agent/records';
export { migrateV1_0ToV1_1 } from '../../agent/records/migration/v1.1';
export { migrateV1_1ToV1_2 } from '../../agent/records/migration/v1.2';
export { migrateV1_2ToV1_3 } from '../../agent/records/migration/v1.3';
export { migrateV1_3ToV1_4 } from '../../agent/records/migration/v1.4';
export { migrateV1_4ToV1_5 } from './wireRecord/migration/v1.5';

export { IContextMemory } from './contextMemory/contextMemory';
export { ContextMemoryService } from './contextMemory/contextMemoryService';

export {
  IContextSizeService,
  type ContextSizeStatus,
} from './contextSize/contextSize';
export { ContextSizeService } from './contextSize/contextSizeService';

export {
  IReplayBuilderService,
  type ReplayBuilderServiceOptions,
  type ReplayRangeOptions,
} from './replayBuilder/replayBuilder';
export { ReplayBuilderService } from './replayBuilder/replayBuilderService';

export {
  IContextProjector,
  project,
  renderNotificationXml,
} from './contextProjector/contextProjector';
export { ContextProjectorService } from './contextProjector/contextProjectorService';

export {
  IMicroCompactionService,
  type MicroCompactionConfig,
  type MicroCompactionEffect,
  type MicroCompactionServiceOptions,
} from './microCompaction/microCompaction';
export { MicroCompactionService } from './microCompaction/microCompactionService';

export { ILoopService } from './loop/loop';
export { LoopService } from './loop/loopService';

export {
  IExternalHooksService,
  type ExternalHooksServiceOptions,
  type NotificationHookPayload,
  type RenderedExternalHookResult,
  type UserPromptHookDecision,
} from './externalHooks/externalHooks';
export { ExternalHooksService } from './externalHooks/externalHooksService';

export {
  IToolRegistry,
  type ToolRegistrationOptions,
} from './toolRegistry/toolRegistry';
export {
  ToolRegistryService,
} from './toolRegistry/toolRegistryService';

export {
  IMcpRuntimeService,
  type McpResolvedServer,
  type McpRuntimeServiceOptions,
} from './mcpRuntime/mcpRuntime';
export { McpRuntimeService } from './mcpRuntime/mcpRuntimeService';

export {
  IUserToolService,
  type UserToolServiceOptions,
  type UserToolRegistration,
} from './userTool/userTool';
export {
  UserToolService,
} from './userTool/userToolService';

export { IToolStoreService } from './toolStore/toolStore';
export { ToolStoreService } from './toolStore/toolStoreService';

export { ITodoListService } from './todoList/todoList';
export { TodoListService } from './todoList/todoListService';

export { IToolExecutor, type ToolExecutorOptions } from './toolExecutor/toolExecutor';
export { ToolExecutorService } from './toolExecutor/toolExecutorService';

export {
  IPermissionModeService,
  type PermissionModeChangedContext,
} from './permissionMode/permissionMode';
export { PermissionModeService } from './permissionMode/permissionModeService';
export {
  IPermissionRulesService,
  type PermissionApprovalRecordedContext,
  type PermissionRulesChangedContext,
  type PermissionRulesServiceOptions,
} from './permissionRules/permissionRules';
export { PermissionRulesService } from './permissionRules/permissionRulesService';
export {
  IPermissionService,
  type PermissionGitWorkTreeMarker,
  type PermissionPlanModeState,
  type PermissionServiceOptions,
  type PermissionSwarmModeState,
} from './permission/permission';
export { PermissionService } from './permission/permissionService';
export {
  IPermissionPolicyService,
  type PermissionPolicy,
  type PermissionPolicyEvaluation,
  type PermissionPolicyResolution,
  type PermissionPolicyResult,
} from './permissionPolicy/permissionPolicy';
export { PermissionPolicyService } from './permissionPolicy/permissionPolicyService';

export { ILLMRequester } from './llmRequester/llmRequester';
export {
  LLMRequesterService,
  type LLMRequesterServiceOptions,
} from './llmRequester/llmRequesterService';
export {
  ILLMRequestLogService,
  type LLMRequestLogInput,
} from './llmRequestLog/llmRequestLog';
export { LLMRequestLogService } from './llmRequestLog/llmRequestLogService';

export { IKaosService } from './kaos/kaos';
export {
  KaosService,
  type KaosServiceOptions,
} from './kaos/kaosService';

export { ITurnRunner } from './turnRunner/turnRunner';
export { TurnRunnerService } from './turnRunner/turnRunnerService';

export {
  IDynamicInjector,
  type DynamicInjectionContext,
  type DynamicInjectionProvider,
} from './dynamicInjector/dynamicInjector';
export { DynamicInjectorService } from './dynamicInjector/dynamicInjectorService';

export { IPromptService } from './prompt/prompt';
export { PromptService } from './prompt/promptService';

export {
  IProfileService,
  type ProfileData,
  type ProfileModelContext,
  type ProfileServiceOptions,
  type ProfileSetModelResult,
  type ProfileUpdateData,
} from './profile/profile';
export { ProfileService } from './profile/profileService';

export {
  IUsageService,
  type UsageStatus,
  type UsageRecordScope,
} from './usage/usage';
export { UsageService } from './usage/usageService';
export {
  IGoalService,
  type GoalReasonInput,
} from './goal/goal';
export {
  GoalService,
  type GoalServiceOptions,
} from './goal/goalService';

export {
  ITelemetryService,
  type TelemetryServiceOptions,
} from './telemetry/telemetry';
export { TelemetryService } from './telemetry/telemetryService';

export {
  IPlanModeService,
  type PlanData,
  type PlanFilePath,
} from './planMode/planMode';
export { PlanModeService, PlanMode } from './planMode/planModeService';
export {
  PermissionModeInjection,
  registerPermissionModeInjection,
} from './permissionMode/injection/permissionModeInjection';
export {
  GoalInjection,
  type GoalInjectionOptions,
} from './goalMode/injection/goalInjection';
export {
  ISwarmMode,
  type SwarmModeTrigger,
} from './swarmMode/swarmMode';
export {
  SwarmModeService,
  SwarmModeService as SwarmMode,
} from './swarmMode/swarmModeService';
export { ISubagentHost } from './subagentHost/subagentHost';
export { SubagentHostService } from './subagentHost/subagentHostService';
export {
  BackgroundTaskPersistence,
  IBackgroundService,
  type BackgroundOptions,
  type BackgroundLoadOptions,
  type BackgroundServiceOptions,
  type BackgroundTask,
  type BackgroundTaskOutputSnapshot,
} from './background/background';
export {
  BackgroundService,
  BackgroundService as Background,
} from './background/backgroundService';
export {
  ICronService,
  type CronFireOptions,
  type CronLoadOptions,
  type CronOptions,
  type CronPersistence,
  type CronTaskInit,
} from './cron/cron';
export {
  CronService,
  CronService as Cron,
} from './cron/cronService';
export {
  IAgentSkillService,
  type AgentSkillServiceOptions,
  type AgentSkillServiceOptions as SkillOptions,
  type ModelSkillActivationInput,
  type SkillActivationInput,
} from './skill/skill';
export {
  AgentSkillService,
  AgentSkillService as Skill,
} from './skill/skillService';
export {
  IFullCompaction,
  type CompactInput,
} from './fullCompaction/fullCompaction';
export {
  FullCompaction,
  FullCompactionService,
} from './fullCompaction/fullCompactionService';
export {
  MicroCompactingProjector,
  type MicroCompactingProjectorOptions,
} from './contextProjector/microCompactingProjector';
export {
  AgentRuntime,
  createAgentRuntime,
  getAgentServiceDescriptors,
  isAgentServiceIdentifier,
  type AgentRuntimeDynamicInjection,
  type AgentRuntimeGoalOptions,
  type AgentRuntimeOptions,
  type AgentRuntimeType,
} from './runtime';
