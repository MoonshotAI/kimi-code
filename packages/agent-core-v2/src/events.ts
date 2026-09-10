import type { CompactionBlockedEvent, CompactionCancelledEvent, CompactionCompletedEvent, CompactionStartedEvent } from '#/agent/fullCompaction/compactionOps';
import type { TurnStartedEvent, TurnStepCompletedEvent, TurnStepInterruptedEvent, TurnStepRetryingEvent, TurnStepStartedEvent, AssistantDeltaEvent, ThinkingDeltaEvent } from '#/agent/loop/turnEvents';
import type { TurnEndedEvent } from '#/agent/loop/turnOps';
import type { PluginCommandActivatedEvent } from '#/agent/pluginCommand/pluginCommand';
import type { PromptAbortedEvent, PromptCompletedEvent, PromptSteeredEvent, PromptSubmittedEvent } from '#/agent/prompt/promptService';
import type { BackgroundTaskStartedEvent, BackgroundTaskTerminatedEvent, TaskStartedEvent, TaskTerminatedEvent } from '#/agent/task/types';
import type { McpServerStatusEvent, ShellCompletedEvent, ShellOutputEvent, ShellStartedEvent, ToolCallDeltaEvent, ToolCallStartedEvent, ToolListUpdatedEvent, ToolProgressEvent } from '#/agent/toolExecutor/toolExecutorEvents';
import type { ToolResultEventPayload } from '#/agent/toolExecutor/toolExecutorEvents';
import type { AgentStatusUpdatedEvent } from '#/agent/usage/usageEvents';
import type { CapabilityChangedEvent } from '#/app/capability/capabilityEvents';
import type { ConfigChangedEvent, ConfigWarningEvent } from '#/app/config/configEvents';
import type { ModelCatalogChangedEvent } from '#/app/kosongConfig/discovery';
import type { PluginChangedEvent } from '#/app/plugin/pluginEvents';
import type { SessionCreatedEvent, SessionStatusChangedEvent, SessionWorkChangedEvent } from '#/app/sessionLegacy/sessionProtocol';
import type { WorkspaceCreatedEvent, WorkspaceDeletedEvent, WorkspaceUpdatedEvent } from '#/app/workspace/workspaceProtocol';
import type { CronFiredEvent } from '#/features/cron/cronOps';
import type { HookResultEvent } from '#/features/externalHooks/agent/agentExternalHooksService';
import type { GoalUpdatedEvent } from '#/features/goal/goalOps';
import type { SkillActivatedEvent } from '#/features/skill/skillOps';
import type { SubagentSuspendedEvent } from '#/features/swarm/session/sessionSwarmService';
import type { SessionMetaUpdatedEvent } from '#/session/sessionMetadata/sessionMetaEvents';
import type { SubagentCompletedEvent, SubagentFailedEvent, SubagentSpawnedEvent, SubagentStartedEvent } from '#/session/subagent/mirrorAgentRun';

import type { ErrorEvent, WarningEvent } from './errors';

export interface ToolResultEvent extends Omit<ToolResultEventPayload, 'agentId'> {
  readonly type: 'tool.result';
}

export type AgentEvent =
  | ErrorEvent
  | WarningEvent
  | AgentStatusUpdatedEvent
  | SessionMetaUpdatedEvent
  | SessionCreatedEvent
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | SessionWorkChangedEvent
  | SessionStatusChangedEvent
  | ConfigChangedEvent
  | ConfigWarningEvent
  | ModelCatalogChangedEvent
  | PluginChangedEvent
  | CapabilityChangedEvent
  | GoalUpdatedEvent
  | SkillActivatedEvent
  | PluginCommandActivatedEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | TurnStepStartedEvent
  | TurnStepCompletedEvent
  | TurnStepRetryingEvent
  | TurnStepInterruptedEvent
  | AssistantDeltaEvent
  | HookResultEvent
  | ThinkingDeltaEvent
  | ToolCallDeltaEvent
  | ToolCallStartedEvent
  | ToolProgressEvent
  | ShellOutputEvent
  | ShellStartedEvent
  | ShellCompletedEvent
  | ToolResultEvent
  | ToolListUpdatedEvent
  | McpServerStatusEvent
  | SubagentSpawnedEvent
  | SubagentStartedEvent
  | SubagentSuspendedEvent
  | SubagentCompletedEvent
  | SubagentFailedEvent
  | CompactionStartedEvent
  | CompactionBlockedEvent
  | CompactionCancelledEvent
  | CompactionCompletedEvent
  | TaskStartedEvent
  | TaskTerminatedEvent
  | BackgroundTaskStartedEvent
  | BackgroundTaskTerminatedEvent
  | CronFiredEvent
  | PromptSubmittedEvent
  | PromptCompletedEvent
  | PromptAbortedEvent
  | PromptSteeredEvent;

export type Event = AgentEvent & { agentId: string; sessionId: string };
