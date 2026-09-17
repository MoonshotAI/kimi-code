import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '#/message';
import { isToolDeclarationOnlyMessage } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  MaxCompletionTokensOptions,
  ProviderRequestAuth,
  ResponseFormat,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import OpenAI from 'openai';

import {
  convertContentPart,
  convertOpenAIError,
  convertToolMessageContent,
  extractUsage,
  isFunctionToolCall,
  normalizeOpenAIFinishReason,
  type OpenAIContentPart,
  TOOL_RESULT_MEDIA_PLACEHOLDER,
  TOOL_RESULT_MEDIA_PROMPT,
  type ToolMessageConversion,
  toolToOpenAI,
} from './openai-common';
import {
  convertChatCompletionStreamToolCall,
  type BufferedChatCompletionToolCall,
} from './chat-completions-stream';
import { ReasoningKeyDialect } from './reasoning-key';
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

// Inbound: scan the known reasoning field names in priority order; first
// string value wins. Outbound: echo the dialect the endpoint actually spoke
// (detected by ReasoningKeyDialect), defaulting to `reasoning_content`. Both
// arms can be pinned by an explicit `reasoningKey` on the provider config.

/**
 * Hard upper bound on `max_tokens` for OpenAI-compatible chat-completions
 * endpoints. Many third-party providers reject `max_tokens` above this limit
 * (the documented range is `[1, 131072]`).
 */
const CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING = 128 * 1024;
const OPENAI_CHAT_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

// ---------------------------------------------------------------------------
// Alibaba gateway newline repair
// ---------------------------------------------------------------------------
// 部分模型（如 Qwen）经阿里 token plan / dashscope 网关返回的流式响应，会在
// 中文行内短语边界插入多余换行符，破坏 Markdown 列表项与表格结构（列表续行
// 丢失缩进、表格行被拆散）。此处仅对阿里系网关启用修复：把“非结构性换行”
// 替换为空格，保留真正的结构性换行。其他渠道不受影响。

/** 判断 baseUrl 是否为阿里系网关（token plan / dashscope 等）。 */
export function isAlibabaGateway(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return /aliyuncs\.com|dashscope/i.test(baseUrl);
}

/**
 * 判断两行之间的换行是否为“结构性换行”（应保留）。
 * 结构性换行包括：空行（段落分隔）、后行以块级标记开头（标题/列表/引用/表格/
 * 代码围栏/水平线）、前行是标题。其余视为行内多余换行，应替换为空格。
 */
export function isStructuralNewline(prevLine: string, nextLine: string): boolean {
  if (prevLine === '' || nextLine === '') return true;
  if (/^(?:#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|\s*>|\||`{3,}|~{3,})/.test(nextLine)) return true;
  if (/^#{1,6}\s/.test(prevLine)) return true;
  // 前行是代码围栏（开始或结束）时，其后换行必须保留，否则围栏会与相邻行粘连。
  if (/^(`{3,}|~{3,})/.test(prevLine.trim())) return true;
  if (/^\s*([-*_])\s*\1\s*\1/.test(nextLine)) return true;
  return false;
}

/** 非流式完整文本修复：逐行合并非结构性换行，保留代码块与块级结构。 */
export function repairFullText(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= 1) return text;
  const result: string[] = [lines[0]!];
  let inCodeBlock = false;
  if (/^(`{3,}|~{3,})/.test(lines[0]!.trim())) inCodeBlock = true;
  for (let i = 1; i < lines.length; i++) {
    const prev = result[result.length - 1]!;
    const curr = lines[i]!;
    if (inCodeBlock) {
      result.push(curr);
      if (/^(`{3,}|~{3,})\s*$/.test(curr.trim())) inCodeBlock = false;
      continue;
    }
    if (/^(`{3,}|~{3,})/.test(curr.trim())) {
      result.push(curr);
      inCodeBlock = true;
      continue;
    }
    if (isStructuralNewline(prev, curr)) {
      result.push(curr);
    } else {
      result[result.length - 1] = prev + ' ' + curr;
    }
  }
  return result.join('\n');
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

export interface OpenAILegacyOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  maxTokens?: number | undefined;
  reasoningKey?: string | undefined;
  /**
   * The effort value that encodes "thinking off" on this wire (e.g. `'none'`
   * for xai grok). When set, `withThinking('off')` sends it as
   * `reasoning_effort` instead of omitting the field — required by models
   * whose default is to reason.
   */
  offEffort?: string | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
  /**
   * Construction-time free-form request kwargs (e.g. `prompt_cache_key` for
   * session affinity), merged into every request at generate time. Explicit
   * first-class options (`maxTokens`) win on conflict; the
   * `withGenerationKwargs` morph layers on top of both.
   */
  generationKwargs?: OpenAILegacyGenerationKwargs | undefined;
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
  content?: string | OpenAIContentPart[] | null | undefined;
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

function convertMessage(
  message: Message,
  reasoningKey: string,
  toolMessageConversion: ToolMessageConversion,
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
      result.content = convertToolMessageContentForChat(message, effectiveConversion);
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

  // A missing `content` key is dropped by JSON.stringify, and strict
  // chat-completions validators (e.g. LiteLLM) reject such assistant messages
  // with a 422. OpenAI's own responses echo `content: null` alongside
  // tool_calls, so normalize the absent field to that spec-legal shape.
  if (message.role === 'assistant' && result.content === undefined) {
    result.content = null;
  }

  if (message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId;
  }

  // Round-trip thinking content back to the server under the dialect the
  // endpoint actually spoke (detected from inbound responses; defaults to the
  // de facto `reasoning_content` so OpenAI-compatible reasoners — DeepSeek,
  // Qwen, One API gateways — work out of the box). Servers that don't
  // understand the field ignore it; an explicit `reasoningKey` config pins
  // the dialect instead of detecting it.
  if (hasReasoningPart) {
    result[reasoningKey] = reasoningContent;
  }

  return result;
}

// Chat Completions has no url-based audio/video content part (only base64
// `input_audio`), so unlike images these cannot be reattached as user input.
// Note the omission inline in the tool message text instead.
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
  reasoningKey: string,
  toolMessageConversion: ToolMessageConversion,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const pendingToolResultMedia: OpenAIContentPart[] = [];

  for (const msg of history) {
    // Message-level tool declarations are a Kimi wire feature; skipped here
    // because the leftover `{role:"system"}` without content is rejected by
    // the Chat Completions API. See isToolDeclarationOnlyMessage.
    if (isToolDeclarationOnlyMessage(msg)) continue;
    if (msg.role !== 'tool') {
      appendToolResultMediaMessage(messages, pendingToolResultMedia);
    }
    messages.push(convertMessage(msg, reasoningKey, toolMessageConversion));
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
  // 阿里网关换行修复状态：仅当 _needsNlRepair 为 true 时使用。
  private readonly _needsNlRepair: boolean;
  private _nlBuffer = '';
  private _nlInCodeBlock = false;

  constructor(
    response: OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    isStream: boolean,
    reasoningKeyDialect: ReasoningKeyDialect,
    needsNlRepair = false,
  ) {
    this._needsNlRepair = needsNlRepair;
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
        reasoningKeyDialect,
      );
    } else {
      this._iter = this._convertNonStreamResponse(
        response as OpenAI.Chat.ChatCompletion,
        reasoningKeyDialect,
      );
    }
  }

  /**
   * 对单个 text delta 做行缓冲换行修复。
   * 流式 delta 可能在任意位置切断一行，因此遇到位于 buffer 末尾的换行时先
   * 暂存，等下一个 chunk 到来再判断该换行是否结构性。返回可立即 yield 的文本。
   */
  private _processNlRepair(content: string): string {
    this._nlBuffer += content;
    let output = '';
    while (true) {
      const nlIdx = this._nlBuffer.indexOf('\n');
      if (nlIdx === -1) break;
      const before = this._nlBuffer.slice(0, nlIdx);
      const after = this._nlBuffer.slice(nlIdx + 1);
      // 换行落在 buffer 末尾，下一行尚未到达，暂存待后续 chunk 判断。
      if (after === '') {
        this._nlBuffer = before + '\n';
        break;
      }
      if (this._nlInCodeBlock) {
        output += before + '\n';
        if (/^(`{3,}|~{3,})\s*$/.test(before.trim())) this._nlInCodeBlock = false;
        this._nlBuffer = after;
        continue;
      }
      if (/^(`{3,}|~{3,})/.test(before.trim())) {
        output += before + '\n';
        this._nlInCodeBlock = true;
        this._nlBuffer = after;
        continue;
      }
      if (/^(`{3,}|~{3,})/.test(after.trim())) {
        output += before + '\n';
        this._nlInCodeBlock = true;
        this._nlBuffer = after;
        continue;
      }
      if (isStructuralNewline(before, after)) {
        output += before + '\n';
      } else {
        output += before + ' ';
      }
      this._nlBuffer = after;
    }
    return output;
  }

  /** 流结束时 flush 残留 buffer（不再等待后续 chunk）。 */
  private _flushNlRepair(): string | null {
    if (this._nlBuffer === '') return null;
    const result = this._nlBuffer;
    this._nlBuffer = '';
    return result;
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
    reasoningKeyDialect: ReasoningKeyDialect,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    if (response.usage) {
      this._usage = extractUsage(response.usage) ?? null;
    }
    this._captureFinishReason(response.choices[0]?.finish_reason ?? null);

    const message = response.choices[0]?.message;
    if (!message) return;

    // Reasoning content: honor the explicit key when set, otherwise scan the
    // de facto field set and remember the dialect for outbound echo.
    const reasoning = reasoningKeyDialect.observe(message);
    if (reasoning !== undefined) {
      yield { type: 'think', think: reasoning } satisfies StreamedMessagePart;
    }

    if (message.content) {
      // 阿里网关可能在非流式响应文本中插入行内多余换行，按需修复。
      const text = this._needsNlRepair ? repairFullText(message.content) : message.content;
      yield { type: 'text', text } satisfies StreamedMessagePart;
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
    reasoningKeyDialect: ReasoningKeyDialect,
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
        // the de facto field set and remember the dialect for outbound echo.
        const reasoning = reasoningKeyDialect.observe(delta);
        if (reasoning !== undefined) {
          yield { type: 'think', think: reasoning } satisfies StreamedMessagePart;
        }

        // text content
        if (delta.content) {
          if (this._needsNlRepair) {
            // 阿里网关行内多余换行修复：经行缓冲判断后产出可立即下发的文本。
            const repaired = this._processNlRepair(delta.content);
            if (repaired) {
              yield { type: 'text', text: repaired } satisfies StreamedMessagePart;
            }
          } else {
            yield { type: 'text', text: delta.content } satisfies StreamedMessagePart;
          }
        }

        // tool calls — preserve `index` on every yielded part so the generate
        // loop can route interleaved argument deltas from parallel tool calls.
        for (const toolCall of delta.tool_calls ?? []) {
          for (const part of convertChatCompletionStreamToolCall(toolCall, bufferedToolCalls)) {
            yield part;
          }
        }
      }
      // 流结束：flush 行缓冲中残留的文本（含此前暂存的末尾换行）。
      if (this._needsNlRepair) {
        const flushed = this._flushNlRepair();
        if (flushed) {
          yield { type: 'text', text: flushed } satisfies StreamedMessagePart;
        }
      }
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }
}
export class OpenAILegacyChatProvider implements ChatProvider {
  readonly name: string = 'openai';

  /**
   * See {@link ChatProvider.maxCompletionTokens}. Reuses the request-time
   * kwargs normalization so the model-dependent `max_tokens` /
   * `max_completion_tokens` aliasing is mirrored exactly.
   */
  get maxCompletionTokens(): number | undefined {
    const kwargs = normalizeGenerationKwargs(this._model, this._generationKwargs);
    return kwargs.max_completion_tokens ?? kwargs.max_tokens;
  }

  private _model: string;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _defaultHeaders: Record<string, string> | undefined;
  private _reasoningKeyDialect: ReasoningKeyDialect;
  private _thinkingEffort: ThinkingEffort | undefined;
  private _offEffort: string | undefined;
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
    this._reasoningKeyDialect = new ReasoningKeyDialect(
      normalizedReasoningKey !== undefined && normalizedReasoningKey.length > 0
        ? normalizedReasoningKey
        : undefined,
    );
    this._thinkingEffort = undefined;
    this._offEffort = options.offEffort;
    this._generationKwargs = {
      ...options.generationKwargs,
      ...(options.maxTokens !== undefined
        ? completionTokenKwargs(this._model, options.maxTokens)
        : {}),
    };
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;
    this._clientFactory = options.clientFactory;

    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._thinkingEffort ?? null;
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      baseUrl: this._baseUrl,
      ...normalizeGenerationKwargs(this._model, this._generationKwargs),
    };
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
    messages.push(
      ...convertHistoryMessages(
        normalizedHistory,
        this._reasoningKeyDialect.outboundKey(),
        this._toolMessageConversion,
      ),
    );

    const kwargs: Record<string, unknown> = normalizeGenerationKwargs(
      this._model,
      this._generationKwargs,
    );

    // Determine reasoning_effort. 'on' has no wire encoding on
    // chat-completions APIs, so it sends no reasoning_effort field; only a
    // concrete effort (low/medium/high/...) is passed through verbatim.
    // 'off' sends the model's declared off value (e.g. 'none') when one is
    // configured — models that reason by default need the explicit value to
    // actually disable reasoning; otherwise the field is omitted as before.
    const effort = this._thinkingEffort;
    let reasoningEffort: string | undefined =
      effort === 'off'
        ? this._offEffort
        : effort === undefined || effort === 'on'
          ? undefined
          : effort;

    // Auto-enable reasoning_effort when the history contains ThinkPart but reasoning
    // was not explicitly configured. This prevents server validation errors from APIs
    // (e.g. One API) that require reasoning_effort when messages contain reasoning_content.
    // Skip when the caller already pinned reasoning_effort via withGenerationKwargs —
    // their value would otherwise be silently overwritten below. An explicit 'off'
    // from withThinking is honored as well: with thinking turned off the
    // auto-enable must not silently switch reasoning back on (or leak the field
    // to models that reject it).
    // See: https://github.com/MoonshotAI/kimi-code/issues/1616
    if (
      reasoningEffort === undefined &&
      effort !== 'off' &&
      kwargs['reasoning_effort'] === undefined
    ) {
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
    if (options?.responseFormat !== undefined) {
      createParams['response_format'] = responseFormatToOpenAI(options.responseFormat);
    }

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
      options?.onRequestSent?.();
      const response = (await client.chat.completions.create(
        createParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      )) as unknown as OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
      return new OpenAILegacyStreamedMessage(
        response,
        this._stream,
        this._reasoningKeyDialect,
        isAlibabaGateway(this._baseUrl),
      );
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  withThinking(effort: ThinkingEffort): OpenAILegacyChatProvider {
    const clone = this._clone();
    // Store the requested effort verbatim; the wire encoding is derived per
    // request so an explicit 'off' stays distinguishable from "never
    // configured" (which the history-based auto-enable relies on).
    clone._thinkingEffort = effort;
    return clone;
  }

  withGenerationKwargs(kwargs: OpenAILegacyGenerationKwargs): OpenAILegacyChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  withMaxCompletionTokens(
    maxCompletionTokens: number,
    options?: MaxCompletionTokensOptions,
  ): OpenAILegacyChatProvider {
    let cap = maxCompletionTokens;
    if (
      options?.usedContextTokens !== undefined &&
      options?.maxContextTokens !== undefined &&
      options.maxContextTokens > 0
    ) {
      cap = Math.min(cap, options.maxContextTokens - options.usedContextTokens);
    }
    cap = Math.min(cap, CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING);
    return this.withGenerationKwargs(completionTokenKwargs(this._model, Math.max(1, cap)));
  }

  private _clone(): OpenAILegacyChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as OpenAILegacyChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    // `_reasoningKeyDialect` stays shared by reference: the dialect learned
    // from a response on any per-step clone must steer the next request's
    // outbound reasoning key.
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
