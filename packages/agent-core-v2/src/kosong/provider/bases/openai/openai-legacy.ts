/**
 * `kosong/provider` domain (L2) — OpenAI Chat Completions wire base.
 *
 * The base that actually speaks the Chat Completions wire format — and the
 * vendor host with the widest hook surface. It knows NOTHING about vendors:
 * every vendor deviation arrives as a composed `OpenAIChatCompletionsHooks`
 * set baked into `options.hooks` at construction. The hook consumption style
 * is uniform — "hook first, `undefined` falls back to the base default".
 *
 * Per-turn intent assembly (`_resolveRequestKwargs`) applies overlays in the
 * fixed contract order: cacheKey → sampling → thinking → maxCompletionTokens.
 * The context-window clamp on the completion budget (floor 1) runs BEFORE any
 * hook and cannot be skipped; the 128k ceiling clamp can be taken over by the
 * `withMaxCompletionTokens` hook.
 *
 * Two load-bearing behaviors:
 *
 *  - When `hooks.withThinking` EXISTS, the history-scanning auto-enable of
 *    `reasoning_effort` (issue #1616) is disabled entirely — once a trait
 *    takes over thinking encoding the base must not interfere.
 *  - When `hooks.convertMessage` EXISTS ("trait mode"), the base's
 *    tool-result `extract_text` fallback and tool-declaration-only skip are
 *    handed over to the trait wholesale: every history message is
 *    base-converted, post-processed by the hook, and dropped on `null`.
 */

import OpenAI from 'openai';

import { parseTraceId } from '#/kosong/contract/errors';
import type {
  ContentPart,
  Message,
  StreamedMessagePart,
  ToolCall,
  VideoURLPart,
} from '#/kosong/contract/message';
import { isToolDeclarationOnlyMessage } from '#/kosong/contract/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  ResponseFormat,
  StreamedMessage,
  ThinkingEffort,
  ToolCallIdPolicy,
  VideoUploadInput,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

import {
  convertChatCompletionStreamToolCall,
  type BufferedChatCompletionToolCall,
} from './chat-completions-stream';
import {
  convertContentPart,
  convertOpenAIError,
  convertToolMessageContent,
  extractUsage,
  hasModelPrefix,
  isFunctionToolCall,
  isOpenAIReasoningModel,
  normalizeOpenAIFinishReason,
  OPENAI_REASONING_CAPABILITY,
  OPENAI_TEXT_TOOL_CAPABILITY,
  OPENAI_VISION_TOOL_CAPABILITY,
  OPENAI_VISION_TOOL_PREFIXES,
  type OpenAIContentPart,
  TOOL_RESULT_MEDIA_PLACEHOLDER,
  TOOL_RESULT_MEDIA_PROMPT,
  type ToolMessageConversion,
  toolToOpenAI,
} from './openai-common';
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from '../request-auth';
import { normalizeToolCallIdsForProvider, sanitizeToolCallId } from '../tool-call-id';

const KNOWN_REASONING_KEYS = ['reasoning_content', 'reasoning_details', 'reasoning'] as const;
const DEFAULT_OUTBOUND_REASONING_KEY = KNOWN_REASONING_KEYS[0];

const CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING = 128 * 1024;

export const OPENAI_CHAT_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

/**
 * The base-internal hook set: same surface as the L1 trait's per-request
 * hooks but with the `TraitContext` already bound away by the compositor.
 * Construction-time declarations (endpoint/headers/provides/capability) never
 * enter this set. A hook returning `undefined` always means "keep the base
 * default".
 */
export interface OpenAIChatCompletionsHooks {
  convertTool?: (tool: Tool) => Record<string, unknown> | undefined;
  convertMessage?: (
    message: Message,
    converted: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  mergeHistory?: (
    messages: readonly Record<string, unknown>[],
  ) => Record<string, unknown>[] | undefined;
  buildParams?: (params: Record<string, unknown>) => Record<string, unknown> | undefined;
  toolCallIdPolicy?: () => ToolCallIdPolicy | undefined;
  withThinking?: (
    effort: ThinkingEffort,
    options: { readonly keep?: string },
    generationKwargs: OpenAILegacyGenerationKwargs,
  ) => OpenAILegacyGenerationKwargs | undefined;
  preserveThinking?: (generationKwargs: Record<string, unknown>) => boolean | undefined;
  withMaxCompletionTokens?: (maxCompletionTokens: number) => Record<string, unknown> | undefined;
  cacheKey?: (key: string) => Record<string, unknown> | undefined;
  extractUsage?: (chunk: Record<string, unknown>) => Record<string, unknown> | null | undefined;
  reasoningKey?: () => string | undefined;
  uploadVideo?: (
    input: string | VideoUploadInput,
    options?: GenerateOptions,
  ) => Promise<VideoURLPart>;
}

export interface OpenAILegacyOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  maxTokens?: number | undefined;
  reasoningKey?: string | undefined;
  offEffort?: string | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
  hooks?: OpenAIChatCompletionsHooks | undefined;
}

export interface OpenAILegacyGenerationKwargs {
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
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

function extractReasoningContent(
  source: unknown,
  explicitKey: string | undefined,
): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  const keys: readonly string[] = explicitKey !== undefined ? [explicitKey] : KNOWN_REASONING_KEYS;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function usesMaxCompletionTokens(model: string): boolean {
  const normalized = model.toLowerCase();
  return /^o\d(?:$|[-.])/.test(normalized) || /^gpt-5(?:$|[-.])/.test(normalized);
}

function completionTokenKwargs(
  model: string,
  maxCompletionTokens: number,
): OpenAILegacyGenerationKwargs {
  return usesMaxCompletionTokens(model)
    ? { max_completion_tokens: maxCompletionTokens }
    : { max_tokens: maxCompletionTokens };
}

function normalizeGenerationKwargs(
  model: string,
  source: OpenAILegacyGenerationKwargs,
): OpenAILegacyGenerationKwargs {
  const kwargs = { ...source };
  if (usesMaxCompletionTokens(model)) {
    if (kwargs.max_completion_tokens === undefined && kwargs.max_tokens !== undefined) {
      kwargs.max_completion_tokens = kwargs.max_tokens;
    }
    delete kwargs.max_tokens;
  }
  return kwargs;
}

function responseFormatToOpenAI(format: ResponseFormat): Record<string, unknown> {
  if (format.type === 'json_object') {
    return { type: 'json_object' };
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: format.jsonSchema.name,
      schema: format.jsonSchema.schema,
      strict: format.jsonSchema.strict,
      description: format.jsonSchema.description,
    },
  };
}

function convertMessage(
  message: Message,
  reasoningKey: string | undefined,
  toolMessageConversion: ToolMessageConversion,
  preserveThinking: boolean,
  allowToolResultExtraction: boolean,
): OpenAIMessage {
  let reasoningContent = '';
  let hasReasoningPart = false;
  const nonThinkParts: ContentPart[] = [];

  for (const part of message.content) {
    if (part.type === 'think') {
      hasReasoningPart = true;
      reasoningContent += part.think;
    } else {
      nonThinkParts.push(part);
    }
  }

  const result: OpenAIMessage = { role: message.role };

  if (message.role === 'tool') {
    const hasNonTextPart = message.content.some((p) => p.type !== 'text' && p.type !== 'think');
    // The forced extract_text fallback for media-bearing tool results is part
    // of the base's non-trait behavior; in trait mode the trait owns shaping.
    const effectiveConversion: ToolMessageConversion =
      allowToolResultExtraction && hasNonTextPart ? 'extract_text' : toolMessageConversion;

    if (effectiveConversion !== null) {
      result.content = convertToolMessageContentForChat(message, effectiveConversion);
    } else {
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

  if (hasReasoningPart || (preserveThinking && message.role === 'assistant')) {
    result[reasoningKey ?? DEFAULT_OUTBOUND_REASONING_KEY] = reasoningContent;
  }

  return result;
}

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: not supported by this provider)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: not supported by this provider)';

function convertToolMessageContentForChat(
  message: Message,
  conversion: ToolMessageConversion,
): string | OpenAIContentPart[] {
  const content = convertToolMessageContent(message, conversion);
  if (typeof content !== 'string') {
    return content;
  }
  const lines: string[] = content.length > 0 ? [content] : [];
  if (message.content.some((part) => part.type === 'audio_url')) {
    lines.push(OMITTED_AUDIO_PLACEHOLDER);
  }
  if (message.content.some((part) => part.type === 'video_url')) {
    lines.push(OMITTED_VIDEO_PLACEHOLDER);
  }
  if (lines.length === 0 && message.content.some((part) => part.type === 'image_url')) {
    return TOOL_RESULT_MEDIA_PLACEHOLDER;
  }
  return lines.join('\n');
}

function toolResultImageParts(message: Message): OpenAIContentPart[] {
  const images: OpenAIContentPart[] = [];
  for (const part of message.content) {
    if (part.type !== 'image_url') continue;
    const converted = convertContentPart(part);
    if (converted !== null) {
      images.push(converted);
    }
  }
  return images;
}

function appendToolResultMediaMessage(
  messages: OpenAIMessage[],
  pendingToolResultMedia: OpenAIContentPart[],
): void {
  if (pendingToolResultMedia.length === 0) return;
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: TOOL_RESULT_MEDIA_PROMPT }, ...pendingToolResultMedia],
  });
  pendingToolResultMedia.length = 0;
}

function convertHistoryMessages(
  history: readonly Message[],
  reasoningKey: string | undefined,
  toolMessageConversion: ToolMessageConversion,
  preserveThinking: boolean,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const pendingToolResultMedia: OpenAIContentPart[] = [];

  for (const msg of history) {
    if (isToolDeclarationOnlyMessage(msg)) continue;
    if (msg.role !== 'tool') {
      appendToolResultMediaMessage(messages, pendingToolResultMedia);
    }
    messages.push(convertMessage(msg, reasoningKey, toolMessageConversion, preserveThinking, true));
    if (msg.role === 'tool') {
      pendingToolResultMedia.push(...toolResultImageParts(msg));
    }
  }

  appendToolResultMediaMessage(messages, pendingToolResultMedia);
  return messages;
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
    private readonly _traceId: string | null,
    private readonly _extractUsageHook?:
      | ((chunk: Record<string, unknown>) => Record<string, unknown> | null | undefined)
      | undefined,
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

  get traceId(): string | null {
    return this._traceId;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureFinishReason(raw: string | null | undefined): void {
    const normalized = normalizeOpenAIFinishReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _captureUsage(raw: Record<string, unknown>, fallback: unknown): void {
    // The hook locates the usage payload first; `undefined` defers to the
    // base default location, `null` asserts the chunk carries no usage.
    const hooked = this._extractUsageHook?.(raw);
    const rawUsage = hooked !== undefined ? hooked : fallback;
    if (rawUsage !== null && rawUsage !== undefined) {
      this._usage = extractUsage(rawUsage) ?? null;
    }
  }

  private async *_convertNonStreamResponse(
    response: OpenAI.Chat.ChatCompletion,
    reasoningKey: string | undefined,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    this._captureUsage(response as unknown as Record<string, unknown>, response.usage);
    this._captureFinishReason(response.choices[0]?.finish_reason ?? null);

    const message = response.choices[0]?.message;
    if (!message) return;

    const reasoning = extractReasoningContent(message, reasoningKey);
    if (reasoning !== undefined) {
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

        this._captureUsage(chunk as unknown as Record<string, unknown>, chunk.usage);

        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          this._captureFinishReason(choice.finish_reason);
        }

        const delta = choice.delta;

        const reasoning = extractReasoningContent(delta, reasoningKey);
        if (reasoning !== undefined) {
          yield { type: 'think', think: reasoning } satisfies StreamedMessagePart;
        }

        if (delta.content) {
          yield { type: 'text', text: delta.content } satisfies StreamedMessagePart;
        }

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

  private readonly _model: string;
  private readonly _stream: boolean;
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _defaultHeaders: Record<string, string> | undefined;
  private readonly _reasoningKey: string | undefined;
  private readonly _offEffort: string | undefined;
  private readonly _thinkingEffort: ThinkingEffort | undefined;
  private readonly _generationKwargs: OpenAILegacyGenerationKwargs;
  private readonly _toolMessageConversion: ToolMessageConversion;
  private readonly _client: OpenAI | undefined;
  private readonly _httpClient: unknown;
  private readonly _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;
  private readonly _hooks: OpenAIChatCompletionsHooks | undefined;

  /**
   * Bound only when the composed hook set declares `uploadVideo` — declaring
   * the hook IS the capability declaration, so a base without the hook has no
   * upload facility at all.
   */
  readonly uploadVideo?: (
    input: string | VideoUploadInput,
    options?: GenerateOptions,
  ) => Promise<VideoURLPart>;

  constructor(options: OpenAILegacyOptions) {
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this._defaultHeaders = options.defaultHeaders;
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._hooks = options.hooks;
    const normalizedReasoningKey = options.reasoningKey?.trim();
    this._reasoningKey =
      normalizedReasoningKey !== undefined && normalizedReasoningKey.length > 0
        ? normalizedReasoningKey
        : this._hooks?.reasoningKey?.();
    this._thinkingEffort = options.thinkingEffort;
    this._offEffort = options.offEffort;
    this._generationKwargs = normalizeGenerationKwargs(
      this._model,
      options.maxTokens !== undefined ? completionTokenKwargs(this._model, options.maxTokens) : {},
    );
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;
    this._clientFactory = options.clientFactory;

    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);

    const uploadVideo = this._hooks?.uploadVideo;
    if (uploadVideo !== undefined) {
      this.uploadVideo = (input, generateOptions) => uploadVideo(input, generateOptions);
    }
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._thinkingEffort ?? null;
  }

  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.max_completion_tokens ?? this._generationKwargs.max_tokens;
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const { kwargs, reasoningEffort } = this._resolveRequestKwargs(history, options);

    // preserveThinking decides whether assistant messages force-replay their
    // reasoning field; the hook reads the already-seeded kwargs (e.g. the
    // thinking config a withThinking hook just encoded).
    const preserveThinking = this._hooks?.preserveThinking?.(kwargs) ?? false;

    const messages: Record<string, unknown>[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    const policy = this._hooks?.toolCallIdPolicy?.() ?? OPENAI_CHAT_TOOL_CALL_ID_POLICY;
    const normalizedHistory = normalizeToolCallIdsForProvider(history, policy);

    const convertMessageHook = this._hooks?.convertMessage;
    if (convertMessageHook !== undefined) {
      // Trait mode: the tool-declaration-only skip and the tool-result media
      // extraction are handed over to the trait wholesale.
      for (const msg of normalizedHistory) {
        const converted = convertMessage(msg, this._reasoningKey, null, preserveThinking, false);
        const shaped = convertMessageHook(msg, converted);
        if (shaped !== null) {
          messages.push(shaped);
        }
      }
    } else {
      messages.push(
        ...convertHistoryMessages(
          normalizedHistory,
          this._reasoningKey,
          this._toolMessageConversion,
          preserveThinking,
        ),
      );
    }

    const merged = this._hooks?.mergeHistory?.(messages);
    const finalMessages = merged ?? messages;

    const createParams: Record<string, unknown> = {
      model: this._model,
      messages: finalMessages,
      stream: this._stream,
      ...kwargs,
    };

    if (tools.length > 0) {
      const convertTool = this._hooks?.convertTool ?? ((tool: Tool) => toolToOpenAI(tool));
      createParams['tools'] = tools.map((tool) => convertTool(tool));
    }
    if (options?.responseFormat !== undefined) {
      createParams['response_format'] = responseFormatToOpenAI(options.responseFormat);
    }

    if (this._stream) {
      createParams['stream_options'] = { include_usage: true };
    }

    if (reasoningEffort !== undefined) {
      createParams['reasoning_effort'] = reasoningEffort;
    }

    // buildParams is the last hook to run before the request is sent.
    const builtParams = this._hooks?.buildParams?.(createParams);
    const finalParams = builtParams ?? createParams;

    try {
      const client = this._createClient(options?.auth);
      options?.onRequestSent?.();
      // `withResponse()` resolves as soon as the response headers arrive
      // (before the stream body), so the trace id is available mid-stream.
      const { data, response } = await client.chat.completions
        .create(
          finalParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          options?.signal ? { signal: options.signal } : undefined,
        )
        .withResponse();
      return new OpenAILegacyStreamedMessage(
        data as unknown as
          | OpenAI.Chat.ChatCompletion
          | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
        this._stream,
        this._reasoningKey,
        parseTraceId(response.headers),
        this._hooks?.extractUsage,
      );
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  /**
   * Per-turn intent → request kwargs, in the fixed contract overlay order:
   * cacheKey → sampling → thinking → maxCompletionTokens. Each intent consults
   * its hook first and falls back to the base encoding on `undefined`.
   */
  private _resolveRequestKwargs(
    history: readonly Message[],
    options: GenerateOptions | undefined,
  ): { kwargs: Record<string, unknown>; reasoningEffort: string | undefined } {
    let kwargs: Record<string, unknown> = { ...this._generationKwargs };

    if (options?.cacheKey !== undefined) {
      const hooked = this._hooks?.cacheKey?.(options.cacheKey);
      kwargs = { ...kwargs, ...(hooked ?? { prompt_cache_key: options.cacheKey }) };
    }

    if (options?.sampling?.temperature !== undefined) {
      kwargs = { ...kwargs, temperature: options.sampling.temperature };
    }
    if (options?.sampling?.topP !== undefined) {
      kwargs = { ...kwargs, top_p: options.sampling.topP };
    }

    const thinking =
      options?.thinking ??
      (this._thinkingEffort !== undefined ? { effort: this._thinkingEffort } : undefined);
    let explicitThinkingEffort: ThinkingEffort | undefined;
    if (thinking !== undefined) {
      const hooked = this._hooks?.withThinking?.(thinking.effort, { keep: thinking.keep }, kwargs);
      if (hooked !== undefined) {
        kwargs = { ...kwargs, ...hooked };
      } else {
        explicitThinkingEffort = thinking.effort;
      }
    }

    let reasoningEffort: string | undefined =
      explicitThinkingEffort === 'off'
        ? this._offEffort
        : explicitThinkingEffort === undefined || explicitThinkingEffort === 'on'
          ? undefined
          : explicitThinkingEffort;

    // issue #1616 history scan — disabled entirely when a withThinking hook
    // exists: once a trait takes over thinking, the base must not interfere.
    if (
      reasoningEffort === undefined &&
      explicitThinkingEffort !== 'off' &&
      kwargs['reasoning_effort'] === undefined &&
      this._hooks?.withThinking === undefined
    ) {
      const hasThinkPart = history.some((message) =>
        message.content.some((part) => part.type === 'think'),
      );
      if (hasThinkPart) {
        reasoningEffort = 'medium';
      }
    }

    if (options?.maxCompletionTokens !== undefined) {
      let cap = options.maxCompletionTokens;
      // Window clamp first — it cannot be skipped by any hook.
      if (
        options.usedContextTokens !== undefined &&
        options.maxContextTokens !== undefined &&
        options.maxContextTokens > 0
      ) {
        cap = Math.min(cap, options.maxContextTokens - options.usedContextTokens);
      }
      cap = Math.max(1, cap);
      const hooked = this._hooks?.withMaxCompletionTokens?.(cap);
      if (hooked !== undefined) {
        kwargs = { ...kwargs, ...hooked };
      } else {
        // The ceiling clamp can be taken over by the hook.
        const capped = Math.min(cap, CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING);
        kwargs = { ...kwargs, ...completionTokenKwargs(this._model, Math.max(1, capped)) };
      }
    }

    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    return { kwargs, reasoningEffort };
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

// ---------------------------------------------------------------------------
// Base capability catalog — the final fallback of capability resolution.
// `undefined` means the base knows nothing about the model.
// ---------------------------------------------------------------------------

export function getOpenAILegacyModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (isOpenAIReasoningModel(normalized)) {
    return OPENAI_REASONING_CAPABILITY;
  }
  if (hasModelPrefix(normalized, OPENAI_VISION_TOOL_PREFIXES)) {
    return OPENAI_VISION_TOOL_CAPABILITY;
  }
  if (normalized.startsWith('gpt-3.5-turbo')) {
    return OPENAI_TEXT_TOOL_CAPABILITY;
  }
  return undefined;
}
