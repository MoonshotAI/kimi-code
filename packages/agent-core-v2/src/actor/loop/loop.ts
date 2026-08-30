import type { Event } from '#/_base/event';
import { defineAgentRuntimeContract } from '#/actor/agentRuntime';
import type { PromptOrigin } from '#/actor/contextMemory/types';
import type { TurnEndReason } from './turnEvents';
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

export type LoopTurnPhase = 'working' | 'streaming' | 'toolCalling' | 'retrying';

export type LoopStreamKind = 'assistant' | 'thinking' | 'tool_call';

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export interface LoopRetryActivity {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName?: string;
  readonly statusCode?: number;
}

export interface LoopTurnActivity {
  readonly turnId: number;
  readonly origin: PromptOrigin;
  readonly since: number;
  readonly step: number;
  readonly phase: LoopTurnPhase;
  readonly stream?: LoopStreamKind;
  readonly retry?: LoopRetryActivity;
  readonly interrupting?: LoopInterruptReason;
}

export interface LoopLastTurnActivity {
  readonly turnId: number;
  readonly reason: TurnEndReason;
  readonly durationMs?: number;
  readonly at: number;
}

export interface LoopActivity {
  readonly turn?: LoopTurnActivity;
  readonly lastTurn?: LoopLastTurnActivity;
}

export interface LoopRuntime {
  run(input: LoopRunInput): Promise<LoopResult>;
  cancel(reason?: string): Promise<void>;
  cancelByUser(reason?: string): Promise<void>;
  status(): LoopStatus;
  waitUntilSettled(): Promise<LoopResult>;
  activity(): LoopActivity;
  readonly onDidChangeActivity: Event<LoopActivity>;
  readonly onDidStartTurn: Event<TurnStartedEvent>;
  readonly onDidEndTurn: Event<TurnEndedEvent>;
}

export const AgentLoop = defineAgentRuntimeContract<LoopRuntime>('loop');
