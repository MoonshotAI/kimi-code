import type { ModelCapability } from '#/capability';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import OpenAI from 'openai';

import { getOpenAILegacyModelCapability } from './capability-registry';
import {
  convertContentPart,
  convertOpenAIError,
  convertToolMessageContent,
  extractUsage,
  isFunctionToolCall,
  normalizeOpenAIFinishReason,
  type OpenAIContentPart,
  type ToolMessageConversion,
  reasoningEffortToThinkingEffort,
  thinkingEffortToReasoningEffort,
  toolToOpenAI,
} from './openai-common';
import {
  convertChatCompletionStreamToolCall,
  type BufferedChatCompletionToolCall,
} from './chat-completions-stream';
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from './request-auth';
import {
  normalizeToolCallIdsForProvider,
  sanitizeToolCallId,
  type ToolCallIdPolicy,
} from './tool-call-id';

// Inbound: scan in priority order; first string value wins. Outbound: the first
// entry doubles as the default field we serialize ThinkPart back into. Both
// arms can be overridden by an explicit `reasoningKey` on the provider config.
const KNOWN_REASONING_KEYS = ['reasoning_content', 'reasoning_details', 'reasoning'] as const;
const DEFAULT_OUTBOUND_REASONING_KEY = KNOWN_REASONING_KEYS[0];
const OPENAI_CHAT_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

function extractReasoningContent(
  source: unknown,
  explicitKey: string | undefined,
): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  const keys: readonly string[] = explicitKey !== undefined ? [explicitKey] : KNOWN_REASONING_KEYS;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export interface OpenAILegacyOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  maxTokens?: number | undefined;
  reasoningKey?: string | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
}

export interface OpenAILegacyGenerationKwargs {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  [key: string]: unknown;
}
interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | undefined;
  tool_calls?: OpenAIToolCallOut[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  [key: string]: unknown;
}

interface OpenAIToolCallOut {
  type: string;
  id: string;
  function: { name: string; arguments: string | null };
}

function convertMessage(
  message: Message,
  reasoningKey: string | undefined,
  toolMessageConversion: ToolMessageConversion,
): OpenAIMessage {
  let reasoningContent = '';
  const nonThinkParts: ContentPart[] = [];

  for (const part of message.content) {
    if (part.type === 'think') {
      reasoningContent += part.think;
    } else {
      nonThinkParts.push(part);
    }
  }

  // Build the OpenAI message.
  const result: OpenAIMessage = { role: message.role };

  if (message.role === 'tool') {
    // OpenAI Chat Completions `tool` messages only accept text content.
    // Any non-text content parts (image_url, audio_url, video_url) would be
    // rejected by the API with a 400. Detect multimodal tool output and
    // force the `extract_text` path in that case, regardless of the caller's
    // `toolMessageConversion` setting. For pure-text tool results we honor
    // the configured strategy (or fall through to the default content-part
    // array when it is unset).
    const hasNonTextPart = message.content.some((p) => p.type !== 'text' && p.type !== 'think');
    const effectiveConversion: ToolMessageConversion = hasNonTextPart
      ? 'extract_text'
      : toolMessageConversion;

    if (effectiveConversion !== null) {
      result.content = convertToolMessageContent(message, effectiveConversion);
    } else {
      // Pure-text tool result with no conversion configured: serialize via the
      // generic content-part path so single-text messages become a plain string.
      const firstPart = nonThinkParts[0];
      if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
        result.content = firstPart.text;
      } else if (nonThinkParts.length > 0) {
        result.content = nonThinkParts
          .map((p) => convertContentPart(p))
          .filter((p): p is OpenAIContentPart => p !== null);
      }
    }
  } else {
    // content: serialize to string if single text, array otherwise
    const firstPart = nonThinkParts[0];
    if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
      result.content = firstPart.text;
    } else if (nonThinkParts.length > 0) {
      result.content = nonThinkParts
        .map((p) => convertContentPart(p))
        .filter((p): p is OpenAIContentPart => p !== null);
    }
  }

  if (message.name !== undefined) {
    result.name = message.name;
  }

  if (message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((tc) => ({
      type: tc.type,
      id: tc.id,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  if (message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId;
  }

  // Round-trip thinking content back to the server. Default to the de facto
  // `reasoning_content` field so OpenAI-compatible reasoners (DeepSeek, Qwen,
  // One API gateways) work without per-provider configuration. Servers that
  // don't understand the field ignore it; servers that require a specific
  // field can override via the explicit `reasoningKey`.
  if (reasoningContent) {
    result[reasoningKey ?? DEFAULT_OUTBOUND_REASONING_KEY] = reasoningContent;
  }

  return result;
}
export class OpenAILegacyStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    isStream: boolean,
    reasoningKey: string | undefined,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
        reasoningKey,
      );
    } else {
      this._iter = this._convertNonStreamResponse(
        response as OpenAI.Chat.ChatCompletion,
        reasoningKey,
      );
    }
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureFinishReason(raw: string | null | undefined): void {
    const normalized = normalizeOpenAIFinishReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private async *_convertNonStreamResponse(
    response: OpenAI.Chat.ChatCompletion,
    reasoningKey: string | undefined,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    if (response.usage) {
      this._usage = extractUsage(response.usage) ?? null;
    }
    this._captureFinishReason(response.choices[0]?.finish_reason ?? null);

    const message = response.choices[0]?.message;
    if (!message) return;

    // Reasoning content: honor the explicit key when set, otherwise scan the
    // de facto field set so hand-written configs work without it.
    const reasoning = extractReasoningContent(message, reasoningKey);
    if (reasoning) {
      yield { type: 'think', think: reasoning } satisfies StreamedMessagePart;
    }

    if (message.content) {
      yield { type: 'text', text: message.content } satisfies StreamedMessagePart;
    }

    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (!isFunctionToolCall(toolCall)) continue;
        yield {
          type: 'function',
          id: toolCall.id || crypto.randomUUID(),
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        } satisfies ToolCall;
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    reasoningKey: string | undefined,
  ): AsyncGenerator<StreamedMessagePart> {
    const bufferedToolCalls = new Map<number | string, BufferedChatCompletionToolCall>();

    try {
      for await (const chunk of response) {
        if (chunk.id) {
          this._id = chunk.id;
        }

        if (chunk.usage) {
          this._usage = extractUsage(chunk.usage) ?? null;
        }

        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        // Capture finish_reason whenever the chunk carries one. Chat
        // Completions only sets it on the final chunk for a given choice.
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          this._captureFinishReason(choice.finish_reason);
        }

        const delta = choice.delta;

        // Reasoning content: honor the explicit key when set, otherwise scan
        // the de facto field set so hand-written configs work without it.
        const reasoning = extractReasoningContent(delta, reasoningKey);
        if (reasoning) {
          yield { type: 'think', think: reasoning } satisfies StreamedMessagePart;
        }

        // text content
        if (delta.content) {
          yield { type: 'text', text: delta.content } satisfies StreamedMessagePart;
        }

        // tool calls — preserve `index` on every yielded part so the generate
        // loop can route interleaved argument deltas from parallel tool calls.
        for (const toolCall of delta.tool_calls ?? []) {
          for (const part of convertChatCompletionStreamToolCall(toolCall, bufferedToolCalls)) {
            yield part;
          }
        }
      }
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }
}
export class OpenAILegacyChatProvider implements ChatProvider {
  readonly name: string = 'openai';

  private _model: string;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _defaultHeaders: Record<string, string> | undefined;
  private _reasoningKey: string | undefined;
  private _reasoningEffort: string | undefined;
  private _generationKwargs: OpenAILegacyGenerationKwargs;
  private _toolMessageConversion: ToolMessageConversion;
  private _client: OpenAI | undefined;
  private _httpClient: unknown;
  private _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;

  constructor(options: OpenAILegacyOptions) {
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this._defaultHeaders = options.defaultHeaders;
    this._model = options.model;
    this._stream = options.stream ?? true;
    // Normalize blank/whitespace reasoningKey to unset. ModelAliasSchema
    // accepts `z.string().optional()`, so `reasoning_key = ""` in config.toml
    // would otherwise disable the default field scan and route reads/writes
    // through an empty property name.
    const normalizedReasoningKey = options.reasoningKey?.trim();
    this._reasoningKey =
      normalizedReasoningKey !== undefined && normalizedReasoningKey.length > 0
        ? normalizedReasoningKey
        : undefined;
    this._reasoningEffort = undefined;
    this._generationKwargs = {};
    if (options.maxTokens !== undefined) {
      this._generationKwargs.max_tokens = options.maxTokens;
    }
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;
    this._clientFactory = options.clientFactory;

    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return reasoningEffortToThinkingEffort(this._reasoningEffort);
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      baseUrl: this._baseUrl,
      ...this._generationKwargs,
    };
  }

  getCapability(model?: string): ModelCapability {
    return getOpenAILegacyModelCapability(model ?? this._model);
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const messages: OpenAIMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    const normalizedHistory = normalizeToolCallIdsForProvider(
      history,
      OPENAI_CHAT_TOOL_CALL_ID_POLICY,
    );
    for (const msg of normalizedHistory) {
      messages.push(convertMessage(msg, this._reasoningKey, this._toolMessageConversion));
    }

    const kwargs: Record<string, unknown> = {
      ...this._generationKwargs,
    };

    // Determine reasoning_effort
    let reasoningEffort: string | undefined = this._reasoningEffort;

    // Auto-enable reasoning_effort when the history contains ThinkPart but reasoning
    // was not explicitly configured. This prevents server validation errors from APIs
    // (e.g. One API) that require reasoning_effort when messages contain reasoning_content.
    // Skip when the caller already pinned reasoning_effort via withGenerationKwargs —
    // their value would otherwise be silently overwritten below.
    // See: https://github.com/MoonshotAI/kimi-code/issues/1616
    if (reasoningEffort === undefined && kwargs['reasoning_effort'] === undefined) {
      const hasThinkPart = history.some((message) =>
        message.content.some((part) => part.type === 'think'),
      );
      if (hasThinkPart) {
        reasoningEffort = 'medium';
      }
    }

    // Remove undefined values from kwargs
    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    // Build the create params
    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      stream: this._stream,
      ...kwargs,
    };

    if (tools.length > 0) {
      createParams['tools'] = tools.map((t) => toolToOpenAI(t));
    }

    if (this._stream) {
      createParams['stream_options'] = { include_usage: true };
    }

    if (reasoningEffort !== undefined) {
      createParams['reasoning_effort'] = reasoningEffort;
    }

    try {
      const client = this._createClient(options?.auth);
      const response = (await client.chat.completions.create(
        createParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      )) as unknown as OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
      return new OpenAILegacyStreamedMessage(response, this._stream, this._reasoningKey);
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  withThinking(effort: ThinkingEffort): OpenAILegacyChatProvider {
    const reasoningEffort = thinkingEffortToReasoningEffort(effort);
    const clone = this._clone();
    clone._reasoningEffort = reasoningEffort;
    return clone;
  }

  withGenerationKwargs(kwargs: OpenAILegacyGenerationKwargs): OpenAILegacyChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  withMaxCompletionTokens(maxCompletionTokens: number): OpenAILegacyChatProvider {
    return this.withGenerationKwargs({ max_tokens: maxCompletionTokens });
  }

  private _clone(): OpenAILegacyChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as OpenAILegacyChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }

  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) =>
        this._buildClient(requireProviderApiKey('OpenAILegacyChatProvider', a, this._apiKey), a),
    );
  }

  private _buildClient(apiKey: string, auth?: ProviderRequestAuth): OpenAI {
    const clientOpts: Record<string, unknown> = {
      apiKey,
      baseURL: this._baseUrl,
    };
    const defaultHeaders = mergeRequestHeaders(this._defaultHeaders, auth?.headers);
    if (defaultHeaders !== undefined) {
      clientOpts['defaultHeaders'] = defaultHeaders;
    }
    if (this._httpClient !== undefined) {
      clientOpts['httpClient'] = this._httpClient;
    }
    return new OpenAI(clientOpts as ConstructorParameters<typeof OpenAI>[0]);
  }
}
