import { normalizeKimiToolSchema } from './kimi-schema';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '../message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  MaxCompletionTokensOptions,
  ProviderRequestAuth,
  ResponseFormat,
  StreamedMessage,
  ThinkingEffort,
  VideoUploadInput,
} from '../provider';
import type { Tool } from '../tool';
import type { TokenUsage } from '../usage';
import OpenAI from 'openai';

import { KimiFiles } from './kimi-files';
import {
  convertChatCompletionStreamToolCall,
  type BufferedChatCompletionToolCall,
} from './chat-completions-stream';
import {
  convertContentPart,
  convertOpenAIError,
  extractUsage,
  isFunctionToolCall,
  normalizeOpenAIFinishReason,
  type OpenAIContentPart,
  type OpenAIToolParam,
  toolToOpenAI,
} from './openai-common';
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
export interface KimiOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  generationKwargs?: GenerationKwargs | undefined;
  supportEfforts?: readonly string[];
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
}

export interface GenerationKwargs {
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  prompt_cache_key?: string | undefined;
  extra_body?: ExtraBody;
}

export interface ThinkingConfig {
  type?: 'enabled' | 'disabled';
  effort?: string;
  keep?: unknown;
  [key: string]: unknown;
}

export interface ExtraBody {
  thinking?: ThinkingConfig;
  [key: string]: unknown;
}
const KIMI_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};
interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | undefined;
  tool_calls?: OpenAIToolCallOut[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  reasoning_content?: string | undefined;
  tools?: OpenAIToolParam[];
}

interface OpenAIToolCallOut {
  type: string;
  id: string;
  function: { name: string; arguments: string | null };
  extras?: Record<string, unknown> | undefined;
}

function isEffectivelyEmptyContent(parts: ContentPart[]): boolean {
  for (const part of parts) {
    if (part.type !== 'text') return false;
    if (part.text.trim() !== '') return false;
  }
  return true;
}

function convertMessage(message: Message): OpenAIMessage {
  let reasoningContent = '';
  const nonThinkParts: ContentPart[] = [];

  for (const part of message.content) {
    if (part.type === 'think') {
      reasoningContent += part.think;
    } else {
      nonThinkParts.push(part);
    }
  }

  const result: OpenAIMessage = { role: message.role };
  const hasToolCalls = message.toolCalls.length > 0;
  const shouldOmitContent =
    message.role === 'assistant' && hasToolCalls && isEffectivelyEmptyContent(nonThinkParts);

  if (!shouldOmitContent) {
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

  if (hasToolCalls) {
    result.tool_calls = message.toolCalls.map((tc) => {
      const mapped: OpenAIToolCallOut = {
        type: tc.type,
        id: tc.id,
        function: { name: tc.name, arguments: tc.arguments },
      };
      if (tc.extras !== undefined) {
        mapped.extras = tc.extras;
      }
      return mapped;
    });
  }

  if (message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId;
  }

  if (reasoningContent) {
    result.reasoning_content = reasoningContent;
  }

  if (message.tools !== undefined && message.tools.length > 0) {
    result.tools = message.tools.map((tool) => convertTool(tool));
  }

  return result;
}
function convertTool(tool: Tool): OpenAIToolParam {
  if (tool.name.startsWith('$')) {
    return {
      type: 'builtin_function',
      function: { name: tool.name },
    };
  }
  const converted = toolToOpenAI(tool);
  return {
    ...converted,
    function: {
      ...converted.function,
      parameters: normalizeKimiToolSchema(tool.parameters),
    },
  };
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

export function extractUsageFromChunk(
  chunk: Record<string, unknown>,
): Record<string, unknown> | null {
  if (
    chunk['usage'] !== null &&
    chunk['usage'] !== undefined &&
    typeof chunk['usage'] === 'object'
  ) {
    return chunk['usage'] as Record<string, unknown>;
  }
  const choices = chunk['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const firstChoice = choices[0] as Record<string, unknown> | undefined;
  if (firstChoice === undefined) {
    return null;
  }
  const choiceUsage = firstChoice['usage'];
  if (choiceUsage !== null && choiceUsage !== undefined && typeof choiceUsage === 'object') {
    return choiceUsage as Record<string, unknown>;
  }
  return null;
}

class KimiStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    isStream: boolean,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
      );
    } else {
      this._iter = this._convertNonStreamResponse(response as OpenAI.Chat.ChatCompletion);
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
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    if (response.usage) {
      this._usage = extractUsage(response.usage) ?? null;
    }
    this._captureFinishReason(response.choices[0]?.finish_reason ?? null);

    const message = response.choices[0]?.message;
    if (!message) return;

    const rc = (message as unknown as Record<string, unknown>)['reasoning_content'];
    if (typeof rc === 'string' && rc) {
      yield { type: 'think', think: rc } satisfies StreamedMessagePart;
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
  ): AsyncGenerator<StreamedMessagePart> {
    const bufferedToolCalls = new Map<number | string, BufferedChatCompletionToolCall>();

    try {
      for await (const chunk of response) {
        if (chunk.id) {
          this._id = chunk.id;
        }

        const rawChunk = chunk as unknown as Record<string, unknown>;
        const rawUsage = extractUsageFromChunk(rawChunk);
        if (rawUsage) {
          this._usage = extractUsage(rawUsage) ?? null;
        }

        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          this._captureFinishReason(choice.finish_reason);
        }

        const delta = choice.delta;

        const rc = (delta as unknown as Record<string, unknown>)['reasoning_content'];
        if (typeof rc === 'string' && rc) {
          yield { type: 'think', think: rc } satisfies StreamedMessagePart;
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
export class KimiChatProvider implements ChatProvider {
  readonly name: string = 'kimi';

  private _model: string;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string;
  private _defaultHeaders: Record<string, string> | undefined;
  private _generationKwargs: GenerationKwargs;
  private readonly _supportEfforts: readonly string[];
  private _client: OpenAI | undefined;
  private _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;
  private _files: KimiFiles | undefined;

  constructor(options: KimiOptions) {
    const apiKey = options.apiKey ?? process.env['KIMI_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? process.env['KIMI_BASE_URL'] ?? 'https://api.moonshot.ai/v1';
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._generationKwargs = { ...options.generationKwargs };
    this._supportEfforts = options.supportEfforts ?? [];
    this._client =
      this._apiKey === undefined
        ? undefined
        : new OpenAI({
            apiKey: this._apiKey,
            baseURL: this._baseUrl,
            defaultHeaders: this._defaultHeaders,
          });
  }

  get modelName(): string {
    return this._model;
  }

  get files(): KimiFiles {
    this._files ??= new KimiFiles({
      apiKey: this._apiKey,
      baseUrl: this._baseUrl,
      defaultHeaders: this._defaultHeaders,
      clientFactory: this._clientFactory,
    });
    return this._files;
  }

  uploadVideo(input: string | VideoUploadInput, options?: GenerateOptions) {
    return this.files.uploadVideo(input, options);
  }

  get thinkingEffort(): ThinkingEffort | null {
    const thinking = this._generationKwargs.extra_body?.thinking;
    if (thinking === undefined) return null;
    if (thinking.type === 'disabled') return 'off';
    return thinking.effort ?? 'on';
  }

  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.max_completion_tokens ?? this._generationKwargs.max_tokens;
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      baseUrl: this._baseUrl,
      ...this._generationKwargs,
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
    const normalizedHistory = normalizeToolCallIdsForProvider(history, KIMI_TOOL_CALL_ID_POLICY);
    for (const msg of normalizedHistory) {
      messages.push(convertMessage(msg));
    }

    const kwargs: Record<string, unknown> = {
      ...this._generationKwargs,
    };

    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    if (
      kwargs['max_completion_tokens'] === undefined &&
      kwargs['max_tokens'] !== undefined
    ) {
      kwargs['max_completion_tokens'] = kwargs['max_tokens'];
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete kwargs['max_tokens'];

    const { extra_body: extraBody, ...requestKwargs } = kwargs;

    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      stream: this._stream,
      ...requestKwargs,
      ...(extraBody as Record<string, unknown> | undefined),
    };

    if (tools.length > 0) {
      createParams['tools'] = tools.map((t) => convertTool(t));
    }
    if (options?.responseFormat !== undefined) {
      createParams['response_format'] = responseFormatToOpenAI(options.responseFormat);
    }

    if (this._stream) {
      createParams['stream_options'] = { include_usage: true };
    }

    try {
      const client = this._createClient(options?.auth);
      options?.onRequestSent?.();
      const response = (await client.chat.completions.create(
        createParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      )) as unknown as OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
      return new KimiStreamedMessage(response, this._stream);
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  withThinking(effort: ThinkingEffort): KimiChatProvider {
    let thinking: ThinkingConfig;
    if (effort === 'off') {
      thinking = { type: 'disabled' };
    } else {
      thinking = this._supportEfforts.includes(effort)
        ? { type: 'enabled', effort }
        : { type: 'enabled' };
    }
    const oldExtra = this._generationKwargs.extra_body ?? {};
    const keep = oldExtra.thinking?.keep;
    if (keep !== undefined) {
      thinking = { ...thinking, keep };
    }
    return this._withGenerationKwargs({
      extra_body: { ...oldExtra, thinking },
    });
  }

  withGenerationKwargs(kwargs: GenerationKwargs): KimiChatProvider {
    return this._withGenerationKwargs(kwargs);
  }

  withMaxCompletionTokens(
    maxCompletionTokens: number,
    options?: MaxCompletionTokensOptions,
  ): KimiChatProvider {
    let cap = maxCompletionTokens;
    if (
      options?.usedContextTokens !== undefined &&
      options?.maxContextTokens !== undefined &&
      options.maxContextTokens > 0
    ) {
      cap = Math.min(cap, options.maxContextTokens - options.usedContextTokens);
    }
    return this._withGenerationKwargs({ max_completion_tokens: Math.max(1, cap) });
  }

  withExtraBody(extraBody: ExtraBody): KimiChatProvider {
    const oldExtra = this._generationKwargs.extra_body ?? {};
    const merged: ExtraBody = { ...oldExtra, ...extraBody };
    const oldThinking = oldExtra.thinking;
    const newThinking = extraBody.thinking;
    if (oldThinking !== undefined && newThinking !== undefined) {
      merged.thinking = { ...oldThinking, ...newThinking };
    }
    return this._withGenerationKwargs({ extra_body: merged });
  }

  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => {
        const defaultHeaders = mergeRequestHeaders(this._defaultHeaders, a?.headers);
        return new OpenAI({
          apiKey: requireProviderApiKey('KimiChatProvider', a, this._apiKey),
          baseURL: this._baseUrl,
          defaultHeaders,
        });
      },
    );
  }

  private _withGenerationKwargs(kwargs: GenerationKwargs): KimiChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  private _clone(): KimiChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as KimiChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    clone._files = undefined;
    return clone;
  }
}
