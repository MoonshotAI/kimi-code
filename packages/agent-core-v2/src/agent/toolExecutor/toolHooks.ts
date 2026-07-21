/**
 * `toolExecutor` domain (L3) — tool-execution hook contexts.
 *
 * Defines the context objects passed through `IAgentToolExecutorService`'s
 * `onBeforeExecuteTool` / `onDidExecuteTool` hooks and the decision results
 * handlers may return. Participants such as `permissionGate`,
 * `permissionPolicy`, `toolDedupe`, `externalHooks`, `goal`, and `prompt`
 * register through the executor's hook slots. Pure contract (types only);
 * no scoped service.
 */

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

export interface AuthorizeToolExecutionResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly syntheticResult?: ExecutableToolResult | undefined;
  readonly executionMetadata?: unknown;
}

export interface PrepareToolExecutionResult extends AuthorizeToolExecutionResult {
  readonly updatedArgs?: unknown;
}

export interface ToolBeforeExecuteContext extends ResolvedToolExecutionHookContext {
  decision?: AuthorizeToolExecutionResult;
}

export interface ToolDidExecuteContext extends ToolExecutionHookContext {
  result: ExecutableToolResult;
  stopTurn?: boolean;
}
