/**
 * `toolExecutor` domain — tool-execution event and hook contexts.
 *
 * Defines the event objects and context records carried by
 * `IAgentToolExecutorService`'s execution-interception surface:
 *
 * - `onBeforeExecuteTool` (veto event, `BeforeToolExecuteEvent`): listeners
 *   answer with `veto(result)` (replace the execution with the given tool
 *   result — an `isError: true` result reads as a denial, anything else as a
 *   short-circuit; first one wins), `allow()` (final pass, ends all
 *   adjudication), `pass(metadata)` (pass with an `executionMetadata` trace,
 *   ends nothing), or `waitUntil(factory)` (defer an adjudication that needs
 *   external input — the fire side invokes the cold factory only when no
 *   listener vetoed or allowed outright, so an ask round-trip can never start
 *   while another listener would have denied). No ids, no ordering contract.
 * - `onWillExecuteTool` (waitUntil participation event,
 *   `WillExecuteToolEvent`): listeners attach hot promises via
 *   `waitUntil(promise)`; the executor awaits all of them before dispatching
 *   an allowed call (e.g. MCP initial load).
 * - `hooks.onDidExecuteTool` (ordered hook slot, `ToolDidExecuteContext`):
 *   post-execution result finalization, kept as an `OrderedHookSlot`. Every
 *   call reaches it — including preflight-rejected ones (missing/unavailable
 *   tool, guard denial, invalid args), which arrive without `tool` set.
 *
 * Pure contract (types only); no scoped service.
 */

import type { IWaitUntil } from '#/_base/event';
import type { ToolCall } from '#/kosong/contract/message';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';

import type { ExecutableTool, ExecutableToolResult, RunnableToolExecution } from '#/tool/toolContract';

export interface ToolExecutionHookContext {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly trace?: LLMRequestTrace;
  readonly toolCall: ToolCall;
  readonly toolCalls: readonly ToolCall[];
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
}

export interface ResolvedToolExecutionHookContext extends ToolExecutionHookContext {
  readonly execution: RunnableToolExecution;
}

export interface BeforeExecuteDecision {
  readonly veto?: ExecutableToolResult;
  readonly executionMetadata?: unknown;
}

export interface BeforeToolExecuteEvent extends ResolvedToolExecutionHookContext {
  veto(result: ExecutableToolResult): void;
  allow(): void;
  pass(metadata?: unknown): void;
  waitUntil(factory: () => Promise<BeforeExecuteDecision | undefined>): void;
}

export interface WillExecuteToolEvent extends IWaitUntil {
  readonly turnId: number;
  readonly toolCall: ToolCall;
  readonly execution: RunnableToolExecution;
  readonly args: unknown;
}

export interface ToolDidExecuteContext extends ToolExecutionHookContext {
  result: ExecutableToolResult;
  stopTurn?: boolean;
}
