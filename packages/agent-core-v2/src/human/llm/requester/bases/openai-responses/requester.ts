import OpenAI from 'openai';

import { headersToRecord } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
import { toLlmSyntaxErrorMessage } from '#/llm/syntax-errors';
import type { ProtocolBase, ProtocolWiring } from '#/llm/protocol/base';
import { resolveModelConnection } from '#/llm/protocol/connection';
import type { ProtocolHookContext } from '#/llm/protocol/context';
import {
  mergeRequestHeaders,
  type LlmClientContext,
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestControl,
  type LlmRequester,
  type LlmRequesterOptions,
  type LlmRequestEvent,
  type ToolCallIdPolicy,
} from '#/llm/requester/requester';

import {
  normalizeToolCallIdsForProvider,
  sanitizeOpenAIResponsesCallId,
} from '../tool-call-id';
import { convertOpenAIError } from '../openai/format';
import { getOpenAIResponsesModelCapability } from './capability';
import { openAIResponsesFormat, type OpenAIResponsesRequestParams } from './format';

const OPENAI_RESPONSES_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeOpenAIResponsesCallId(id, 64),
  maxLength: 64,
};

function createClient(model: LlmModel, headers: Record<string, string> | undefined): OpenAI {
  return new OpenAI({
    apiKey: model.apiKey ?? 'unused',
    baseURL: model.baseUrl,
    defaultHeaders: headers,
    maxRetries: 0,
  });
}

interface OpenAIResponsesTransport {
  readonly wiring: ProtocolWiring | undefined;
  readonly ctx: ProtocolHookContext;
  readonly resolveClient: (request: LlmClientContext) => OpenAI;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmRequestEvent) => void;
}

async function internalGenerate(
  request: OpenAIResponsesRequestParams,
  transport: OpenAIResponsesTransport,
): Promise<void> {
  const { wiring, ctx, resolveClient, signal, onEvent } = transport;
  const client = resolveClient({
    model: ctx.model,
    headers: mergeRequestHeaders(
      mergeRequestHeaders(wiring?.connection?.defaultHeaders?.(ctx), ctx.model.defaultHeaders),
      request.headers,
    ),
  });
  onEvent?.({ type: 'llm.sent' });
  const { data: stream, response } = await client.responses
    .create(request.params, { signal })
    .withResponse();
  onEvent?.({ type: 'llm.headers', headers: headersToRecord(response.headers) ?? {} });
  const parse = openAIResponsesFormat.createStreamParser({ dialect: wiring?.dialect, ctx });
  let messageId: string | undefined;
  for await (const chunk of stream) {
    let failed = false;
    parse(chunk, {
      onDelta: (part) => onEvent?.({ type: 'llm.delta', part }),
      onFinish: (finish) => onEvent?.({ type: 'llm.finish', finish }),
      onMessageId: (id) => {
        if (id === messageId) return;
        messageId = id;
        onEvent?.({ type: 'llm.message-id', messageId: id });
      },
      onUsage: (usage) => onEvent?.({ type: 'llm.usage', usage }),
      onError: (message) => {
        failed = true;
        onEvent?.({ type: 'llm.failed.remote', error: message });
      },
    });
    if (failed) {
      return;
    }
  }
  onEvent?.({ type: 'llm.done' });
}

export function createOpenAIResponsesRequester(
  wiring?: ProtocolWiring,
  options?: LlmRequesterOptions<OpenAI>,
): LlmRequester {
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers));
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const model = resolveModelConnection(config.model, wiring?.connection);
      const { systemPrompt, tools = [] } = config;
      const { messages } = content;
      const { signal, onEvent } = control;
      const ctx: ProtocolHookContext = { model };
      let request: OpenAIResponsesRequestParams;
      try {
        const policy = wiring?.dialect?.toolCallIdPolicy?.(ctx) ?? OPENAI_RESPONSES_TOOL_CALL_ID_POLICY;
        request = openAIResponsesFormat.formatRequest({
          model,
          messages: normalizeToolCallIdsForProvider(messages, policy),
          systemPrompt,
          tools,
          dialect: wiring?.dialect,
          policy: wiring?.policy,
          ctx,
          cacheKey: config.cacheKey,
          thinking: config.thinking,
          responseFormat: config.responseFormat,
          maxCompletionTokens: config.maxCompletionTokens,
          usedContextTokens: content.usedContextTokens,
          maxContextTokens: config.maxContextTokens,
          extraParams: config.extraParams,
          toolMessageConversion: config.toolMessageConversion,
        });
      } catch (error) {
        onEvent?.({ type: 'llm.failed.syntax', error: toLlmSyntaxErrorMessage(error) });
        return;
      }
      try {
        await internalGenerate(request, { wiring, ctx, resolveClient, signal, onEvent });
      } catch (error) {
        onEvent?.({
          type: 'llm.failed.remote',
          error: convertOpenAIError(error, (e) => wiring?.connection?.convertError?.(e, ctx)),
        });
      }
    },
  };
}

export const openAIResponsesBase: ProtocolBase = {
  capability: getOpenAIResponsesModelCapability,
  createRequester: createOpenAIResponsesRequester,
};
