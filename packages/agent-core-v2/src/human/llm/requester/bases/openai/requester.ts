import OpenAI from 'openai';
import { assign, shake } from 'radashi';

import { headersToRecord } from '#/llm/errors';
import { modelKey, type LlmModel } from '#/llm/model';
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
  sanitizeToolCallId,
} from '../tool-call-id';
import { getOpenAILegacyModelCapability } from './capability';
import type { OpenAIWireMessage } from './contract';
import type { OpenAITrait } from './trait';
import {
  assembleOpenAIRequest,
  convertOpenAIError,
  createOpenAIFormat,
  defaultOpenAITool,
  encodeOpenAICacheKey,
  encodeOpenAIMaxCompletionTokens,
  encodeOpenAIRequest,
  encodeOpenAIThinkHistoryKwargs,
  lowerOpenAIRequest,
  parseOpenAIUsage,
  responseFormatToOpenAI,
  type OpenAIRequestParams,
} from './format';
import { DEFAULT_REASONING_KEY, ReasoningKeyDialect } from './reasoning-key';

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

export interface OpenAIRequesterOptions
  extends ProtocolRequesterOptions<OpenAITrait>,
    LlmRequesterOptions<OpenAI> {}

export interface OpenAIRequestPlanOptions {
  readonly trait?: OpenAITrait;
  readonly reasoningKey?: string;
}

export function planOpenAIRequest(
  input: FormatRequestInput,
  options?: OpenAIRequestPlanOptions,
): OpenAIRequestParams {
  const trait = options?.trait;
  const ctx: TraitContext = { model: input.model };
  let kwargs: Record<string, unknown> = {};
  if (input.cacheKey !== undefined) {
    kwargs = trait?.cacheKey?.(input.cacheKey, ctx) ?? encodeOpenAICacheKey(input.cacheKey);
  }
  let preserveThinking = false;
  if (input.thinking !== undefined) {
    const applied = applyThinking(kwargs, input.thinking, trait?.thinking, ctx, (t) =>
      encodeReasoningEffortFallback(t, ctx.model, trait?.strictThinkingValidation === true),
    );
    kwargs = applied.kwargs;
    preserveThinking = applied.preserveThinking;
  }
  if (
    trait?.thinking === undefined &&
    input.thinking?.effort !== 'off' &&
    kwargs['reasoning_effort'] === undefined &&
    input.messages.some((message) => message.content.some((part) => part.type === 'think'))
  ) {
    kwargs = { ...kwargs, ...encodeOpenAIThinkHistoryKwargs() };
  }
  if (input.responseFormat !== undefined) {
    kwargs = { ...kwargs, response_format: responseFormatToOpenAI(input.responseFormat) };
  }
  const cap = resolveMaxCompletionCap(input);
  if (cap !== undefined) {
    kwargs = {
      ...kwargs,
      ...(trait?.maxCompletionTokens?.(cap, ctx) ??
        encodeOpenAIMaxCompletionTokens(ctx.model.model, cap)),
    };
  }
  kwargs = shake(assign(kwargs, input.extraParams?.openai ?? {}));

  const lowered = lowerOpenAIRequest(input, {
    reasoningKey: options?.reasoningKey ?? DEFAULT_REASONING_KEY,
    preserveThinking,
    toolMessageConversion: input.toolMessageConversion ?? trait?.toolMessageConversion,
  });
  const converted = lowered.flatMap(({ source, message }) => {
    if (trait?.convertMessage === undefined) {
      return [message];
    }
    const hooked = trait.convertMessage(source, message, ctx);
    return hooked === null ? [] : [hooked];
  });
  const history: readonly OpenAIWireMessage[] = input.systemPrompt
    ? [{ role: 'system', content: input.systemPrompt }, ...converted]
    : converted;
  const merged = trait?.mergeHistory?.(history, ctx) ?? history;
  const tools = input.tools.map(
    (tool) => trait?.convertTool?.(tool, ctx) ?? defaultOpenAITool(tool),
  );
  const params = assembleOpenAIRequest(input, { messages: merged, tools, kwargs });
  const finalParams = trait?.buildParams?.(params, ctx) ?? params;
  return encodeOpenAIRequest(finalParams);
}

interface OpenAITransport {
  readonly connection: OpenAIRequesterOptions['connection'];
  readonly trait: OpenAITrait | undefined;
  readonly ctx: TraitContext;
  readonly format: ReturnType<typeof createOpenAIFormat>;
  readonly reasoning: ReasoningKeyDialect;
  readonly resolveClient: (request: LlmClientContext) => OpenAI;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmRequestEvent) => void;
}

async function internalGenerate(
  request: OpenAIRequestParams,
  transport: OpenAITransport,
): Promise<void> {
  const { connection, trait, ctx, format, reasoning, resolveClient, signal, onEvent } = transport;
  const client = resolveClient({
    model: ctx.model,
    headers: mergeRequestHeaders(
      mergeRequestHeaders(connection?.defaultHeaders?.(ctx), ctx.model.defaultHeaders),
      request.headers,
    ),
  });
  onEvent?.({ type: 'llm.sent' });
  const { data: stream, response } = await client.chat.completions
    .create(request.params, { signal })
    .withResponse();
  onEvent?.({ type: 'llm.streaming.headers', headers: headersToRecord(response.headers) ?? {} });
  const parse = format.createStreamParser({
    reasoningKey: trait?.reasoningKey,
    resolveUsage:
      trait?.extractUsage === undefined
        ? undefined
        : (chunk, defaultUsage) => {
            const hooked = trait.extractUsage?.(chunk);
            return hooked !== undefined ? parseOpenAIUsage(hooked) : defaultUsage;
          },
  });
  let messageId: string | undefined;
  for await (const chunk of stream) {
    reasoning.observe(chunk.choices?.[0]?.delta);
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

export function createOpenAIRequester(options?: OpenAIRequesterOptions): LlmRequester {
  const connection = options?.connection;
  const trait = options?.trait;
  const convertError = options?.convertError;
  const format = createOpenAIFormat();
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers));
  const reasoningByModel = new Map<string, ReasoningKeyDialect>();
  const reasoningFor = (ctx: TraitContext): ReasoningKeyDialect => {
    const key = modelKey(ctx.model);
    let reasoning = reasoningByModel.get(key);
    if (reasoning === undefined) {
      reasoning = new ReasoningKeyDialect(trait?.reasoningKey);
      reasoningByModel.set(key, reasoning);
    }
    return reasoning;
  };
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
      let reasoning: ReasoningKeyDialect;
      let request: OpenAIRequestParams;
      try {
        reasoning = reasoningFor(ctx);
        const policy = trait?.toolCallIdPolicy ?? OPENAI_CHAT_TOOL_CALL_ID_POLICY;
        request = planOpenAIRequest(
          {
            ...config,
            model,
            messages: normalizeToolCallIdsForProvider(messages, policy),
            tools,
            usedContextTokens: content.usedContextTokens,
          },
          { trait, reasoningKey: reasoning.outboundKey() },
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
          reasoning,
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

export const openAIBase: ProtocolBase<OpenAITrait> = {
  capability: getOpenAILegacyModelCapability,
  createRequester: createOpenAIRequester,
};
