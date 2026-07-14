import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  normalizeAPIStatusError,
} from '../errors';
import type { Message, StreamedMessagePart, ToolCall } from '../message';
import { isToolDeclarationOnlyMessage } from '../message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  ResponseFormat,
  StreamedMessage,
  ThinkingEffort,
} from '../provider';
import type { Tool } from '../tool';
import type { TokenUsage } from '../usage';
import { ApiError as GoogleApiError, GoogleGenAI as GenAIClient } from '@google/genai';
import { mergeConsecutiveUserMessages } from './merge-user-messages';

import { requireProviderApiKey, resolveAuthBackedClient } from './request-auth';

function normalizeGoogleGenAIFinishReason(raw: unknown): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  let rawString: string;
  if (typeof raw === 'string') {
    rawString = raw.toUpperCase();
  } else if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean') {
    rawString = String(raw).toUpperCase();
  } else {
    return { finishReason: null, rawFinishReason: null };
  }
  if (rawString === 'FINISH_REASON_UNSPECIFIED' || rawString === '') {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (rawString) {
    case 'STOP':
      return { finishReason: 'completed', rawFinishReason: rawString };
    case 'MAX_TOKENS':
      return { finishReason: 'truncated', rawFinishReason: rawString };
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return { finishReason: 'filtered', rawFinishReason: rawString };
    case 'MALFORMED_FUNCTION_CALL':
    case 'OTHER':
    case 'LANGUAGE':
      return { finishReason: 'other', rawFinishReason: rawString };
    default:
      return { finishReason: 'other', rawFinishReason: rawString };
  }
}
export interface GoogleGenAIOptions {
  apiKey?: string | undefined;
  model: string;
  baseUrl?: string;
  vertexai?: boolean | undefined;
  project?: string | undefined;
  location?: string | undefined;
  stream?: boolean | undefined;
  defaultHeaders?: Record<string, string>;
  clientFactory?: (auth: ProviderRequestAuth) => GenAIClient;
}

export interface GoogleGenAIGenerationKwargs {
  maxOutputTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  thinkingConfig?: ThinkingConfig;
  [key: string]: unknown;
}

interface ThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: string;
}
interface GoogleFunctionDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

interface GoogleTool {
  functionDeclarations: GoogleFunctionDeclaration[];
}

function toolToGoogleGenAI(tool: Tool): GoogleTool {
  return {
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      },
    ],
  };
}

function applyResponseFormat(
  config: Record<string, unknown>,
  format: ResponseFormat | undefined,
): void {
  if (format === undefined) return;
  config['responseMimeType'] = 'application/json';
  delete config['responseSchema'];
  delete config['responseJsonSchema'];
  if (format.type === 'json_schema') {
    config['responseJsonSchema'] = format.jsonSchema.schema;
  }
}
interface GoogleContent {
  role: string;
  parts: GooglePart[];
}

interface GooglePart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: {
    name: string;
    response: Record<string, string>;
    parts: unknown[];
  };
  thoughtSignature?: string;
  [key: string]: unknown;
}

function toolCallIdToName(toolCallId: string, toolNameById: Map<string, string>): string {
  const name = toolNameById.get(toolCallId);
  if (name !== undefined) return name;
  const match = /^(.+)_[^_]+$/.exec(toolCallId);
  return match?.[1] ?? toolCallId;
}

function convertMediaUrl(
  url: string,
  fallbackMimeType: string,
):
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType: string } } {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex === -1) {
      return { fileData: { fileUri: url, mimeType: fallbackMimeType } };
    }
    const meta = url.slice(0, commaIndex);
    const data = url.slice(commaIndex + 1);
    const colonIndex = meta.indexOf(':');
    const semiIndex = meta.indexOf(';');
    const mimeType =
      colonIndex !== -1 && semiIndex !== -1
        ? meta.slice(colonIndex + 1, semiIndex)
        : fallbackMimeType;
    return { inlineData: { mimeType, data } };
  }
  let mimeType = fallbackMimeType;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.png')) mimeType = 'image/png';
    else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (pathname.endsWith('.gif')) mimeType = 'image/gif';
    else if (pathname.endsWith('.webp')) mimeType = 'image/webp';
    else if (pathname.endsWith('.mp3') || pathname.endsWith('.mpeg')) mimeType = 'audio/mpeg';
    else if (pathname.endsWith('.wav')) mimeType = 'audio/wav';
    else if (pathname.endsWith('.ogg')) mimeType = 'audio/ogg';
  } catch {
  }
  return { fileData: { fileUri: url, mimeType } };
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) {
    return new Promise(() => {
    });
  }
  if (signal.aborted) {
    throw createAbortError();
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(createAbortError());
      },
      { once: true },
    );
  });
}

function messageToGoogleGenAI(message: Message): GoogleContent {
  if (message.role === 'tool') {
    throw new ChatProviderError(
      'Tool messages must be converted via messagesToGoogleGenAIContents.',
    );
  }

  const role = message.role === 'assistant' ? 'model' : message.role;
  const parts: GooglePart[] = [];

  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        parts.push({ text: part.text });
        break;
      case 'think':
        break;
      case 'image_url':
        parts.push(convertMediaUrl(part.imageUrl.url, 'image/jpeg'));
        break;
      case 'audio_url':
        parts.push(convertMediaUrl(part.audioUrl.url, 'audio/mpeg'));
        break;
      case 'video_url':
        parts.push(convertMediaUrl(part.videoUrl.url, 'video/mp4'));
        break;
    }
  }

  for (const toolCall of message.toolCalls) {
    let args: Record<string, unknown> = {};
    if (toolCall.arguments) {
      try {
        const parsed: unknown = JSON.parse(toolCall.arguments);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          throw new ChatProviderError('Tool call arguments must be a JSON object.');
        }
      } catch (error) {
        if (error instanceof ChatProviderError) throw error;
        throw new ChatProviderError('Tool call arguments must be valid JSON.');
      }
    }

    const functionCallPart: GooglePart = {
      functionCall: {
        name: toolCall.name,
        args,
      },
    };

    if (toolCall.extras && 'thought_signature_b64' in toolCall.extras) {
      functionCallPart['thoughtSignature'] = toolCall.extras['thought_signature_b64'] as string;
    }

    parts.push(functionCallPart);
  }

  return { role, parts };
}

function toolMessageToFunctionResponseParts(
  message: Message,
  toolNameById: Map<string, string>,
): GooglePart[] {
  if (message.role !== 'tool') {
    throw new ChatProviderError('Expected a tool message.');
  }
  if (message.toolCallId === undefined) {
    throw new ChatProviderError('Tool response is missing `toolCallId`.');
  }

  let textOutput = '';
  const mediaParts: GooglePart[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        if (part.text) textOutput += part.text;
        break;
      case 'image_url':
        mediaParts.push(convertMediaUrl(part.imageUrl.url, 'image/jpeg'));
        break;
      case 'audio_url':
        mediaParts.push(convertMediaUrl(part.audioUrl.url, 'audio/mpeg'));
        break;
      case 'video_url':
        mediaParts.push(convertMediaUrl(part.videoUrl.url, 'video/mp4'));
        break;
      case 'think':
        break;
    }
  }

  const functionResponsePart: GooglePart = {
    functionResponse: {
      name: toolCallIdToName(message.toolCallId, toolNameById),
      response: { output: textOutput },
      parts: [],
    },
  };

  return [functionResponsePart, ...mediaParts];
}

export function messagesToGoogleGenAIContents(messages: Message[]): GoogleContent[] {
  const contents: GoogleContent[] = [];
  const toolNameById = new Map<string, string>();

  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message === undefined) break;

    if (isToolDeclarationOnlyMessage(message)) {
      i += 1;
      continue;
    }

    if (message.role === 'system') {
      const text = message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      if (text.length > 0) {
        contents.push({
          role: 'user',
          parts: [{ text: `<system>${text}</system>` }],
        });
      }
      i += 1;
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      contents.push(messageToGoogleGenAI(message));
      const expectedToolCallIds: string[] = [];
      for (const toolCall of message.toolCalls) {
        toolNameById.set(toolCall.id, toolCall.name);
        expectedToolCallIds.push(toolCall.id);
      }

      let j = i + 1;
      const toolMessages: Message[] = [];
      while (j < messages.length) {
        const toolMsg = messages[j];
        if (toolMsg === undefined || toolMsg.role !== 'tool') break;
        toolMessages.push(toolMsg);
        j += 1;
      }

      if (toolMessages.length > 0) {
        const toolMsgById = new Map<string, Message>();
        const seenToolCallIds = new Set<string>();
        for (const toolMsg of toolMessages) {
          if (toolMsg.toolCallId === undefined) {
            throw new ChatProviderError('Tool response is missing `toolCallId`.');
          }
          if (seenToolCallIds.has(toolMsg.toolCallId)) {
            throw new ChatProviderError(`Duplicate tool response for id: ${toolMsg.toolCallId}`);
          }
          seenToolCallIds.add(toolMsg.toolCallId);
          toolMsgById.set(toolMsg.toolCallId, toolMsg);
        }

        const sortedToolMessages: Message[] = [];
        for (const expectedId of expectedToolCallIds) {
          const msg = toolMsgById.get(expectedId);
          if (msg === undefined) {
            throw new ChatProviderError(`Missing tool responses for ids: ${expectedId}`);
          }
          sortedToolMessages.push(msg);
          toolMsgById.delete(expectedId);
        }
        if (toolMsgById.size > 0) {
          throw new ChatProviderError(
            `Unexpected tool responses for ids: ${JSON.stringify([...toolMsgById.keys()])}`,
          );
        }

        const parts: GooglePart[] = [];
        for (const toolMsg of sortedToolMessages) {
          parts.push(...toolMessageToFunctionResponseParts(toolMsg, toolNameById));
        }
        contents.push({ role: 'user', parts });
        i = j;
        continue;
      }

      i += 1;
      continue;
    }

    if (message.role === 'tool') {
      const parts: GooglePart[] = toolMessageToFunctionResponseParts(message, toolNameById);
      contents.push({ role: 'user', parts });
      i += 1;
      continue;
    }

    contents.push(messageToGoogleGenAI(message));
    i += 1;
  }

  return mergeConsecutiveUserMessages(contents, {
    isUser: (content) => content.role === 'user',
    isToolResultOnly: (content) =>
      content.parts.length > 0 &&
      content.parts.every((part) => part.functionResponse !== undefined),
    merge: (last, next) => ({ ...last, parts: [...last.parts, ...next.parts] }),
  });
}
export class GoogleGenAIStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: AsyncIterable<Record<string, unknown>> | Record<string, unknown>,
    isStream: boolean,
    signal?: AbortSignal,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<Record<string, unknown>>,
        signal,
      );
    } else {
      this._iter = this._convertNonStreamResponse(response as Record<string, unknown>, signal);
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

  private _captureFinishReason(response: Record<string, unknown>): void {
    const candidates = response['candidates'] as unknown[] | undefined;
    if (!candidates || candidates.length === 0) {
      return;
    }
    const first = candidates[0] as Record<string, unknown> | undefined;
    if (first === undefined) {
      return;
    }
    const raw = first['finishReason'] ?? first['finish_reason'];
    if (raw === undefined) {
      return;
    }
    const normalized = normalizeGoogleGenAIFinishReason(raw);
    if (normalized.finishReason !== null || normalized.rawFinishReason !== null) {
      this._finishReason = normalized.finishReason;
      this._rawFinishReason = normalized.rawFinishReason;
    }
  }

  private _extractChunkParts(response: Record<string, unknown>): StreamedMessagePart[] {
    const parts: StreamedMessagePart[] = [];

    const candidates = response['candidates'] as unknown[] | undefined;
    for (const candidate of candidates ?? []) {
      const cand = candidate as Record<string, unknown>;
      const content = cand['content'] as Record<string, unknown> | undefined;
      const contentParts = content?.['parts'] as unknown[] | undefined;
      if (!contentParts) continue;

      for (const part of contentParts) {
        const p = part as Record<string, unknown>;
        if (p['thought'] === true && p['text']) {
          parts.push({ type: 'think', think: p['text'] as string });
        } else if (p['text']) {
          parts.push({ type: 'text', text: p['text'] as string });
        } else if (p['functionCall'] || p['function_call']) {
          const fc = (p['functionCall'] ?? p['function_call']) as Record<string, unknown>;
          const name = fc['name'] as string;
          if (!name) continue;
          const id_ = (fc['id'] as string) ?? crypto.randomUUID();
          const toolCallId = `${name}_${id_}`;
          const thoughtSigB64 = p['thoughtSignature'] ?? p['thought_signature'];
          parts.push({
            type: 'function',
            id: toolCallId,
            name,
            arguments: fc['args'] ? JSON.stringify(fc['args']) : '{}',
            ...(thoughtSigB64
              ? { extras: { thought_signature_b64: thoughtSigB64 as string } }
              : {}),
          } satisfies ToolCall);
        }
      }
    }

    return parts;
  }

  private _extractUsage(response: Record<string, unknown>): void {
    const usageMetadata = response['usageMetadata'] as Record<string, unknown> | undefined;
    if (usageMetadata) {
      const promptTokenCount =
        typeof usageMetadata['promptTokenCount'] === 'number'
          ? usageMetadata['promptTokenCount']
          : 0;
      const cachedContentTokenCount =
        typeof usageMetadata['cachedContentTokenCount'] === 'number'
          ? usageMetadata['cachedContentTokenCount']
          : 0;
      this._usage = {
        inputOther: Math.max(promptTokenCount - cachedContentTokenCount, 0),
        output: (usageMetadata['candidatesTokenCount'] as number) ?? 0,
        inputCacheRead: cachedContentTokenCount,
        inputCacheCreation: 0,
      };
    }
  }

  private _extractId(response: Record<string, unknown>): void {
    if (response['responseId'] !== undefined) {
      this._id = response['responseId'] as string;
    }
  }

  private _throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal !== undefined && signal.aborted) {
      throw createAbortError();
    }
  }

  private async *_convertNonStreamResponse(
    response: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    this._throwIfAborted(signal);
    this._extractUsage(response);
    this._extractId(response);
    this._captureFinishReason(response);
    for (const part of this._extractChunkParts(response)) {
      this._throwIfAborted(signal);
      yield part;
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    try {
      for await (const chunk of response) {
        this._throwIfAborted(signal);
        this._extractUsage(chunk);
        this._extractId(chunk);
        this._captureFinishReason(chunk);
        for (const part of this._extractChunkParts(chunk)) {
          this._throwIfAborted(signal);
          yield part;
        }
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }
}
const NETWORK_RE = /network|connection|connect|disconnect|fetch failed/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

export function convertGoogleGenAIError(error: unknown): ChatProviderError {
  if (error instanceof GoogleApiError) {
    return normalizeAPIStatusError(error.status, error.message);
  }
  if (error instanceof Error) {
    const msg = error.message;
    if (TIMEOUT_RE.test(msg)) {
      return new APITimeoutError(msg);
    }
    if (NETWORK_RE.test(msg) || (error instanceof TypeError && msg.includes('fetch'))) {
      return new APIConnectionError(msg);
    }
    const statusCode = (error as { code?: number }).code;
    if (typeof statusCode === 'number') {
      return normalizeAPIStatusError(statusCode, msg);
    }
    return new ChatProviderError(`GoogleGenAI error: ${msg}`);
  }
  return new ChatProviderError(`GoogleGenAI error: ${String(error)}`);
}
export class GoogleGenAIChatProvider implements ChatProvider {
  readonly name: string = 'google_genai';

  private _model: string;
  private _client: GenAIClient | undefined;
  private _generationKwargs: GoogleGenAIGenerationKwargs;
  private _vertexai: boolean;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _project: string | undefined;
  private _location: string | undefined;
  private _defaultHeaders: Record<string, string> | undefined;
  private _clientFactory: ((auth: ProviderRequestAuth) => GenAIClient) | undefined;

  constructor(options: GoogleGenAIOptions) {
    this._model = options.model;
    this._vertexai = options.vertexai ?? false;
    this._stream = options.stream ?? true;
    this._generationKwargs = {};

    const apiKey = options.apiKey ?? process.env['GOOGLE_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl =
      options.baseUrl === undefined || options.baseUrl.length === 0 ? undefined : options.baseUrl;
    this._project = options.project;
    this._location = options.location;
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._client =
      this._vertexai || this._apiKey !== undefined ? this._buildClient(this._apiKey) : undefined;
  }

  private _buildClient(apiKey: string | undefined): GenAIClient {
    const httpOptions: { headers?: Record<string, string>; baseUrl?: string } = {};
    if (this._defaultHeaders !== undefined) {
      httpOptions.headers = this._defaultHeaders;
    }
    if (this._baseUrl !== undefined) {
      httpOptions.baseUrl = this._baseUrl;
    }
    return new GenAIClient({
      apiKey,
      ...(this._vertexai
        ? {
            vertexai: true,
            project: this._project,
            location: this._location,
          }
        : {}),
      httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
    });
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const thinkingConfig = this._generationKwargs.thinkingConfig;
    if (thinkingConfig === undefined) return null;

    if (thinkingConfig.thinkingLevel !== undefined) {
      switch (thinkingConfig.thinkingLevel) {
        case 'MINIMAL':
          return thinkingConfig.includeThoughts === false ? 'off' : 'low';
        case 'LOW':
          return 'low';
        case 'MEDIUM':
          return 'medium';
        case 'HIGH':
          return 'high';
        default:
          return null;
      }
    }

    if (thinkingConfig.thinkingBudget !== undefined) {
      if (thinkingConfig.thinkingBudget === 0) return 'off';
      if (thinkingConfig.thinkingBudget <= 1024) return 'low';
      if (thinkingConfig.thinkingBudget <= 4096) return 'medium';
      return 'high';
    }

    return null;
  }

  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.maxOutputTokens;
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      ...this._generationKwargs,
    };
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    if (options?.signal?.aborted === true) {
      throw createAbortError();
    }

    const contents = messagesToGoogleGenAIContents(history);

    const config: Record<string, unknown> = {
      ...this._generationKwargs,
      systemInstruction: systemPrompt,
      ...(tools.length > 0 ? { tools: tools.map((t) => toolToGoogleGenAI(t)) } : {}),
    };
    applyResponseFormat(config, options?.responseFormat);

    try {
      const client = this._createClient(options?.auth);
      const models = client.models as unknown as {
        generateContent(params: Record<string, unknown>): Promise<unknown>;
        generateContentStream(params: Record<string, unknown>): Promise<AsyncGenerator>;
      };

      const params = { model: this._model, contents, config };

      options?.onRequestSent?.();
      if (this._stream) {
        const stream = await Promise.race([
          models.generateContentStream(params),
          abortPromise(options?.signal),
        ]);
        return new GoogleGenAIStreamedMessage(
          stream as AsyncIterable<Record<string, unknown>>,
          true,
          options?.signal,
        );
      }

      const response = await Promise.race([
        models.generateContent(params),
        abortPromise(options?.signal),
      ]);
      return new GoogleGenAIStreamedMessage(
        response as Record<string, unknown>,
        false,
        options?.signal,
      );
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }

  private _createClient(auth: ProviderRequestAuth | undefined): GenAIClient {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => {
        if (this._vertexai) return this._buildClient(this._apiKey);
        return this._buildClient(requireProviderApiKey('GoogleGenAIChatProvider', a, this._apiKey));
      },
    );
  }

  withThinking(effort: ThinkingEffort): GoogleGenAIChatProvider {
    const thinkingConfig: ThinkingConfig = { includeThoughts: true };

    if (this._model.includes('gemini-3')) {
      switch (effort) {
        case 'off':
          thinkingConfig.thinkingLevel = 'MINIMAL';
          thinkingConfig.includeThoughts = false;
          break;
        case 'low':
          thinkingConfig.thinkingLevel = 'LOW';
          break;
        case 'medium':
          thinkingConfig.thinkingLevel = 'MEDIUM';
          break;
        case 'high':
        case 'xhigh':
        case 'max':
          thinkingConfig.thinkingLevel = 'HIGH';
          break;
      }
    } else {
      switch (effort) {
        case 'off':
          thinkingConfig.thinkingBudget = 0;
          thinkingConfig.includeThoughts = false;
          break;
        case 'low':
          thinkingConfig.thinkingBudget = 1024;
          thinkingConfig.includeThoughts = true;
          break;
        case 'medium':
          thinkingConfig.thinkingBudget = 4096;
          thinkingConfig.includeThoughts = true;
          break;
        case 'high':
        case 'xhigh':
        case 'max':
          thinkingConfig.thinkingBudget = 32_000;
          thinkingConfig.includeThoughts = true;
          break;
      }
    }

    return this.withGenerationKwargs({ thinkingConfig });
  }

  withGenerationKwargs(kwargs: GoogleGenAIGenerationKwargs): GoogleGenAIChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  withMaxCompletionTokens(maxCompletionTokens: number): GoogleGenAIChatProvider {
    return this.withGenerationKwargs({ maxOutputTokens: maxCompletionTokens });
  }

  private _clone(): GoogleGenAIChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as GoogleGenAIChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}
