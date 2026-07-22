/**
 * `toolExecutor` domain (L3) — `IAgentToolExecutorService` implementation.
 *
 * Resolves executable tools through `toolRegistry`, adjudicates tool calls
 * through the `onBeforeExecuteTool` veto event, awaits readiness work
 * through the `onWillExecuteTool` participation event, finalizes results
 * through the ordered `onDidExecuteTool` hook, publishes tool lifecycle
 * events through `event`, records telemetry through `telemetry`, truncates
 * oversized outputs through `toolResultTruncation`, and logs parse
 * diagnostics through `log`. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { AsyncEmitter, type Event } from '#/_base/event';
import type { ContentPart, ToolCall } from '#/kosong/contract/message';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '#/tool/args-validator';
import { PathSecurityError } from '#/tool/path-access';
import { isAbortError, isUserCancellation } from '#/_base/utils/abort';
import { IEventBus } from '#/app/event/eventBus';
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
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ILogService } from '#/_base/log/log';
import type { ToolCallEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { OrderedHookSlot } from '#/hooks';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { BeforeToolExecuteEmitter } from './beforeToolExecuteEvent';
import {
  IAgentToolExecutorService,
  type MissingToolDescriber,
  type ToolCallGuard,
  type ToolCallDupType,
  type ToolExecutionResult,
  type ToolExecutorExecuteOptions,
  type UnavailableToolDescriber,
} from './toolExecutor';
import { ToolScheduler } from './toolScheduler';
// Loads the `DomainEventMap` augmentation for the `tool.call.*` / `tool.result`
// events this service publishes (the augmentation lives with the event
// definitions; without an import it would not enter every consumer's program).
import './toolExecutorEvents';

const ABORT_GRACE_MS = 2_000;
const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';

const validators = new WeakMap<ExecutableTool, ToolArgsValidator>();

export interface ToolExecutionTask {
  readonly accesses: ToolAccesses;
  readonly execute: (signal: AbortSignal) => Promise<ToolResult>;
}

interface TimedToolResult {
  readonly index: number;
  readonly result: ToolResult;
  readonly durationMs: number;
}

type SettledTimedToolResult =
  | { readonly status: 'fulfilled'; readonly value: TimedToolResult }
  | { readonly status: 'rejected'; readonly index: number; readonly reason: unknown };

type SettledToolExecutionResult =
  | { readonly status: 'fulfilled'; readonly value: ToolExecutionResult }
  | { readonly status: 'rejected'; readonly reason: unknown };

type ToolExecutionResultPromise = Promise<SettledToolExecutionResult>;

type ToolExecutionStreamEvent =
  | { readonly type: 'timed'; readonly result: IteratorResult<TimedToolResult> }
  | { readonly type: 'timedRejected'; readonly reason: unknown }
  | {
      readonly type: 'finalized';
      readonly promise: ToolExecutionResultPromise;
      readonly settled: SettledToolExecutionResult;
    };

export class AgentToolExecutorService implements IAgentToolExecutorService {
  declare readonly _serviceBrand: undefined;

  private readonly beforeExecuteEmitter = new BeforeToolExecuteEmitter();
  readonly onBeforeExecuteTool: Event<BeforeToolExecuteEvent> = this.beforeExecuteEmitter.event;
  private readonly willExecuteEmitter = new AsyncEmitter<WillExecuteToolEvent>();
  readonly onWillExecuteTool: Event<WillExecuteToolEvent> = this.willExecuteEmitter.event;

  readonly hooks = {
    onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>(),
  };

  private missingToolDescriber: MissingToolDescriber | undefined;
  private unavailableToolDescriber: UnavailableToolDescriber | undefined;
  private toolCallGuard: ToolCallGuard | undefined;
  private readonly toolCallDupTypes = new Map<string, ToolCallDupType>();
  private dupTypeTurnId: number | undefined;

  recordDupType(toolCallId: string, dupType: ToolCallDupType): void {
    this.toolCallDupTypes.set(toolCallId, dupType);
  }

  registerToolCallGuard(guard: ToolCallGuard) {
    this.toolCallGuard = guard;
    return toDisposable(() => {
      if (this.toolCallGuard === guard) this.toolCallGuard = undefined;
    });
  }

  registerUnavailableToolDescriber(describer: UnavailableToolDescriber) {
    this.unavailableToolDescriber = describer;
    return toDisposable(() => {
      if (this.unavailableToolDescriber === describer) this.unavailableToolDescriber = undefined;
    });
  }

  registerMissingToolDescriber(describer: MissingToolDescriber) {
    this.missingToolDescriber = describer;
    return toDisposable(() => {
      if (this.missingToolDescriber === describer) this.missingToolDescriber = undefined;
    });
  }

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IEventBus private readonly eventBus: IEventBus,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentToolResultTruncationService
    private readonly resultTruncation: IAgentToolResultTruncationService,
    @ILogService private readonly log?: ILogService,
  ) {}

  async *execute(
    calls: ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): AsyncIterable<ToolExecutionResult> {
    if (calls.length === 0) return;
    if (options.turnId !== this.dupTypeTurnId) {
      this.dupTypeTurnId = options.turnId;
      this.toolCallDupTypes.clear();
    }

    const preflighted = calls.map((call) =>
      preflightToolCall(
        this.toolRegistry,
        call,
        this.toolCallGuard,
        this.unavailableToolDescriber,
        this.missingToolDescriber,
        this.log,
      ),
    );
    const preparedTasks: Array<{
      task: ToolExecutionTask;
      call: PreflightedToolCall;
      stopBatchAfterThis?: boolean;
    }> = [];

    let stopBatch = false;
    for (const call of preflighted) {
      if (stopBatch) {
        preparedTasks.push({ task: this.prepareSkippedToolCall(call, options), call });
        continue;
      }

      const prepared = await this.prepareToolCall(call, calls, options);
      preparedTasks.push({
        task: prepared.task,
        call,
        stopBatchAfterThis: prepared.stopBatchAfterThis,
      });
      if (prepared.stopBatchAfterThis === true) {
        stopBatch = true;
      }
    }

    const timedResults = this.executeBatch(
      preparedTasks.map(({ task }) => task),
      options.signal,
    )[Symbol.asyncIterator]();
    let nextTimed: Promise<IteratorResult<TimedToolResult>> | undefined = timedResults.next();
    const finalizations = new Set<ToolExecutionResultPromise>();

    try {
      while (nextTimed !== undefined || finalizations.size > 0) {
        const candidates: Array<Promise<ToolExecutionStreamEvent>> = [];
        if (nextTimed !== undefined) {
          candidates.push(
            nextTimed.then(
              (result): ToolExecutionStreamEvent => ({ type: 'timed', result }),
              (reason): ToolExecutionStreamEvent => ({ type: 'timedRejected', reason }),
            ),
          );
        }
        for (const promise of finalizations) {
          candidates.push(
            promise.then((settled): ToolExecutionStreamEvent => ({
              type: 'finalized',
              promise,
              settled,
            })),
          );
        }

        const event = await Promise.race(candidates);
        if (event.type === 'timedRejected') {
          throw event.reason;
        }
        if (event.type === 'timed') {
          if (event.result.done === true) {
            nextTimed = undefined;
            continue;
          }

          const finalization = this.finalizeTimedResult(
            preparedTasks[event.result.value.index]!,
            event.result.value,
            options,
          ).then(
            (value): SettledToolExecutionResult => ({ status: 'fulfilled', value }),
            (reason): SettledToolExecutionResult => ({ status: 'rejected', reason }),
          );
          finalizations.add(finalization);
          nextTimed = timedResults.next();
          continue;
        }

        finalizations.delete(event.promise);
        if (event.settled.status === 'rejected') throw event.settled.reason;
        yield event.settled.value;
      }
    } finally {
      await timedResults.return?.();
      await Promise.allSettled(finalizations);
    }
  }

  private async finalizeTimedResult(
    prepared: {
      readonly call: PreflightedToolCall;
    },
    timedResult: TimedToolResult,
    options: ToolExecutorExecuteOptions,
  ): Promise<ToolExecutionResult> {
    const { call } = prepared;
    const rawResult = timedResult.result;
    const finalized = await this.finalizeToolResult(call, rawResult, options);

    this.dispatchToolResult(call, finalized, options);
    this.trackToolCall(call, finalized, timedResult.durationMs, options);

    return {
      toolCallId: call.toolCall.id,
      toolName: call.toolName,
      result: finalized,
    };
  }

  private trackToolCall(
    call: PreflightedToolCall,
    result: ToolResult,
    durationMs: number,
    options: ToolExecutorExecuteOptions,
  ): void {
    const outcome = toolTelemetryOutcome(result);
    const toolCallId = call.toolCall.id;
    const dupType = this.toolCallDupTypes.get(toolCallId) ?? 'normal';
    this.toolCallDupTypes.delete(toolCallId);
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
    this.telemetry.track2('tool_call', properties);
  }

  private async prepareToolCall(
    call: PreflightedToolCall,
    allCalls: readonly ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): Promise<{
    task: ToolExecutionTask;
    stopBatchAfterThis?: boolean;
  }> {
    const settleError = (
      args: unknown,
      output: string,
      displayFields?: ToolCallDisplayFields,
    ): { task: ToolExecutionTask } => {
      this.dispatchToolCall(call, args, options, displayFields);
      return {
        task: makeResolvedTask(makeErrorToolResult(call, args, output)),
      };
    };

    const settleSynthetic = (
      args: unknown,
      result: ExecutableToolResult,
      displayFields?: ToolCallDisplayFields,
    ): {
      task: ToolExecutionTask;
      stopBatchAfterThis?: boolean;
    } => {
      const toolResult = this.normalizeAndMergeResult(result, call.toolName, undefined);
      this.dispatchToolCall(call, args, options, displayFields);
      return {
        task: makeResolvedTask({
          toolCall: call.toolCall,
          toolName: call.toolName,
          args,
          result: toolResult,
          stopTurn: toolResult.stopTurn === true,
        }),
        stopBatchAfterThis: toolResult.stopBatchAfterThis ?? toolResult.stopTurn,
      };
    };

    if (call.kind === 'rejected') {
      return settleError(call.args, call.output);
    }

    let execution: ToolExecution;
    try {
      execution = await call.tool.resolveExecution(call.args);
    } catch (error) {
      const output =
        error instanceof PathSecurityError
          ? error.message
          : `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
      return settleError(call.args, output);
    }

    const displayFields = toolCallDisplayFieldsFromExecution(execution);

    if (options.signal.aborted) {
      return settleError(
        call.args,
        abortedToolOutput(call.toolName, options.signal),
        displayFields,
      );
    }

    if (execution.isError === true) {
      return settleSynthetic(call.args, execution, displayFields);
    }

    const beforeContext = buildBeforeExecuteContext(call, execution, allCalls, options);
    const decision = await this.beforeExecuteEmitter.fireBeforeExecute(beforeContext);

    if (decision?.veto !== undefined) {
      return settleSynthetic(call.args, decision.veto, displayFields);
    }

    const executionMetadata = decision?.executionMetadata;

    await this.willExecuteEmitter.fireAsync(
      {
        turnId: options.turnId,
        toolCall: call.toolCall,
        execution,
        args: call.args,
      },
      options.signal,
    );

    this.dispatchToolCall(call, call.args, options, displayFields);

    return {
      task: {
        accesses: execution.accesses ?? ToolAccesses.all(),
        execute: async (taskSignal) =>
          this.runSingleExecution(call, execution, executionMetadata, options, taskSignal),
      },
      stopBatchAfterThis: execution.stopBatchAfterThis,
    };
  }

  private prepareSkippedToolCall(
    call: PreflightedToolCall,
    options: ToolExecutorExecuteOptions,
  ): ToolExecutionTask {
    const output = 'Tool skipped because a previous tool call stopped the turn.';
    this.dispatchToolCall(call, call.args, options);
    return makeResolvedTask(makeErrorToolResult(call, call.args, output));
  }

  private async *executeBatch(
    tasks: ToolExecutionTask[],
    signal: AbortSignal,
  ): AsyncIterable<TimedToolResult> {
    const scheduler = new ToolScheduler<TimedToolResult>();
    const allResults: Array<Promise<TimedToolResult>> = [];
    const pendingResults = new Map<number, Promise<SettledTimedToolResult>>();

    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index]!;
      const pendingResult = scheduler.add({
        accesses: task.accesses,
        start: async () => {
          const startedAt = Date.now();
          return {
            result: task.execute(signal).then((result) => ({
              index,
              result,
              durationMs: Math.max(0, Date.now() - startedAt),
            })),
          };
        },
      });
      allResults.push(pendingResult);
      pendingResults.set(
        index,
        pendingResult.then(
          (value): SettledTimedToolResult => ({ status: 'fulfilled', value }),
          (reason): SettledTimedToolResult => ({ status: 'rejected', index, reason }),
        ),
      );
    }

    try {
      while (pendingResults.size > 0) {
        const settled = await Promise.race(pendingResults.values());
        const index = settled.status === 'fulfilled' ? settled.value.index : settled.index;
        pendingResults.delete(index);
        if (settled.status === 'rejected') throw settled.reason;
        yield settled.value;
      }
    } finally {
      await Promise.allSettled(allResults);
    }
  }

  private async runSingleExecution(
    call: RunnableToolCall,
    execution: RunnableToolExecution,
    metadata: unknown,
    options: ToolExecutorExecuteOptions,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      return makeErrorToolResult(
        call,
        call.args,
        abortedToolOutput(call.toolName, signal),
      ).result;
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
          this.dispatchToolProgress(call, update, options);
        },
      });
      rawResult = await raceWithAbortGrace(executePromise, signal, call.toolName);
    } catch (error) {
      const aborted = isAbortError(error) || signal.aborted;
      const output = aborted
        ? abortedToolOutput(call.toolName, signal)
        : `Tool "${call.toolName}" failed: ${errorMessage(error)}`;
      return makeErrorToolResult(call, call.args, output).result;
    }

    return this.normalizeAndMergeResult(rawResult, call.toolName, execution);
  }

  private normalizeAndMergeResult(
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

  private dispatchToolCall(
    call: PreflightedToolCall,
    args: unknown,
    options: ToolExecutorExecuteOptions,
    displayFields?: ToolCallDisplayFields,
  ): void {
    this.eventBus.publish({
      type: 'tool.call.started',
      turnId: options.turnId,
      toolCallId: call.toolCall.id,
      name: call.toolName,
      args,
      description: displayFields?.description,
      display: displayFields?.display,
    });
    options.onToolCall?.({
      toolCallId: call.toolCall.id,
      name: call.toolName,
      args,
    });
  }

  private dispatchToolResult(
    call: PreflightedToolCall,
    result: ToolResult,
    options: ToolExecutorExecuteOptions,
  ): void {
    this.eventBus.publish({
      type: 'tool.result',
      turnId: options.turnId,
      toolCallId: call.toolCall.id,
      output: result.output,
      isError: result.isError,
    });
  }

  private dispatchToolProgress(
    call: RunnableToolCall,
    update: ToolUpdate,
    options: ToolExecutorExecuteOptions,
  ): void {
    this.eventBus.publish({
      type: 'tool.progress',
      turnId: options.turnId,
      toolCallId: call.toolCall.id,
      update,
    });
  }

  private async finalizeToolResult(
    call: PreflightedToolCall,
    result: ToolResult,
    options: ToolExecutorExecuteOptions,
  ): Promise<ToolResult> {
    if (call.kind === 'rejected') {
      return result;
    }

    const didCtx: ToolDidExecuteContext = {
      turnId: options.turnId,
      signal: options.signal,
      trace: options.trace,
      toolCall: call.toolCall,
      toolCalls: [call.toolCall],
      tool: call.tool,
      args: call.args,
      result: result as ExecutableToolResult,
    };

    try {
      await this.hooks.onDidExecuteTool.run(didCtx);
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
    return this.resultTruncation.truncateForModel({
      toolName: call.toolName,
      toolCallId: call.toolCall.id,
      result: finalResult,
    });
  }
}

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

type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

interface PreparedToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ToolResult;
  readonly stopTurn?: boolean;
}

type ToolCallDisplayFields = { description?: string | undefined; display?: ToolInputDisplay | undefined };

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

function preflightToolCall(
  toolRegistry: IAgentToolRegistryService,
  toolCall: ToolCall,
  guard: ToolCallGuard | undefined,
  describeUnavailableTool: UnavailableToolDescriber | undefined,
  describeMissingTool: MissingToolDescriber | undefined,
  log?: ILogService,
): PreflightedToolCall {
  const toolName = toolCall.name;
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  if (parsedArgs.parseFailed) {
    log?.debug('tool args JSON parse failed', {
      toolName,
      toolCallId: toolCall.id,
      rawLength: typeof toolCall.arguments === 'string' ? toolCall.arguments.length : 0,
      error: parsedArgs.error,
    });
  }
  const tool = toolRegistry.resolve(toolName);
  if (tool === undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: describeMissingTool?.(toolName) ?? `Tool "${toolName}" not found`,
    };
  }
  const source = toolRegistry.list().find((entry) => entry.name === toolName)?.source ?? 'builtin';
  const denied = guard?.({ name: toolName, source });
  if (denied !== undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: denied,
    };
  }
  const unavailable = describeUnavailableTool?.(toolName);
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

export function parseToolCallArguments(raw: unknown): {
  readonly data: unknown;
  readonly parseFailed: boolean;
  readonly error?: string;
} {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.length === 0)) {
    return { data: {}, parseFailed: false };
  }
  if (typeof raw !== 'string') {
    return { data: raw, parseFailed: false };
  }
  try {
    return { data: JSON.parse(raw) as unknown, parseFailed: false };
  } catch (error) {
    return { data: {}, parseFailed: true, error: errorMessage(error) };
  }
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

function makeResolvedTask(result: PreparedToolResult): ToolExecutionTask {
  return {
    accesses: ToolAccesses.none(),
    execute: async () => result.result,
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolExecutorService,
  AgentToolExecutorService,
  InstantiationType.Eager,
  'toolExecutor',
);
