import type { z } from 'zod';

import type { agentEventSchema } from '../../../protocol/events-zod';
import type { MessageContent } from '../../../protocol/message';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';
import type { UsageStatus } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import type { AgentPhase } from '../../../services/legacyStatus/legacyStatus';
import type { ConfigResponse } from '../../../protocol/rest-config';
import type { Session, SessionPendingInteraction } from '../../../protocol/session';
import type { Workspace } from '../../../protocol/workspace';

export interface AgentStatusUpdatedEvent {
  readonly type: 'agent.status.updated';
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly towerMode?: boolean;
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

export interface SessionArchivedEvent {
  readonly type: 'event.session.archived';
  readonly workspace_id: string;
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

export interface ConfigWarningItem {
  readonly domain?: string;
  readonly message: string;
}

/**
 * Global config warnings (deprecated keys / env vars in use, invalid
 * sections). Pushed live to every connection whenever the config service's
 * warning set changes; an empty `warnings` array means the last warning
 * cleared. Late joiners are not replayed — pull current warnings via the
 * config diagnostics RPC surface instead.
 */
export interface ConfigWarningEvent {
  readonly type: 'event.config.warning';
  readonly warnings: readonly ConfigWarningItem[];
}

/**
 * Plugin set mutation (install / enable / disable / remove from any client).
 * Bare fan-out signal — clients re-read the plugins REST surface.
 */
export interface PluginChangedEvent {
  readonly type: 'event.plugin.changed';
}

/**
 * Capability install progress transition. Global fan-out; clients update the
 * row live and re-read the capability once it settles (`running: false`).
 */
export interface CapabilityChangedEvent {
  readonly type: 'event.capability.changed';
  readonly capability_id: string;
  readonly install: {
    readonly running: boolean;
    readonly step?: string;
    readonly percent?: number;
    readonly error?: string;
    readonly note?: string;
  };
}

/**
 * DI unit state transition of the engine's scope tree, produced by
 * agent-core-v2's `IDebugCascadeService` (the L5 debug surface feed). Global:
 * carries no owning session and fans out to every connection.
 */
export interface DiUnitChangedEvent {
  readonly type: 'event.di.unit_changed';
  /** Scope path of the container owning the unit (`app` / `app/workspace:<id>` / …). */
  readonly scope: string;
  readonly token: string;
  readonly state: 'Pending' | 'Activating' | 'Active' | 'Unloading' | 'Failed';
  readonly error?: string;
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

type CoreStreamEvent = z.infer<typeof agentEventSchema>;

export type AgentEvent =
  | CoreStreamEvent
  | AgentStatusUpdatedEvent
  | AgentCreatedEvent
  | AgentDisposedEvent
  | SessionMetaUpdatedEvent
  | SessionCreatedEvent
  | SessionArchivedEvent
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | SessionWorkChangedEvent
  | SessionStatusChangedEvent
  | ConfigChangedEvent
  | ConfigWarningEvent
  | PluginChangedEvent
  | CapabilityChangedEvent
  | DiUnitChangedEvent
  | PromptSubmittedEvent
  | BackgroundTaskStartedEvent
  | BackgroundTaskTerminatedEvent;

export type Event = AgentEvent & { agentId: string; sessionId: string; readonly time?: number };

export const VOLATILE_EVENT_TYPES = [
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.output',
  'shell.started',
  'shell.completed',
  'agent.status.updated',
  'event.di.unit_changed',
  'event.capability.changed',
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
