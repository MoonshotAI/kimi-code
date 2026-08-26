import type { Event } from '#/_base/event';
import { defineAgentRuntimeContract } from '#/agent/runtime/agentRuntime';
export type { LoopRunResult } from './internal/loop';

export interface LoopRunInput {
  readonly promptId?: string;
}

export type LoopStatus = 'idle' | 'running' | 'settled' | 'cancelled';

export interface LoopResult {
  readonly status: LoopStatus;
}

export interface TurnStartedEvent {
  readonly turnId: number;
}

export interface TurnEndedEvent {
  readonly turnId: number;
  readonly status: LoopStatus;
}

export interface LoopRuntime {
  run(input: LoopRunInput): Promise<LoopResult>;
  cancel(reason?: string): Promise<void>;
  cancelByUser(reason?: string): Promise<void>;
  status(): LoopStatus;
  waitUntilSettled(): Promise<LoopResult>;
  readonly onDidStartTurn: Event<TurnStartedEvent>;
  readonly onDidEndTurn: Event<TurnEndedEvent>;
}

export const AgentLoop = defineAgentRuntimeContract<LoopRuntime>('loop');
