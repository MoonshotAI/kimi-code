/**
 * Executes one provider step.
 *
 * A step owns the provider call, atomic transcript envelope, streaming callback
 * wiring, tool-call lifecycle, and post-step hooks. Provider usage is recorded
 * immediately after `llm.chat` returns so a later abort during tool execution
 * does not lose model usage that was already spent.
 */

import { randomUUID } from 'node:crypto';

import { isRecoverableRequestStructureError, type TokenUsage } from '@moonshot-ai/kosong';
import type { Logger } from '#/logging/types';

import type { LoopEventDispatcher } from './events';
import { errorMessage } from './errors';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';
import { chatWithRetry } from './retry';
import { runToolCallBatch, type ToolCallStepContext } from './tool-call';
import type {
  ExecutableTool,
  LoopHooks,
  LoopMessageBuilder,
  LoopStepStopReason,
  RecordStepUsageResult,
} from './types';

type ChatStreamingCallbacks = Pick<
  LLMChatParams,
  'onTextDelta' | 'onThinkDelta' | 'onToolCallDelta' | 'onTextPart' | 'onThinkPart'
>;

export interface ExecuteLoopStepDeps {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly buildMessages: LoopMessageBuilder;
  readonly buildMessagesStrict?: LoopMessageBuilder | undefined;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly llm: LLM;
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly currentStep: number;
  readonly maxRetryAttempts?: number;
  readonly recordUsage: (usage: TokenUsage) => RecordStepUsageResult | void | Promise<RecordStepUsageResult | void>;
}

export async function executeLoopStep(deps: ExecuteLoopStepDeps): Promise<{
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
}> {
  const {
    turnId,
    signal,
    buildMessages,
    buildMessagesStrict,
    dispatchEvent,
    llm,
    tools,
    hooks,
    log,
    currentStep,
    maxRetryAttempts,
    recordUsage,
  } = deps;

  if (hooks?.beforeStep !== undefined) {
    const beforeStep = await hooks.beforeStep({
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
    if (beforeStep?.block === true) {
      throw new Error(beforeStep.reason ?? `Step ${String(currentStep)} was blocked`);
    }
  }

  signal.throwIfAborted();

  const messages = await buildMessages();
  signal.throwIfAborted();

  const stepUuid = randomUUID();

  const step: ToolCallStepContext = {
    tools,
    hooks,
    log,
    dispatchEvent,
    llm,
    signal,
    turnId,
    currentStep,
    stepUuid,
  };

  await dispatchEvent({
    type: 'step.begin',
    uuid: stepUuid,
    turnId,
    step: currentStep,
  });

  const chatParams: LLMChatParams = {
    messages,
    tools: tools ?? [],
    signal,
    ...createChatStreamingCallbacks({
      dispatchEvent,
      turnId,
      currentStep,
      stepUuid,
    }),
  };
  const retryInput = {
    llm,
    dispatchEvent,
    turnId,
    currentStep,
    stepUuid,
    maxAttempts: maxRetryAttempts,
    log,
  } as const;
  let response: LLMChatResponse;
  try {
    response = await chatWithRetry({ ...retryInput, params: chatParams });
  } catch (error) {
    // A structural request rejection (tool_use/tool_result pairing, empty or
    // whitespace-only text, non-user first message, non-alternating roles) means
    // the projected history is not wire-compliant for a strict provider — and
    // since the same history is re-sent every turn, the session would stay stuck
    // on this error forever. Resend ONCE with a strict, guaranteed-compliant
    // rebuild (every open call closed, stray results dropped, leading non-user
    // trimmed, consecutive assistants merged) as a last resort. Any other error,
    // or a host that supplied no strict builder, propagates unchanged.
    if (buildMessagesStrict === undefined || !isRecoverableRequestStructureError(error)) throw error;
    signal.throwIfAborted();
    log?.warn('provider rejected request structure; resending with strict projection', {
      turnStep: `${turnId}.${String(currentStep)}`,
      model: llm.modelName,
    });
    const strictMessages = await buildMessagesStrict();
    signal.throwIfAborted();
    try {
      response = await chatWithRetry({
        ...retryInput,
        params: { ...chatParams, messages: strictMessages },
      });
    } catch (strictError) {
      // The strictly-sanitized rebuild was still rejected — our wire-compliance
      // repair did not cover this case. Surface it loudly: the session is stuck
      // and this is the signal we need to diagnose the gap.
      log?.error('strict resend still rejected by provider; request remains wire-invalid', {
        turnStep: `${turnId}.${String(currentStep)}`,
        model: llm.modelName,
        originalError: errorMessage(error),
        strictError: errorMessage(strictError),
      });
      throw strictError;
    }
    log?.info('recovered after strict resend', {
      turnStep: `${turnId}.${String(currentStep)}`,
    });
  }
  const usage = response.usage;
  const usageResult = await recordUsage(usage);
  const stopTurnAfterUsage = usageResult?.stopTurn === true;
  const stopReason = deriveStepStopReason(response);

  // Execute tools only when the normalized response shape represents a tool
  // step. Provider terminal diagnostics such as filtering or truncation must
  // not trigger side-effecting tool execution even if a malformed response also
  // contains tool calls.
  let effectiveStopReason: LoopStepStopReason =
    stopTurnAfterUsage && stopReason === 'tool_use' ? 'end_turn' : stopReason;
  if (effectiveStopReason === 'tool_use') {
    const toolBatch = await runToolCallBatch(step, response);
    if (toolBatch.stopTurn) effectiveStopReason = 'end_turn';
  }

  // When a tool batch runs, it drains paired `tool.result` events even when
  // cancellation is requested. Check the signal here before sealing the step.
  signal.throwIfAborted();

  await dispatchEvent({
    type: 'step.end',
    uuid: stepUuid,
    turnId,
    step: currentStep,
    usage,
    finishReason: effectiveStopReason,
    llmFirstTokenLatencyMs: response.streamTiming?.firstTokenLatencyMs,
    llmStreamDurationMs: response.streamTiming?.streamDurationMs,
    llmRequestBuildMs: response.streamTiming?.requestBuildMs,
    llmServerFirstTokenMs: response.streamTiming?.serverFirstTokenMs,
    llmServerDecodeMs: response.streamTiming?.serverDecodeMs,
    llmClientConsumeMs: response.streamTiming?.clientConsumeMs,
    ...stepEndProviderDiagnostics(response, effectiveStopReason),
  });

  logStepTiming(log, turnId, currentStep, response);

  let stopTurnAfterStep = stopTurnAfterUsage;
  if (hooks?.afterStep !== undefined) {
    try {
      const afterStep = await hooks.afterStep({
        turnId,
        stepNumber: currentStep,
        usage,
        stopReason: effectiveStopReason,
        signal,
        llm,
      });
      stopTurnAfterStep = stopTurnAfterStep || afterStep?.stopTurn === true;
    } catch {
      // The step is already sealed; observer hooks cannot change the result.
    }
  }

  return {
    usage,
    stopReason:
      stopTurnAfterStep && effectiveStopReason === 'tool_use' ? 'end_turn' : effectiveStopReason,
  };
}

/**
 * Emit a per-step completion log with the LLM response timing. TTFT is split
 * into the client-side request-build portion and the network + API-server
 * portion, and the decode window is split into server (awaiting parts) vs.
 * client (processing parts) time, so slow turns can be attributed without
 * parsing the wire log.
 */
function logStepTiming(
  log: Logger | undefined,
  turnId: string,
  step: number,
  response: LLMChatResponse,
): void {
  if (log === undefined) return;
  const timing = response.streamTiming;
  if (timing === undefined) return;
  log.info('llm response', {
    turnStep: `${turnId}/${String(step)}`,
    ttftMs: timing.firstTokenLatencyMs,
    ...(timing.requestBuildMs !== undefined ? { requestBuildMs: timing.requestBuildMs } : {}),
    ...(timing.serverFirstTokenMs !== undefined
      ? { serverFirstTokenMs: timing.serverFirstTokenMs }
      : {}),
    streamDurationMs: timing.streamDurationMs,
    ...(timing.serverDecodeMs !== undefined ? { serverDecodeMs: timing.serverDecodeMs } : {}),
    ...(timing.clientConsumeMs !== undefined ? { clientConsumeMs: timing.clientConsumeMs } : {}),
    outputTokens: response.usage.output,
  });
}

function deriveStepStopReason(response: LLMChatResponse): LoopStepStopReason {
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
      return response.toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    case 'tool_calls':
      return response.toolCalls.length > 0 ? 'tool_use' : 'unknown';
    default: {
      const _exhaustive: never = response.providerFinishReason;
      return _exhaustive;
    }
  }
}

function stepEndProviderDiagnostics(
  response: LLMChatResponse,
  stopReason: LoopStepStopReason,
): Pick<LLMChatResponse, 'providerFinishReason' | 'rawFinishReason'> {
  const providerFinishReason = response.providerFinishReason;
  if (
    (providerFinishReason === 'completed' && stopReason === 'end_turn') ||
    (providerFinishReason === 'tool_calls' && stopReason === 'tool_use')
  ) {
    return {};
  }

  return {
    ...(providerFinishReason !== undefined ? { providerFinishReason } : {}),
    ...(response.rawFinishReason !== undefined
      ? { rawFinishReason: response.rawFinishReason }
      : {}),
  };
}

function createChatStreamingCallbacks(deps: {
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
}): ChatStreamingCallbacks {
  const { dispatchEvent, turnId, currentStep, stepUuid } = deps;

  return {
    onTextDelta: (delta) => {
      dispatchEvent({ type: 'text.delta', delta });
    },
    onThinkDelta: (delta) => {
      dispatchEvent({ type: 'thinking.delta', delta });
    },
    onToolCallDelta: (delta) => {
      dispatchEvent({
        type: 'tool.call.delta',
        toolCallId: delta.toolCallId,
        name: delta.name,
        argumentsPart: delta.argumentsPart,
      });
    },
    onTextPart: async (part) => {
      await dispatchEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        part,
      });
    },
    onThinkPart: async (part) => {
      await dispatchEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        part,
      });
    },
  };
}
