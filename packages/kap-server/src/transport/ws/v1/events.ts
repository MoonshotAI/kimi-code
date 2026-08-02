/**
 * The v1 WS `Event` union — the per-agent event stream frame payloads.
 *
 * Engine mode (the only mode): Rust-engine frames arrive as projected
 * `Record<string, unknown>` via the broadcaster's `broadcastRustFrame` path;
 * the typed `Event` union below covers the v1-only frames this transport
 * synthesizes (session/workspace lifecycle, config changes, the merged
 * legacy status overlay, and the legacy background-task spellings). The v2
 * `DomainEvent` backbone was retired with the engine migration.
 */

import type { MessageContent } from '../../../protocol/message';
import type { AgentPhase } from '../../../services/legacyStatus/legacyStatus';
import type { ConfigResponse } from '../../../protocol/rest-config';
import type { Session, SessionPendingInteraction } from '../../../protocol/session';
import type { Workspace } from '../../../protocol/workspace';

/** Legacy `permission` mode of the combined status payload (localized from v2). */
export type PermissionMode = 'manual' | 'yolo' | 'auto';

/** Legacy token-usage shape of the combined status payload (localized from v2). */
export interface TokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly currentTurn?: TokenUsage;
  readonly total?: TokenUsage;
}

export interface AgentStatusUpdatedEvent {
  readonly type: 'agent.status.updated';
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly permission?: PermissionMode;
  readonly usage?: UsageStatus;
  readonly phase?: AgentPhase;
}

export interface AgentCreatedEvent {
  readonly type: 'agent.created';
}

export interface AgentDisposedEvent {
  readonly type: 'agent.disposed';
}

export interface SessionMetaUpdatedEvent {
  readonly type: 'session.meta.updated';
  readonly title?: string;
  readonly patch?: Record<string, unknown>;
}

export interface SessionCreatedEvent {
  readonly type: 'event.session.created';
  readonly session: Session;
}

export interface WorkspaceCreatedEvent {
  readonly type: 'event.workspace.created';
  readonly workspace: Workspace;
}

export interface WorkspaceUpdatedEvent {
  readonly type: 'event.workspace.updated';
  readonly workspace: Workspace;
}

export interface WorkspaceDeletedEvent {
  readonly type: 'event.workspace.deleted';
  readonly workspace_id: string;
  readonly root: string;
}

export interface SessionWorkChangedEvent {
  readonly type: 'event.session.work_changed';
  readonly busy: boolean;
  readonly main_turn_active?: boolean;
  readonly pending_interaction?: SessionPendingInteraction;
  readonly last_turn_reason?: 'completed' | 'cancelled' | 'failed';
}

type LegacySessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_question'
  | 'aborted';

export interface SessionStatusChangedEvent {
  readonly type: 'event.session.status_changed';
  readonly status: LegacySessionStatus;
  readonly previous_status: LegacySessionStatus;
  readonly current_prompt_id?: string;
}

export interface ConfigChangedEvent {
  readonly type: 'event.config.changed';
  readonly changedFields: string[];
  readonly config: ConfigResponse;
}

export interface PromptSubmittedEvent {
  readonly type: 'prompt.submitted';
  readonly promptId: string;
  readonly userMessageId: string;
  readonly status: 'running' | 'queued' | 'blocked';
  readonly content: readonly MessageContent[];
  readonly createdAt: string;
}

export type TaskLifecycleStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface TaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: TaskLifecycleStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
}

export interface ProcessTaskInfo extends TaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export interface AgentTaskInfo extends TaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
}

export interface QuestionTaskInfo extends TaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export type TaskInfo =
  | ProcessTaskInfo
  | AgentTaskInfo
  | QuestionTaskInfo;

/**
 * Legacy background-task lifecycle events (`background.task.started` /
 * `background.task.terminated`). The v2 engine emits `task.started` /
 * `task.terminated`; the broadcaster re-spells them onto these legacy names so
 * older clients see a consistent stream.
 */
export interface BackgroundTaskStartedEvent {
  readonly type: 'background.task.started';
  readonly info: TaskInfo;
}

export interface BackgroundTaskTerminatedEvent {
  readonly type: 'background.task.terminated';
  readonly info: TaskInfo;
}

export type AgentEvent =
  | AgentStatusUpdatedEvent
  | AgentCreatedEvent
  | AgentDisposedEvent
  | SessionMetaUpdatedEvent
  | SessionCreatedEvent
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | SessionWorkChangedEvent
  | SessionStatusChangedEvent
  | ConfigChangedEvent
  | PromptSubmittedEvent
  | BackgroundTaskStartedEvent
  | BackgroundTaskTerminatedEvent;

export type Event = AgentEvent & { agentId: string; sessionId: string };

export const VOLATILE_EVENT_TYPES = [
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.output',
  'shell.started',
  'shell.completed',
  'agent.status.updated',
] as const;

export type VolatileEventType = (typeof VOLATILE_EVENT_TYPES)[number];

const volatileEventTypeSet: ReadonlySet<string> = new Set(VOLATILE_EVENT_TYPES);

/**
 * Volatile-vs-durable classification for the global / model event paths (the
 * agent path uses the local `isVolatileSignal` in the broadcaster instead).
 */
export function isVolatileEventType(type: string): type is VolatileEventType {
  return volatileEventTypeSet.has(type);
}
