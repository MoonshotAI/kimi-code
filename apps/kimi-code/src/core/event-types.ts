/**
 * Named event types for the TUI/CLI event handlers. The v2 barrel exports only
 * the `DomainEvent` union, so the v1 SDK event names consumers import are
 * derived from the session stream union: each alias is the matching
 * `SessionEvent` variant (v2-native payload plus `agentId`/`sessionId`).
 */

import type { SessionEventOf } from './types';

export type TurnStartedEvent = SessionEventOf<'turn.started'>;
export type TurnEndedEvent = SessionEventOf<'turn.ended'>;
export type TurnStepStartedEvent = SessionEventOf<'turn.step.started'>;
export type TurnStepCompletedEvent = SessionEventOf<'turn.step.completed'>;
export type TurnStepInterruptedEvent = SessionEventOf<'turn.step.interrupted'>;
export type AssistantDeltaEvent = SessionEventOf<'assistant.delta'>;
export type ThinkingDeltaEvent = SessionEventOf<'thinking.delta'>;
export type ToolCallStartedEvent = SessionEventOf<'tool.call.started'>;
export type ToolCallDeltaEvent = SessionEventOf<'tool.call.delta'>;
export type ToolProgressEvent = SessionEventOf<'tool.progress'>;
export type ToolResultEvent = SessionEventOf<'tool.result'>;
export type AgentStatusUpdatedEvent = SessionEventOf<'agent.status.updated'>;
export type SessionMetaUpdatedEvent = SessionEventOf<'session.meta.updated'>;
export type GoalUpdatedEvent = SessionEventOf<'goal.updated'>;
export type SkillActivatedEvent = SessionEventOf<'skill.activated'>;
export type PluginCommandActivatedEvent = SessionEventOf<'plugin_command.activated'>;
export type ErrorEvent = SessionEventOf<'error'>;
export type WarningEvent = SessionEventOf<'warning'>;
export type HookResultEvent = SessionEventOf<'hook.result'>;
export type CompactionStartedEvent = SessionEventOf<'compaction.started'>;
export type CompactionCompletedEvent = SessionEventOf<'compaction.completed'>;
export type CompactionCancelledEvent = SessionEventOf<'compaction.cancelled'>;
/** v2 renamed `background.task.*` to `task.*`; payload is `{ info: AgentTaskInfo }`. */
export type TaskStartedEvent = SessionEventOf<'task.started'>;
export type TaskTerminatedEvent = SessionEventOf<'task.terminated'>;
export type CronFiredEvent = SessionEventOf<'cron.fired'>;
