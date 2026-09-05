import OpenAI from 'openai';

import { headersToRecord } from '#/llm/errors';
import { modelKey, type LlmModel } from '#/llm/model';
import { toLlmSyntaxErrorMessage } from '#/llm/syntax-errors';
import type { ProtocolBase } from '#/llm/protocol/base';
import { resolveModelConnection, type ProtocolTrait, type TraitContext } from '#/llm/protocol/trait';
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
  sanitizeToolCallId,
} from '../tool-call-id';
import { getOpenAILegacyModelCapability } from './capability';
import { convertOpenAIError, openAIFormat, type OpenAIRequestParams } from './format';
import { ReasoningKeyDialect } from './reasoning-key';

const OPENAI_CHAT_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
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

interface OpenAITransport {
  readonly trait: ProtocolTrait | undefined;
  readonly ctx: TraitContext;
  readonly dialect: ReasoningKeyDialect;
  readonly resolveClient: (request: LlmClientContext) => OpenAI;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmRequestEvent) => void;
}

async function internalGenerate(
  request: OpenAIRequestParams,
  transport: OpenAITransport,
): Promise<void> {
  const { trait, ctx, dialect, resolveClient, signal, onEvent } = transport;
  const client = resolveClient({
    model: ctx.model,
    headers: mergeRequestHeaders(
      mergeRequestHeaders(trait?.defaultHeaders?.(ctx), ctx.model.defaultHeaders),
      request.headers,
    ),
  });
  onEvent?.({ type: 'llm.sent' });
  const { data: stream, response } = await client.chat.completions
    .create(request.params, { signal })
    .withResponse();
  onEvent?.({ type: 'llm.headers', headers: headersToRecord(response.headers) ?? {} });
  const parse = openAIFormat.createStreamParser({ trait, ctx });
  let messageId: string | undefined;
  for await (const chunk of stream) {
    dialect.observe(chunk.choices?.[0]?.delta);
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

export function createOpenAIRequester(
  trait?: ProtocolTrait,
  options?: LlmRequesterOptions<OpenAI>,
): LlmRequester {
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers));
  const dialects = new Map<string, ReasoningKeyDialect>();
  const dialectFor = (ctx: TraitContext): ReasoningKeyDialect => {
    const key = modelKey(ctx.model);
    let dialect = dialects.get(key);
    if (dialect === undefined) {
      dialect = new ReasoningKeyDialect(trait?.reasoningKey?.(ctx));
      dialects.set(key, dialect);
    }
    return dialect;
  };
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const model = resolveModelConnection(config.model, trait);
      const { systemPrompt, tools = [] } = config;
      const { messages } = content;
      const { signal, onEvent } = control;
      const ctx: TraitContext = { model };
      let dialect: ReasoningKeyDialect;
      let request: OpenAIRequestParams;
      try {
        dialect = dialectFor(ctx);
        const policy = trait?.toolCallIdPolicy?.(ctx) ?? OPENAI_CHAT_TOOL_CALL_ID_POLICY;
        request = openAIFormat.formatRequest(
          {
            model,
            messages: normalizeToolCallIdsForProvider(messages, policy),
            systemPrompt,
            tools,
            trait,
            ctx,
            cacheKey: config.cacheKey,
            thinking: config.thinking,
            responseFormat: config.responseFormat,
            maxCompletionTokens: config.maxCompletionTokens,
            usedContextTokens: content.usedContextTokens,
            maxContextTokens: config.maxContextTokens,
            extraParams: config.extraParams,
            toolMessageConversion: config.toolMessageConversion,
          },
          { reasoningKey: dialect.outboundKey() },
        );
      } catch (error) {
        onEvent?.({ type: 'llm.failed.syntax', error: toLlmSyntaxErrorMessage(error) });
        return;
      }
      try {
        await internalGenerate(request, { trait, ctx, dialect, resolveClient, signal, onEvent });
      } catch (error) {
        onEvent?.({
          type: 'llm.failed.remote',
          error: convertOpenAIError(error, (e) => trait?.convertError?.(e, ctx)),
        });
      }
    },
  };
}

export const openAIBase: ProtocolBase = {
  capability: getOpenAILegacyModelCapability,
  createRequester: createOpenAIRequester,
};
