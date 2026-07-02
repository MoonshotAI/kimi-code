import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  IAgentContextMemoryService,
  newMessageId,
  type ContextMessage,
} from '#/agent/contextMemory';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { IAgentRecordService } from '#/agent/record';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import {
  IAgentLLMRequesterService,
  type LLMRequestFinish,
} from '#/agent/llmRequester';
import { IAgentProfileService } from '#/agent/profile';
import type { ToolResult } from '#/agent/tool';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { IConfigService } from '#/app/config';
import { ILogService } from '#/app/log';
import { ErrorCodes, isKimiError } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import {
  APIContextOverflowError,
  createToolMessage,
  isToolCall,
  isToolCallPart,
  type ContentPart,
  type StreamedMessagePart,
  type TokenUsage,
} from '@moonshot-ai/kosong';
import type { AgentEvent } from '@moonshot-ai/protocol';
import { randomUUID } from 'node:crypto';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  createMaxStepsExceededError,
  errorMessage,
  isAbortError,
  isMaxStepsExceededError,
} from './errors';
import { IAgentLoopService } from './loop';
import type {
  LoopInterruptReason,
  LoopStepStopReason,
  LoopTurnStopReason,
  TurnResult,
} from './types';

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

export class AgentLoopService implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    beforeStep: new OrderedHookSlot(),
    onStepUsage: new OrderedHookSlot(),
    afterStep: new OrderedHookSlot(),
    onContextOverflow: new OrderedHookSlot(),
  };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentExternalHooksService private readonly externalHooks: IAgentExternalHooksService,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {}

  async runTurn(
    turnId: number,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TurnResult> {
    this.profile.resolveModelContext();

    while (true) {
      let steps = 0;
      let stopReason: LoopTurnStopReason = 'end_turn';
      let activeStep: number | undefined;
      const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
      let stopHookContinuationUsed = false;

      try {
        while (true) {
          signal.throwIfAborted();

          if (maxSteps !== undefined && maxSteps > 0 && steps >= maxSteps) {
            throw createMaxStepsExceededError(maxSteps);
          }

          steps += 1;
          activeStep = steps;
          const stepResult = await this.executeLoopStep(turnId, signal, steps);
          activeStep = undefined;

          if (stepResult.stopReason === 'tool_use') {
            continue;
          }

          stopReason = stepResult.stopReason;

          if (stepResult.continueTurn) {
            continue;
          }

          if (!stopHookContinuationUsed) {
            const reason = await this.externalHooks.triggerStop(signal, false);
            if (reason !== undefined && hasStepBudgetRemaining(maxSteps, steps)) {
              stopHookContinuationUsed = true;
              this.append({
                role: 'user',
                content: [{ type: 'text', text: reason }],
                toolCalls: [],
                origin: { kind: 'system_trigger', name: 'stop_hook' },
              });
              continue;
            }
          }

          break;
        }
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          this.emitStepInterrupted(turnId, activeStep, 'aborted');
          return { stopReason: 'aborted', steps };
        }

        const reason: LoopInterruptReason = isMaxStepsExceededError(error)
          ? 'max_steps'
          : 'error';
        this.emitStepInterrupted(turnId, activeStep, reason, errorMessage(error));

        if (isContextOverflowError(error)) {
          const context = { turnId, signal, error, handled: false };
          await this.hooks.onContextOverflow.run(context);
          if (context.handled) continue;
        }
        throw error;
      }

      return { stopReason, steps };
    }
  }

  private async executeLoopStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
  ): Promise<{
    readonly stopReason: LoopStepStopReason;
    readonly continueTurn: boolean;
  }> {
    await this.hooks.beforeStep.run({ turnId, signal });
    signal.throwIfAborted();

    const stepUuid = randomUUID();
    const turnStep = `${turnId}.${String(currentStep)}`;
    const emit = (event: AgentEvent): void => {
      this.record.signal(event);
    };

    emit({ type: 'turn.step.started', turnId, step: currentStep, stepId: stepUuid });

    const emitToolCallDelta = createToolCallDeltaHandler(emit, turnId);
    const response = await this.llmRequester.request(
      {
        requestLogFields: { turnStep },
        retry: {
          maxAttempts: this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxRetriesPerStep,
          onRetry: (retry) => {
            emit({
              type: 'turn.step.retrying',
              turnId,
              step: currentStep,
              stepId: stepUuid,
              failedAttempt: retry.failedAttempt,
              nextAttempt: retry.nextAttempt,
              maxAttempts: retry.maxAttempts,
              delayMs: retry.delayMs,
              errorName: retry.errorName,
              errorMessage: retry.errorMessage,
              statusCode: retry.statusCode,
            });
          },
        },
        usageContext: { type: 'turn', turnId },
      },
      (part) => {
        this.emitStreamPart(turnId, emitToolCallDelta, part);
      },
      signal,
    );

    this.append({
      id: newMessageId(),
      role: 'assistant',
      content: response.message.content,
      toolCalls: response.message.toolCalls,
      providerMessageId: response.providerMessageId,
    });

    const usage = response.usage;
    const usageContext = {
      turnId,
      signal,
      usage,
      stepNumber: currentStep,
      stepUuid,
      toolCallCount: response.message.toolCalls.length,
      stopTurn: false,
    };
    await this.hooks.onStepUsage.run(usageContext);
    this.recordContextSize(usage);
    const stopReason = deriveStepStopReason(response);

    let effectiveStopReason: LoopStepStopReason =
      usageContext.stopTurn && stopReason === 'tool_use' ? 'end_turn' : stopReason;
    if (effectiveStopReason === 'tool_use') {
      const toolResults = await this.toolExecutor.execute(response.message.toolCalls, {
        signal,
        turnId,
        dispatchProtocolEvent: emit,
        onToolResult: (toolCallId, result) => {
          this.append({
            ...createToolMessage(toolCallId, toolResultOutputForModel(result)),
            role: 'tool',
            isError: result.isError,
          });
        },
        onProgress: (toolCallId, update) => {
          emit({ type: 'tool.progress', turnId, toolCallId, update });
        },
      });
      if (toolResults.some((r) => r.stopTurn === true)) {
        effectiveStopReason = 'end_turn';
      }
    }

    signal.throwIfAborted();

    this.emitStepCompleted(turnId, currentStep, stepUuid, usage, effectiveStopReason, response);
    if (response.timing !== undefined) {
      this.log.info('llm response', {
        turnStep,
        ttftMs: response.timing.firstTokenLatencyMs,
        requestBuildMs: response.timing.requestBuildMs,
        serverFirstTokenMs: response.timing.serverFirstTokenMs,
        streamDurationMs: response.timing.streamDurationMs,
        serverDecodeMs: response.timing.serverDecodeMs,
        clientConsumeMs: response.timing.clientConsumeMs,
        outputTokens: response.usage.output,
      });
    }

    const afterStepContext = { turnId, signal, continueTurn: false };
    try {
      await this.hooks.afterStep.run(afterStepContext);
    } catch {
      // afterStep hook failures must not affect the turn result.
    }

    return {
      stopReason: effectiveStopReason,
      continueTurn: effectiveStopReason !== 'tool_use' && afterStepContext.continueTurn,
    };
  }

  private append(message: ContextMessage): void {
    this.context.splice(this.context.get().length, 0, [message]);
  }

  private recordContextSize(usage: TokenUsage): void {
    const tokens =
      usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
    if (tokens <= 0) return;
    this.contextSize.measured(this.context.get().length, tokens);
  }

  private emitStreamPart(
    turnId: number,
    emitToolCallDelta: (part: StreamedMessagePart) => void,
    part: StreamedMessagePart,
  ): void {
    switch (part.type) {
      case 'text':
        this.record.signal({ type: 'assistant.delta', turnId, delta: part.text });
        return;
      case 'think':
        this.record.signal({ type: 'thinking.delta', turnId, delta: part.think });
        return;
      case 'image_url':
      case 'audio_url':
      case 'video_url':
        return;
      case 'function':
      case 'tool_call_part':
        emitToolCallDelta(part);
        return;
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  }

  private emitStepCompleted(
    turnId: number,
    step: number,
    stepId: string,
    usage: TokenUsage,
    finishReason: LoopStepStopReason,
    response: LLMRequestFinish,
  ): void {
    // Provider diagnostics are omitted when the normalized finish reason already
    // matches the provider's, and surfaced only when they diverge.
    const normalFinish =
      (response.providerFinishReason === 'completed' && finishReason === 'end_turn') ||
      (response.providerFinishReason === 'tool_calls' && finishReason === 'tool_use');
    this.record.signal({
      type: 'turn.step.completed',
      turnId,
      step,
      stepId,
      usage,
      finishReason,
      llmFirstTokenLatencyMs: response.timing?.firstTokenLatencyMs,
      llmStreamDurationMs: response.timing?.streamDurationMs,
      llmRequestBuildMs: response.timing?.requestBuildMs,
      llmServerFirstTokenMs: response.timing?.serverFirstTokenMs,
      llmServerDecodeMs: response.timing?.serverDecodeMs,
      llmClientConsumeMs: response.timing?.clientConsumeMs,
      providerFinishReason: normalFinish ? undefined : response.providerFinishReason,
      rawFinishReason: normalFinish ? undefined : response.rawFinishReason,
    });
  }

  private emitStepInterrupted(
    turnId: number,
    activeStep: number | undefined,
    reason: LoopInterruptReason,
    message?: string,
  ): void {
    if (activeStep === undefined) return;
    this.record.signal({
      type: 'turn.step.interrupted',
      turnId,
      step: activeStep,
      reason,
      message,
    });
  }
}

function isContextOverflowError(error: unknown): boolean {
  return (
    error instanceof APIContextOverflowError ||
    (isKimiError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW)
  );
}

function toolResultOutputForModel(result: ToolResult): string | ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    if (result.isError === true) {
      if (output.length === 0) return TOOL_EMPTY_ERROR_STATUS;
      if (output.trimStart().startsWith('<system>ERROR:')) return output;
      return `${TOOL_ERROR_STATUS}\n${output}`;
    }
    if (output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT) {
      return TOOL_EMPTY_STATUS;
    }
    return output;
  }

  if (output.length === 0) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) {
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...output];
  }
  return output;
}

function hasStepBudgetRemaining(maxSteps: number | undefined, currentStep: number): boolean {
  return maxSteps === undefined || maxSteps <= 0 || currentStep < maxSteps;
}

function deriveStepStopReason(response: LLMRequestFinish): LoopStepStopReason {
  switch (response.providerFinishReason) {
    case 'truncated':
      return 'max_tokens';
    case 'filtered':
      return 'filtered';
    case 'paused':
      return 'paused';
    case 'other':
      return 'unknown';
    case 'completed':
    case undefined:
      return response.message.toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    case 'tool_calls':
      return response.message.toolCalls.length > 0 ? 'tool_use' : 'unknown';
    default: {
      const _exhaustive: never = response.providerFinishReason;
      return _exhaustive;
    }
  }
}

function createToolCallDeltaHandler(
  emit: (event: AgentEvent) => void,
  turnId: number,
): (part: StreamedMessagePart) => void {
  const callsByIndex = new Map<number | string, { id: string; name: string }>();
  let lastToolCall: { id: string; name: string } | undefined;

  return (part) => {
    if (isToolCall(part)) {
      lastToolCall = { id: part.id, name: part.name };
      if (part._streamIndex !== undefined) {
        callsByIndex.set(part._streamIndex, lastToolCall);
      }
      emit({
        type: 'tool.call.delta',
        turnId,
        toolCallId: part.id,
        name: part.name,
        argumentsPart: part.arguments ?? undefined,
      });
      return;
    }
    if (!isToolCallPart(part) || part.argumentsPart === null) return;
    const toolCall = part.index !== undefined ? callsByIndex.get(part.index) : lastToolCall;
    if (toolCall === undefined) return;
    emit({
      type: 'tool.call.delta',
      turnId,
      toolCallId: toolCall.id,
      name: toolCall.name,
      argumentsPart: part.argumentsPart,
    });
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  InstantiationType.Delayed,
  'loop',
);
