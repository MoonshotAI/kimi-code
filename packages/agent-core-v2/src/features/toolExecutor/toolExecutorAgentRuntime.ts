import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { AsyncEmitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { isAbortError } from '#/_base/utils/abort';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/agent/runtime/agentRuntime';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import type { ToolCallEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { OrderedHookSlot } from '#/hooks';
import type { ToolCall } from '#/kosong/contract/message';
import { PathSecurityError } from '#/tool/path-access';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type RunnableToolExecution,
  type ToolExecution,
  type ToolResult,
  type ToolUpdate,
} from '#/tool/toolContract';

import { BeforeToolExecuteEmitter } from './beforeToolExecuteEvent';
import {
  makeErrorToolResult,
  makeResolvedTask,
  type SettledTimedToolResult,
  type SettledToolExecutionResult,
  type TimedToolResult,
  type ToolExecutionResultPromise,
  type ToolExecutionRunResult,
  type ToolExecutionStreamEvent,
  type ToolExecutionTask,
} from './internal/executionPipeline';
import {
  buildBeforeExecuteContext,
  preflightToolCall,
  toolCallDisplayFieldsFromExecution,
  type PreflightedToolCall,
  type RunnableToolCall,
  type ToolCallDisplayFields,
} from './internal/preflight';
import { ToolScheduler } from './internal/toolScheduler';
import {
  abortedToolOutput,
  coerceToolResult,
  errorMessage,
  normalizeToolResult,
  raceWithAbortGrace,
  toolTelemetryErrorType,
  toolTelemetryOutcome,
} from './internal/toolResult';
import type {
  MissingToolDescriber,
  ToolCallDupType,
  ToolCallGuard,
  ToolExecutionResult,
  ToolExecutorExecuteOptions,
  UnavailableToolDescriber,
} from './toolExecutor';
import { ToolCallStarted, ToolProgress, ToolResultEvent } from './toolExecutorEvents';
import type {
  BeforeToolExecuteEvent,
  ToolDidExecuteContext,
  ToolExecutionOutcome,
  WillExecuteToolEvent,
} from './toolHooks';

export class ToolExecutorRuntime {
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

  constructor(private readonly runtime: AgentRuntimeContext<null>) {}

  private get toolRegistry(): IAgentToolRegistryService {
    return this.runtime.get(IAgentToolRegistryService);
  }

  private get telemetry(): ITelemetryService {
    return this.runtime.get(ITelemetryService);
  }

  private get resultTruncation(): IAgentToolResultTruncationService {
    return this.runtime.get(IAgentToolResultTruncationService);
  }

  private get log(): ILogService | undefined {
    return this.runtime.get(ILogService);
  }

  recordDupType(toolCallId: string, dupType: ToolCallDupType): void {
    this.toolCallDupTypes.set(toolCallId, dupType);
  }

  registerToolCallGuard(guard: ToolCallGuard): IDisposable {
    this.toolCallGuard = guard;
    return toDisposable(() => {
      if (this.toolCallGuard === guard) this.toolCallGuard = undefined;
    });
  }

  registerUnavailableToolDescriber(describer: UnavailableToolDescriber): IDisposable {
    this.unavailableToolDescriber = describer;
    return toDisposable(() => {
      if (this.unavailableToolDescriber === describer) this.unavailableToolDescriber = undefined;
    });
  }

  registerMissingToolDescriber(describer: MissingToolDescriber): IDisposable {
    this.missingToolDescriber = describer;
    return toDisposable(() => {
      if (this.missingToolDescriber === describer) this.missingToolDescriber = undefined;
    });
  }

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
      resolvedAccesses?: ToolAccesses;
      stopBatchAfterThis?: boolean;
    }> = [];

    let stopBatch = false;
    for (const call of preflighted) {
      if (stopBatch) {
        const skipped = this.prepareSkippedToolCall(call, options);
        preparedTasks.push({ ...skipped, call });
        continue;
      }

      const prepared = await this.prepareToolCall(call, calls, options);
      preparedTasks.push({
        task: prepared.task,
        call,
        resolvedAccesses: prepared.resolvedAccesses,
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
      readonly resolvedAccesses?: ToolAccesses;
    },
    timedResult: TimedToolResult,
    options: ToolExecutorExecuteOptions,
  ): Promise<ToolExecutionResult> {
    const { call } = prepared;
    const rawResult = timedResult.result;
    const finalized = await this.finalizeToolResult(
      call,
      rawResult,
      options,
      timedResult.outcome,
      prepared.resolvedAccesses,
    );

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
    resolvedAccesses?: ToolAccesses;
    stopBatchAfterThis?: boolean;
  }> {
    const settleError = (
      args: unknown,
      output: string,
      outcome: Exclude<ToolExecutionOutcome, 'executed'>,
      displayFields?: ToolCallDisplayFields,
    ): { task: ToolExecutionTask } => {
      this.dispatchToolCall(call, args, options, displayFields);
      return {
        task: makeResolvedTask(makeErrorToolResult(call, args, output), outcome),
      };
    };

    const settleSynthetic = (
      args: unknown,
      result: ExecutableToolResult,
      outcome: Exclude<ToolExecutionOutcome, 'executed'>,
      displayFields?: ToolCallDisplayFields,
    ): {
      task: ToolExecutionTask;
      stopBatchAfterThis?: boolean;
    } => {
      const toolResult = this.normalizeAndMergeResult(result, call.toolName, undefined);
      this.dispatchToolCall(call, args, options, displayFields);
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
    const decision = await this.beforeExecuteEmitter.fireBeforeExecute(beforeContext);

    if (decision?.veto !== undefined) {
      return settleSynthetic(call.args, decision.veto, 'vetoed', displayFields);
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
      resolvedAccesses: execution.accesses,
      stopBatchAfterThis: execution.stopBatchAfterThis,
    };
  }

  private prepareSkippedToolCall(
    call: PreflightedToolCall,
    options: ToolExecutorExecuteOptions,
  ): { task: ToolExecutionTask } {
    const output = 'Tool skipped because a previous tool call stopped the turn.';
    this.dispatchToolCall(call, call.args, options);
    return {
      task: makeResolvedTask(makeErrorToolResult(call, call.args, output), 'skipped'),
    };
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
            result: task.execute(signal).then(({ result, outcome }) => ({
              index,
              result,
              outcome,
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
          this.dispatchToolProgress(call, update, options);
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
      result: this.normalizeAndMergeResult(rawResult, call.toolName, execution),
      outcome: 'executed',
    };
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
    void this.runtime.dispatch(
      new ToolCallStarted({
        agentId: this.runtime.agent.agentId,
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

  private dispatchToolResult(
    call: PreflightedToolCall,
    result: ToolResult,
    options: ToolExecutorExecuteOptions,
  ): void {
    void this.runtime.dispatch(
      new ToolResultEvent({
        agentId: this.runtime.agent.agentId,
        turnId: options.turnId,
        toolCallId: call.toolCall.id,
        output: result.output,
        isError: result.isError,
      }),
    );
  }

  private dispatchToolProgress(
    call: RunnableToolCall,
    update: ToolUpdate,
    options: ToolExecutorExecuteOptions,
  ): void {
    void this.runtime.dispatch(
      new ToolProgress({
        agentId: this.runtime.agent.agentId,
        turnId: options.turnId,
        toolCallId: call.toolCall.id,
        update,
      }),
    );
  }

  private async finalizeToolResult(
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

export const AgentToolExecutor = defineAgentRuntimeContract<ToolExecutorRuntime>('toolExecutor');

export const toolExecutorAgentRuntimeProvider = defineAgentRuntimeProvider<null, ToolExecutorRuntime>(AgentToolExecutor, {
  id: 'toolExecutor',
  createApi: (context) => new ToolExecutorRuntime(context),
});
