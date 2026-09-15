import OpenAI from 'openai';
import { assign, shake } from 'radashi';

import { headersToRecord } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
import { toLlmSyntaxErrorMessage } from '#/llm/syntax-errors';
import type { ProtocolBase, ProtocolRequesterOptions, TraitContext } from '#/llm/protocol/base';
import { resolveModelConnection } from '#/llm/protocol/connection';
import { applyThinking } from '#/llm/protocol/thinking';
import { resolveMaxCompletionCap, type FormatRequestInput } from '#/llm/protocol/format';
import { encodeReasoningEffortFallback } from '#/llm/thinking';
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
import type { OpenAIResponsesRawChunk } from './contract';
import type { OpenAIResponsesTrait } from './trait';
import {
  applyOpenAIResponsesResponseFormat,
  assembleOpenAIResponsesRequest,
  createOpenAIResponsesFormat,
  defaultOpenAIResponsesTool,
  encodeOpenAIResponsesCacheKey,
  encodeOpenAIResponsesMaxCompletionTokens,
  encodeOpenAIResponsesRequest,
  lowerOpenAIResponsesRequest,
  normalizeOpenAIResponsesReasoning,
  parseOpenAIResponsesUsage,
  type OpenAIResponsesRequestParams,
} from './format';

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

export interface OpenAIResponsesRequesterOptions
  extends ProtocolRequesterOptions<OpenAIResponsesTrait>,
    LlmRequesterOptions<OpenAI> {}

export interface OpenAIResponsesRequestPlanOptions {
  readonly trait?: OpenAIResponsesTrait;
}

export function planOpenAIResponsesRequest(
  input: FormatRequestInput,
  options?: OpenAIResponsesRequestPlanOptions,
): OpenAIResponsesRequestParams {
  const trait = options?.trait;
  const ctx: TraitContext = { model: input.model };
  let kwargs: Record<string, unknown> = {};
  if (input.cacheKey !== undefined) {
    kwargs =
      trait?.cacheKey?.(input.cacheKey, ctx) ?? encodeOpenAIResponsesCacheKey(input.cacheKey);
  }
  if (input.thinking !== undefined) {
    kwargs = applyThinking(kwargs, input.thinking, trait?.thinking, ctx, (t) =>
      encodeReasoningEffortFallback(t, ctx.model, trait?.strictThinkingValidation === true),
    ).kwargs;
  }
  const cap = resolveMaxCompletionCap(input);
  if (cap !== undefined) {
    kwargs = {
      ...kwargs,
      ...(trait?.maxCompletionTokens?.(cap, ctx) ?? encodeOpenAIResponsesMaxCompletionTokens(cap)),
    };
  }
  if (input.responseFormat !== undefined) {
    kwargs = applyOpenAIResponsesResponseFormat(kwargs, input.responseFormat);
  }
  kwargs = normalizeOpenAIResponsesReasoning(kwargs);
  kwargs = shake(assign(kwargs, input.extraParams?.responses ?? {}));

  const lowered = lowerOpenAIResponsesRequest(input, {
    extractText:
      (input.toolMessageConversion ?? trait?.toolMessageConversion) === 'extract_text',
  });
  const merged = trait?.mergeHistory?.(lowered, ctx) ?? lowered;
  const tools = input.tools.map(
    (tool) => trait?.convertTool?.(tool, ctx) ?? defaultOpenAIResponsesTool(tool),
  );
  const params = assembleOpenAIResponsesRequest(input, { input: merged, tools, kwargs });
  const finalParams = trait?.buildParams?.(params, ctx) ?? params;
  return encodeOpenAIResponsesRequest(finalParams);
}

interface OpenAIResponsesTransport {
  readonly connection: OpenAIResponsesRequesterOptions['connection'];
  readonly trait: OpenAIResponsesTrait | undefined;
  readonly ctx: TraitContext;
  readonly format: ReturnType<typeof createOpenAIResponsesFormat>;
  readonly resolveClient: (request: LlmClientContext) => OpenAI;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmRequestEvent) => void;
}

async function internalGenerate(
  request: OpenAIResponsesRequestParams,
  transport: OpenAIResponsesTransport,
): Promise<void> {
  const { connection, trait, ctx, format, resolveClient, signal, onEvent } = transport;
  const client = resolveClient({
    model: ctx.model,
    headers: mergeRequestHeaders(
      mergeRequestHeaders(connection?.defaultHeaders?.(ctx), ctx.model.defaultHeaders),
      request.headers,
    ),
  });
  onEvent?.({ type: 'llm.sent' });
  const { data: stream, response } = await client.responses
    .create(request.params, { signal })
    .withResponse();
  onEvent?.({ type: 'llm.streaming.headers', headers: headersToRecord(response.headers) ?? {} });
  const parse = format.createStreamParser({
    resolveUsage:
      trait?.extractUsage === undefined
        ? undefined
        : (chunk, defaultUsage) => {
            const hooked = trait.extractUsage?.(chunk as OpenAIResponsesRawChunk);
            return hooked !== undefined ? parseOpenAIResponsesUsage(hooked) : defaultUsage;
          },
  });
  let messageId: string | undefined;
  for await (const chunk of stream) {
    let failed = false;
    parse(chunk, {
      onDelta: (part) => onEvent?.({ type: 'llm.streaming.part', part }),
      onFinish: (finish) => onEvent?.({ type: 'llm.streaming.finish', finish }),
      onMessageId: (id) => {
        if (id === messageId) return;
        messageId = id;
        onEvent?.({ type: 'llm.streaming.message_id', messageId: id });
      },
      onUsage: (usage) => onEvent?.({ type: 'llm.streaming.usage', usage }),
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
  options?: OpenAIResponsesRequesterOptions,
): LlmRequester {
  const connection = options?.connection;
  const trait = options?.trait;
  const convertError = options?.convertError;
  const format = createOpenAIResponsesFormat();
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers));
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const model = resolveModelConnection(config.model, connection);
      const { tools = [] } = config;
      const { messages } = content;
      const { signal, onEvent } = control;
      const ctx: TraitContext = { model };
      let request: OpenAIResponsesRequestParams;
      try {
        const policy = trait?.toolCallIdPolicy ?? OPENAI_RESPONSES_TOOL_CALL_ID_POLICY;
        request = planOpenAIResponsesRequest(
          {
            ...config,
            model,
            messages: normalizeToolCallIdsForProvider(messages, policy),
            tools,
            usedContextTokens: content.usedContextTokens,
          },
          { trait },
        );
      } catch (error) {
        onEvent?.({ type: 'llm.failed.syntax', error: toLlmSyntaxErrorMessage(error) });
        return;
      }
      try {
        await internalGenerate(request, {
          connection,
          trait,
          ctx,
          format,
          resolveClient,
          signal,
          onEvent,
        });
      } catch (error) {
        onEvent?.({
          type: 'llm.failed.remote',
          error: convertOpenAIError(error, (e) => convertError?.(e)),
        });
      }
    },
  };
}

export const openAIResponsesBase: ProtocolBase<OpenAIResponsesTrait> = {
  capability: getOpenAIResponsesModelCapability,
  createRequester: createOpenAIResponsesRequester,
};
