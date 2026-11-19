import type { FixtureResponse, RawWireId } from '@copilotkit/aimock';
import { useAimock } from '@copilotkit/aimock/vitest';
import { beforeEach, expect, it } from 'vitest';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import {
  createMessageAccumulator,
  createUserMessage,
  type AssistantMessage,
  type Message,
  type StreamedMessagePart,
} from '#/llm/message';
import type { LlmPolicy } from '#/llm/policy/policy';
import type { DecodeSink, LlmModule, Protocol } from '#/llm/protocol/protocol';
import type {
  LlmEndpoint,
  LlmRequest,
  LlmRequestModel,
  LlmRequestProfile,
} from '#/llm/request';
import { createRequester } from '#/llm/requester';
import type {
  FinishInfo,
  LlmOutcome,
  LlmRemoteErrorMessage,
  LlmRunEvent,
  TokenUsage,
} from '#/llm/response';

export const TEST_MODEL: LlmRequestModel = {
  spec: {
    provider: 'test',
    name: 'test-model',
    capability: {
      image_in: true,
      video_in: true,
      audio_in: true,
      thinking: true,
      tool_use: true,
    },
  },
};

export function testModule<TOptions>(
  input: {
    model?: LlmRequestModel;
    profile?: LlmRequestProfile;
    messages?: readonly Message[];
    usedTokens?: number;
    options?: TOptions;
  } = {},
): LlmModule<TOptions> {
  return {
    model: input.model ?? TEST_MODEL,
    profile: input.profile ?? {},
    content: {
      messages: input.messages ?? [createUserMessage('hi')],
      usedTokens: input.usedTokens,
    },
    options: input.options,
  };
}

export interface MockResponse {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly sse?: {
    readonly events: readonly unknown[];
    readonly eventNames?: boolean;
    readonly done?: boolean;
  };
}

export function useAimockServer(): ReturnType<typeof useAimock> {
  const server = useAimock({
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    strict: true,
    auth: { apiKeys: ['test-key'] },
  });
  beforeEach(() => {
    const { llm } = server();
    llm.clearFixtures();
    llm.clearRequests();
    llm.resetMatchCounts();
  });
  return server;
}

export function aimockEndpoint(url: string, basePath = '/v1'): LlmEndpoint {
  return {
    baseUrl: `${url}${basePath}`,
    credentials: { resolve: () => ({ apiKey: 'test-key' }) },
  };
}

export function rawMockResponse(wire: RawWireId, response: MockResponse): FixtureResponse {
  if (response.sse !== undefined) {
    return {
      raw: {
        wire,
        events: response.sse.events as Record<string, unknown>[],
        status: response.status,
        headers: response.headers,
        done: wire === 'openai-chat' ? response.sse.done : undefined,
      },
    };
  }
  return {
    raw: {
      wire,
      json: response.json,
      status: response.status,
      headers: response.headers,
    },
  };
}

export function openAIChunk(
  delta: Record<string, unknown>,
  options: {
    id?: string;
    finishReason?: string;
    usage?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    id: options.id,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: options.finishReason ?? null }],
    usage: options.usage,
  })) as Record<string, unknown>;
}

export function openAICompletion(
  message: Record<string, unknown>,
  options: {
    id?: string;
    finishReason?: string;
    usage?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    id: options.id,
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', ...message },
      finish_reason: options.finishReason ?? null,
    }],
    usage: options.usage,
  })) as Record<string, unknown>;
}

export function accumulatedMessage(parts: readonly StreamedMessagePart[]): AssistantMessage {
  const accumulator = createMessageAccumulator();
  for (const part of parts) accumulator.push(part);
  return accumulator.finish();
}

export interface EncodeFixture<TOptions> {
  readonly name: string;
  readonly module: LlmModule<TOptions>;
  readonly expected?: unknown;
  readonly expectedError?: RegExp;
}

export type DecodedEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'finish'; readonly finish: FinishInfo }
  | { readonly type: 'messageId'; readonly messageId: string }
  | { readonly type: 'usage'; readonly usage: Partial<TokenUsage> }
  | { readonly type: 'error'; readonly error: LlmRemoteErrorMessage }
  | { readonly type: 'toolCallEnd'; readonly index?: number | string };

export interface DecodeFixture<TOptions, TResponse, TChunk> {
  readonly name: string;
  readonly module?: LlmModule<TOptions>;
  readonly chunks: readonly TChunk[];
  readonly expected?: readonly DecodedEvent[];
  readonly expectedError?: RegExp;
  readonly replay?: {
    readonly response: TResponse;
    readonly expected?: readonly DecodedEvent[];
  };
}

export interface TransportFixture<TOptions> {
  readonly name: string;
  readonly module: LlmModule<TOptions>;
  readonly endpoint: Omit<ResolvedEndpoint, 'fetch'> & Pick<LlmEndpoint, 'defaultBaseUrl'>;
  readonly stream?: boolean;
  readonly rawRequest?: boolean;
  readonly response: MockResponse;
  readonly expected: {
    readonly url: string;
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: Record<string, unknown>;
    readonly outcome: Record<string, unknown>;
  };
}

export function runEncodeFixtures<TOptions, TRequest, TResponse, TChunk, TClient>(
  protocol: Protocol<TOptions, TRequest, TResponse, TChunk, TClient>,
  fixtures: readonly EncodeFixture<TOptions>[],
): void {
  it.each(fixtures)('$name', (fixture) => {
    if (fixture.expectedError !== undefined) {
      expect(() => protocol.encode(fixture.module)).toThrow(fixture.expectedError);
      return;
    }
    expect(protocol.encode(fixture.module)).toEqual(fixture.expected);
  });
}

function decodeChunks<TOptions, TRequest, TResponse, TChunk, TClient>(
  protocol: Protocol<TOptions, TRequest, TResponse, TChunk, TClient>,
  module: LlmModule<TOptions>,
  chunks: Iterable<TChunk>,
): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  const sink: DecodeSink = {
    onDelta: (part) => events.push({ type: 'part', part }),
    onFinish: (finish) => events.push({ type: 'finish', finish }),
    onMessageId: (messageId) => events.push({ type: 'messageId', messageId }),
    onUsage: (usage) => events.push({ type: 'usage', usage }),
    onError: (error) => events.push({ type: 'error', error }),
    onToolCallEnd: (index) => events.push({ type: 'toolCallEnd', index }),
  };
  const decoder = protocol.decoder(module, sink);
  for (const chunk of chunks) decoder.push(chunk);
  decoder.end();
  return events;
}

export function runDecodeFixtures<TOptions, TRequest, TResponse, TChunk, TClient>(
  protocol: Protocol<TOptions, TRequest, TResponse, TChunk, TClient>,
  fixtures: readonly DecodeFixture<TOptions, TResponse, TChunk>[],
): void {
  it.each(fixtures)('$name', (fixture) => {
    const module = fixture.module ?? testModule<TOptions>();
    if (fixture.expectedError !== undefined) {
      expect(() => decodeChunks(protocol, module, fixture.chunks)).toThrow(fixture.expectedError);
      return;
    }
    expect(decodeChunks(protocol, module, fixture.chunks)).toEqual(fixture.expected);
    if (fixture.replay !== undefined) {
      expect(decodeChunks(
        protocol,
        module,
        protocol.replay(fixture.replay.response),
      )).toEqual(fixture.replay.expected ?? fixture.expected);
    }
  });
}

export async function runGenerate<TOptions, TRequest, TResponse, TChunk, TClient>(
  protocol: Protocol<TOptions, TRequest, TResponse, TChunk, TClient>,
  input: {
    module: LlmModule<TOptions>;
    endpoint?: LlmEndpoint;
    stream?: boolean;
    signal?: AbortSignal;
    maxAttemptsPerStep?: number;
    infiniteRetry?: boolean;
    recoveries?: NonNullable<LlmRequest['policy']>['recoveries'];
    resolvers?: NonNullable<LlmRequest['policy']>['resolvers'];
    policy?: LlmPolicy;
    onEvent?: (event: LlmRunEvent) => void;
  },
): Promise<{ outcome: LlmOutcome; events: LlmRunEvent[] }> {
  const events: LlmRunEvent[] = [];
  const requester = createRequester().with({
    protocol: {
      base: protocol,
      options: input.module.options,
      stream: input.stream,
    },
    endpoint: input.endpoint,
  });
  const outcome = await requester.generate(
    {
      model: input.module.model,
      profile: input.module.profile,
      content: {
        messages: input.module.content.messages,
        usedTokens: input.module.content.usedTokens,
      },
      policy: input.policy ?? {
        retry: {
          maxAttemptsPerStep: input.maxAttemptsPerStep ?? 1,
          infiniteRetry: input.infiniteRetry,
        },
        recoveries: input.recoveries,
        resolvers: input.resolvers,
      },
    },
    {
      signal: input.signal ?? new AbortController().signal,
      onEvent: (event) => {
        events.push(event);
        input.onEvent?.(event);
      },
    },
  );
  expect(events.filter((event) => event.type === 'llm.started')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'llm.ended')).toHaveLength(1);
  expect(events[0]?.type).toBe('llm.started');
  expect(events.at(-1)?.type).toBe('llm.ended');
  const firstRequested = events.findIndex((event) => event.type === 'llm.requested');
  const deltas = events.filter((entry) => entry.type.startsWith('llm.delta.'));
  const deltaOrderValid = firstRequested < 0
    ? deltas.length === 0
    : deltas.every((event) => events.indexOf(event) > firstRequested);
  expect(deltaOrderValid).toBe(true);
  return { outcome, events };
}

export function doneOutcome(outcome: LlmOutcome): Extract<LlmOutcome, { type: 'done' }> {
  if (outcome.type !== 'done') throw new Error(`Expected done outcome, got ${outcome.type}`);
  return outcome;
}

export function failedOutcome(outcome: LlmOutcome): Extract<LlmOutcome, { type: 'failed' }> {
  if (outcome.type !== 'failed') throw new Error(`Expected failed outcome, got ${outcome.type}`);
  return outcome;
}

export async function* asyncChunks<T>(chunks: Iterable<T>): AsyncGenerator<T> {
  yield* chunks;
}

export function sseResponse(
  events: readonly unknown[],
  options: {
    headers?: Record<string, string>;
    eventNames?: boolean;
    done?: boolean;
  } = {},
): Response {
  const lines = events.map((event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    if (options.eventNames !== true || typeof event !== 'object' || event === null) return data;
    const type = (event as { type?: unknown }).type;
    return typeof type === 'string' ? `event: ${type}\n${data}` : data;
  });
  if (options.done !== false) lines.push('data: [DONE]\n\n');
  return new Response(lines.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...options.headers },
  });
}

export interface SdkReply<T> {
  withResponse(): Promise<{ data: T; response: Response }>;
}

export function sdkReply<T>(body: T, headers?: Record<string, string>): SdkReply<T> {
  return {
    withResponse: async () => ({
      data: body,
      response: new Response(null, { status: 200, headers }),
    }),
  };
}

interface TransportCall {
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function mountMockResponse(
  server: ReturnType<typeof useAimock>,
  path: string,
  response: MockResponse,
): TransportCall[] {
  const calls: TransportCall[] = [];
  server().llm.mount(path, {
    handleRequest: async (request, res) => {
      if (response.sse !== undefined) throw new Error('Mounted SSE fixtures are not supported');
      let text = '';
      for await (const chunk of request) text += String(chunk);
      const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.join(', ') : value ?? '',
      ]));
      calls.push({
        path: request.url ?? '',
        method: request.method ?? '',
        headers,
        body: text.length === 0 ? null : JSON.parse(text),
      });
      res.writeHead(response.status ?? 200, {
        'content-type': 'application/json',
        ...response.headers,
      });
      res.end(JSON.stringify(response.json));
      return true;
    },
  });
  return calls;
}

export function runTransportFixtures<TOptions, TRequest, TResponse, TChunk, TClient>(
  protocol: Protocol<TOptions, TRequest, TResponse, TChunk, TClient>,
  fixtures: readonly TransportFixture<TOptions>[],
  wire: RawWireId,
): void {
  const server = useAimockServer();
  it.each(fixtures)('$name', async (fixture) => {
    const { apiKey, ...endpoint } = fixture.endpoint;
    const declaredBaseUrl = endpoint.baseUrl ?? endpoint.defaultBaseUrl;
    if (declaredBaseUrl === undefined) throw new Error(`Missing base URL for ${fixture.name}`);
    const baseUrl = new URL(declaredBaseUrl);
    const mountedCalls = fixture.rawRequest === true
      ? mountMockResponse(server, new URL(fixture.expected.url).pathname, fixture.response)
      : wire === 'gemini' && baseUrl.pathname.startsWith('/proxy/')
        ? mountMockResponse(server, '/proxy', fixture.response)
        : undefined;
    if (mountedCalls === undefined) {
      server().llm.on({ predicate: () => true }, rawMockResponse(wire, fixture.response));
    }
    const { outcome } = await runGenerate(protocol, {
      module: fixture.module,
      endpoint: {
        ...endpoint,
        baseUrl: `${server().url}${baseUrl.pathname}${baseUrl.search}`,
        defaultBaseUrl: undefined,
        credentials: { resolve: () => ({ apiKey }) },
      },
      stream: fixture.stream,
    });

    const calls = mountedCalls ?? server().llm.getRequests().map((call) => ({
      path: call.path,
      method: call.method,
      headers: call.headers,
      body: call.body,
    }));
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const expectedUrl = new URL(fixture.expected.url);
    expect(call.path).toBe(`${expectedUrl.pathname}${expectedUrl.search}`);
    expect(call.method).toBe(fixture.expected.method ?? 'POST');
    for (const [name, value] of Object.entries(fixture.expected.headers ?? {})) {
      const actual = call.headers[name];
      expect(actual === '[REDACTED]' || actual === value).toBe(true);
    }
    if (fixture.expected.body !== undefined) {
      expect(call.body).toMatchObject(fixture.expected.body);
    }
    expect(outcome).toMatchObject(fixture.expected.outcome);
  });
}
