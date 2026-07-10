import { createDecorator } from '#/_base/di/instantiation';
import type { ContentPart } from '#/app/llmProtocol/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { LoopRunResult } from '#/agent/loop/loop';
import type { ActivityLease } from '#/activity/activity';

export type { LoopRunResult as TurnResult } from '#/agent/loop/loop';

export interface Turn {
  readonly id: number;
  /**
   * Cancellation signal owned by the `activity` kernel's turn lease. Abort it
   * through `IAgentTurnService.cancel(...)` rather than holding a controller;
   * the kernel is the single authority for turn cancellation.
   */
  readonly signal: AbortSignal;
  /**
   * Resolves on the first model response event for the first loop step, or at
   * step completion; rejects if the turn ends earlier.
   */
  readonly ready: Promise<void>;
  readonly result: Promise<LoopRunResult>;
}

export interface TurnPromptInfo {
  readonly input?: readonly ContentPart[];
  readonly origin?: PromptOrigin;
}

export interface IAgentTurnService {
  readonly _serviceBrand: undefined;

  launch(prompt?: TurnPromptInfo): Turn;
  /**
   * Launches a turn using an already-acquired `ActivityLease` (from
   * `IAgentActivityService.tryBegin`). Callers that must prove they hold the
   * lane before doing other work (e.g. goal continuation appending its prompt
   * to context) use this instead of `launch`, which acquires the lease itself.
   */
  launchWithLease(lease: ActivityLease, prompt?: TurnPromptInfo): Turn;
  recordSteer(input: readonly ContentPart[], origin?: PromptOrigin): void;
  cancel(turnId?: number, reason?: unknown): boolean;
  getActiveTurn(): Turn | undefined;
}

export const IAgentTurnService = createDecorator<IAgentTurnService>('agentTurnService');
