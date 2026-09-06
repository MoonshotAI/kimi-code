import type {
  AgentLLMRequestFinish,
  AgentLLMRequestSource,
  IAgentLLMRequesterService,
} from '#/agent/llmRequester/llmRequester';
import { ToolCallIdResponseNormalizer } from '#/agent/llmRequester/toolCallIdNormalizer';
import { unwrapErrorCause } from '#/errors';
import { llmMessageFromError } from '#/llm-adapter/contract/errors';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import { toLlmErrorMessage, type LlmRemoteErrorMessage } from '#human/llm/errors';
import type {
  LlmRequestConfig,
  LlmRequestContent,
  LlmRequestControl,
  LlmRequester,
} from '#human/llm/requester/requester';

export type MachineRequesterGateDecision =
  | { readonly type: 'proceed'; readonly signal?: AbortSignal; readonly step?: number }
  | { readonly type: 'fail' };

export interface MachineRequesterOptions {
  readonly source?: () => AgentLLMRequestSource | undefined;
  readonly gate?: (signal: AbortSignal) => Promise<MachineRequesterGateDecision>;
  readonly onTrace?: (trace: LLMRequestTrace) => void;
}

export interface MachineRequester {
  readonly requester: LlmRequester;
  lastFinish(): AgentLLMRequestFinish | undefined;
  lastError(): unknown;
}

const GATE_FAILURE: LlmRemoteErrorMessage = {
  kind: 'abort',
  message: 'The agent loop gate stopped the step.',
};

function toRemoteErrorMessage(error: unknown, signal: AbortSignal): LlmRemoteErrorMessage {
  const raw = unwrapErrorCause(error);
  const known =
    llmMessageFromError(raw) ?? (raw === error ? undefined : llmMessageFromError(error));
  if (known !== undefined) return known;
  if (signal.aborted) {
    return { kind: 'abort', message: 'The operation was aborted.' };
  }
  return toLlmErrorMessage(raw);
}

export function createMachineRequester(
  service: IAgentLLMRequesterService,
  options?: MachineRequesterOptions,
): MachineRequester {
  let lastFinish: AgentLLMRequestFinish | undefined;
  let lastError: unknown;
  const generate = async (
    _config: LlmRequestConfig,
    _content: LlmRequestContent,
    control: LlmRequestControl,
  ): Promise<void> => {
    const decision =
      options?.gate !== undefined
        ? await options.gate(control.signal)
        : ({ type: 'proceed' } as const);
    if (decision.type === 'fail') {
      control.onEvent?.({ type: 'llm.failed.remote', error: GATE_FAILURE });
      return;
    }
    if (control.signal.aborted) {
      control.onEvent?.({ type: 'llm.failed.remote', error: GATE_FAILURE });
      return;
    }
    const signal =
      decision.signal !== undefined
        ? AbortSignal.any([control.signal, decision.signal])
        : control.signal;
    lastError = undefined;
    control.onEvent?.({ type: 'llm.sent' });
    const baseSource = options?.source?.();
    const source: AgentLLMRequestSource | undefined =
      baseSource?.type === 'turn' && decision.step !== undefined
        ? { ...baseSource, step: decision.step }
        : baseSource;
    const toolCallIds = new ToolCallIdResponseNormalizer(new Set());
    const task = service.start(
      { source },
      (part) => {
        if (part.type !== 'function') {
          control.onEvent?.({ type: 'llm.delta', part });
          return;
        }
        const id = toolCallIds.remapStreamedId(part.id, part._streamIndex);
        control.onEvent?.({ type: 'llm.delta', part: id === part.id ? part : { ...part, id } });
      },
      signal,
    );
    options?.onTrace?.(task.trace);
    try {
      const finish = await task.result;
      lastFinish = finish;
      control.onEvent?.({ type: 'llm.usage', usage: finish.usage });
      control.onEvent?.({
        type: 'llm.finish',
        finish: {
          finishReason: finish.providerFinishReason ?? null,
          rawFinishReason: finish.rawFinishReason ?? null,
        },
      });
      if (finish.providerMessageId !== undefined) {
        control.onEvent?.({ type: 'llm.message-id', messageId: finish.providerMessageId });
      }
      control.onEvent?.({ type: 'llm.done' });
    } catch (error) {
      lastFinish = undefined;
      lastError = error;
      control.onEvent?.({
        type: 'llm.failed.remote',
        error: toRemoteErrorMessage(error, signal),
      });
    }
  };
  return {
    requester: { generate },
    lastFinish: () => lastFinish,
    lastError: () => lastError,
  };
}
