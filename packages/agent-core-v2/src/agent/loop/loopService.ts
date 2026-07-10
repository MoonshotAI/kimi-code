import { randomUUID } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type {
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepRetryingEvent,
  TurnStepStartedEvent,
} from '@moonshot-ai/protocol';
import { IAgentLLMRequesterService, type LLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { type FinishReason } from '#/app/llmProtocol/finishReason';
import { type StreamedMessagePart } from '#/app/llmProtocol/message';
import { type TokenUsage } from '#/app/llmProtocol/usage';
import { ErrorCodes, KimiError } from '#/errors';
import { OrderedHookSlot } from '#/hooks';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  createMaxStepsExceededError,
  errorMessage,
  isAbortError,
  isMaxStepsExceededError,
} from './errors';
import {
  IAgentLoopService,
  type LoopRunOptions,
  type AfterStepContext,
  type LoopRunResult,
} from './loop';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.step.started': TurnStepStartedEvent;
    'turn.step.retrying': TurnStepRetryingEvent;
    'turn.step.completed': TurnStepCompletedEvent;
    'turn.step.interrupted': TurnStepInterruptedEvent;
    'assistant.delta': AssistantDeltaEvent;
    'thinking.delta': ThinkingDeltaEvent;
    'tool.call.delta': ToolCallDeltaEvent;
  }
}

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export class AgentLoopService implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    beforeStep: new OrderedHookSlot(),
    afterStep: new OrderedHookSlot(),
    onError: new OrderedHookSlot(),
  };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IConfigService private readonly config: IConfigService,
  ) { }

  async run(options: LoopRunOptions): Promise<LoopRunResult> {
    const { turnId } = options;
    const signal = options.signal ?? new AbortController().signal;

    let steps = 0;
    let activeStep: number | undefined;
    while (true) {
      try {
        activeStep = undefined;
        signal.throwIfAborted();

        const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;

        if (maxSteps !== undefined && maxSteps > 0 && steps >= maxSteps) {
          throw createMaxStepsExceededError(maxSteps);
        }

        steps += 1;
        activeStep = steps;
        const stepResult = await this.executeLoopStep(
          turnId,
          signal,
          steps,
          options.onStarted,
        );
        activeStep = undefined;

        if (stepResult.stopReason === 'filtered') {
          throw new KimiError(
            ErrorCodes.PROVIDER_FILTERED,
            'Provider safety policy blocked the response.',
            {
              name: 'ProviderFilteredError',
              details: { finishReason: 'filtered' },
            },
          );
        }

        if (stepResult.stopReason === 'tool_calls' || stepResult.continue) {
          continue;
        }

        return { type: 'completed', steps, truncated: stepResult.stopReason === 'truncated' };
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          this.emitStepInterrupted(turnId, activeStep, 'aborted');
          return { type: 'cancelled', reason: signal.reason ?? error, steps };
        }

        const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
        this.emitStepInterrupted(turnId, activeStep, reason, errorMessage(error));

        const context = { turnId, step: activeStep, signal, error, retry: false };
        try {
          await this.hooks.onError.run(context);
        } catch (hookError) {
          return { type: 'failed', error: hookError, steps };
        }
        if (context.retry) {
          activeStep = undefined;
          continue;
        }
        return { type: 'failed', error, steps };
      }
    }
  }

  private async executeLoopStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    onStarted: ((step: number) => void) | undefined,
  ): Promise<{
    readonly stopReason: FinishReason;
    readonly continue: boolean;
  }> {
    await this.hooks.beforeStep.run({ turnId, step: currentStep, signal });
    signal.throwIfAborted();

    const stepUuid = randomUUID();

    this.eventBus.publish({ type: 'turn.step.started', turnId, step: currentStep, stepId: stepUuid });
    this.context.appendLoopEvent({
      type: 'step.begin',
      uuid: stepUuid,
      turnId: String(turnId),
      step: currentStep,
    });

    let stepStarted = false;
    const markStepStarted = (): void => {
      if (stepStarted) return;
      stepStarted = true;
      onStarted?.(currentStep);
    };
    const emitStreamPart = this.createStreamPartHandler(turnId, markStepStarted);
    const response = await this.llmRequester.request(
      {
        source: { type: 'turn', turnId, step: currentStep },
        retry: {
          maxAttempts: this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxRetriesPerStep,
          onRetry: (retry) => {
            this.eventBus.publish({
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
      },
      emitStreamPart,
      signal,
    );

    const usage = response.usage;
    const { providerFinishReason, message } = response;
    let finishReason = providerFinishReason ?? 'completed';

    const turnIdStr = String(turnId);
    const toolCallUuids = new Map<string, string>();
    for (const part of message.content) {
      this.context.appendLoopEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId: turnIdStr,
        step: currentStep,
        stepUuid,
        part,
      });
    }

    const hasToolCalls = message.toolCalls.length > 0;
    if (hasToolCalls) {
      let stopTurn = false;
      for await (const toolResult of this.toolExecutor.execute(response.message.toolCalls, {
        signal,
        turnId,
        onToolCall: ({ toolCallId, name, args }) => {
          const callUuid = randomUUID();
          toolCallUuids.set(toolCallId, callUuid);
          this.context.appendLoopEvent({
            type: 'tool.call',
            uuid: callUuid,
            turnId: turnIdStr,
            step: currentStep,
            stepUuid,
            toolCallId,
            name,
            args,
          });
        },
      })) {
        const { result } = toolResult;
        this.context.appendLoopEvent({
          type: 'tool.result',
          parentUuid: toolCallUuids.get(toolResult.toolCallId) ?? randomUUID(),
          toolCallId: toolResult.toolCallId,
          result: { output: result.output, isError: result.isError, note: result.note },
        });
        if (result.stopTurn === true) stopTurn = true;
      }
      if (stopTurn) {
        finishReason = 'completed';
      } else {
        finishReason = 'tool_calls';
      }
    }

    signal.throwIfAborted();

    markStepStarted();
    const timing = response.timing;
    const stepFinishReason = normalizeFinishReason(finishReason);
    this.context.appendLoopEvent({
      type: 'step.end',
      uuid: stepUuid,
      turnId: turnIdStr,
      step: currentStep,
      finishReason: stepFinishReason,
      usage,
      llmFirstTokenLatencyMs: timing?.firstTokenLatencyMs,
      llmStreamDurationMs: timing?.streamDurationMs,
      llmRequestBuildMs: timing?.requestBuildMs,
      llmServerFirstTokenMs: timing?.serverFirstTokenMs,
      llmServerDecodeMs: timing?.serverDecodeMs,
      llmClientConsumeMs: timing?.clientConsumeMs,
      messageId: response.providerMessageId,
      providerFinishReason,
      rawFinishReason: response.rawFinishReason,
    });
    if (response.model !== undefined) {
      this.usage.record(response.model, usage, { type: 'turn', turnId, step: currentStep });
    }
    this.emitStepCompleted(turnId, currentStep, stepUuid, usage, stepFinishReason, response);

    const afterStepContext: AfterStepContext = {
      turnId,
      step: currentStep,
      signal,
      usage,
      finishReason,
      continue: false,
    };
    try {
      await this.hooks.afterStep.run(afterStepContext);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      // afterStep hook failures must not affect the turn result.
    }

    return {
      stopReason: finishReason,
      continue: afterStepContext.continue,
    };
  }

  private emitStepCompleted(
    turnId: number,
    step: number,
    stepId: string,
    usage: TokenUsage,
    finishReason: string,
    response: LLMRequestFinish,
  ): void {
    this.eventBus.publish({
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
      providerFinishReason: response.providerFinishReason,
      rawFinishReason: response.rawFinishReason,
    });
  }

  private emitStepInterrupted(
    turnId: number,
    activeStep: number | undefined,
    reason: LoopInterruptReason,
    message?: string,
  ): void {
    if (activeStep === undefined) return;
    this.eventBus.publish({
      type: 'turn.step.interrupted',
      turnId,
      step: activeStep,
      reason,
      message,
    });
  }

  private createStreamPartHandler(
    turnId: number,
    onResponseEvent: () => void,
  ): (part: StreamedMessagePart) => void {
    // Maps a tool call's streaming index to its identity so that interleaved
    // argument deltas from parallel tool calls can be routed to the right call.
    // Each provider emits a `function` header before any of its `tool_call_part`
    // deltas, and a delta's `index` always matches a previously-seen header's
    // `_streamIndex`. The `undefined` key doubles as the single-call fallback
    // for providers that stream without indices: those streams never mix indexed
    // and unindexed parts, so the most recent unindexed header is always the
    // target.
    const callsByIndex = new Map<number | string | undefined, { id: string; name: string }>();

    return (part) => {
      switch (part.type) {
        case 'text':
          onResponseEvent();
          this.eventBus.publish({ type: 'assistant.delta', turnId, delta: part.text });
          return;
        case 'think':
          onResponseEvent();
          this.eventBus.publish({ type: 'thinking.delta', turnId, delta: part.think });
          return;
        case 'image_url':
        case 'audio_url':
        case 'video_url':
          return;
        case 'function': {
          onResponseEvent();
          callsByIndex.set(part._streamIndex, { id: part.id, name: part.name });
          this.eventBus.publish({
            type: 'tool.call.delta',
            turnId,
            toolCallId: part.id,
            name: part.name,
            argumentsPart: part.arguments ?? undefined,
          });
          return;
        }
        case 'tool_call_part': {
          if (part.argumentsPart === null) return;
          const toolCall = callsByIndex.get(part.index);
          if (toolCall === undefined) return;
          onResponseEvent();
          this.eventBus.publish({
            type: 'tool.call.delta',
            turnId,
            toolCallId: toolCall.id,
            name: toolCall.name,
            argumentsPart: part.argumentsPart,
          });
          return;
        }
        default: {
          const _exhaustive: never = part;
          return _exhaustive;
        }
      }
    };
  }
}

function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  InstantiationType.Delayed,
  'loop',
);
