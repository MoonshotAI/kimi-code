/**
 * Tool-call lifecycle for one completed provider response.
 *
 * This module keeps the provider-order invariant in one place:
 *   - validate every provider tool call before hooks or events
 *   - run preparation hooks and compute tool-call display fields in provider order
 *   - dispatch `tool.call` before execution starts
 *   - execute tools with non-conflicting resource accesses concurrently
 *   - serialize tools whose resource accesses conflict
 *   - dispatch terminal `tool.result` events in provider order
 *
 * These phases are coupled by transcript ordering and abort handling, so they
 * should be reviewed together.
 */

import type { ContentPart } from '@moonshot-ai/kosong';

import type { Logger } from '#/logging/types';
import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '../tools/args-validator';
import { PathSecurityError } from '../tools/policies/path-access';

import { isUserCancellation } from '../utils/abort';
import { errorMessage, isAbortError } from './errors';
import type { LoopEventDispatcher, LoopToolCallEvent } from './events';
import { parseToolCallArguments } from './tool-args-parse';
import type { LLM, LLMChatResponse } from './llm';
import { ToolAccesses } from './tool-access';
import { ToolScheduler, type ToolCallTask } from './tool-scheduler';
import type {
  AuthorizeToolExecutionResult,
  ExecutableTool,
  LoopHooks,
  ToolCall,
  PrepareToolExecutionResult,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from './types';

const GRACE_TIMEOUT_MS = 2_000;
const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';

const validators = new WeakMap<ExecutableTool, ToolArgsValidator>();

/**
 * Output for an aborted tool call. When the abort carries a user-cancellation
 * reason (the user pressed stop), say so explicitly so the model treats it as a
 * deliberate interruption instead of a system fault to theorise about or retry.
 * Any other abort keeps the neutral wording.
 */
function abortedToolOutput(toolName: string, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) {
    return `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`;
  }
  return `Tool "${toolName}" was aborted`;
}

export interface ToolCallStepContext {
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly llm: LLM;
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
}

interface ToolCallBatchContext extends ToolCallStepContext {
  readonly toolCalls: readonly ToolCall[];
}

type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

interface RunnableToolCall {
  readonly kind: 'runnable';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly tool: ExecutableTool;
  readonly args: unknown;
}

interface RejectedToolCall {
  readonly kind: 'rejected';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly output: string;
}

type PrepareToolExecutionDecision =
  | { readonly kind: 'allowed'; readonly args: unknown; readonly metadata?: unknown }
  | { readonly kind: 'synthetic'; readonly args: unknown; readonly result: ExecutableToolResult }
  | { readonly kind: 'blocked'; readonly args: unknown; readonly output: string }
  | { readonly kind: 'hookFailed'; readonly args: unknown; readonly output: string };

interface PendingToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ExecutableToolResult;
  readonly stopTurn?: boolean | undefined;
}

interface PreparedToolCallTask {
  readonly task: ToolCallTask<PendingToolResult>;
  readonly stopBatchAfterThis?: boolean | undefined;
}

type ToolCallDisplayFields = Pick<LoopToolCallEvent, 'description' | 'display'>;

export interface ToolCallBatchResult {
  readonly stopTurn: boolean;
}

export async function runToolCallBatch(
  step: ToolCallStepContext,
  response: LLMChatResponse,
): Promise<ToolCallBatchResult> {
  if (response.toolCalls.length === 0) return { stopTurn: false };
  const batchStep: ToolCallBatchContext = { ...step, toolCalls: response.toolCalls };
  const calls = response.toolCalls.map((toolCall) => preflightToolCall(step, toolCall));
  const scheduler = new ToolScheduler<PendingToolResult>();
  const pendingResults: Array<Promise<PendingToolResult>> = [];
  let stopTurn = false;

  try {
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      const prepared = await prepareToolCall(batchStep, call);
      pendingResults.push(scheduler.add(prepared.task));

      if (prepared.stopBatchAfterThis === true) {
        stopTurn = true;
        for (const skippedCall of calls.slice(index + 1)) {
          const skippedTask = await prepareSkippedToolCall(batchStep, skippedCall);
          pendingResults.push(scheduler.add(skippedTask));
        }
        break;
      }
    }

    // Tool tasks may finish out of order; terminal results are still emitted in
    // provider order. Await all tasks so each recorded `tool.call` gets a
    // paired `tool.result`; the caller checks abort before writing `step.end`.
    for (const pendingResult of pendingResults) {
      const result = await finalizePendingToolResult(batchStep, await pendingResult);
      if (result.stopTurn === true) stopTurn = true;
      await step.dispatchEvent({
        type: 'tool.result',
        parentUuid: result.toolCall.id,
        toolCallId: result.toolCall.id,
        result: result.result,
      });
    }
  } finally {
    // Preparation or result dispatch can throw after execution has started.
    // Always settle spawned tasks before the caller continues so rejected
    // execute promises cannot surface as detached unhandled rejections.
    await Promise.allSettled(pendingResults);
  }
  return { stopTurn };
}

/**
 * Provider-order validation pass. It does not run hooks, spawn tools, or write
 * events. Validator compilation may populate the local cache.
 */
function preflightToolCall(
  step: Pick<ToolCallStepContext, 'tools' | 'log'>,
  toolCall: ToolCall,
): PreflightedToolCall {
  const toolName = toolCall.name;
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  const tool = step.tools?.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: `Tool "${toolName}" not found`,
    };
  }

  if (parsedArgs.parseFailed) {
    step.log?.debug('tool args JSON parse failed', {
      toolName,
      toolCallId: toolCall.id,
      rawLength: toolCall.arguments?.length ?? 0,
      error: parsedArgs.error,
    });
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
  let validator = validators.get(tool);
  if (validator === undefined) {
    try {
      validator = compileToolArgsValidator(tool.parameters);
      validators.set(tool, validator);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return validateToolArgs(validator, args as JsonType);
}

async function prepareToolCall(
  step: ToolCallBatchContext,
  call: PreflightedToolCall,
): Promise<PreparedToolCallTask> {
  const settleError = async (
    args: unknown,
    output: string,
    displayFields?: ToolCallDisplayFields,
  ): Promise<PreparedToolCallTask> => {
    await dispatchToolCall(step, call, args, displayFields);
    return { task: makeResolvedToolCallTask(makeErrorToolResult(call, args, output)) };
  };

  const settleSynthetic = async (
    args: unknown,
    result: ExecutableToolResult,
    displayFields?: ToolCallDisplayFields,
  ): Promise<PreparedToolCallTask> => {
    const coerced = coerceToolResult(result, call.toolName);
    await dispatchToolCall(step, call, args, displayFields);
    return {
      task: makeResolvedToolCallTask(makeToolResult(call, args, coerced)),
      stopBatchAfterThis: toolResultStopsTurn(coerced),
    };
  };

  if (call.kind === 'rejected') return settleError(call.args, call.output);

  const decision = await runPrepareToolExecutionHook(step, call);
  if (decision.kind === 'blocked' || decision.kind === 'hookFailed') {
    return settleError(decision.args, decision.output);
  }
  if (decision.kind === 'synthetic') {
    return settleSynthetic(decision.args, decision.result);
  }

  const validationError = validateExecutableToolArgs(call.tool, decision.args);
  if (validationError !== null) {
    return settleError(
      decision.args,
      `Invalid args for tool "${call.toolName}" after prepareToolExecution hook: ${validationError}`,
    );
  }

  const effectiveArgs = decision.args;
  let execution: ToolExecution;
  try {
    execution = await call.tool.resolveExecution(effectiveArgs);
  } catch (error) {
    if (!(error instanceof PathSecurityError)) {
      step.log?.warn('tool execution setup failed', {
        toolName: call.toolName,
        toolCallId: call.toolCall.id,
        error,
      });
    }
    const output =
      error instanceof PathSecurityError
        ? error.message
        : `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
    return settleError(effectiveArgs, output);
  }

  const displayFields = toolCallDisplayFieldsFromExecution(execution);
  const settleAborted = (): Promise<PreparedToolCallTask> =>
    settleError(effectiveArgs, abortedToolOutput(call.toolName, step.signal), displayFields);

  if (step.signal.aborted) return settleAborted();

  if (execution.isError === true) {
    return settleSynthetic(effectiveArgs, execution, displayFields);
  }

  const authorization = await runAuthorizeToolExecutionHook(step, call, effectiveArgs, execution);
  if (step.signal.aborted) return settleAborted();

  if (authorization?.block === true) {
    return settleError(
      effectiveArgs,
      authorization.reason ?? `Tool call "${call.toolName}" was blocked`,
      displayFields,
    );
  }

  if (authorization?.syntheticResult !== undefined) {
    return settleSynthetic(effectiveArgs, authorization.syntheticResult, displayFields);
  }

  const executionMetadata = authorization?.executionMetadata ?? decision.metadata;
  await dispatchToolCall(step, call, effectiveArgs, displayFields);
  return {
    task: {
      accesses: execution.accesses ?? ToolAccesses.all(),
      start: async () => ({
        result: runRunnableToolCall(step, call, effectiveArgs, executionMetadata, execution),
      }),
    },
    stopBatchAfterThis: execution.stopBatchAfterThis,
  };
}

async function prepareSkippedToolCall(
  step: ToolCallBatchContext,
  call: PreflightedToolCall,
): Promise<ToolCallTask<PendingToolResult>> {
  const output = 'Tool skipped because a previous tool call stopped the turn.';
  await dispatchToolCall(step, call, call.args);
  return makeResolvedToolCallTask(makeErrorToolResult(call, call.args, output));
}

function makeResolvedToolCallTask(result: PendingToolResult): ToolCallTask<PendingToolResult> {
  return {
    accesses: ToolAccesses.none(),
    start: async () => ({ result: Promise.resolve(result) }),
  };
}

/**
 * Run `prepareToolExecution` in provider order before recording `tool.call`.
 * Hook decisions can block a call or replace args before execution starts.
 */
async function runPrepareToolExecutionHook(
  step: ToolCallBatchContext,
  call: RunnableToolCall,
): Promise<PrepareToolExecutionDecision> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  const { toolCall, args } = call;

  if (hooks?.prepareToolExecution === undefined) {
    return { kind: 'allowed', args };
  }

  let hookResult: PrepareToolExecutionResult | undefined;
  try {
    hookResult = await hooks.prepareToolExecution({
      toolCall,
      toolCalls: step.toolCalls,
      tool: call.tool,
      args,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
  } catch (error) {
    // If the turn is cancelled while an abort-aware hook is awaited, report the
    // call as aborted instead of treating it as a hook failure.
    if (isAbortError(error) || signal.aborted) {
      return {
        kind: 'hookFailed',
        args,
        output: `Tool "${call.toolName}" was aborted during prepareToolExecution hook`,
      };
    }
    return {
      kind: 'hookFailed',
      args,
      output: `prepareToolExecution hook failed for "${call.toolName}": ${errorMessage(error)}`,
    };
  }

  const effectiveArgs = hookResult?.updatedArgs ?? args;
  if (hookResult?.block === true) {
    return {
      kind: 'blocked',
      args: effectiveArgs,
      output: hookResult.reason ?? `Tool call "${call.toolName}" was blocked`,
    };
  }

  if (hookResult?.syntheticResult !== undefined) {
    return { kind: 'synthetic', args: effectiveArgs, result: hookResult.syntheticResult };
  }

  return { kind: 'allowed', args: effectiveArgs, metadata: hookResult?.executionMetadata };
}

async function runAuthorizeToolExecutionHook(
  step: ToolCallBatchContext,
  call: RunnableToolCall,
  args: unknown,
  execution: RunnableToolExecution,
): Promise<AuthorizeToolExecutionResult | undefined> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  if (hooks?.authorizeToolExecution === undefined) return undefined;

  try {
    return await hooks.authorizeToolExecution({
      toolCall: call.toolCall,
      toolCalls: step.toolCalls,
      tool: call.tool,
      args,
      execution,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return {
        block: true,
        reason: `Tool "${call.toolName}" was aborted during authorizeToolExecution hook`,
      };
    }
    return {
      block: true,
      reason: `authorizeToolExecution hook failed for "${call.toolName}": ${errorMessage(error)}`,
    };
  }
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

async function runRunnableToolCall(
  step: ToolCallStepContext,
  call: RunnableToolCall,
  effectiveArgs: unknown,
  metadata: unknown,
  execution: RunnableToolExecution,
): Promise<PendingToolResult> {
  const { signal } = step;
  const { toolCall, toolName } = call;

  if (signal.aborted) {
    return makeErrorToolResult(call, effectiveArgs, abortedToolOutput(toolName, signal));
  }

  let toolResult: ExecutableToolResult;
  try {
    const raw = await executeTool(step, execution, toolCall, toolName, metadata);
    toolResult = coerceToolResult(raw, toolName);
  } catch (error) {
    const aborted = isAbortError(error) || signal.aborted;
    if (!aborted) {
      step.log?.warn('tool execution failed', {
        toolName,
        toolCallId: toolCall.id,
        error,
      });
    }
    const output = aborted
      ? abortedToolOutput(toolName, signal)
      : `Tool "${toolName}" failed: ${errorMessage(error)}`;
    return makeErrorToolResult(call, effectiveArgs, output);
  }

  return makeToolResult(call, effectiveArgs, toolResult);
}

async function finalizePendingToolResult(
  step: ToolCallBatchContext,
  pendingResult: PendingToolResult,
): Promise<PendingToolResult> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  if (hooks?.finalizeToolResult === undefined) {
    return { ...pendingResult, result: normalizeToolResult(pendingResult.result) };
  }

  try {
    const finalizedResult = await hooks.finalizeToolResult({
      toolCall: pendingResult.toolCall,
      toolCalls: step.toolCalls,
      args: pendingResult.args,
      result: pendingResult.result,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
    const effectiveResult = coerceToolResult(
      finalizedResult ?? pendingResult.result,
      pendingResult.toolName,
    );
    return {
      ...pendingResult,
      stopTurn: pendingResult.stopTurn === true || toolResultStopsTurn(effectiveResult),
      result: normalizeToolResult(effectiveResult),
    };
  } catch (error) {
    // This is the redaction/truncation boundary. If it fails, do not persist
    // the raw tool output; write an error result instead.
    const aborted = isAbortError(error) || signal.aborted;
    if (!aborted) {
      step.log?.warn('finalizeToolResult hook failed', {
        toolName: pendingResult.toolName,
        toolCallId: pendingResult.toolCall.id,
        error,
      });
    }
    const output = aborted
      ? `Tool "${pendingResult.toolName}" aborted during finalizeToolResult hook.`
      : `finalizeToolResult hook failed for "${pendingResult.toolName}": ${errorMessage(error)}`;
    return {
      ...pendingResult,
      stopTurn: pendingResult.stopTurn,
      result: { output, isError: true },
    };
  }
}

async function executeTool(
  step: ToolCallStepContext,
  execution: RunnableToolExecution,
  toolCall: ToolCall,
  toolName: string,
  metadata: unknown,
): Promise<ExecutableToolResult> {
  const { dispatchEvent, signal, turnId } = step;

  signal.throwIfAborted();

  const executePromise = execution.execute({
    turnId,
    toolCallId: toolCall.id,
    metadata,
    signal,
    onUpdate: (update) => {
      if (signal.aborted) return;
      dispatchEvent({
        type: 'tool.progress',
        toolCallId: toolCall.id,
        update,
      });
    },
  });
  return raceExecuteWithGraceTimeout(executePromise, signal, toolName);
}

async function raceExecuteWithGraceTimeout(
  executePromise: Promise<ExecutableToolResult>,
  signal: AbortSignal,
  toolName: string,
): Promise<ExecutableToolResult> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const graceSentinel: Promise<ExecutableToolResult> = new Promise((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(() => {
        resolve({
          output: `Tool "${toolName}" aborted by grace timeout (${String(GRACE_TIMEOUT_MS)}ms)`,
          isError: true,
        });
      }, GRACE_TIMEOUT_MS);
    };
    if (signal.aborted) {
      armTimer();
    } else {
      onAbort = armTimer;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    // Tools that ignore AbortSignal may never settle. After abort, the grace
    // branch lets the turn finish with a synthetic error result.
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // Some AbortSignal polyfills do not implement removeEventListener.
      }
    }
  }
}

function isMediaContentPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

/**
 * Validate a tool's raw return against the {@link ExecutableToolResult} contract.
 * A tool that returns `undefined`, a primitive, or an object without a valid
 * `output` field is coerced into an `isError: true` result so the loop can still
 * emit a paired `tool.result` event. This is the trust boundary between
 * arbitrary tool implementations and the rest of the loop.
 */
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

function normalizeToolResult(r: ExecutableToolResult): ExecutableToolResult {
  let output: ExecutableToolResult['output'];
  if (typeof r.output === 'string') {
    output = r.output.length > 0 ? r.output : TOOL_OUTPUT_EMPTY;
  } else if (r.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    const hasMediaBlock = r.output.some(isMediaContentPart);
    if (hasMediaBlock) {
      const hasNonEmptyText = r.output.some((c) => c.type === 'text' && c.text.length > 0);
      output = hasNonEmptyText
        ? r.output
        : [{ type: 'text', text: TOOL_OUTPUT_NON_TEXT }, ...r.output];
    } else {
      const textJoined = r.output
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join('');
      output = textJoined.length > 0 ? textJoined : TOOL_OUTPUT_EMPTY;
    }
  }
  if (r.isError === true) {
    return r.truncated === true
      ? { output, isError: true, truncated: true }
      : { output, isError: true };
  }
  return r.truncated === true ? { output, truncated: true } : { output };
}

function makeToolResult(
  call: PreflightedToolCall,
  args: unknown,
  result: ExecutableToolResult,
): PendingToolResult {
  return {
    toolCall: call.toolCall,
    toolName: call.toolName,
    args,
    result,
    stopTurn: toolResultStopsTurn(result),
  };
}

function toolResultStopsTurn(result: ExecutableToolResult): boolean {
  return result.stopTurn === true;
}

function makeErrorToolResult(
  call: PreflightedToolCall,
  args: unknown,
  output: string,
): PendingToolResult {
  return makeToolResult(call, args, { output, isError: true });
}

/**
 * Record `tool.call` in provider order. Reusing the provider/API tool-call id
 * keeps transcript linkage on one canonical identity.
 */
async function dispatchToolCall(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
  args: unknown,
  displayFields?: ToolCallDisplayFields | undefined,
): Promise<void> {
  const { toolCall, toolName } = call;
  await step.dispatchEvent({
    type: 'tool.call',
    uuid: toolCall.id,
    turnId: step.turnId,
    step: step.currentStep,
    stepUuid: step.stepUuid,
    toolCallId: toolCall.id,
    name: toolName,
    args,
    description: displayFields?.description,
    display: displayFields?.display,
  });
}
