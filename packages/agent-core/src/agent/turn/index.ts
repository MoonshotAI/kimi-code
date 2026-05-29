import { createHash } from 'node:crypto';

import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  inputTotal,
  type ContentPart,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import type { Agent } from '..';
import {
  ErrorCodes,
  type KimiErrorPayload,
  isKimiError,
  makeErrorPayload,
  toKimiErrorPayload,
} from '#/errors';
import { isAbortError, isMaxStepsExceededError } from '../../loop/errors';
import {
  createLoopEventDispatcher,
  runTurn,
  type ExecutableToolResult,
  type LoopEvent,
  type LoopRecordedEvent,
  type LoopTurnInterruptedEvent,
  type LoopTurnStopReason,
} from '../../loop/index';
import type { AgentEvent, TurnEndedEvent } from '../../rpc';
import type { TelemetryPropertyValue } from '../../telemetry';
import { abortable } from '../../utils/abort';
import { USER_PROMPT_ORIGIN, type PromptOrigin } from '../context';
import { renderUserPromptHookBlockResult, renderUserPromptHookResult } from '../../session/hooks';
import { canonicalTelemetryArgs, isPlainRecord } from './canonical-args';
import { ToolCallDeduplicator } from './tool-dedup';

interface ActiveTurn {
  controller: AbortController;
  promise: Promise<TurnEndResult>;
}

interface BufferedSteer {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface TurnEndResult {
  readonly event: TurnEndedEvent;
  readonly stopReason?: LoopTurnStopReason;
}

const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';

export class TurnFlow {
  private steerBuffer: BufferedSteer[] = [];
  private turnId = -1;
  private activeTurn: 'resuming' | ActiveTurn | null = null;
  private readonly toolCallStartedAt = new Map<string, { name: string; startedAt: number }>();
  private readonly toolCallDupType = new Map<string, 'normal' | 'cross_step'>();
  private readonly stepToolCallKeys = new Map<number, Set<string>>();
  private readonly telemetryModeByTurn = new Map<number, 'agent' | 'plan'>();
  private readonly currentStepByTurn = new Map<number, number>();
  private readonly interruptedTelemetryTurnIds = new Set<number>();
  private readonly stepFailureByTurn = new Map<number, LoopTurnInterruptedEvent>();
  private currentStep = 0;

  constructor(protected readonly agent: Agent) {}

  // Returns the new turnId, or null if the turn was marked as resuming.
  prompt(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.prompt',
      input,
      origin,
    });
    return this.launch(input, origin);
  }

  // Returns the new turnId, or null if the input was buffered as a steer
  // message or the turn was marked as resuming.
  steer(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.steer',
      input,
      origin,
    });
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return null;
    }
    return this.launch(input, origin);
  }

  private launch(input: readonly ContentPart[], origin: PromptOrigin): number | null {
    if (this.activeTurn) {
      this.agent.emitEvent({
        type: 'error',
        ...makeErrorPayload(
          'turn.agent_busy',
          `Cannot launch a new turn while another turn (ID ${this.turnId}) is active`,
          { details: { turnId: this.turnId } },
        ),
      });
      return null;
    }

    this.turnId += 1;
    this.currentStep = 0;
    this.stepToolCallKeys.clear();
    this.toolCallDupType.clear();
    const telemetryMode = this.telemetryMode();
    this.telemetryModeByTurn.set(this.turnId, telemetryMode);
    this.currentStepByTurn.set(this.turnId, 0);
    this.agent.telemetry.track('turn_started', { mode: telemetryMode });
    this.agent.fullCompaction.resetForTurn();
    this.agent.usage.beginTurn();
    this.agent.emitEvent({
      type: 'turn.started',
      turnId: this.turnId,
      origin,
    });
    this.agent.context.appendUserMessage(input, origin);
    const controller = new AbortController();
    const promise = this.turnWorker(this.turnId, input, origin, controller.signal);
    this.activeTurn = { controller, promise };
    return this.turnId;
  }

  restorePrompt(): void {
    if (this.activeTurn) {
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  restoreSteer(input: readonly ContentPart[], origin: PromptOrigin): void {
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  cancel(turnId?: number): void {
    this.agent.records.logRecord({ type: 'turn.cancel', turnId });
    if (turnId !== undefined && turnId !== this.currentId) {
      return; // Ignore cancel for non-active turn
    }
    this.abortTurn();
    this.agent.subagentHost?.cancelAll();
  }

  get currentId() {
    return this.turnId;
  }

  get hasActiveTurn(): boolean {
    return this.activeTurn !== null && this.activeTurn !== 'resuming';
  }

  waitForCurrentTurn(signal?: AbortSignal | undefined): Promise<TurnEndResult> {
    const active = this.activeTurn;
    if (active === null || active === 'resuming') {
      return Promise.reject(new Error('No active turn'));
    }
    signal?.throwIfAborted();
    if (signal === undefined) return active.promise;

    const turnId = this.currentId;
    const onAbort = (): void => {
      this.agent.turn.cancel(turnId);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    return abortable(active.promise, signal).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }

  private abortTurn() {
    if (this.activeTurn !== 'resuming') {
      this.activeTurn?.controller.abort();
    }
    this.activeTurn = null;
  }

  private flushSteerBuffer(): boolean {
    const steers = this.steerBuffer;
    if (steers.length === 0) return false;
    for (const steer of steers) {
      this.agent.context.appendUserMessage(steer.input, steer.origin);
    }
    steers.length = 0;
    return true;
  }

  finishResume(): void {
    if (this.activeTurn === 'resuming') {
      this.activeTurn = null;
    }
    this.steerBuffer.length = 0;
  }

  private async turnWorker(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    const startedAt = Date.now();
    let ended: TurnEndedEvent;
    let completedStopReason: LoopTurnStopReason | undefined;
    try {
      const promptHookEnded = await this.applyUserPromptHook(
        turnId,
        input,
        origin,
        signal,
      );
      if (promptHookEnded !== undefined) {
        ended = promptHookEnded;
      } else {
        const stopReason = await this.runTurn(turnId, signal);
        completedStopReason = stopReason;
        ended = {
          type: 'turn.ended',
          turnId,
          reason: stopReason === 'aborted' ? 'cancelled' : 'completed',
        };
        this.agent.emitEvent(ended);
      }
    } catch (error) {
      if (isAbortError(error)) {
        ended = {
          type: 'turn.ended',
          turnId,
          reason: 'cancelled',
        };
        this.agent.emitEvent(ended);
      } else {
        const summary = summarizeTurnError(error, turnId);
        void this.agent.hooks?.fireAndForgetTrigger('StopFailure', {
          matcherValue: summary.name,
          inputData: {
            errorType: summary.name,
            errorMessage: summary.message,
          },
        });
        ended = {
          type: 'turn.ended',
          turnId,
          reason: 'failed',
          error: summary,
        };
        this.agent.emitEvent(ended);
        this.agent.emitEvent({
          type: 'error',
          ...summary,
        });
        if (this.shouldTrackApiError(turnId)) {
          const classification = classifyApiError(error, summary);
          const properties: Record<string, TelemetryPropertyValue> = {
            error_type: classification.errorType,
            model: this.agent.config.model,
            retryable: summary.retryable,
            duration_ms: Date.now() - startedAt,
          };
          if (classification.statusCode !== undefined) {
            properties['status_code'] = classification.statusCode;
          }
          const inputTokens = currentTurnInputTokens(this.agent.usage.data().currentTurn);
          if (inputTokens !== undefined) {
            properties['input_tokens'] = inputTokens;
          }
          this.agent.telemetry.track('api_error', properties);
        }
      }
    } finally {
      // The turn may have been aborted and a new turn may have started
      if (this.currentId === turnId) {
        this.agent.usage.endTurn();
        this.activeTurn = null;
      }
    }
    if (ended.reason !== 'completed') {
      this.trackTurnInterrupted(turnId, this.currentStepByTurn.get(turnId) ?? this.currentStep);
    }
    this.telemetryModeByTurn.delete(turnId);
    this.currentStepByTurn.delete(turnId);
    this.interruptedTelemetryTurnIds.delete(turnId);
    this.stepFailureByTurn.delete(turnId);
    return {
      event: ended,
      stopReason: completedStopReason,
    };
  }

  private async applyUserPromptHook(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndedEvent | undefined> {
    if (origin.kind !== 'user') return undefined;
    signal.throwIfAborted();
    const promptHookResults = await this.agent.hooks?.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      inputData: { prompt: input },
    });
    signal.throwIfAborted();
    const blockResult = renderUserPromptHookBlockResult(promptHookResults);
    if (blockResult !== undefined) {
      this.agent.context.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: blockResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      });
      this.agent.emitEvent({
        type: 'hook.result',
        turnId,
        hookEvent: blockResult.event,
        content: blockResult.message,
        blocked: true,
      });
      const ended: TurnEndedEvent = {
        type: 'turn.ended',
        turnId,
        reason: 'completed',
      };
      this.agent.emitEvent(ended);
      return ended;
    }

    const hookResult = renderUserPromptHookResult(promptHookResults);
    if (hookResult === undefined) return undefined;

    this.agent.context.appendUserMessage([{ type: 'text', text: hookResult.text }], {
      kind: 'hook_result',
      event: 'UserPromptSubmit',
    });
    this.agent.emitEvent({
      type: 'hook.result',
      turnId,
      hookEvent: hookResult.event,
      content: hookResult.message,
    });
    return undefined;
  }

  private async runTurn(turnId: number, signal: AbortSignal): Promise<LoopTurnStopReason> {
    let stopHookContinuationUsed = false;
    const deduper = new ToolCallDeduplicator();
    await this.agent.mcp?.waitForInitialLoad(signal);
    while (true) {
      signal.throwIfAborted();
      const model = this.agent.config.model;
      const loopControl = this.agent.kimiConfig?.loopControl;
      try {
        const result = await runTurn({
          turnId: String(turnId),
          signal,
          llm: this.agent.llm,
          buildMessages: () => this.agent.context.messages,
          dispatchEvent: this.buildDispatchEvent(turnId),
          tools: this.agent.tools.loopTools,
          log: this.agent.log,
          maxSteps: loopControl?.maxStepsPerTurn,
          maxRetryAttempts: loopControl?.maxRetriesPerStep,
          hooks: {
            beforeStep: async ({ signal: stepSignal }) => {
              this.flushSteerBuffer();
              await this.agent.fullCompaction.beforeStep(stepSignal);
              await this.agent.injection.inject();
              deduper.beginStep();
              return;
            },
            afterStep: async ({ usage }) => {
              this.agent.usage.record(model, usage, 'turn');
              await this.agent.fullCompaction.afterStep();
              deduper.endStep();
            },
            // oxlint-disable-next-line no-loop-func -- stop hook continuation state is scoped to this turn.
            shouldContinueAfterStop: async ({ signal }) => {
              if (this.flushSteerBuffer()) return { continue: true };
              signal.throwIfAborted();

              // Stop hooks get one continuation; otherwise a hook that always blocks would loop forever.
              if (stopHookContinuationUsed) return { continue: false };
              const stopBlock = await this.agent.hooks?.triggerBlock('Stop', {
                signal,
                inputData: { stopHookActive: stopHookContinuationUsed },
              });
              signal.throwIfAborted();
              if (stopBlock !== undefined) {
                stopHookContinuationUsed = true;
                this.agent.context.appendUserMessage(
                  [{ type: 'text', text: stopBlock.reason }],
                  {
                    kind: 'system_trigger',
                    name: 'stop_hook',
                  },
                );
                return { continue: true };
              }
              return { continue: false };
            },
            prepareToolExecution: async (ctx) => {
              const cached = deduper.checkSameStep(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
              );
              if (cached !== null) return { syntheticResult: cached };
              return undefined;
            },
            authorizeToolExecution: async (ctx) => {
              return this.agent.permission.beforeToolCall(ctx);
            },
            finalizeToolResult: async (ctx) => {
              // Resolve dedup BEFORE firing the PostToolUse hook so same-step
              // dups (whose ctx.result is the dedup placeholder) report the
              // original's real outcome, not an empty success.
              const finalResult = await deduper.finalizeResult(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
                ctx.result,
              );
              const { isError, output } = finalResult;
              const event = isError === true ? 'PostToolUseFailure' : 'PostToolUse';
              void this.agent.hooks?.fireAndForgetTrigger(event, {
                matcherValue: ctx.toolCall.name,
                inputData: {
                  toolName: ctx.toolCall.name,
                  toolInput: toolInputRecord(ctx.args),
                  toolCallId: ctx.toolCall.id,
                  error: isError === true ? toKimiErrorPayload(toolOutputText(output)) : undefined,
                  toolOutput: isError === true ? undefined : toolOutputText(output).slice(0, 2000),
                },
              });
              return finalResult;
            },
          },
        });

        return result.stopReason;
      } catch (error) {
        if (
          error instanceof APIContextOverflowError ||
          (isKimiError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW)
        ) {
          await this.agent.fullCompaction.handleOverflowError(signal, error);
          continue; // Retry with compacted context
        }
        if (isMaxStepsExceededError(error)) {
          this.agent.log.warn('turn hit max steps', {
            turnId,
            steps: this.currentStepByTurn.get(turnId) ?? this.currentStep,
            limit: isKimiError(error) ? error.details?.['maxSteps'] : undefined,
          });
        } else {
          this.agent.log.error('turn failed', { turnId, error });
        }
        throw error;
      }
    }
  }

  private buildDispatchEvent(turnId: number) {
    return createLoopEventDispatcher({
      appendTranscriptRecord: async (event: LoopRecordedEvent) => {
        this.agent.context.appendLoopEvent(event);
      },
      emitLiveEvent: (event: LoopEvent) => {
        this.trackLoopTelemetry(event, turnId);
        const mapped = mapLoopEvent(event, turnId);
        if (mapped !== undefined) this.agent.emitEvent(mapped);
      },
    });
  }

  private trackLoopTelemetry(event: LoopEvent, turnId: number): void {
    if (event.type === 'step.begin') {
      this.beginTrackedStep(turnId, event.step);
      return;
    }
    if (event.type === 'turn.interrupted') {
      if (event.reason === 'error' && event.activeStep !== undefined) {
        this.stepFailureByTurn.set(turnId, event);
      }
      this.trackTurnInterrupted(turnId, interruptedStep(event));
      return;
    }
    this.trackToolLifecycle(event, turnId);
  }

  private beginTrackedStep(turnId: number, step: number): void {
    this.currentStepByTurn.set(turnId, step);
    this.currentStep = step;
    if (!this.stepToolCallKeys.has(step)) {
      this.stepToolCallKeys.set(step, new Set());
    }
  }

  private trackToolLifecycle(event: LoopEvent, turnId: number): void {
    if (event.type === 'tool.call') {
      const dupType = this.trackDuplicateToolCall(turnId, event.step, event.name, event.args);
      this.toolCallDupType.set(
        event.toolCallId,
        dupType === 'cross_step' ? 'cross_step' : 'normal',
      );
      this.toolCallStartedAt.set(event.toolCallId, {
        name: event.name,
        startedAt: Date.now(),
      });
      return;
    }
    if (event.type === 'tool.result') {
      const started = this.toolCallStartedAt.get(event.toolCallId);
      if (started === undefined) return;
      this.toolCallStartedAt.delete(event.toolCallId);
      const dupType = this.toolCallDupType.get(event.toolCallId) ?? 'normal';
      this.toolCallDupType.delete(event.toolCallId);
      const outcome = telemetryToolOutcome(event.result);
      const properties: Record<string, TelemetryPropertyValue> = {
        tool_name: started.name,
        outcome,
        duration_ms: Date.now() - started.startedAt,
        dup_type: dupType,
      };
      const errorType = outcome === 'error' ? telemetryToolErrorType(event.result) : undefined;
      if (errorType !== undefined) {
        properties['error_type'] = errorType;
      }
      this.agent.telemetry.track('tool_call', properties);
    }
  }

  private trackDuplicateToolCall(
    turnId: number,
    step: number,
    toolName: string,
    args: unknown,
  ): 'normal' | 'same_step' | 'cross_step' {
    const argsText = canonicalTelemetryArgs(args);
    const key = `${toolName}\u0000${argsText}`;
    const stepKeys = this.stepToolCallKeys.get(step) ?? new Set<string>();
    this.stepToolCallKeys.set(step, stepKeys);

    let dupType: 'same_step' | 'cross_step' | undefined;
    if (stepKeys.has(key)) {
      dupType = 'same_step';
    } else if (this.hasPriorStepToolCallKey(step, key)) {
      dupType = 'cross_step';
    }

    stepKeys.add(key);
    if (dupType === undefined) return 'normal';

    this.agent.telemetry.track('tool_call_dedup_detected', {
      turn_id: turnId,
      step_no: step,
      tool_name: toolName,
      dup_type: dupType,
      args_hash: createHash('sha256').update(argsText).digest('hex').slice(0, 8),
    });
    return dupType;
  }

  private hasPriorStepToolCallKey(step: number, key: string): boolean {
    for (const [seenStep, keys] of this.stepToolCallKeys) {
      if (seenStep !== step && keys.has(key)) return true;
    }
    return false;
  }

  private trackTurnInterrupted(turnId: number, atStep: number): void {
    if (this.interruptedTelemetryTurnIds.has(turnId)) return;
    this.interruptedTelemetryTurnIds.add(turnId);
    this.agent.telemetry.track('turn_interrupted', {
      mode: this.telemetryModeByTurn.get(turnId) ?? this.telemetryMode(),
      at_step: atStep,
    });
  }

  private telemetryMode(): 'agent' | 'plan' {
    return this.agent.planMode.isActive ? 'plan' : 'agent';
  }

  private shouldTrackApiError(turnId: number): boolean {
    const failure = this.stepFailureByTurn.get(turnId);
    return failure?.reason === 'error' && failure.activeStep !== undefined;
  }
}

function mapLoopEvent(event: LoopEvent, turnId: number): AgentEvent | undefined {
  switch (event.type) {
    case 'step.begin':
      return {
        type: 'turn.step.started',
        turnId,
        step: event.step,
        stepId: event.uuid,
      };
    case 'step.end':
      return {
        type: 'turn.step.completed',
        turnId,
        step: event.step,
        stepId: event.uuid,
        usage: event.usage,
        finishReason: event.finishReason,
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        providerFinishReason: event.providerFinishReason,
        rawFinishReason: event.rawFinishReason,
      };
    case 'step.retrying':
      return {
        type: 'turn.step.retrying',
        turnId,
        step: event.step,
        stepId: event.stepUuid,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      };
    case 'content.part':
      return undefined;
    case 'tool.call':
      return {
        type: 'tool.call.started',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        description: event.description,
        display: event.display,
      };
    case 'tool.result':
      return {
        type: 'tool.result',
        turnId,
        toolCallId: event.toolCallId,
        output: event.result.output,
        isError: event.result.isError,
      };
    case 'turn.interrupted':
      if (event.activeStep === undefined) return undefined;
      return {
        type: 'turn.step.interrupted',
        turnId,
        step: event.activeStep,
        reason: event.reason,
        message: event.message,
      };
    case 'text.delta':
      return {
        type: 'assistant.delta',
        turnId,
        delta: event.delta,
      };
    case 'thinking.delta':
      return {
        type: 'thinking.delta',
        turnId,
        delta: event.delta,
      };
    case 'tool.call.delta':
      return {
        type: 'tool.call.delta',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsPart: event.argumentsPart,
      };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        turnId,
        toolCallId: event.toolCallId,
        update: event.update,
      };
  }
}

function summarizeTurnError(error: unknown, turnId: number): KimiErrorPayload {
  const payload = toKimiErrorPayload(error);
  const details = { ...payload.details, turnId };

  // Substitute a friendlier TUI-aware message for model-not-configured.
  // The raw "Model not set" / "Provider not set" text is not actionable;
  // this string points the user at the login flow.
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details };
  }

  return { ...payload, details };
}

function toolInputRecord(args: unknown): Record<string, unknown> {
  return isPlainRecord(args) ? args : {};
}

function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

function interruptedStep(event: LoopTurnInterruptedEvent): number {
  return event.activeStep ?? event.attemptedSteps;
}

interface ApiErrorClassification {
  readonly errorType: string;
  readonly statusCode?: number;
}

function classifyApiError(error: unknown, summary: KimiErrorPayload): ApiErrorClassification {
  const statusCode = apiStatusCode(error) ?? summaryStatusCode(summary);
  if (statusCode !== undefined) {
    if (statusCode === 429) return { errorType: 'rate_limit', statusCode };
    if (statusCode === 401 || statusCode === 403) return { errorType: 'auth', statusCode };
    if (statusCode >= 500) return { errorType: '5xx_server', statusCode };
    if (isContextOverflowMessage(summary.message)) {
      return { errorType: 'context_overflow', statusCode };
    }
    if (statusCode >= 400) return { errorType: '4xx_client', statusCode };
    return { errorType: 'api', statusCode };
  }

  if (summary.code === ErrorCodes.PROVIDER_RATE_LIMIT) return { errorType: 'rate_limit' };
  if (summary.code === ErrorCodes.PROVIDER_AUTH_ERROR) return { errorType: 'auth' };
  if (summary.code === ErrorCodes.CONTEXT_OVERFLOW) return { errorType: 'context_overflow' };
  if (isApiConnectionError(error, summary)) return { errorType: 'network' };
  if (isApiTimeoutError(error, summary)) return { errorType: 'timeout' };
  if (isApiEmptyResponseError(error, summary)) return { errorType: 'empty_response' };
  return { errorType: 'other' };
}

function apiStatusCode(error: unknown): number | undefined {
  if (error instanceof APIStatusError) {
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    return typeof statusCode === 'number' ? statusCode : undefined;
  }
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function summaryStatusCode(summary: KimiErrorPayload): number | undefined {
  const statusCode = summary.details?.['statusCode'];
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function isApiConnectionError(error: unknown, summary: KimiErrorPayload): boolean {
  return error instanceof APIConnectionError || summary.name === 'APIConnectionError';
}

function isApiTimeoutError(error: unknown, summary: KimiErrorPayload): boolean {
  return (
    error instanceof APITimeoutError ||
    summary.name === 'APITimeoutError' ||
    summary.name === 'TimeoutError'
  );
}

function isApiEmptyResponseError(error: unknown, summary: KimiErrorPayload): boolean {
  return error instanceof APIEmptyResponseError || summary.name === 'APIEmptyResponseError';
}

function isContextOverflowMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('context length') ||
    lower.includes('context_length') ||
    lower.includes('max tokens') ||
    lower.includes('maximum context') ||
    lower.includes('too many tokens')
  );
}

function currentTurnInputTokens(usage: TokenUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  return inputTotal(usage);
}

type ToolTelemetryResult = Extract<LoopEvent, { type: 'tool.result' }>['result'];

function telemetryToolOutcome(result: ToolTelemetryResult): 'success' | 'error' | 'cancelled' {
  if (result.isError !== true) return 'success';
  const text = toolResultText(result).toLowerCase();
  return text.includes('aborted') || text.includes('cancelled') ? 'cancelled' : 'error';
}

function telemetryToolErrorType(result: ToolTelemetryResult): string {
  const text = toolResultText(result);
  if (text.startsWith('Tool "') && text.includes('" not found')) return 'ToolNotFound';
  if (text.startsWith('Invalid args for tool "')) return 'ToolInputError';
  if (text.includes('prepareToolExecution hook failed')) return 'HookError';
  if (text.includes('finalizeToolResult hook failed')) return 'HookError';
  if (text.includes('blocked')) return 'ToolBlocked';
  return 'ToolError';
}

function toolResultText(result: ToolTelemetryResult): string {
  return toolOutputText(result.output);
}
