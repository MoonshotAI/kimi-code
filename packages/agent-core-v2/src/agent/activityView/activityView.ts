/**
 * `activityView` domain (L4) — the agent's one-way activity projection.
 *
 * Defines `IAgentActivityView`: a per-agent, read-only, event-folded read
 * model of "what this agent is doing" — the current turn with its live
 * phase/stream/step/retry/pending-approval/tool-call detail and the latest
 * turn outcome, published on the agent's event bus as
 * `agent.activity.updated`. The view OWNS NO authoritative state: every fact
 * is folded from the agent's own event bus (loop turn/step/delta/tool/retry,
 * permission approval, task, and full-compaction events) and seeded once from
 * the owning services; it can be discarded and rebuilt at any time. Turn
 * mechanics live in the loop, admission/drain in the session lifecycle, and
 * background work in task/full-compaction services — none of that is
 * duplicated here. Bound at Agent scope — one instance per agent, dying with
 * it.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { TurnEndReason } from '#/agent/loop/turnEvents';

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

/**
 * Coarse existence reference to one piece of the agent's active background
 * work (task or full compaction) — the second busy layer. Owner-specific
 * details live in their own domains; this carries only "there is live
 * background work".
 */
export interface BackgroundRef {
  readonly kind: string;
  readonly id: string;
  readonly since: number;
}

/** The view's lifecycle slice: `ready` once materialized, `disposed` when the
 *  agent is being torn down. There is no `initializing` state — the view is
 *  created lazily and a restoring agent exposes no handles yet. */
export type ActivityViewLifecycle = 'ready' | 'disposed';

/** The agent's folded activity snapshot — the payload of `agent.activity.updated`. */
export interface AgentActivityState {
  readonly lifecycle: ActivityViewLifecycle;
  readonly turn?: ActivityTurnState;
  readonly lastTurn?: ActivityLastTurnState;
  readonly background: readonly BackgroundRef[];
}

export interface IAgentActivityView {
  readonly _serviceBrand: undefined;

  /** The current folded snapshot (cheap to recompute; do not cache long-term). */
  state(): AgentActivityState;
}

export const IAgentActivityView: ServiceIdentifier<IAgentActivityView> =
  createDecorator<IAgentActivityView>('agentActivityView');

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'agent.activity.updated': AgentActivityState & { readonly type: 'agent.activity.updated' };
  }
}
