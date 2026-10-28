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
  errorFromLlmMessage,
  isAbortError,
  llmMessageFromError,
  traceIdFromHeadersRecord,
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
      readonly traceId?: string;
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
  readonly onTraceId?: (traceId: string | null) => void;
}

export interface ModelRequestPolicy {
  readonly recoveries: readonly LlmRecovery[];
  readonly resolvers?: readonly LlmResolver[];
  readonly recoveryLedger?: LlmRecoveryLedger;
  readonly resolveMessages?: (
    messages: readonly Message[],
    signal: AbortSignal,
  ) => Promise<readonly Message[]>;
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

export async function* generateModel(
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
  yield* events;
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
  let traceId: string | null | undefined;
  try {
    const resolveMessages = policy?.resolveMessages;
    const resolvers: LlmResolver[] = [...(policy?.resolvers ?? [])];
    if (resolveMessages !== undefined) {
      resolvers.push({
        id: 'model-media',
        resolve: async (request, control) => ({
          ...request,
          content: {
            ...request.content,
            messages: await resolveMessages(request.content.messages, control.signal),
          },
        }),
      });
    }
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
        resolvers,
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
              traceId = traceIdFromHeadersRecord(event.headers);
              params?.onTraceId?.(traceId);
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
      if (outcome.error.kind === 'unknown' && classified === undefined) {
        throw translateProviderError(outcome.rawError ?? outcome.error.message);
      }
      const error = classified ?? outcome.error;
      throw errorFromLlmMessage(error.kind === 'auth' ? { ...error, kind: 'status' as const } : error);
    }
    pushDone(outcome, events, traceId, contentsOf(initial).model?.spec?.name);
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = llmMessageFromError(error);
    if (message !== undefined) throw errorFromLlmMessage(message);
    throw translateProviderError(error);
  }
}

function pushDone(
  outcome: Extract<LlmOutcome, { readonly type: 'done' }>,
  events: ModelEventSink,
  traceId: string | null | undefined,
  model: string | undefined,
): void {
  if (outcome.usage !== undefined) events.push({ type: 'usage', usage: outcome.usage, model });
  const outcomeTraceId = traceId ?? traceIdFromHeadersRecord(outcome.headers ?? {});
  events.push({
    type: 'finish',
    message: outcome.message,
    providerFinishReason: outcome.finish?.finishReason ?? undefined,
    rawFinishReason: outcome.finish?.rawFinishReason ?? undefined,
    id: outcome.messageId,
    traceId: outcomeTraceId ?? undefined,
  });
  if (outcome.timing !== undefined) events.push({ type: 'timing', ...outcome.timing });
}
