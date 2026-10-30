import { AsyncEventQueue } from '#/_base/asyncEventQueue';
import type { LlmRequest, LlmRequestModel, LlmProtocolBinding, LlmEndpoint, LlmSampling } from '#human/llm/request';
import { contentsOf, type LlmRequester } from '#human/llm/requester';
import type { LlmOutcome, LlmRunEvent } from '#human/llm/response';
import type { LlmRecovery, LlmRecoveryLedger } from '#human/llm/policy/recovery';
import type { LlmResolver } from '#human/llm/policy/resolver';
import type { FinishReason } from '#human/llm-requester/finish-reason';
import type { ResponseFormat } from '#human/llm-requester/response-format';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
import type { TokenUsage } from '#human/llm-requester/usage';
import type {
  AssistantMessage,
  Message,
  StreamedMessagePart,
  ToolDescription as Tool,
} from '#human/llm/message';
import {
  errorDiagnostics,
  errorFromLlmMessage,
  isAbortError,
  llmMessageFromError,
  withErrorDiagnostics,
} from '../contract/errors';
import { translateProviderError } from '../protocol/errors';

export type SamplingOptions = LlmSampling;

export interface ModelRequestInput {
  readonly systemPrompt: string;
  readonly tools?: readonly Tool[];
  readonly messages: readonly Message[];
  readonly responseFormat?: ResponseFormat;
}

export interface ModelRequestTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  readonly requestBuildMs?: number;
  readonly serverFirstTokenMs?: number;
  readonly serverDecodeMs?: number;
  readonly clientConsumeMs?: number;
  readonly clientBlockedMs?: number;
}

export type ModelRequestEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | {
      readonly type: 'finish';
      readonly message: AssistantMessage;
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
      readonly id?: string;
      readonly requestId?: string;
    }
  | ({ readonly type: 'timing' } & ModelRequestTiming);

export interface ModelRequestParams {
  readonly cacheKey?: string;
  readonly sampling?: SamplingOptions;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
  readonly usedContextTokens?: number;
  readonly maxContextTokens?: number;
  readonly stream?: boolean;
  readonly onRequestId?: (requestId: string | undefined) => void;
}

export interface ModelRequestPolicy {
  readonly recoveries: readonly LlmRecovery[];
  readonly resolvers?: readonly LlmResolver[];
  readonly recoveryLedger?: LlmRecoveryLedger;
  readonly onAttempt?: (input: ModelRequestInput, request: LlmRequest) => void;
  readonly onRecovery?: (
    event: Extract<LlmRunEvent, { readonly reason: 'recovery' }>,
  ) => void;
}

export interface LlmRequestInitialization {
  readonly protocol: LlmProtocolBinding;
  readonly endpoint?: LlmEndpoint;
  readonly model: LlmRequestModel;
}

export type InitializedLlmRequester = LlmRequester<'protocol' | 'model' | 'endpoint'>;

export function effectiveMaxCompletionTokens(params?: ModelRequestParams): number | undefined {
  return params?.maxCompletionTokens;
}

export function generateModel(
  initial: InitializedLlmRequester,
  input: ModelRequestInput,
  signal: AbortSignal | undefined,
  params?: ModelRequestParams,
  policy?: ModelRequestPolicy,
): AsyncIterable<ModelRequestEvent> {
  const events = new AsyncEventQueue<ModelRequestEvent>();
  void runModel(initial, input, signal, params, policy, events).then(
    () => events.end(),
    (error) => events.fail(error),
  );
  return events;
}

interface ModelEventSink {
  push(event: ModelRequestEvent): void;
}

async function runModel(
  initial: InitializedLlmRequester,
  input: ModelRequestInput,
  signal: AbortSignal | undefined,
  params: ModelRequestParams | undefined,
  policy: ModelRequestPolicy | undefined,
  events: ModelEventSink,
): Promise<void> {
  try {
    const requester = initial.with({
      model: { responseFormat: input.responseFormat },
      profile: {
        systemPrompt: input.systemPrompt,
        tools: input.tools,
      },
      content: { messages: input.messages, usedTokens: params?.usedContextTokens },
      policy: {
        retry: { maxAttemptsPerStep: 1 },
        recoveries: policy?.recoveries ?? [],
        resolvers: policy?.resolvers ?? [],
      },
    });
    const outcome = await requester.generate(
      {},
      {
        signal: signal ?? new AbortController().signal,
        recoveries: policy?.recoveryLedger,
        onAttempt: (request) =>
          policy?.onAttempt?.(
            {
              ...input,
              systemPrompt: request.profile?.systemPrompt ?? input.systemPrompt,
              tools: request.profile?.tools ?? input.tools,
              messages: request.content.messages,
            },
            request,
          ),
        onEvent: (event) => {
          switch (event.type) {
            case 'llm.streaming.headers': {
              params?.onRequestId?.(contentsOf(initial).protocol!.base!.requestId?.(event.headers));
              return;
            }
            case 'llm.streaming.part': {
              events.push({ type: 'part', part: event.part });
              return;
            }
            case 'llm.retrying': {
              if (event.reason === 'recovery') policy?.onRecovery?.(event);
              return;
            }
            default:
              return;
          }
        },
      },
    );
    if (outcome.type === 'aborted') {
      throw errorFromLlmMessage({ kind: 'abort', message: 'The operation was aborted.' });
    }
    if (outcome.type === 'failed') {
      const classified =
        outcome.error.kind === 'unknown' && outcome.rawError !== undefined
          ? llmMessageFromError(outcome.rawError)
          : undefined;
      if (
        outcome.error.kind === 'unknown' &&
        classified === undefined &&
        outcome.rawError instanceof Error
      ) {
        throw withErrorDiagnostics(translateProviderError(outcome.rawError), outcome.diagnostics);
      }
      const error = classified ?? outcome.error;
      throw errorFromLlmMessage(
        error.kind === 'auth' ? { ...error, kind: 'status' as const } : error,
        outcome.diagnostics,
      );
    }
    pushDone(outcome, events, contentsOf(initial).model?.spec?.name);
  } catch (error) {
    if (isAbortError(error)) throw error;
    const diagnostics = errorDiagnostics(error);
    const message = llmMessageFromError(error);
    if (message !== undefined) throw errorFromLlmMessage(message, diagnostics);
    throw withErrorDiagnostics(translateProviderError(error), diagnostics);
  }
}

function pushDone(
  outcome: Extract<LlmOutcome, { readonly type: 'done' }>,
  events: ModelEventSink,
  model: string | undefined,
): void {
  if (outcome.usage !== undefined) events.push({ type: 'usage', usage: outcome.usage, model });
  events.push({
    type: 'finish',
    message: outcome.message,
    providerFinishReason: outcome.finish?.finishReason ?? undefined,
    rawFinishReason: outcome.finish?.rawFinishReason ?? undefined,
    id: outcome.messageId,
    requestId: outcome.requestId,
  });
  if (outcome.timing !== undefined) events.push({ type: 'timing', ...outcome.timing });
}
