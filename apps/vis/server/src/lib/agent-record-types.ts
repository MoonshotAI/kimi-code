export type {
  ContextMessage,
  LoopRecordedEvent,
  Message,
  ContentPart,
  ToolCall,
  TokenUsage,
  PermissionMode,
  PromptOrigin,
  CronTask,
} from '@moonshot-ai/agent-core-v2';
export type { ContentPart as CoreContentPart } from '@moonshot-ai/core/llm/message';
export { mediaUrlOf } from '@moonshot-ai/core/llm/protocol/kit/media';
export { WIRE_PROTOCOL_VERSION } from '@moonshot-ai/agent-core-v2/wire/migration/migration';
export type {
  AgentTaskInfo as BackgroundTaskInfo,
  AgentTaskStatus as BackgroundTaskStatus,
} from '@moonshot-ai/agent-core-v2';
export type {
  ProcessTaskInfo as ProcessBackgroundTaskInfo,
  QuestionTaskInfo as QuestionBackgroundTaskInfo,
  SubagentTaskInfo as AgentBackgroundTaskInfo,
} from '@moonshot-ai/agent-core-v2/agent/task/types';

import type {
  AgentTaskInfo as BackgroundTaskInfo,
  CronAddPayload,
  CronCursorPayload,
  CronDeletePayload,
  CronTask,
  ExportSessionManifest,
  FileHistoryCheckpointed,
  FileHistoryTracked,
  Forked,
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
  GoalClear,
  GoalCreate,
  GoalUpdate,
  InteractionRequestEvent,
  InteractionResolvedEvent,
  InterruptionCancellationRequested,
  InterruptionReminderRecorded,
  LlmRequest,
  LlmToolsSnapshot,
  McpServerFailed,
  McpServerFailureResolved,
  McpToolsDiscovered,
  PlanModeCancel,
  PlanModeEnter,
  PlanModeExit,
  PlanRevision,
  PluginSessionStartEvent,
  PromptAborted,
  PromptCompleted,
  PromptSteered,
  SubagentCancelled,
  SubagentCompleted,
  SubagentFailed,
  SubagentSpawned,
  SubagentStarted,
  TaskStarted,
  TaskTerminated,
  TokenCountingMeasured,
  TokenCountingRebased,
  TokenCountingTruncated,
  TokenCountingTurnRecorded,
  ToolSelectInitialized,
  ToolSelectToolsChanged,
  ToolsRegisterUserTool,
  ToolsUnregisterUserTool,
} from '@moonshot-ai/agent-core-v2';
import type {
  ContextAppendLoopEvent,
  ContextAppendMessage,
  ContextApplyCompactionPayload,
  ContextClear,
  ContextUndo,
} from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import type { TurnCancel, TurnEnded, TurnPrompt, TurnSteer } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import type {
  TurnStepInterrupted,
  TurnStepRetrying,
} from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { UsageRecord } from '@moonshot-ai/agent-core-v2/agent/usage/usageOps';
import type {
  ConfigUpdate,
  ProfileBind,
  ToolsResetActiveTools,
  ToolsSetActiveTools,
} from '@moonshot-ai/agent-core-v2/agent/profile/profileOps';
import type { ChangeNotifierSnapshotEvent } from '@moonshot-ai/agent-core-v2/agent/changeNotifier/changeNotifierOps';
import type { PermissionSetMode } from '@moonshot-ai/agent-core-v2/agent/permissionMode/permissionModeOps';
import type { PermissionRecordApprovalResult } from '@moonshot-ai/agent-core-v2/agent/permissionRules/permissionRulesOps';
import type { EnvironmentSetBinding } from '@moonshot-ai/agent-core-v2/agent/environmentBinding/environmentBindingOps';
import type {
  AutoReviewAncestryRecorded,
  AutoReviewCompleted,
} from '@moonshot-ai/agent-core-v2/features/autoReview/autoReviewEvents';
import type { SwarmModeEnter, SwarmModeExit } from '@moonshot-ai/agent-core-v2/features/swarm/swarmOps';
import type { TowerModeEnter, TowerModeExit } from '@moonshot-ai/agent-core-v2/features/tower/towerOps';
import type { ToolsUpdateStore } from '@moonshot-ai/agent-core-v2/features/todo/todoOps';

interface TaskWaitDelivered {
  readonly agentId: string;
  readonly keys: string[];
}

type WireRecordOf<T extends string, E> = E extends unknown
  ? Omit<E, 'type' | 'time' | 'serialize'> & { readonly type: T; readonly time?: number }
  : never;

export interface ContextUpdateTokenCountRecord {
  readonly type: 'context.update_token_count';
  readonly tokenCount: number;
  readonly time?: number;
}

export interface MicroCompactionApplyRecord {
  readonly type: 'micro_compaction.apply';
  readonly cutoff: number;
  readonly time?: number;
}

export interface StaleGuardRecordedRecord {
  readonly type: 'staleGuard.recorded';
  readonly path: string;
  readonly mtimeMs: number;
  readonly time?: number;
}

export interface StaleGuardClearedRecord {
  readonly type: 'staleGuard.cleared';
  readonly time?: number;
}

export interface PromptAcceptedRecord {
  readonly type: 'prompt.accepted';
  readonly agentId: string;
  readonly promptId: string;
  readonly content?: unknown;
  readonly time?: number;
}

export interface WireMetadataHeader {
  readonly type: 'metadata';
  readonly protocol_version: string;
  readonly created_at: number;
  readonly time?: number;
}

export type AgentRecord =
  | WireMetadataHeader
  | WireRecordOf<'auto_review.ancestry_recorded', AutoReviewAncestryRecorded>
  | WireRecordOf<'auto_review.decision', AutoReviewCompleted>
  | WireRecordOf<'changeNotifier.snapshot', ChangeNotifierSnapshotEvent>
  | WireRecordOf<'config.update', ConfigUpdate>
  | WireRecordOf<'context.append_loop_event', ContextAppendLoopEvent>
  | WireRecordOf<'context.append_message', ContextAppendMessage>
  | WireRecordOf<'context.apply_compaction', ContextApplyCompactionPayload>
  | WireRecordOf<'context.clear', ContextClear>
  | WireRecordOf<'context.undo', ContextUndo>
  | WireRecordOf<'cron.add', CronAddPayload>
  | WireRecordOf<'cron.cursor', CronCursorPayload>
  | WireRecordOf<'cron.delete', CronDeletePayload>
  | WireRecordOf<'file_history.checkpoint', FileHistoryCheckpointed>
  | WireRecordOf<'file_history.tracked', FileHistoryTracked>
  | WireRecordOf<'forked', Forked>
  | WireRecordOf<'full_compaction.begin', FullCompactionBegin>
  | WireRecordOf<'full_compaction.cancel', FullCompactionCancel>
  | WireRecordOf<'full_compaction.complete', FullCompactionComplete>
  | WireRecordOf<'goal.clear', GoalClear>
  | WireRecordOf<'goal.create', GoalCreate>
  | WireRecordOf<'goal.update', GoalUpdate>
  | WireRecordOf<'interaction.request', InteractionRequestEvent>
  | WireRecordOf<'interaction.resolved', InteractionResolvedEvent>
  | WireRecordOf<'interruptionReminder.recorded', InterruptionReminderRecorded>
  | WireRecordOf<'interruptionReminder.requested', InterruptionCancellationRequested>
  | WireRecordOf<'llm.request', LlmRequest>
  | WireRecordOf<'llm.tools_snapshot', LlmToolsSnapshot>
  | WireRecordOf<'mcp.server_failed', McpServerFailed>
  | WireRecordOf<'mcp.server_failure_resolved', McpServerFailureResolved>
  | WireRecordOf<'mcp.tools_discovered', McpToolsDiscovered>
  | WireRecordOf<'tool_select.initialized', ToolSelectInitialized>
  | WireRecordOf<'tool_select.tools_changed', ToolSelectToolsChanged>
  | WireRecordOf<'permission.record_approval_result', PermissionRecordApprovalResult>
  | WireRecordOf<'permission.set_mode', PermissionSetMode>
  | WireRecordOf<'plan_mode.cancel', PlanModeCancel>
  | WireRecordOf<'plan_mode.enter', PlanModeEnter>
  | WireRecordOf<'plan_mode.exit', PlanModeExit>
  | WireRecordOf<'plan.revision', PlanRevision>
  | WireRecordOf<'plugin.session_start', PluginSessionStartEvent>
  | WireRecordOf<'profile.bind', ProfileBind>
  | WireRecordOf<'prompt.aborted', PromptAborted>
  | PromptAcceptedRecord
  | WireRecordOf<'prompt.completed', PromptCompleted>
  | WireRecordOf<'prompt.steered', PromptSteered>
  | WireRecordOf<'environment.set_binding', EnvironmentSetBinding>
  | WireRecordOf<'subagent.cancelled', SubagentCancelled>
  | WireRecordOf<'subagent.completed', SubagentCompleted>
  | WireRecordOf<'subagent.failed', SubagentFailed>
  | WireRecordOf<'subagent.spawned', SubagentSpawned>
  | WireRecordOf<'subagent.started', SubagentStarted>
  | WireRecordOf<'swarm_mode.enter', SwarmModeEnter>
  | WireRecordOf<'swarm_mode.exit', SwarmModeExit>
  | WireRecordOf<'task.started', TaskStarted>
  | WireRecordOf<'task.terminated', TaskTerminated>
  | WireRecordOf<'task.waitDelivered', TaskWaitDelivered>
  | WireRecordOf<'token_counting.measured', TokenCountingMeasured>
  | WireRecordOf<'token_counting.rebased', TokenCountingRebased>
  | WireRecordOf<'token_counting.truncated', TokenCountingTruncated>
  | WireRecordOf<'token_counting.turn_recorded', TokenCountingTurnRecorded>
  | WireRecordOf<'tools.register_user_tool', ToolsRegisterUserTool>
  | WireRecordOf<'tools.reset_active_tools', ToolsResetActiveTools>
  | WireRecordOf<'tools.set_active_tools', ToolsSetActiveTools>
  | WireRecordOf<'tools.unregister_user_tool', ToolsUnregisterUserTool>
  | WireRecordOf<'tools.update_store', ToolsUpdateStore>
  | WireRecordOf<'tower_mode.enter', TowerModeEnter>
  | WireRecordOf<'tower_mode.exit', TowerModeExit>
  | WireRecordOf<'turn.cancel', TurnCancel>
  | WireRecordOf<'turn.ended', TurnEnded>
  | WireRecordOf<'turn.prompt', TurnPrompt>
  | WireRecordOf<'turn.steer', TurnSteer>
  | WireRecordOf<'turn.step.interrupted', TurnStepInterrupted>
  | WireRecordOf<'turn.step.retrying', TurnStepRetrying>
  | WireRecordOf<'usage.record', UsageRecord>
  | ContextUpdateTokenCountRecord
  | MicroCompactionApplyRecord
  | StaleGuardRecordedRecord
  | StaleGuardClearedRecord;

export type AgentRecordOf<K extends AgentRecord['type']> = Extract<
  AgentRecord,
  { readonly type: K }
>;

export type ImportManifest = Partial<ExportSessionManifest>;

export interface ImportInfo {
  importId: string;
  importedAt: string;
  originalName: string | null;
  manifest: ImportManifest | null;
}

export interface ApiError {
  error: string;
  code:
    | 'NOT_FOUND'
    | 'BAD_REQUEST'
    | 'UNAUTHORIZED'
    | 'READ_ERROR'
    | 'PARSE_ERROR'
    | 'DELETE_ERROR';
}

export type SessionHealth =
  | 'ok'
  | 'broken_state'
  | 'broken_main_wire'
  | 'missing_main_wire';

export interface SessionSummary {
  sessionId: string;
  sessionDir: string;
  workDir: string;
  title: string | null;
  lastPrompt: string | null;
  isCustomTitle: boolean;
  createdAt: number;
  updatedAt: number;
  agentCount: number;
  mainAgentExists: boolean;
  mainWireRecordCount: number;
  wireProtocolVersion: string | null;
  health: SessionHealth;
  imported: boolean;
  importMeta: ImportInfo | null;
}

export interface AgentInfo {
  agentId: string;
  type: 'main' | 'sub' | 'independent';
  parentAgentId: string | null;
  profileName: string | null;
  homedir: string;
  wireExists: boolean;
  wireRecordCount: number;
  wireProtocolVersion: string | null;
  swarmItem: string | null;
}

export interface SessionDetail {
  sessionId: string;
  sessionDir: string;
  workDir: string;
  state: unknown;
  agents: AgentInfo[];
  imported: boolean;
  importMeta: ImportInfo | null;
}

export interface WireEntry {
  lineNo: number;
  data: AgentRecord;
  raw: unknown;
}

export interface WireResponse {
  sessionId: string;
  agentId: string;
  protocolVersion: string;
  metadata: { protocolVersion: string; createdAt: number };
  records: readonly WireEntry[];
  warnings: string[];
}

export interface AgentNode extends AgentInfo {
  children: AgentNode[];
}

export interface AgentTreeResponse {
  sessionId: string;
  tree: AgentNode[];
}

export interface BackgroundTaskEntry {
  task: BackgroundTaskInfo;
  agentId: string;
  outputSizeBytes: number;
  outputExists: boolean;
}

export interface BackgroundTasksResponse {
  sessionId: string;
  tasks: BackgroundTaskEntry[];
}

export interface TaskOutputResponse {
  sessionId: string;
  taskId: string;
  offset: number;
  nextOffset: number;
  size: number;
  content: string;
  eof: boolean;
}

export interface CronTasksResponse {
  sessionId: string;
  cron: CronTask[];
}

export interface ImportResult {
  sessionId: string;
  importMeta: ImportInfo;
}

export interface LogLine {
  lineNo: number;
  time: string | null;
  level: string | null;
  message: string;
  fields: Record<string, string>;
  raw: string;
}

export interface LogsResponse {
  sessionId: string;
  which: 'session' | 'global';
  available: { session: boolean; global: boolean };
  lines: LogLine[];
  truncated: boolean;
}
