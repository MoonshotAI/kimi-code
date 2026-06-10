import type { FinishReason, TokenUsage } from '@moonshot-ai/kosong';

import type { GoalChange, GoalSnapshot } from '../agent/goal';
import type { CronJobOrigin, PromptOrigin } from '../agent/context';
import type { KimiErrorPayload } from '../errors';
import type { PermissionMode } from '../agent/permission';
import type { SkillSource } from '../skill';
import type { BackgroundTaskInfo } from '../agent/background';
import type { ToolInputDisplay } from '../tools/display';

export type { ToolInputDisplay } from '../tools/display';
export type { KimiErrorPayload } from '../errors';

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage> | undefined;
  readonly currentTurn?: TokenUsage | undefined;
  readonly total?: TokenUsage | undefined;
}

export interface ToolUpdate {
  readonly kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  readonly text?: string | undefined;
  readonly percent?: number | undefined;
  readonly customKind?: string | undefined;
  readonly customData?: unknown;
}

export const MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE = 'mcp.oauth.authorization_url';

export interface McpOAuthAuthorizationUrlUpdateData {
  readonly serverName: string;
  readonly authorizationUrl: string;
}

export interface CompactionResult {
  readonly summary: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export type TurnEndReason = 'completed' | 'cancelled' | 'failed';

export interface AgentStatusUpdatedEvent {
  readonly type: 'agent.status.updated';
  readonly model?: string | undefined;
  readonly contextTokens?: number | undefined;
  readonly maxContextTokens?: number | undefined;
  readonly contextUsage?: number | undefined;
  readonly planMode?: boolean | undefined;
  readonly swarmMode?: boolean | undefined;
  readonly permission?: PermissionMode | undefined;
  readonly usage?: UsageStatus | undefined;
}

export interface SessionMetaUpdatedEvent {
  readonly type: 'session.meta.updated';
  readonly title?: string | undefined;
  readonly patch?: Record<string, unknown> | undefined;
}

export interface GoalUpdatedEvent {
  readonly type: 'goal.updated';
  /** Current goal snapshot, or `null` when no goal is set (cleared/cancelled). */
  readonly snapshot: GoalSnapshot | null;
  /**
   * What changed, when the update is a lifecycle / verdict / terminal transition.
   * Absent for snapshot-only refreshes (e.g. a turn increment). Drives transcript
   * markers and the completion card.
   */
  readonly change?: GoalChange;
}

export interface SkillActivatedEvent {
  readonly type: 'skill.activated';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string | undefined;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillPath?: string | undefined;
  readonly skillSource?: SkillSource | undefined;
}

export interface ErrorEvent extends KimiErrorPayload {
  readonly type: 'error';
}

export interface WarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly code?: string | undefined;
}

export interface TurnStartedEvent {
  readonly type: 'turn.started';
  readonly turnId: number;
  readonly origin: PromptOrigin;
}

export interface TurnEndedEvent {
  readonly type: 'turn.ended';
  readonly turnId: number;
  readonly reason: TurnEndReason;
  readonly error?: KimiErrorPayload | undefined;
}

export interface TurnStepStartedEvent {
  readonly type: 'turn.step.started';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string | undefined;
}

export interface TurnStepCompletedEvent {
  readonly type: 'turn.step.completed';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string | undefined;
  readonly usage?: TokenUsage | undefined;
  readonly finishReason?: string | undefined;
  readonly llmFirstTokenLatencyMs?: number | undefined;
  readonly llmStreamDurationMs?: number | undefined;
  readonly providerFinishReason?: FinishReason | undefined;
  readonly rawFinishReason?: string | undefined;
}

export interface TurnStepRetryingEvent {
  readonly type: 'turn.step.retrying';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export interface TurnStepInterruptedEvent {
  readonly type: 'turn.step.interrupted';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string | undefined;
  readonly reason: string;
  readonly message?: string | undefined;
}

export interface AssistantDeltaEvent {
  readonly type: 'assistant.delta';
  readonly turnId: number;
  readonly delta: string;
}

export interface HookResultEvent {
  readonly type: 'hook.result';
  readonly turnId: number;
  readonly hookEvent: string;
  readonly content: string;
  readonly blocked?: boolean | undefined;
}

export interface ThinkingDeltaEvent {
  readonly type: 'thinking.delta';
  readonly turnId: number;
  readonly delta: string;
}

export interface ToolCallDeltaEvent {
  readonly type: 'tool.call.delta';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name?: string | undefined;
  readonly argumentsPart?: string | undefined;
}

export interface ToolCallStartedEvent {
  readonly type: 'tool.call.started';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly description?: string | undefined;
  readonly display?: ToolInputDisplay | undefined;
}

export interface ToolProgressEvent {
  readonly type: 'tool.progress';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly update: ToolUpdate;
}

export interface ToolResultEvent {
  readonly type: 'tool.result';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly output: unknown;
  readonly isError?: boolean | undefined;
  readonly synthetic?: boolean | undefined;
}

export interface SubagentSpawnedEvent {
  readonly type: 'subagent.spawned';
  readonly subagentId: string;
  readonly subagentName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string | undefined;
  readonly parentAgentId?: string | undefined;
  readonly description?: string | undefined;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
}

export interface SubagentStartedEvent {
  readonly type: 'subagent.started';
  readonly subagentId: string;
}

export interface SubagentSuspendedEvent {
  readonly type: 'subagent.suspended';
  readonly subagentId: string;
  readonly reason: string;
}

export interface SubagentCompletedEvent {
  readonly type: 'subagent.completed';
  readonly subagentId: string;
  readonly resultSummary: string;
  readonly usage?: TokenUsage | undefined;
  readonly contextTokens?: number | undefined;
}

export interface SubagentFailedEvent {
  readonly type: 'subagent.failed';
  readonly subagentId: string;
  readonly error: string;
}

export interface CompactionStartedEvent {
  readonly type: 'compaction.started';
  readonly trigger: 'manual' | 'auto';
  readonly instruction?: string | undefined;
}

export interface CompactionBlockedEvent {
  readonly type: 'compaction.blocked';
  readonly turnId?: number | undefined;
}

export interface CompactionCancelledEvent {
  readonly type: 'compaction.cancelled';
}

export interface CompactionCompletedEvent {
  readonly type: 'compaction.completed';
  readonly result: CompactionResult;
}

export interface BackgroundTaskStartedEvent {
  readonly type: 'background.task.started';
  readonly info: BackgroundTaskInfo;
}

export interface BackgroundTaskTerminatedEvent {
  readonly type: 'background.task.terminated';
  readonly info: BackgroundTaskInfo;
}

export interface CronFiredEvent {
  readonly type: 'cron.fired';
  readonly origin: CronJobOrigin;
  readonly prompt: string;
}

export type ToolListUpdatedReason = 'mcp.connected' | 'mcp.disconnected' | 'mcp.failed';

export interface ToolListUpdatedEvent {
  readonly type: 'tool.list.updated';
  readonly reason: ToolListUpdatedReason;
  readonly serverName: string;
}

export interface McpServerStatusEvent {
  readonly type: 'mcp.server.status';
  readonly server: McpServerStatusPayload;
}

export interface McpServerStatusPayload {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string | undefined;
}

export type AgentEvent =
  | ErrorEvent
  | WarningEvent
  | AgentStatusUpdatedEvent
  | SessionMetaUpdatedEvent
  | GoalUpdatedEvent
  | SkillActivatedEvent
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
  | BackgroundTaskStartedEvent
  | BackgroundTaskTerminatedEvent
  | CronFiredEvent;

export type Event = AgentEvent & { agentId: string; sessionId: string };
