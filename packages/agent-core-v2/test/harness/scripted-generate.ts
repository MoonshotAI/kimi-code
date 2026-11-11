import {
  isContentPart,
  isToolCall,
  isToolCallPart,
  type AssistantMessage,
  type Message,
  type StreamedMessagePart,
} from '@moonshot-ai/core/llm/message';
import { anthropicProtocol } from '@moonshot-ai/core/llm/builtin/protocol/anthropic/index';
import { openAIResponsesProtocol } from '@moonshot-ai/core/llm/builtin/protocol/openai-responses/index';
import {
  kimiAnthropicProtocol,
  kimiResponsesProtocol,
} from '@moonshot-ai/core/llm/builtin/provider/kimi/protocol';
import { openAIProtocol } from '@moonshot-ai/core/llm/builtin/protocol/openai/index';
import { googleGenAIProtocol } from '@moonshot-ai/core/llm/builtin/protocol/google-genai/index';
import { APIError as RawOpenAISDKAPIError } from 'openai/error';
import type { LlmProtocolRequest, LlmRequest } from '@moonshot-ai/core/llm/request';
import type { LlmResolver } from '@moonshot-ai/core/llm/policy/resolver';
import {
  contentsOf,
  createRequester,
  requesterContents,
  type InitializedLlmRequester,
  type LlmRequestPart,
} from '@moonshot-ai/core/llm/requester';
import type { FinishReason } from '@moonshot-ai/core/llm/response';
import type { TokenUsage } from '@moonshot-ai/core/llm/usage';
import { estimateTokensForMessages } from '#/llm-adapter/contract/tokens';
import { errorFromLlmMessage, llmMessageFromError } from '#/llm-adapter/contract/errors';

import {
  generateInputSnapshot,
  generateInputsSnapshot,
  normalizeGenerateInput,
  type GenerateCall,
} from './snapshots';

export interface MockProviderHttpError {
  readonly statusCode: number;
  readonly message: string;
  readonly requestId?: string | null;
  readonly traceId?: string | null;
  readonly retryAfterMs?: number | null;
  readonly code?: string;
}

export interface MockProviderResponse {
  readonly id?: string | null;
  readonly message?: AssistantMessage;
  readonly parts?: readonly StreamedMessagePart[];
  readonly usage?: Partial<TokenUsage> | null;
  readonly finishReason?: FinishReason | null;
  readonly rawFinishReason?: string | null;
  readonly requestId?: string | null;
  readonly httpError?: MockProviderHttpError;
  readonly error?: unknown;
  readonly fetch?: typeof fetch;
  readonly onStream?: () => void;
}

export type MockProviderHandler = (
  request: LlmProtocolRequest,
  signal: AbortSignal,
) => MockProviderResponse | Promise<MockProviderResponse>;

interface PreparedAttempt {
  readonly request: LlmProtocolRequest;
  readonly result: {
    readonly id: string | null;
    readonly message: AssistantMessage;
    readonly usage: Partial<TokenUsage> | null;
    readonly finishReason: FinishReason | null;
    readonly rawFinishReason: string | null;
    readonly requestId?: string | null;
  };
  readonly parts: readonly StreamedMessagePart[];
  readonly httpError?: MockProviderHttpError;
  readonly error?: unknown;
  readonly fetch?: typeof fetch;
  readonly onStream?: () => void;
}

export interface MockProvider {
  respond(request: LlmProtocolRequest, signal: AbortSignal): PreparedAttempt | Promise<PreparedAttempt>;
  readonly fetch: typeof fetch;
}

export function generateCallOf(request: LlmProtocolRequest): GenerateCall {
  return normalizeGenerateInput({
    systemPrompt: request.profile?.systemPrompt ?? '',
    tools: (request.profile?.tools ?? []).filter((tool) => tool.deferred !== true).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
    history: structuredClone([...request.content.messages]),
  });
}

export function createMockProvider(handler: MockProviderHandler): MockProvider {
  const pending: Promise<PreparedAttempt>[] = [];
  let index = 0;
  return {
    respond: (request, signal) => {
      const attempt = (async (): Promise<PreparedAttempt> => {
        try {
          return prepareProviderAttempt(request, await handler(request, signal), index++);
        } catch (error) {
          return { ...prepareProviderAttempt(request, {}, index++), parts: [], error };
        }
      })();
      pending.push(attempt);
      return attempt;
    },
    fetch: mockProviderFetch(pending),
  };
}

export function providerHttpError(
  statusCode: number,
  message: string,
  options: Omit<MockProviderHttpError, 'statusCode' | 'message'> = {},
): MockProviderResponse {
  return { httpError: { statusCode, message, ...options } };
}

export function createMockProviderRequester(
  input: MockProviderHandler | readonly (MockProviderResponse | Error)[],
): InitializedLlmRequester {
  const responses = typeof input === 'function' ? undefined : [...input];
  const provider = createMockProvider((request, signal) => {
    if (responses === undefined) return (input as MockProviderHandler)(request, signal);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error('Unexpected provider request');
    return response;
  });
  return withMockProvider(
    createRequester().with({
      protocol: { base: openAIProtocol },
      model: { spec: { provider: 'mock', name: 'mock-model' } },
      policy: { retry: { maxAttemptsPerStep: 1 } },
      endpoint: {
        baseUrl: 'https://provider.example.test/v1',
        credentials: { resolve: () => ({ apiKey: 'test-key' }) },
      },
    }),
    provider,
  );
}

function prepareProviderAttempt(
  request: LlmProtocolRequest,
  response: MockProviderResponse,
  index: number,
): PreparedAttempt {
  const parts = normalizeProviderStreamParts(
    response.parts ?? (response.message === undefined ? [] : partsFromGeneratedMessage(response.message)),
  );
  const message = response.message ?? {
    role: 'assistant' as const,
    content: parts.filter(isContentPart),
    toolCalls: parts.filter(isToolCall),
  };
  const finishReason = response.finishReason === undefined
    ? message.toolCalls.length > 0
      ? 'tool_calls'
      : 'completed'
    : response.finishReason;
  if (response.error !== undefined) void Promise.resolve(response.error).catch(() => {});
  return {
    request,
    result: {
      id: response.id === undefined ? `mock-${String(index + 1)}` : response.id,
      message,
      usage: response.usage === undefined
        ? {
            inputOther: estimateTokensForMessages(normalizeMessagesForTokenEstimates(request.content.messages)),
            output: estimateTokensForMessages(normalizeMessagesForTokenEstimates([message])),
            inputCacheRead: 0,
            inputCacheCreation: 0,
          }
        : response.usage,
      finishReason,
      rawFinishReason: response.rawFinishReason === undefined
        ? defaultRawFinishReason(finishReason, protocolKind(request))
        : response.rawFinishReason,
      requestId: response.requestId,
    },
    parts,
    httpError: response.httpError,
    error: response.error,
    fetch: response.fetch,
    onStream: response.onStream,
  };
}

export function createScriptedGenerate() {
  const calls: GenerateCall[] = [];
  const responses: MockProviderResponse[] = [];
  let assertedCallCount = 0;

  function mockNextResponse(...response: StreamedMessagePart[]) {
    responses.push({ parts: structuredClone(response) });
  }

  function mockNextProviderResponse(input: MockProviderResponse) {
    responses.push({
      ...input,
      parts: input.parts === undefined ? undefined : structuredClone(input.parts),
      usage: input.usage === undefined ? undefined : structuredClone(input.usage),
    });
  }

  const provider = createMockProvider((request) => {
    const response = responses.shift();
    if (response === undefined) {
      throw new Error(`Unexpected generate call #${String(calls.length + 1)}`);
    }
    calls.push(generateCallOf(request));
    return response;
  });

  return {
    provider,
    calls,
    lastInput() {
      const pendingCount = calls.length - assertedCallCount;
      if (pendingCount === 0) {
        throw new Error('No unasserted LLM input. Call ctx.lastLlmInput() after an LLM call.');
      }
      if (pendingCount > 1) {
        throw new Error(
          `Expected one unasserted LLM input, but ${String(pendingCount)} were produced. ` +
            'Call ctx.lastLlmInput() after each LLM call.',
        );
      }
      assertedCallCount = calls.length;
      return generateInputSnapshot(calls.at(-1)!, calls.at(-2));
    },
    inputs() {
      const pendingCount = calls.length - assertedCallCount;
      if (pendingCount === 0) {
        throw new Error('No unasserted LLM inputs. Call ctx.llmInputs() after LLM calls.');
      }
      const pending = calls.slice(assertedCallCount);
      const previous = calls[assertedCallCount - 1];
      assertedCallCount = calls.length;
      return generateInputsSnapshot(pending, previous);
    },
    mockNextResponse,
    mockNextProviderResponse,
  };
}

function mockAttemptResolver(provider: MockProvider): LlmResolver {
  return {
    id: 'mock-provider',
    resolve: async (request, control) => {
      void Promise.resolve(provider.respond(request, control.signal));
      return request;
    },
  };
}

export function withMockProvider(
  initial: InitializedLlmRequester,
  provider: MockProvider,
): InitializedLlmRequester {
  return {
    [requesterContents]: contentsOf(initial),
    with: ((part: LlmRequestPart) =>
      withMockProvider(initial.with(part as never), provider)) as InitializedLlmRequester['with'],
    request: (rest): LlmRequest => {
      const request = initial.with({ endpoint: { fetch: provider.fetch } }).request(rest);
      const previous = request.policy?.resolvers;
      return {
        ...request,
        policy: {
          ...request.policy,
          resolvers: () => [
            ...(typeof previous === 'function' ? previous() : (previous ?? [])),
            mockAttemptResolver(provider),
          ],
        },
      };
    },
    generate: (rest, control) =>
      initial.with(rest).with({ endpoint: { fetch: provider.fetch } }).generate({}, {
        ...control,
        onAttempt: (request, context) => {
          void Promise.resolve(provider.respond(request, control.signal));
          control.onAttempt?.(request, context);
        },
      }),
  };
}

function mockProviderError(error: unknown): Error {
  const message = llmMessageFromError(error);
  if (message !== undefined) return errorFromLlmMessage(message);
  return error instanceof Error ? error : new Error(String(error));
}

function mockProviderFetch(pending: Promise<PreparedAttempt>[]): typeof fetch {
  return async (input, init) => {
    const pendingAttempt = pending.shift();
    if (pendingAttempt === undefined) {
      throw new Error('mock provider received an unscheduled fetch');
    }
    const attempt = await pendingAttempt;
    if (attempt.fetch !== undefined) return attempt.fetch(input, init);
    const headers = new Headers({ 'content-type': 'application/json' });
    const requestId = attempt.result.requestId ?? attempt.httpError?.requestId;
    const traceId = attempt.httpError?.traceId ?? requestId;
    if (traceId !== undefined && traceId !== null) headers.set('x-trace-id', traceId);
    if (requestId !== undefined && requestId !== null) headers.set('x-request-id', requestId);
    if (attempt.httpError?.retryAfterMs !== undefined && attempt.httpError.retryAfterMs !== null) {
      headers.set('retry-after-ms', String(attempt.httpError.retryAfterMs));
    }
    if (attempt.httpError !== undefined && attempt.parts.length > 0) {
      return streamFailure(attempt, headers, init?.signal ?? undefined);
    }
    if (attempt.httpError !== undefined) {
      return new Response(
        JSON.stringify({
          error: {
            message: attempt.httpError.message,
            type: 'provider_error',
            code: attempt.httpError.code ?? attempt.httpError.statusCode,
            status: googleErrorStatus(attempt.httpError.statusCode),
            requestId: attempt.httpError.requestId,
          },
        }),
        { status: attempt.httpError.statusCode, headers },
      );
    }
    if (attempt.error !== undefined) {
      if (attempt.parts.length > 0 || (attempt.result.requestId !== undefined && attempt.result.requestId !== null)) {
        return streamFailure(attempt, headers, init?.signal ?? undefined);
      }
      throw mockProviderError(attempt.error);
    }
    const result = attempt.result;
    const kind = protocolKind(attempt.request);
    if (attempt.request.protocol.stream === false) {
      return new Response(JSON.stringify(nonStreamingBody(attempt, kind, result), replacer), {
        status: 200,
        headers,
      });
    }
    const chunks = streamingChunks(attempt, kind, result);
    headers.set('content-type', 'text/event-stream');
    return chunkedResponse(attempt, chunks, headers, init?.signal ?? undefined);
  };
}

function streamFailure(attempt: PreparedAttempt, headers: Headers, signal?: AbortSignal): Response {
  const kind = protocolKind(attempt.request);
  const result = attempt.result;
  const chunks = kind === 'openai'
    ? [
        openAIChunk(attempt, result, { role: 'assistant' }),
        ...openAIStreamParts(attempt.parts).map((part) => openAIChunk(attempt, result, openAIDelta(part))),
        openAIChunk(attempt, result, {}, null, openAIUsage(result.usage)),
      ]
    : kind === 'anthropic'
      ? [
          ...anthropicChunks(attempt, result).slice(0, -2),
          {
            type: 'message_delta',
            delta: { stop_reason: null, stop_sequence: null },
            usage: anthropicUsage(result.usage),
          },
        ]
      : kind === 'responses'
        ? responsesChunks(attempt, result)
        : [googleResponse(attempt, result)];
  headers.set('content-type', 'text/event-stream');
  return chunkedResponse(attempt, chunks, headers, signal);
}

function chunkedResponse(
  attempt: PreparedAttempt,
  chunks: readonly Record<string, unknown>[],
  headers: Headers,
  signal?: AbortSignal,
): Response {
  const events = chunks.map((chunk) => {
    const event = protocolKind(attempt.request) === 'anthropic' ? `event: ${String(chunk['type'])}\n` : '';
    return `${event}data: ${JSON.stringify(chunk, replacer)}\n\n`;
  });
  if (protocolKind(attempt.request) !== 'google' && attempt.httpError === undefined && attempt.error === undefined) {
    events.push('data: [DONE]\n\n');
  }
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (signal?.aborted === true) {
          controller.error(signal.reason);
          return;
        }
        if (index < events.length) {
          controller.enqueue(new TextEncoder().encode(events[index++]!));
          return;
        }
        attempt.onStream?.();
        if (attempt.httpError !== undefined) {
          controller.error(new RawOpenAISDKAPIError(
            attempt.httpError.statusCode,
            {
              message: attempt.httpError.message,
              code: attempt.httpError.statusCode,
              type: 'provider_error',
            },
            attempt.httpError.message,
            headers,
          ));
          return;
        }
        if (attempt.error !== undefined) {
          controller.error(mockProviderError(attempt.error));
          return;
        }
        controller.close();
      },
    }),
    { status: 200, headers },
  );
}

function googleErrorStatus(statusCode: number): string {
  switch (statusCode) {
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'PERMISSION_DENIED';
    case 413:
    case 429:
      return 'RESOURCE_EXHAUSTED';
    case 529:
      return 'OVERLOADED';
    case 503:
      return 'UNAVAILABLE';
    default:
      return 'INVALID_ARGUMENT';
  }
}

function protocolKind(request: LlmProtocolRequest): 'openai' | 'anthropic' | 'responses' | 'google' {
  const base = request.protocol.base;
  if (base.client === anthropicProtocol.client || base.client === kimiAnthropicProtocol.client) return 'anthropic';
  if (base.client === openAIResponsesProtocol.client || base.client === kimiResponsesProtocol.client) return 'responses';
  if (base.client === googleGenAIProtocol.client) return 'google';
  return 'openai';
}

function googleResponse(
  attempt: PreparedAttempt,
  result: PreparedAttempt['result'],
): Record<string, unknown> {
  return {
    responseId: result.id ?? undefined,
    candidates: [
      {
        content: { role: 'model', parts: attempt.parts.flatMap(googlePart) },
        finishReason: result.rawFinishReason ?? undefined,
      },
    ],
    usageMetadata: googleUsage(result.usage),
  };
}

function googlePart(part: StreamedMessagePart): Record<string, unknown>[] {
  switch (part.type) {
    case 'text':
      return [{ text: part.text, thoughtSignature: part.meta?.['thought_signature_b64'] }];
    case 'think':
      return [{ text: part.think, thought: true, thoughtSignature: part.encrypted }];
    case 'function':
      return [{
        functionCall: {
          id: part.rawId,
          name: part.name,
          args: JSON.parse(part.arguments ?? '{}') as Record<string, unknown>,
        },
        thoughtSignature: part.extras?.['thought_signature_b64'],
      }];
    case 'tool_call_part':
      return [];
    case 'image_url':
      return [googleMediaPart(part.imageUrl.url, 'image/jpeg')];
    case 'audio_url':
      return [googleMediaPart(part.audioUrl.url, 'audio/mpeg')];
    case 'video_url':
      return [googleMediaPart(part.videoUrl.url, 'video/mp4')];
  }
}

function googleMediaPart(url: string, mimeType: string): Record<string, unknown> {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    const metadata = commaIndex === -1 ? '' : url.slice(0, commaIndex);
    const data = commaIndex === -1 ? url : url.slice(commaIndex + 1);
    const mediaType = metadata.split(':')[1]?.split(';')[0] ?? mimeType;
    return { inlineData: { mimeType: mediaType, data } };
  }
  return { fileData: { fileUri: url, mimeType } };
}

function googleUsage(usage: Partial<TokenUsage> | null): Record<string, unknown> | undefined {
  if (usage === null) return undefined;
  return {
    promptTokenCount: (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0),
    candidatesTokenCount: usage.output ?? 0,
    cachedContentTokenCount: usage.inputCacheRead,
  };
}

function nonStreamingBody(
  attempt: PreparedAttempt,
  kind: 'openai' | 'anthropic' | 'responses' | 'google',
  result: PreparedAttempt['result'],
): Record<string, unknown> {
  const content = result.message.content.filter(isContentPart);
  const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('');
  const thinking = content.filter((part) => part.type === 'think').map((part) => part.think).join('');
  const toolCalls = result.message.toolCalls;
  if (kind === 'google') return googleResponse(attempt, result);
  if (kind === 'anthropic') {
    return {
      id: result.id ?? 'mock',
      type: 'message',
      role: 'assistant',
      model: attempt.request.model.spec.name,
      content: anthropicBlocks(attempt.parts),
      stop_reason: anthropicStopReason(result),
      usage: anthropicUsage(result.usage),
    };
  }
  if (kind === 'responses') {
    return {
      id: result.id ?? 'mock',
      object: 'response',
      created: 0,
      model: attempt.request.model.spec.name,
      output: [
        {
          type: 'message',
          id: result.id ?? 'mock',
          role: 'assistant',
          content: text.length > 0 ? [{ type: 'output_text', text }] : [],
        },
      ],
      status: 'completed',
      usage: openAIUsage(result.usage),
    };
  }
  return {
    id: result.id ?? 'mock',
    object: 'chat.completion',
    created: 0,
    model: attempt.request.model.spec.name,
    choices: [
      {
        index: 0,
        finish_reason: openAIFinishReason(result),
        message: {
          role: 'assistant',
          content: text,
          reasoning_content: thinking.length > 0 ? thinking : undefined,
          tool_calls: toolCalls.length > 0
            ? toolCalls.map((part, index) => openAIToolCall({ ...part, _streamIndex: part._streamIndex ?? index }))
            : undefined,
        },
      },
    ],
    usage: openAIUsage(result.usage),
  };
}

function streamingChunks(
  attempt: PreparedAttempt,
  kind: 'openai' | 'anthropic' | 'responses' | 'google',
  result: PreparedAttempt['result'],
): Record<string, unknown>[] {
  if (kind === 'google') return [googleResponse(attempt, result)];
  if (kind === 'anthropic') return anthropicChunks(attempt, result);
  if (kind === 'responses') return responsesChunks(attempt, result);
  const chunks: Record<string, unknown>[] = [
    openAIChunk(attempt, result, { role: 'assistant' }),
    ...openAIStreamParts(attempt.parts).map((part) => openAIChunk(attempt, result, openAIDelta(part))),
    openAIChunk(attempt, result, {}, openAIFinishReason(result), openAIUsage(result.usage)),
  ];
  return chunks;
}

function openAIStreamParts(parts: readonly StreamedMessagePart[]): StreamedMessagePart[] {
  let toolCallIndex = 0;
  return parts.map((part) =>
    part.type === 'function'
      ? { ...part, _streamIndex: part._streamIndex ?? toolCallIndex++ }
      : part
  );
}

function openAIChunk(
  attempt: PreparedAttempt,
  result: PreparedAttempt['result'],
  delta: Record<string, unknown>,
  finishReason?: string | null,
  usage?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: result.id ?? 'mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: attempt.request.model.spec.name,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    usage,
  };
}

function openAIDelta(part: StreamedMessagePart): Record<string, unknown> {
  switch (part.type) {
    case 'text':
      return { content: part.text };
    case 'think':
      if (part.encrypted !== undefined || part.reasoningKey === 'reasoning_details') {
        return {
          reasoning_details: [
            {
              type: 'summary',
              index: part.detailsIndex ?? 0,
              summary: part.think,
            },
            {
              type: 'encrypted',
              index: part.detailsIndex ?? 0,
              summary: '',
              encrypted: part.encrypted,
            },
          ],
        };
      }
      return { reasoning_content: part.think };
    case 'function':
      return { tool_calls: [openAIToolCall(part)] };
    case 'tool_call_part':
      return {
        tool_calls: [
          {
            index: part.index ?? 0,
            function: { arguments: part.argumentsPart },
          },
        ],
      };
    default:
      return { content: '' };
  }
}

function openAIToolCall(part: Extract<StreamedMessagePart, { type: 'function' }>): Record<string, unknown> {
  return {
    index: part._streamIndex ?? 0,
    id: part.id,
    type: 'function',
    function: { name: part.name, arguments: part.arguments },
    extras: part.extras,
  };
}

function anthropicChunks(
  attempt: PreparedAttempt,
  result: PreparedAttempt['result'],
): Record<string, unknown>[] {
  const chunks: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        id: result.id ?? 'mock',
        type: 'message',
        role: 'assistant',
        model: attempt.request.model.spec.name,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  ];
  for (const [index, part] of attempt.parts.entries()) {
    const block = anthropicBlock(part);
    if (block === undefined) continue;
    chunks.push({ type: 'content_block_start', index, content_block: block });
    const delta = anthropicDelta(part);
    if (delta !== undefined) chunks.push({ type: 'content_block_delta', index, delta });
    chunks.push({ type: 'content_block_stop', index });
  }
  chunks.push({
    type: 'message_delta',
    delta: { stop_reason: anthropicStopReason(result), stop_sequence: null },
    usage: anthropicUsage(result.usage),
  });
  chunks.push({ type: 'message_stop' });
  return chunks;
}

function anthropicBlocks(parts: readonly StreamedMessagePart[]): Record<string, unknown>[] {
  return parts.flatMap((part) => {
    const block = anthropicBlock(part);
    return block === undefined ? [] : [block];
  });
}

function anthropicBlock(part: StreamedMessagePart): Record<string, unknown> | undefined {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return { type: 'thinking', thinking: part.think, signature: part.encrypted };
    case 'function':
      return { type: 'tool_use', id: part.id, name: part.name, input: JSON.parse(part.arguments ?? '{}') };
    default:
      return undefined;
  }
}

function anthropicDelta(part: StreamedMessagePart): Record<string, unknown> | undefined {
  switch (part.type) {
    case 'text':
      return { type: 'text_delta', text: part.text };
    case 'think':
      return { type: 'thinking_delta', thinking: part.think };
    case 'tool_call_part':
      return { type: 'input_json_delta', partial_json: part.argumentsPart };
    default:
      return undefined;
  }
}

function responsesChunks(
  attempt: PreparedAttempt,
  result: PreparedAttempt['result'],
): Record<string, unknown>[] {
  const text = attempt.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return [
    {
      type: 'response.output_text.delta',
      item_id: result.id ?? 'mock',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.completed',
      response: nonStreamingBody(attempt, 'responses', result),
    },
  ];
}

function openAIUsage(usage: Partial<TokenUsage> | null): Record<string, unknown> | undefined {
  if (usage === null) return undefined;
  const inputOther = usage.inputOther ?? 0;
  const inputCacheRead = usage.inputCacheRead ?? 0;
  const inputCacheCreation = usage.inputCacheCreation ?? 0;
  const output = usage.output ?? 0;
  return {
    prompt_tokens: inputOther + inputCacheRead + inputCacheCreation,
    completion_tokens: output,
    total_tokens: inputOther + inputCacheRead + inputCacheCreation + output,
    prompt_tokens_details: { cached_tokens: inputCacheRead },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

function anthropicUsage(usage: Partial<TokenUsage> | null): Record<string, unknown> {
  return {
    input_tokens: usage === null ? 0 : (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0),
    output_tokens: usage?.output ?? 0,
    cache_read_input_tokens: usage?.inputCacheRead ?? 0,
    cache_creation_input_tokens: usage?.inputCacheCreation ?? 0,
  };
}

function openAIFinishReason(result: PreparedAttempt['result']): string | null {
  if (result.rawFinishReason !== null) return result.rawFinishReason;
  if (result.finishReason === 'filtered') return 'content_filter';
  if (result.finishReason === null) return null;
  return result.finishReason === 'completed' ? 'stop' : result.finishReason;
}

function anthropicStopReason(result: PreparedAttempt['result']): string | null {
  if (result.rawFinishReason !== null) return result.rawFinishReason;
  if (result.finishReason === null) return null;
  switch (result.finishReason) {
    case 'completed':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'truncated':
      return 'max_tokens';
    case 'filtered':
      return 'refusal';
    case 'paused':
      return 'pause_turn';
    default:
      return 'other';
  }
}

function partsFromGeneratedMessage(message: AssistantMessage): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [
    ...message.content.map((part) => structuredClone(part)),
    ...message.toolCalls.map((part) => structuredClone(part)),
  ];
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

function normalizeProviderStreamParts(
  parts: readonly StreamedMessagePart[],
): StreamedMessagePart[] {
  const normalized: StreamedMessagePart[] = [];
  const pendingIndexedDeltas = new Map<number | string, StreamedMessagePart[]>();
  const seenIndexes = new Set<number | string>();

  for (const part of parts) {
    if (isToolCallPart(part) && part.index !== undefined && !seenIndexes.has(part.index)) {
      const pending = pendingIndexedDeltas.get(part.index) ?? [];
      pending.push(structuredClone(part));
      pendingIndexedDeltas.set(part.index, pending);
      continue;
    }

    normalized.push(structuredClone(part));

    if (isToolCall(part) && part._streamIndex !== undefined) {
      seenIndexes.add(part._streamIndex);
      const pending = pendingIndexedDeltas.get(part._streamIndex);
      if (pending !== undefined) {
        pendingIndexedDeltas.delete(part._streamIndex);
        normalized.push(...pending);
      }
    }
  }

  for (const pending of pendingIndexedDeltas.values()) {
    normalized.push(...pending);
  }

  return normalized;
}

function normalizeMessagesForTokenEstimates(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((part) =>
      part.type === 'text'
        ? {
            ...part,
            text: part.text.replaceAll(/^Plan file: .+$/gm, 'Plan file: <plan-file>'),
          }
        : part,
    ),
  }));
}

function defaultRawFinishReason(
  finishReason: FinishReason | null,
  kind: 'openai' | 'anthropic' | 'responses' | 'google',
): string | null {
  if (finishReason === null) return null;
  if (kind === 'google') {
    switch (finishReason) {
      case 'completed':
      case 'tool_calls':
        return 'STOP';
      case 'truncated':
        return 'MAX_TOKENS';
      case 'filtered':
        return 'SAFETY';
      default:
        return 'OTHER';
    }
  }
  if (kind === 'anthropic') {
    switch (finishReason) {
      case 'completed':
        return 'end_turn';
      case 'tool_calls':
        return 'tool_use';
      case 'truncated':
        return 'max_tokens';
      case 'filtered':
        return 'refusal';
      case 'paused':
        return 'pause_turn';
      default:
        return 'other';
    }
  }
  if (finishReason === 'filtered') return 'content_filter';
  if (finishReason === 'completed') return 'stop';
  return finishReason;
}

function replacer(_key: string, value: unknown): unknown {
  return value === undefined ? null : value;
}
