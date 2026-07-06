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
import { IAgentLLMRequesterService, type LLMRequestFinish } from '#/agent/llmRequester';
import type { ToolResult } from '#/agent/tool';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { IConfigService } from '#/app/config';
import { IEventBus } from '#/app/event';
import {
  createToolMessage,
  type ContentPart,
  type FinishReason,
  type StreamedMessagePart,
  type TokenUsage,
} from '#/app/llmProtocol';
import { ErrorCodes, KimiError } from '#/errors';
import { OrderedHookSlot } from '#/hooks';

import { IAgentContextMemoryService, newMessageId, type ContextMessage } from '../contextMemory';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  createMaxStepsExceededError,
  errorMessage,
  isAbortError,
  isMaxStepsExceededError,
} from './errors';
import {
  IAgentLoopService,
  type RunOptions,
  type TurnAfterStepContext,
  type TurnResult,
} from './loop';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.step.started': Omit<TurnStepStartedEvent, 'type'>;
    'turn.step.retrying': Omit<TurnStepRetryingEvent, 'type'>;
    'turn.step.completed': Omit<TurnStepCompletedEvent, 'type'>;
    'turn.step.interrupted': Omit<TurnStepInterruptedEvent, 'type'>;
    'assistant.delta': Omit<AssistantDeltaEvent, 'type'>;
    'thinking.delta': Omit<ThinkingDeltaEvent, 'type'>;
    'tool.call.delta': Omit<ToolCallDeltaEvent, 'type'>;
  }
}

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

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
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IConfigService private readonly config: IConfigService,
  ) { }

  async run(options: RunOptions): Promise<TurnResult> {
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

        return { reason: 'completed', steps };
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          this.emitStepInterrupted(turnId, activeStep, 'aborted');
          return {
            reason: 'cancelled',
            error: signal.aborted ? signal.reason : error,
            steps,
          };
        }

        const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
        this.emitStepInterrupted(turnId, activeStep, reason, errorMessage(error));

        const context = { turnId, step: activeStep, signal, error, retry: false };
        try {
          await this.hooks.onError.run(context);
        } catch (hookError) {
          return { reason: 'failed', error: hookError, steps };
        }
        if (context.retry) {
          activeStep = undefined;
          continue;
        }
        return { reason: 'failed', error, steps };
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

    this.append({
      id: newMessageId(),
      role: 'assistant',
      content: response.message.content,
      toolCalls: response.message.toolCalls,
      providerMessageId: response.providerMessageId,
    });

    const hasToolCalls = message.toolCalls.length > 0;
    if (hasToolCalls) {
      let stopTurn = false;
      for await (const toolResult of this.toolExecutor.execute(response.message.toolCalls, {
        signal,
        turnId,
      })) {
        const { result } = toolResult;
        this.append({
          ...createToolMessage(toolResult.toolCallId, toolResultOutputForModel(result)),
          role: 'tool',
          isError: result.isError,
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
    this.emitStepCompleted(turnId, currentStep, stepUuid, usage, finishReason, response);

    const afterStepContext: TurnAfterStepContext = {
      turnId,
      step: currentStep,
      signal,
      usage,
      stopReason: finishReason,
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

  private append(message: ContextMessage): void {
    this.context.append(message);
  }

  private emitStepCompleted(
    turnId: number,
    step: number,
    stepId: string,
    usage: TokenUsage,
    finishReason: string,
    response: LLMRequestFinish,
  ): void {
    const providerFinishReason =
      response.providerFinishReason !== undefined &&
        response.providerFinishReason !== finishReason
        ? response.providerFinishReason
        : undefined;
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
      providerFinishReason,
      rawFinishReason: providerFinishReason !== undefined ? response.rawFinishReason : undefined,
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  InstantiationType.Delayed,
  'loop',
);
