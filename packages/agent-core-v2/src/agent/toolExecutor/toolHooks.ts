/**
 * `toolExecutor` domain (L3) — tool-execution event and hook contexts.
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
 *   post-execution result finalization, kept as an `OrderedHookSlot`.
 *
 * Participants such as `permissionGate`, `toolDedupe`, `externalHooks`,
 * `goal`, `plan`, `swarm`, `btw`, and `mcp` register through these surfaces.
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
  /**
   * Replace the execution with the given tool result: an `isError: true`
   * result reads as a denial, anything else as a short-circuit with a
   * synthetic result. First veto wins; later vetoes are ignored.
   */
  veto(result: ExecutableToolResult): void;
  /** Allow the call and end all adjudication: no further listener runs and no pending `waitUntil` factory is invoked. */
  allow(): void;
  /** Allow the call but leave an `executionMetadata` trace; does not stop other listeners from adjudicating. */
  pass(metadata?: unknown): void;
  /**
   * Declare an adjudication that needs external input (e.g. an approval
   * round-trip). The factory is cold: the fire side invokes it only after
   * every listener ran without a veto or an allow, so its side effects
   * (Interactions) can never happen while another listener would have
   * denied. Returns the decision (`veto` to replace the execution,
   * `executionMetadata` to pass with a trace), or `undefined` to allow.
   */
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
