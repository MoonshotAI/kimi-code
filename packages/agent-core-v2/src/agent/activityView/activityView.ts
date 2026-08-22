/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { TurnEndReason } from '#/agent/loop/turnEvents';
import { AgentEvent2, type AgentDomainTrait } from '#/app/event/event2';

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

export class AgentActivityUpdated extends AgentEvent2<AgentActivityState & AgentDomainTrait> {
  static override readonly type = 'agent.activity.updated';
  static override readonly observable = true;
}
export interface AgentActivityUpdated extends AgentActivityState {
  readonly agentId: string;
}
