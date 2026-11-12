import { expect, it } from 'vitest';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import { createUserMessage, type Message, type StreamedMessagePart } from '#/llm/message';
import type { DecodeSink, LlmModule, Protocol } from '#/llm/protocol/protocol';
import type {
  LlmEndpoint,
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
  readonly response:
    | {
        readonly status?: number;
        readonly headers?: Record<string, string>;
        readonly json: unknown;
        readonly sse?: never;
      }
    | {
        readonly status?: number;
        readonly headers?: Record<string, string>;
        readonly json?: never;
        readonly sse: {
          readonly events: readonly unknown[];
          readonly eventNames?: boolean;
          readonly done?: boolean;
        };
      };
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
  },
): Promise<{ outcome: LlmOutcome; events: LlmRunEvent[] }> {
  const events: LlmRunEvent[] = [];
  const requester = createRequester().with({
    protocol: {
      base: protocol,
      options: input.module.options,
      stream: input.stream,
    },
    endpoint: input.endpoint ?? { clientFactory: () => protocol.client({}, input.module.options) },
  });
  const outcome = await requester.generate(
    {
      model: input.module.model,
      profile: input.module.profile,
      content: {
        messages: input.module.content.messages,
        usedTokens: input.module.content.usedTokens,
      },
      policy: { retry: { maxAttemptsPerStep: 1 } },
    },
    {
      signal: input.signal ?? new AbortController().signal,
      onEvent: (event) => events.push(event),
    },
  );
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

export async function* asyncChunks<T>(chunks: readonly T[]): AsyncGenerator<T> {
  yield* chunks;
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

export function jsonResponse(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
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

export async function requestJson(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<{ request: Request; body: unknown }> {
  const request = new Request(input, init);
  return { request, body: await request.json() };
}

export function runTransportFixtures<TOptions, TRequest, TResponse, TChunk, TClient>(
  protocol: Protocol<TOptions, TRequest, TResponse, TChunk, TClient>,
  fixtures: readonly TransportFixture<TOptions>[],
): void {
  it.each(fixtures)('$name', async (fixture) => {
    const calls: { request: Request; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(await requestJson(input, init));
      if (fixture.response.sse !== undefined) {
        const sse = fixture.response.sse;
        return sseResponse(sse.events, {
          headers: fixture.response.headers,
          eventNames: sse.eventNames,
          done: sse.done,
        });
      }
      return jsonResponse(fixture.response.json, {
        status: fixture.response.status,
        headers: fixture.response.headers,
      });
    };
    const { apiKey, ...endpoint } = fixture.endpoint;
    const { outcome } = await runGenerate(protocol, {
      module: fixture.module,
      endpoint: {
        ...endpoint,
        credentials: { resolve: () => ({ apiKey }) },
        fetch,
      },
      stream: fixture.stream,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.request.url).toBe(fixture.expected.url);
    expect(call.request.method).toBe(fixture.expected.method ?? 'POST');
    for (const [name, value] of Object.entries(fixture.expected.headers ?? {})) {
      expect(call.request.headers.get(name)).toBe(value);
    }
    if (fixture.expected.body !== undefined) {
      expect(call.body).toMatchObject(fixture.expected.body);
    }
    expect(outcome).toMatchObject(fixture.expected.outcome);
  });
}
