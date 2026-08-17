/**
 * `activityView` domain — the agent's one-way activity projection.
 *
 * Defines `IAgentActivityView`: a per-agent, read-only, event-folded read
 * model of "what this agent is doing" — the current turn with its live
 * phase/stream/step/retry/pending-approval/tool-call detail and the latest
 * turn outcome, published on the agent's event bus as
 * `agent.activity.updated`. The view OWNS NO authoritative state: every fact
 * is folded from the agent's own event bus (loop turn/step/delta/tool/retry,
 * permission approval, task, and full-compaction events) and seeded once from
 * the owning services; it can be discarded and rebuilt at any time. Bound at
 * Agent scope — one instance per agent, dying with it.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { TurnEndReason } from '#/agent/loop/turnEvents';
import { Event2 } from '#/app/event/event2';

export type TurnPhase = 'running' | 'streaming' | 'tool_call' | 'retrying';

export interface ApprovalRef {
  readonly approvalId: string;
  readonly toolCallId?: string;
  readonly since: number;
}

export interface ToolCallRef {
  readonly toolCallId: string;
  readonly name: string;
  readonly since: number;
}

export interface ActivityRetryState {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName?: string;
  readonly statusCode?: number;
}

export interface ActivityTurnState {
  readonly turnId: number;
  readonly origin: PromptOrigin;
  readonly phase: TurnPhase;
  readonly stream?: 'assistant' | 'thinking' | 'tool_call';
  readonly step: number;
  readonly ending: boolean;
  readonly endingReason?: 'aborted' | 'max_steps' | 'error';
  readonly retry?: ActivityRetryState;
  readonly pendingApprovals: readonly ApprovalRef[];
  readonly activeToolCalls: readonly ToolCallRef[];
  readonly since: number;
}

export interface ActivityLastTurnState {
  readonly turnId: number;
  readonly reason: TurnEndReason;
  readonly durationMs?: number;
  readonly at: number;
}

export interface BackgroundRef {
  readonly kind: string;
  readonly id: string;
  readonly since: number;
}

export type ActivityViewLifecycle = 'ready' | 'disposed';

export interface AgentActivityState {
  readonly lifecycle: ActivityViewLifecycle;
  readonly turn?: ActivityTurnState;
  readonly lastTurn?: ActivityLastTurnState;
  readonly background: readonly BackgroundRef[];
}

export interface IAgentActivityView {
  readonly _serviceBrand: undefined;

  state(): AgentActivityState;
}

export const IAgentActivityView: ServiceIdentifier<IAgentActivityView> =
  createDecorator<IAgentActivityView>('agentActivityView');

export class AgentActivityUpdated extends Event2<AgentActivityState> {
  static override readonly type = 'agent.activity.updated';
  static override readonly observable = true;
}
export interface AgentActivityUpdated extends AgentActivityState {}
