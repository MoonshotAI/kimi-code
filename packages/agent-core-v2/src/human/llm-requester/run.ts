import { toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmEndpoint } from '#/llm/request';
import { contentsOf, type LlmRequester as CoreLlmRequester } from '#/llm/requester';
import type {
  LlmErrorMessage as CoreLlmErrorMessage,
  LlmRemoteErrorMessage as CoreLlmRemoteErrorMessage,
  LlmRunEvent,
} from '#/llm/response';
import { isUnknownCapability } from '#/llm-requester/capability';
import {
  resolveModelConnection,
  type DefaultHeadersResolver,
  type ProtocolEndpointSource,
} from '#/llm-requester/connection';
import type { LlmErrorMessage, LlmRemoteErrorMessage } from '#/llm-requester/errors';
import { thinkingMetadataOf } from '#/llm-requester/thinking';

import {
  mergeRequestHeaders,
  type LlmClientContext,
  type LlmErrorClassifier,
  type LlmRequestConfig,
  type LlmRequestEvent,
  type LlmRequester,
} from './requester';
import { createLlmHeadersTimeoutFetch } from './timeout';

export interface RunRequesterOptions<TOptions> {
  readonly endpoint?: ProtocolEndpointSource;
  readonly defaultHeaders?: DefaultHeadersResolver;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => unknown;
  readonly options?: (
    config: LlmRequestConfig,
    model: LlmRequestConfig['model'],
  ) => TOptions | undefined;
}

function toV2Error(error: CoreLlmErrorMessage): LlmErrorMessage {
  if (error.kind === 'auth') {
    return { ...error, kind: 'status' };
  }
  return error as LlmErrorMessage;
}

function toV2RemoteError(error: CoreLlmRemoteErrorMessage): LlmRemoteErrorMessage {
  return toV2Error(error) as LlmRemoteErrorMessage;
}

function translateEvent(
  event: LlmRunEvent,
  onEvent: (event: LlmRequestEvent) => void,
): void {
  switch (event.type) {
    case 'llm.sent':
    case 'llm.streaming.headers':
    case 'llm.streaming.usage':
    case 'llm.streaming.finish':
    case 'llm.streaming.message_id':
      onEvent(event);
      return;
    case 'llm.streaming.part':
      onEvent(event);
      return;
    default:
      return;
  }
}

function abortErrorOf(reason: unknown): LlmErrorMessage<'abort'> {
  if (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { kind?: unknown }).kind === 'abort' &&
    typeof (reason as { message?: unknown }).message === 'string'
  ) {
    return reason as LlmErrorMessage<'abort'>;
  }
  return { kind: 'abort', message: 'The operation was aborted.' };
}

function decodeRemoteError(
  base: CoreLlmRequester<'protocol'>,
  error: unknown,
  classifyError: LlmErrorClassifier | undefined,
): LlmRemoteErrorMessage {
  const classified = classifyError?.(error);
  if (classified !== undefined) return toV2RemoteError(classified);
  const protocol = contentsOf(base).protocol?.base;
  return toV2RemoteError(protocol?.decodeError(error) ?? toLlmErrorMessage(error));
}

export function createRunRequester<TOptions>(
  base: CoreLlmRequester<'protocol'>,
  options?: RunRequesterOptions<TOptions>,
): LlmRequester {
  return {
    async generate(config, content, control): Promise<void> {
      const { signal, onEvent } = control;
      const model = resolveModelConnection(config.model, options?.endpoint);
      const validContextSizes = [config.maxContextTokens, model.maxContextSize].filter(
        (size): size is number => size !== undefined && size > 0,
      );
      const maxContextSize =
        validContextSizes.length === 0 ? undefined : Math.min(...validContextSizes);
      let fetchFn: typeof fetch | undefined;
      if (
        options?.clientFactory === undefined &&
        contentsOf(base).protocol?.base?.usesEndpointFetch !== false
      ) {
        try {
          fetchFn = createLlmHeadersTimeoutFetch();
        } catch (error) {
          onEvent?.({
            type: 'llm.failed.remote',
            error: decodeRemoteError(base, error, options?.classifyError),
            rawError: error,
          });
          return;
        }
      }
      const endpoint: LlmEndpoint = {
        baseUrl: model.baseUrl,
        headers: mergeRequestHeaders(options?.defaultHeaders?.({ model }), model.defaultHeaders),
        credentials: {
          resolve: () => (model.apiKey === undefined ? undefined : { apiKey: model.apiKey }),
        },
        fetch: fetchFn,
        clientFactory:
          options?.clientFactory === undefined
            ? undefined
            : (resolved) => options.clientFactory?.({ model, headers: resolved.headers }),
      };
      const requester = base.with({
        protocol: {
          options: options?.options?.(config, model),
          stream: config.stream ?? true,
        },
        endpoint,
      });
      const outcome = await requester.generate(
        {
          model: {
            spec: {
              provider: model.provider,
              name: model.model,
              capability: isUnknownCapability(model.capability) ? undefined : model.capability,
              thinking: thinkingMetadataOf(model),
              maxContextSize,
              maxInputSize: model.maxInputSize,
            },
            thinking: config.thinking,
            maxOutputTokens:
              config.maxCompletionTokens === undefined
                ? undefined
                : config.maxCompletionTokens <= 0
                  ? 'none'
                  : config.maxCompletionTokens,
            responseFormat: config.responseFormat,
            cacheKey: config.cacheKey,
          },
          profile: { systemPrompt: config.systemPrompt, tools: config.tools },
          content: {
            messages: content.messages,
            usedTokens: content.usedContextTokens,
          },
          policy: { retry: { maxAttemptsPerStep: 1 }, recoveries: [] },
        },
        {
          signal,
          onEvent: onEvent === undefined ? undefined : (event) => translateEvent(event, onEvent),
        },
      );
      if (onEvent === undefined) return;
      if (outcome.type === 'done') {
        onEvent({ type: 'llm.done' });
        return;
      }
      if (outcome.type === 'aborted') {
        onEvent({ type: 'llm.failed.remote', error: abortErrorOf(outcome.reason) });
        return;
      }
      if (outcome.error.kind === 'syntax') {
        onEvent({ type: 'llm.failed.syntax', error: outcome.error });
        return;
      }
      const classified =
        outcome.rawError === undefined ? undefined : options?.classifyError?.(outcome.rawError);
      onEvent({
        type: 'llm.failed.remote',
        error: classified === undefined ? toV2RemoteError(outcome.error) : toV2RemoteError(classified),
        rawError: outcome.rawError,
      });
    },
  };
}
