import type { AsyncEmitter, Emitter } from '#/_base/event';
import type { ContentPart, ToolCall } from '#/kosong/contract/message';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '#/tool/args-validator';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import { PathSecurityError } from '#/tool/path-access';
import { isAbortError, isUserCancellation } from '#/_base/utils/abort';
import {
  ToolAccesses,
  type ExecutableTool,
  type ExecutableToolResult,
  type RunnableToolExecution,
  type ToolExecution,
  type ToolResult,
  type ToolUpdate,
} from '#/tool/toolContract';
import type {
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  ToolExecutionOutcome,
  WillExecuteToolEvent,
} from '#/actor/toolExecutor/toolHooks';
import type {
  MissingToolDescriber,
  ToolCallDupType,
  ToolCallGuard,
  ToolExecutionFinishedEvent,
  ToolExecutionResult,
  ToolExecutorExecuteOptions,
  UnavailableToolDescriber,
} from '#/actor/toolExecutor/toolExecutor';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import type { ILogService } from '#/_base/log/log';
import type { ToolCallEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { OrderedHookSlot } from '#/hooks';
import type { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import type { BeforeToolExecuteBus } from '#/actor/toolExecutor/internal/beforeToolExecute';
import type { ToolCatalogState } from '#/actor/toolExecutor/internal/catalog';
import { catalogList, resolveCatalogTool } from '#/actor/toolExecutor/internal/catalog';
import {
  ToolCallStarted,
  ToolProgress,
  ToolResultEvent,
} from '#/actor/toolExecutor/toolExecutorEvents';

const ABORT_GRACE_MS = 2_000;
const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';
export const TOOL_SKIPPED_OUTPUT = 'Tool skipped because a previous tool call stopped the turn.';

const validators = new WeakMap<
  ExecutableTool,
  { schema: Record<string, unknown>; validator: ToolArgsValidator }
>();

export interface ToolExecutionTask {
  readonly accesses: ToolAccesses;
  readonly execute: (signal: AbortSignal) => Promise<ToolExecutionRunResult>;
}

export interface ToolExecutionRunResult {
  readonly result: ToolResult;
  readonly outcome: ToolExecutionOutcome;
}

export interface TimedToolResult {
  readonly result: ToolResult;
  readonly outcome: ToolExecutionOutcome;
  readonly durationMs: number;
}

export interface RunnableToolCall {
  readonly kind: 'runnable';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly tool: ExecutableTool;
  readonly args: unknown;
}

export interface RejectedToolCall {
  readonly kind: 'rejected';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly output: string;
}

export type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

interface PreparedToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ToolResult;
  readonly stopTurn?: boolean;
}

export interface PreparedCall {
  readonly task: ToolExecutionTask;
  readonly resolvedAccesses?: ToolAccesses;
  readonly stopBatchAfterThis?: boolean;
}

type ToolCallDisplayFields = { description?: string | undefined; display?: ToolInputDisplay | undefined };

export interface ToolCallPipelineDeps {
  readonly runtime: AgentRuntimeContext<unknown>;
  readonly vetoBus: BeforeToolExecuteBus;
  readonly willExecuteEmitter: AsyncEmitter<WillExecuteToolEvent>;
  readonly didHooks: OrderedHookSlot<ToolDidExecuteContext>;
  readonly didExecuteEmitter: Emitter<ToolExecutionFinishedEvent>;
  readonly telemetry: ITelemetryService;
  truncation(): IAgentToolResultTruncationService;
  takeDupType(toolCallId: string): ToolCallDupType | undefined;
}

function buildBeforeExecuteContext(
  call: RunnableToolCall,
  execution: RunnableToolExecution,
  allCalls: readonly ToolCall[],
  options: ToolExecutorExecuteOptions,
): ResolvedToolExecutionHookContext {
  return {
    turnId: options.turnId,
    signal: options.signal,
    trace: options.trace,
    toolCall: call.toolCall,
    toolCalls: allCalls,
    tool: call.tool,
    args: call.args,
    execution,
  };
}

export interface PreflightDeps {
  readonly catalog: ToolCatalogState;
  readonly guard: ToolCallGuard | undefined;
  readonly describeUnavailableTool: UnavailableToolDescriber | undefined;
  readonly describeMissingTool: MissingToolDescriber | undefined;
  readonly log?: ILogService;
}

export function preflightToolCall(deps: PreflightDeps, toolCall: ToolCall): PreflightedToolCall {
  const toolName = toolCall.name;
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  if (parsedArgs.parseFailed) {
    deps.log?.debug('tool args JSON parse failed', {
      toolName,
      toolCallId: toolCall.id,
      rawLength: typeof toolCall.arguments === 'string' ? toolCall.arguments.length : 0,
      error: parsedArgs.error,
    });
  }
  const tool = resolveCatalogTool(deps.catalog, toolName);
  if (tool === undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: deps.describeMissingTool?.(toolName) ?? `Tool "${toolName}" not found`,
    };
  }
  const source =
    catalogList(deps.catalog).find((entry) => entry.name === toolName)?.source ?? 'builtin';
  const denied = deps.guard?.({ name: toolName, source });
  if (denied !== undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: denied,
    };
  }
  const unavailable = deps.describeUnavailableTool?.(toolName);
  if (unavailable !== undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: unavailable,
    };
  }
  const validationError = validateExecutableToolArgs(tool, parsedArgs.data);
  if (validationError !== null) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: `Invalid args for tool "${toolName}": ${validationError}`,
    };
  }
  return { kind: 'runnable', toolCall, toolName, tool, args: parsedArgs.data };
}

function validateExecutableToolArgs(tool: ExecutableTool, args: unknown): string | null {
  const schema = tool.parameters;
  let cached = validators.get(tool);
  if (cached === undefined || cached.schema !== schema) {
    try {
      cached = { schema, validator: compileToolArgsValidator(schema) };
      validators.set(tool, cached);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return validateToolArgs(cached.validator, args as JsonType);
}

export async function prepareToolCall(
  deps: ToolCallPipelineDeps,
  call: PreflightedToolCall,
  allCalls: readonly ToolCall[],
  options: ToolExecutorExecuteOptions,
): Promise<PreparedCall> {
  const settleError = (
    args: unknown,
    output: string,
    outcome: Exclude<ToolExecutionOutcome, 'executed'>,
    displayFields?: ToolCallDisplayFields,
  ): PreparedCall => {
    dispatchToolCall(deps.runtime, call, args, options, displayFields);
    return {
      task: makeResolvedTask(makeErrorToolResult(call, args, output), outcome),
    };
  };

  const settleSynthetic = (
    args: unknown,
    result: ExecutableToolResult,
    outcome: Exclude<ToolExecutionOutcome, 'executed'>,
    displayFields?: ToolCallDisplayFields,
  ): PreparedCall => {
    const toolResult = normalizeAndMergeResult(result, call.toolName, undefined);
    dispatchToolCall(deps.runtime, call, args, options, displayFields);
    return {
      task: makeResolvedTask(
        {
          toolCall: call.toolCall,
          toolName: call.toolName,
          args,
          result: toolResult,
          stopTurn: toolResult.stopTurn === true,
        },
        outcome,
      ),
      stopBatchAfterThis: toolResult.stopBatchAfterThis ?? toolResult.stopTurn,
    };
  };

  if (call.kind === 'rejected') {
    return settleError(call.args, call.output, 'preflight-rejected');
  }

  let execution: ToolExecution;
  try {
    execution = await call.tool.resolveExecution(call.args);
  } catch (error) {
    const output =
      error instanceof PathSecurityError
        ? error.message
        : `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
    return settleError(call.args, output, 'resolution-failed');
  }

  const displayFields = toolCallDisplayFieldsFromExecution(execution);

  if (options.signal.aborted) {
    return settleError(
      call.args,
      abortedToolOutput(call.toolName, options.signal),
      'aborted',
      displayFields,
    );
  }

  if (execution.isError === true) {
    return settleSynthetic(call.args, execution, 'synthetic', displayFields);
  }

  const beforeContext = buildBeforeExecuteContext(call, execution, allCalls, options);
  const decision = await deps.vetoBus.fireBeforeExecute(beforeContext);

  if (decision?.veto !== undefined) {
    return settleSynthetic(call.args, decision.veto, 'vetoed', displayFields);
  }

  const executionMetadata = decision?.executionMetadata;

  await deps.willExecuteEmitter.fireAsync(
    {
      turnId: options.turnId,
      toolCall: call.toolCall,
      execution,
      args: call.args,
    },
    options.signal,
  );

  dispatchToolCall(deps.runtime, call, call.args, options, displayFields);

  return {
    task: {
      accesses: execution.accesses ?? ToolAccesses.all(),
      execute: async (taskSignal) =>
        runToolExecution(deps.runtime, call, execution, executionMetadata, options, taskSignal),
    },
    resolvedAccesses: execution.accesses,
    stopBatchAfterThis: execution.stopBatchAfterThis,
  };
}

export function prepareSkippedToolCall(
  runtime: AgentRuntimeContext<unknown>,
  call: PreflightedToolCall,
  options: ToolExecutorExecuteOptions,
): PreparedCall {
  dispatchToolCall(runtime, call, call.args, options);
  return {
    task: makeResolvedTask(makeErrorToolResult(call, call.args, TOOL_SKIPPED_OUTPUT), 'skipped'),
  };
}

async function runToolExecution(
  runtime: AgentRuntimeContext<unknown>,
  call: RunnableToolCall,
  execution: RunnableToolExecution,
  metadata: unknown,
  options: ToolExecutorExecuteOptions,
  signal: AbortSignal,
): Promise<ToolExecutionRunResult> {
  if (signal.aborted) {
    return {
      result: makeErrorToolResult(
        call,
        call.args,
        abortedToolOutput(call.toolName, signal),
      ).result,
      outcome: 'aborted',
    };
  }

  let rawResult: ExecutableToolResult;
  try {
    const executePromise = execution.execute({
      turnId: options.turnId,
      toolCallId: call.toolCall.id,
      trace: options.trace,
      metadata,
      signal,
      onUpdate: (update) => {
        if (signal.aborted) return;
        dispatchToolProgress(runtime, call, update, options);
      },
    });
    rawResult = await raceWithAbortGrace(executePromise, signal, call.toolName);
  } catch (error) {
    const aborted = isAbortError(error) || signal.aborted;
    const output = aborted
      ? abortedToolOutput(call.toolName, signal)
      : `Tool "${call.toolName}" failed: ${errorMessage(error)}`;
    return {
      result: makeErrorToolResult(call, call.args, output).result,
      outcome: 'executed',
    };
  }

  return {
    result: normalizeAndMergeResult(rawResult, call.toolName, execution),
    outcome: 'executed',
  };
}

export async function runPreparedTask(
  task: ToolExecutionTask,
  signal: AbortSignal,
): Promise<TimedToolResult> {
  const startedAt = Date.now();
  const { result, outcome } = await task.execute(signal);
  return { result, outcome, durationMs: Math.max(0, Date.now() - startedAt) };
}

export async function finalizeToolCall(
  deps: ToolCallPipelineDeps,
  call: PreflightedToolCall,
  timed: TimedToolResult,
  options: ToolExecutorExecuteOptions,
  resolvedAccesses: ToolAccesses | undefined,
): Promise<ToolExecutionResult> {
  const finalized = await finalizeToolResult(deps, call, timed.result, options, timed.outcome, resolvedAccesses);

  dispatchToolResult(deps.runtime, call, finalized, options);
  trackToolCall(deps, call, finalized, timed.durationMs, options);
  deps.didExecuteEmitter.fire({
    turnId: options.turnId,
    toolCall: call.toolCall,
    toolName: call.toolName,
    result: finalized,
  });

  return {
    toolCallId: call.toolCall.id,
    toolName: call.toolName,
    result: finalized,
  };
}

function trackToolCall(
  deps: ToolCallPipelineDeps,
  call: PreflightedToolCall,
  result: ToolResult,
  durationMs: number,
  options: ToolExecutorExecuteOptions,
): void {
  const outcome = toolTelemetryOutcome(result);
  const toolCallId = call.toolCall.id;
  const dupType = deps.takeDupType(toolCallId) ?? 'normal';
  const properties: ToolCallEvent = {
    turn_id: options.turnId,
    tool_call_id: toolCallId,
    tool_name: call.toolName,
    outcome,
    duration_ms: durationMs,
    dup_type: dupType,
    trace_id: options.trace?.traceId,
  };
  if (result.isError === true) properties['error_type'] = toolTelemetryErrorType(outcome);
  deps.telemetry.track2('tool_call', properties);
}

async function finalizeToolResult(
  deps: ToolCallPipelineDeps,
  call: PreflightedToolCall,
  result: ToolResult,
  options: ToolExecutorExecuteOptions,
  outcome: ToolExecutionOutcome,
  resolvedAccesses?: ToolAccesses,
): Promise<ToolResult> {
  const didCtx: ToolDidExecuteContext = {
    turnId: options.turnId,
    signal: options.signal,
    trace: options.trace,
    toolCall: call.toolCall,
    toolCalls: [call.toolCall],
    tool: call.kind === 'runnable' ? call.tool : undefined,
    args: call.args,
    outcome,
    accesses: resolvedAccesses,
    result: result as ExecutableToolResult,
  };

  try {
    await deps.didHooks.run(didCtx);
  } catch (error) {
    const aborted = isAbortError(error) || options.signal.aborted;
    const output = aborted
      ? `Tool "${call.toolName}" aborted during onDidExecuteTool hook.`
      : `onDidExecuteTool hook failed for "${call.toolName}": ${errorMessage(error)}`;
    return {
      output,
      isError: true,
      description: result.description,
      display: result.display,
      approvalRule: result.approvalRule,
    };
  }

  const coercedResult = coerceToolResult(didCtx.result, call.toolName);
  const effectiveResult = normalizeToolResult(coercedResult);
  const finalResult: ToolResult = {
    ...effectiveResult,
    description: result.description,
    display: result.display,
    approvalRule: result.approvalRule,
    stopTurn:
      result.stopTurn === true ||
      didCtx.stopTurn === true ||
      effectiveResult.stopTurn === true,
    stopBatchAfterThis: result.stopBatchAfterThis,
    delivery: coercedResult.delivery,
  };
  return deps.truncation().truncateForModel({
    toolName: call.toolName,
    toolCallId: call.toolCall.id,
    result: finalResult,
  });
}

function normalizeAndMergeResult(
  rawResult: unknown,
  toolName: string,
  execution: RunnableToolExecution | undefined,
): ToolResult {
  const coerced = coerceToolResult(rawResult, toolName);
  const normalized = normalizeToolResult(coerced);
  return {
    ...normalized,
    description: execution?.description ?? normalized.description,
    display: execution?.display ?? normalized.display,
    approvalRule: execution?.approvalRule,
    stopBatchAfterThis: normalized.stopBatchAfterThis ?? execution?.stopBatchAfterThis,
    delivery: coerced.delivery,
  };
}

export function dispatchToolCall(
  runtime: AgentRuntimeContext<unknown>,
  call: PreflightedToolCall,
  args: unknown,
  options: ToolExecutorExecuteOptions,
  displayFields?: ToolCallDisplayFields,
): void {
  runtime.send({
    type: 'toolExecutor.callStarted',
    call: {
      toolCallId: call.toolCall.id,
      name: call.toolName,
      turnId: options.turnId,
      since: Date.now(),
    },
  });
  void runtime.dispatch(
    new ToolCallStarted({
      agentId: runtime.agent.agentId,
      turnId: options.turnId,
      toolCallId: call.toolCall.id,
      name: call.toolName,
      args,
      description: displayFields?.description,
      display: displayFields?.display,
    }),
  );
  options.onToolCall?.({
    toolCallId: call.toolCall.id,
    name: call.toolName,
    args,
  });
}

function dispatchToolResult(
  runtime: AgentRuntimeContext<unknown>,
  call: PreflightedToolCall,
  result: ToolResult,
  options: ToolExecutorExecuteOptions,
): void {
  runtime.send({ type: 'toolExecutor.callSettled', toolCallId: call.toolCall.id });
  void runtime.dispatch(
    new ToolResultEvent({
      agentId: runtime.agent.agentId,
      turnId: options.turnId,
      toolCallId: call.toolCall.id,
      output: result.output,
      isError: result.isError,
    }),
  );
}

function dispatchToolProgress(
  runtime: AgentRuntimeContext<unknown>,
  call: RunnableToolCall,
  update: ToolUpdate,
  options: ToolExecutorExecuteOptions,
): void {
  void runtime.dispatch(
    new ToolProgress({
      agentId: runtime.agent.agentId,
      turnId: options.turnId,
      toolCallId: call.toolCall.id,
      update,
    }),
  );
}

function makeResolvedTask(
  result: PreparedToolResult,
  outcome: ToolExecutionOutcome,
): ToolExecutionTask {
  return {
    accesses: ToolAccesses.none(),
    execute: async () => ({ result: result.result, outcome }),
  };
}

function makeErrorToolResult(
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

function coerceToolResult(value: unknown, toolName: string): ExecutableToolResult {
  if (value === null || value === undefined) {
    return { output: `Tool "${toolName}" returned no result.`, isError: true };
  }
  if (typeof value !== 'object') {
    return {
      output: `Tool "${toolName}" returned a ${typeof value} instead of a tool result.`,
      isError: true,
    };
  }
  const candidate = value as { output?: unknown };
  if (typeof candidate.output !== 'string' && !Array.isArray(candidate.output)) {
    return {
      output: `Tool "${toolName}" returned a result with a missing or malformed "output" field.`,
      isError: true,
    };
  }
  return value as ExecutableToolResult;
}

function normalizeToolResult(result: ExecutableToolResult): ToolResult {
  let output: ToolResult['output'];
  if (typeof result.output === 'string') {
    output = result.output.length > 0 ? result.output : TOOL_OUTPUT_EMPTY;
  } else if (result.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    const hasMediaBlock = result.output.some(isMediaContentPart);
    if (hasMediaBlock) {
      const hasNonEmptyText = result.output.some(
        (part) => part.type === 'text' && part.text.length > 0,
      );
      output = hasNonEmptyText
        ? result.output
        : [{ type: 'text', text: TOOL_OUTPUT_NON_TEXT }, ...result.output];
    } else {
      const textJoined = result.output
        .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('');
      output = textJoined.length > 0 ? textJoined : TOOL_OUTPUT_EMPTY;
    }
  }
  const base: {
    output: ToolResult['output'];
    stopTurn?: boolean;
    truncated?: true;
    note?: string;
  } = { output, stopTurn: result.stopTurn };
  if (result.truncated === true) base.truncated = true;
  if (typeof result.note === 'string' && result.note.length > 0) base.note = result.note;
  if (result.isError === true) {
    return {
      ...base,
      isError: true,
    };
  }
  return base;
}

function toolTelemetryOutcome(result: ToolResult): 'success' | 'error' | 'cancelled' {
  if (result.isError !== true) return 'success';
  const text = toolOutputText(result.output).toLowerCase();
  return text.includes('aborted') ||
    text.includes('cancelled') ||
    text.includes('manually interrupted')
    ? 'cancelled'
    : 'error';
}

function toolTelemetryErrorType(outcome: 'success' | 'error' | 'cancelled'): 'cancelled' | 'error' {
  if (outcome === 'cancelled') return 'cancelled';
  return 'error';
}

function toolOutputText(output: ToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function isMediaContentPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

function abortedToolOutput(toolName: string, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) {
    return `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`;
  }
  return `Tool "${toolName}" was aborted`;
}

function toolCallDisplayFieldsFromExecution(
  execution: ToolExecution,
): ToolCallDisplayFields | undefined {
  if (execution.isError === true) return undefined;
  const description = execution.description;
  const display = execution.display;
  return {
    description: description !== undefined && description.length > 0 ? description : undefined,
    display,
  };
}

async function raceWithAbortGrace<Result>(
  executePromise: Promise<Result>,
  signal: AbortSignal,
  toolName: string,
): Promise<Result> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const graceSentinel: Promise<Result> = new Promise((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(() => {
        resolve({
          output: abortedToolOutput(toolName, signal),
          isError: true,
        } as unknown as Result);
      }, ABORT_GRACE_MS);
    };
    if (signal.aborted) {
      armTimer();
    } else {
      onAbort = armTimer;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
