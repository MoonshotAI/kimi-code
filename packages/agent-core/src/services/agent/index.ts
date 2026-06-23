export {
  createHooks,
  OrderedHookSlot,
  type HookHandler,
  type HookRegisterOptions,
  type Hooks,
  type HookSlot,
} from './hooks';
export type {
  AgentEventMap,
  AgentEvent as AgentServiceEvent,
  ContextMessage,
  LLMEvent,
  LLMRequestOverrides,
  Tool,
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

export { IEventBus } from './eventBus/eventBus';
export { EventBusService } from './eventBus/eventBusService';

export { IWireRecord } from './wireRecord/wireRecord';
export type {
  PersistedWireRecord,
  WireRecordMetadata,
  WireRecordPersistence,
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

export { IContextMemory } from './contextMemory/contextMemory';
export { ContextMemoryService } from './contextMemory/contextMemoryService';

export { IContextProjector } from './contextProjector/contextProjector';
export { ContextProjectorService } from './contextProjector/contextProjectorService';

export { ILoopService } from './loop/loop';
export { LoopService } from './loop/loopService';

export {
  IToolRegistry,
  type ToolRegistrationOptions,
} from './toolRegistry/toolRegistry';
export {
  ToolRegistryService,
} from './toolRegistry/toolRegistryService';

export { IToolStoreService } from './toolStore/toolStore';
export { ToolStoreService } from './toolStore/toolStoreService';

export { IToolExecutor, type ToolExecutorOptions } from './toolExecutor/toolExecutor';
export { ToolExecutorService } from './toolExecutor/toolExecutorService';

export { ILLMRequester } from './llmRequester/llmRequester';
export {
  LLMRequesterService,
  type LLMRequesterServiceOptions,
} from './llmRequester/llmRequesterService';

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
  type ProfileUpdateData,
} from './profile/profile';
export { ProfileService } from './profile/profileService';

export {
  IUsageService,
  type UsageStatus,
  type UsageRecordScope,
} from './usage/usage';
export { UsageService } from './usage/usageService';

export { PlanMode } from './extensions/planMode';
export { PermissionModeInjection } from './extensions/permissionModeInjection';
export { GoalInjection, type GoalInjectionOptions } from './extensions/goalInjection';
export { SwarmMode, type SwarmModeTrigger } from './extensions/swarmMode';
export {
  Background,
  type BackgroundTaskOutputSnapshot,
} from './extensions/background';
export {
  Cron,
  type CronFireOptions,
  type CronTaskInit,
} from './extensions/cron';
export { Skill, type SkillActivationInput } from './extensions/skill';
export {
  IFullCompaction,
  type CompactInput,
  type FullCompactionHooks,
  type PostCompactContext,
  type PreCompactContext,
} from './fullCompaction/fullCompaction';
export {
  FullCompaction,
  FullCompactionService,
} from './fullCompaction/fullCompactionService';
export {
  MicroCompactingProjector,
  type MicroCompactingProjectorOptions,
} from './extensions/microCompactingProjector';
