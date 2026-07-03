/**
 * Turn-level loop for a stateless agent run.
 *
 * Owns convergence across steps: abort checks at loop boundaries, max-step
 * enforcement, usage aggregation, optional continuation after non-tool stops,
 * and final `TurnResult` mapping. One-step execution lives in `turn-step.ts`.
 */

import { addUsage, emptyUsage, type TokenUsage } from '@moonshot-ai/kosong';

import type { Logger } from '#/logging/types';

import {
  createMaxStepsExceededError,
  errorMessage,
  isAbortError,
  isMaxStepsExceededError,
} from './errors';
import type { LoopInterruptReason, LoopEventDispatcher, LoopTurnInterruptedEvent } from './events';
import type { LLM } from './llm';
import { executeLoopStep } from './turn-step';
import type {
  ExecutableTool,
  LoopHooks,
  LoopMessageBuilder,
  RecordStepUsageResult,
  LoopTerminalStepStopReason,
  LoopTurnStopReason,
  TurnResult,
} from './types';

export interface RunTurnInput {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly llm: LLM;
  readonly buildMessages: LoopMessageBuilder;
  /**
   * Optional strict, guaranteed wire-compliant rebuild of the request messages.
   * Used only to resend once after a provider rejects the normal projection with
   * a tool_use/tool_result adjacency 400 (see `executeLoopStep`).
   */
  readonly buildMessagesStrict?: LoopMessageBuilder | undefined;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly maxSteps?: number | undefined;
  readonly maxRetryAttempts?: number;
  readonly recordStepUsage?:
    | ((usage: TokenUsage) => RecordStepUsageResult | void | Promise<RecordStepUsageResult | void>)
    | undefined;
}

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const {
    turnId,
    signal,
    llm,
    buildMessages,
    buildMessagesStrict,
    dispatchEvent,
    tools,
    hooks,
    log,
    maxSteps,
    maxRetryAttempts,
    recordStepUsage: hostRecordStepUsage,
  } = input;
  let usage: TokenUsage = emptyUsage();
  let steps = 0;
  // Normal exits overwrite this with the completed step's stop reason.
  let stopReason: LoopTurnStopReason = 'end_turn';
  let activeStep: number | undefined;
  const recordStepUsage = async (
    stepUsage: TokenUsage,
  ): Promise<RecordStepUsageResult | void> => {
    usage = addUsage(usage, stepUsage);
    return hostRecordStepUsage?.(stepUsage);
  };

  try {
    while (true) {
      signal.throwIfAborted();

      if (maxSteps !== undefined && maxSteps > 0 && steps >= maxSteps) {
        throw createMaxStepsExceededError(maxSteps);
      }

      steps += 1;
      activeStep = steps;
      const stepResult = await executeLoopStep({
        turnId,
        signal,
        buildMessages,
        buildMessagesStrict,
        dispatchEvent,
        llm,
        tools,
        hooks,
        log,
        currentStep: steps,
        maxRetryAttempts,
        recordUsage: recordStepUsage,
      });
      activeStep = undefined;

      if (stepResult.stopReason === 'tool_use') {
        continue;
      }

      const terminalStopReason: LoopTerminalStepStopReason = stepResult.stopReason;
      stopReason = terminalStopReason;

      const continuation = await hooks?.shouldContinueAfterStop?.({
        turnId,
        stepNumber: steps,
        usage: stepResult.usage,
        stopReason: terminalStopReason,
        signal,
        llm,
      });
      if (continuation?.continue !== true) {
        break;
      }
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      dispatchEvent(makeInterruptedEvent('aborted', steps, activeStep));
      return { stopReason: 'aborted', steps, usage };
    }
    const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
    dispatchEvent(makeInterruptedEvent(reason, steps, activeStep, errorMessage(error)));
    throw error;
  }

  return { stopReason, steps, usage };
}

function makeInterruptedEvent(
  reason: LoopInterruptReason,
  attemptedSteps: number,
  activeStep: number | undefined,
  message?: string | undefined,
): LoopTurnInterruptedEvent {
  return {
    type: 'turn.interrupted',
    reason,
    attemptedSteps,
    ...(activeStep !== undefined ? { activeStep } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}
