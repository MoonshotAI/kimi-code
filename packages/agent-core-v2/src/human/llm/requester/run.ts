import { runLlmRequest } from '#/llm/policy/policy';
import { resolveModelConnection, type ProviderConnection } from '#/llm/protocol/connection';
import type { Protocol } from '#/llm/protocol/protocol';
import type { LlmRequest } from '#/llm/request';
import type { LlmRunEvent } from '#/llm/response';
import type { LlmErrorMessage } from '#/llm/errors';
import { thinkingMetadataOf } from '#/llm/thinking';

import {
  mergeRequestHeaders,
  type LlmClientContext,
  type LlmErrorClassifier,
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestControl,
  type LlmRequestEvent,
  type LlmRequester,
} from './requester';
import { createLlmHeadersTimeoutFetch } from './timeout';

export interface RunRequesterOptions<TOptions> {
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => unknown;
  readonly options?: (config: LlmRequestConfig) => TOptions | undefined;
}

function translateEvent(
  event: LlmRunEvent,
  onEvent: (event: LlmRequestEvent) => void,
): void {
  switch (event.type) {
    case 'llm.sent':
    case 'llm.streaming.headers':
    case 'llm.streaming.part':
    case 'llm.streaming.usage':
    case 'llm.streaming.finish':
    case 'llm.streaming.message_id':
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

export function createRunRequester<TOptions>(
  protocol: Protocol<TOptions>,
  options?: RunRequesterOptions<TOptions>,
): LlmRequester {
  const classifyError = options?.classifyError;
  const base: Protocol<TOptions> =
    classifyError === undefined
      ? protocol
      : {
          ...protocol,
          decodeError: (error: unknown) => classifyError(error) ?? protocol.decodeError(error),
        };
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const { signal, onEvent } = control;
      const model = resolveModelConnection(config.model, options?.connection);
      let fetchFn: typeof fetch;
      try {
        fetchFn = createLlmHeadersTimeoutFetch();
      } catch (error) {
        onEvent?.({ type: 'llm.failed.remote', error: base.decodeError(error), rawError: error });
        return;
      }
      const request: LlmRequest = {
        protocol: {
          base,
          options: options?.options?.(config),
          stream: config.stream ?? true,
        },
        endpoint: {
          baseUrl: model.baseUrl,
          headers: mergeRequestHeaders(
            options?.connection?.defaultHeaders?.({ model }),
            model.defaultHeaders,
          ),
          credentials: {
            resolve: () =>
              model.apiKey === undefined ? undefined : { apiKey: model.apiKey },
          },
          fetch: fetchFn,
          clientFactory:
            options?.clientFactory === undefined
              ? undefined
              : (endpoint) => options.clientFactory?.({ model, headers: endpoint.headers }),
        },
        model: {
          spec: {
            provider: model.provider,
            name: model.model,
            capability: model.capability,
            thinking: thinkingMetadataOf(model),
            maxContextSize: config.maxContextTokens ?? model.maxContextSize,
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
        content: { messages: content.messages, usedTokens: content.usedContextTokens },
        policy: { retry: { maxAttemptsPerStep: 1 }, recoveries: [] },
      };
      const outcome = await runLlmRequest(request, {
        signal,
        onEvent: onEvent === undefined ? undefined : (event) => translateEvent(event, onEvent),
      });
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
      onEvent({ type: 'llm.failed.remote', error: outcome.error, rawError: outcome.rawError });
    },
  };
}
