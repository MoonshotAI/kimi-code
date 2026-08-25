import { ToolAccesses, type ToolResult } from '#/tool/toolContract';
import type { ToolCall } from '#/kosong/contract/message';

import type { ToolExecutionResult } from '../toolExecutor';
import type { ToolExecutionOutcome } from '../toolHooks';

import type { PreflightedToolCall } from './preflight';

export interface ToolExecutionTask {
  readonly accesses: ToolAccesses;
  readonly execute: (signal: AbortSignal) => Promise<ToolExecutionRunResult>;
}

export interface ToolExecutionRunResult {
  readonly result: ToolResult;
  readonly outcome: ToolExecutionOutcome;
}

export interface TimedToolResult {
  readonly index: number;
  readonly result: ToolResult;
  readonly outcome: ToolExecutionOutcome;
  readonly durationMs: number;
}

export type SettledTimedToolResult =
  | { readonly status: 'fulfilled'; readonly value: TimedToolResult }
  | { readonly status: 'rejected'; readonly index: number; readonly reason: unknown };

export type SettledToolExecutionResult =
  | { readonly status: 'fulfilled'; readonly value: ToolExecutionResult }
  | { readonly status: 'rejected'; readonly reason: unknown };

export type ToolExecutionResultPromise = Promise<SettledToolExecutionResult>;

export type ToolExecutionStreamEvent =
  | { readonly type: 'timed'; readonly result: IteratorResult<TimedToolResult> }
  | { readonly type: 'timedRejected'; readonly reason: unknown }
  | {
      readonly type: 'finalized';
      readonly promise: ToolExecutionResultPromise;
      readonly settled: SettledToolExecutionResult;
    };

export interface PreparedToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ToolResult;
  readonly stopTurn?: boolean;
}

export function makeResolvedTask(
  result: PreparedToolResult,
  outcome: ToolExecutionOutcome,
): ToolExecutionTask {
  return {
    accesses: ToolAccesses.none(),
    execute: async () => ({ result: result.result, outcome }),
  };
}

export function makeErrorToolResult(
  call: PreflightedToolCall,
  args: unknown,
  output: string,
): PreparedToolResult {
  return {
    toolCall: call.toolCall,
    toolName: call.toolName,
    args,
    result: { output, isError: true },
  };
}
