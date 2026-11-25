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
import type { LlmRequest } from '@moonshot-ai/core/llm/request';
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
import {
  call,
  createFakeModel,
  disconnect,
  finishWith,
  held,
  httpError,
  networkError,
  reply,
  say,
  streamError,
  think,
  thinkSigned,
  unitsOf,
  withResponseId,
  withUsage,
  type FakeModel,
  type HttpErrorOptions,
  type Lane,
  type ReplyStep,
  type ScriptedStep,
} from '@moonshot-ai/testkit/model';
import { afterEach } from 'vitest';

import { isError2 } from '#/_base/errors/errors';
import { estimateTokensForMessages } from '#/llm-adapter/contract/tokens';
import { ChatProviderError, errorFromLlmMessage, llmMessageFromError } from '#/llm-adapter/contract/errors';

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
  readonly onStream?: () => void | Promise<void>;
  readonly step?: ScriptedStep;
}

export type MockProviderHandler = (
  request: LlmRequest,
  signal: AbortSignal,
) => MockProviderResponse | Promise<MockProviderResponse>;

export interface MockProviderOptions {
  readonly checkMessages?: boolean;
  readonly checkCalls?: boolean;
}

interface StreamPause {
  readonly name: string;
  readonly hangs: boolean;
  readonly onStream?: () => void | Promise<void>;
}

interface PreparedAttempt {
  readonly request: LlmRequest;
  readonly signal?: AbortSignal;
  readonly step?: ScriptedStep;
  readonly fault?: unknown;
  readonly pause?: StreamPause;
}

export interface MockProvider {
  respond(request: LlmRequest, signal: AbortSignal): PreparedAttempt | Promise<PreparedAttempt>;
  readonly fetch: typeof fetch;
}

const UNSCRIPTED = Symbol('unscripted');

class ScriptTranslationError extends Error {}

type ScriptedHandler = (
  request: LlmRequest,
  signal: AbortSignal,
) => MockProviderResponse | typeof UNSCRIPTED | Promise<MockProviderResponse | typeof UNSCRIPTED>;

type ScriptedCheck = () => readonly string[];

const scriptedChecks = new Set<ScriptedCheck>();
const retiredProblems: string[] = [];

export function takeScriptedModelProblems(): string[] {
  return [...retiredProblems.splice(0), ...[...scriptedChecks].flatMap((check) => check())];
}

function retireChecks(checks: readonly ScriptedCheck[]): void {
  for (const check of checks) {
    retiredProblems.push(...check());
    scriptedChecks.delete(check);
  }
}

afterEach(() => {
  const problems = takeScriptedModelProblems();
  if (problems.length > 0) {
    throw new Error(`The scripted model found ${String(problems.length)} problem(s):\n- ${problems.join('\n- ')}`);
  }
});

export function generateCallOf(request: LlmRequest): GenerateCall {
  return normalizeGenerateInput({
    systemPrompt: request.profile?.systemPrompt ?? '',
    tools: (request.profile?.tools ?? []).filter((tool) => tool.deferred !== true).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
    history: structuredClone(
      request.content.messages.map(({ attributes: _attributes, ...message }) => message),
    ),
  });
}

export function createMockProvider(handler: MockProviderHandler, options: MockProviderOptions = {}): MockProvider {
  return createModelProvider(handler, options);
}

interface CheckedProvider extends MockProvider {
  readonly check: ScriptedCheck;
}

function createModelProvider(handler: ScriptedHandler, options: MockProviderOptions): CheckedProvider {
  const model = createFakeModel({ checkMessages: options.checkMessages ?? true, checkCalls: options.checkCalls ?? false });
  const lane = model.route('scripted', () => true);
  const handlerProblems: string[] = [];
  const pending: Promise<PreparedAttempt>[] = [];
  let index = 0;
  let reported = 0;
  const check = (): readonly string[] => {
    const all = [...handlerProblems, ...model.problems()];
    const fresh = all.slice(reported);
    reported = all.length;
    return fresh;
  };
  scriptedChecks.add(check);
  return {
    check,
    respond: (request, signal) => {
      const attempt = (async (): Promise<PreparedAttempt> => {
        const current = index++;
        try {
          const response = await handler(request, signal);
          if (response === UNSCRIPTED) return { request, signal };
          return { ...attemptOf(request, response, current), signal };
        } catch (error) {
          if (error instanceof ScriptTranslationError) {
            handlerProblems.push(`the reply for request #${String(current)} could not be prepared: ${error.message}`);
            return { request, step: networkError() };
          }
          return { request, fault: error };
        }
      })();
      pending.push(attempt);
      return attempt;
    },
    fetch: modelFetch(pending, lane, model),
  };
}

export function fetchBackedProvider(fetchImpl: typeof fetch): MockProvider {
  return {
    respond: (request) => ({ request }),
    fetch: fetchImpl,
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
  input: MockProviderHandler | readonly MockProviderResponse[],
): InitializedLlmRequester {
  const responses = typeof input === 'function' ? undefined : [...input];
  if (responses !== undefined) scriptedChecks.add(() => leftoverProblems(responses));
  const provider = createModelProvider(
    (request, signal) => {
      if (responses === undefined) return (input as MockProviderHandler)(request, signal);
      return responses.shift() ?? UNSCRIPTED;
    },
    {},
  );
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

export function createScriptedGenerate(options: MockProviderOptions = {}) {
  const calls: GenerateCall[] = [];
  const responses: MockProviderResponse[] = [];
  let assertedCallCount = 0;
  const leftovers = (): readonly string[] => leftoverProblems(responses);
  scriptedChecks.add(leftovers);

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

  const provider = createModelProvider((request) => {
    const response = responses.shift();
    if (response === undefined) return UNSCRIPTED;
    calls.push(generateCallOf(request));
    return response;
  }, options);

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
    retire: () => retireChecks([leftovers, provider.check]),
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
    generate: async (rest, control) => {
      let directError: Error | undefined;
      const directAbort = new AbortController();
      const signal = AbortSignal.any([control.signal, directAbort.signal]);
      const interceptFetch: typeof fetch = async (input, init) => {
        try {
          return await provider.fetch(input, init);
        } catch (error) {
          if (isError2(error) && !(error instanceof ChatProviderError)) {
            directError = error;
            directAbort.abort(error);
          }
          throw error;
        }
      };
      const outcome = await initial.with(rest).with({ endpoint: { fetch: interceptFetch } }).generate({}, {
        ...control,
        signal,
        onEvent: (event) => {
          if (directError !== undefined && event.type === 'llm.ended') return;
          control.onEvent?.(event);
        },
        onAttempt: (request, context) => {
          void Promise.resolve(provider.respond(request, control.signal));
          control.onAttempt?.(request, context);
        },
      });
      if (directError !== undefined) throw directError;
      return outcome;
    },
  };
}

function modelFetch(pending: Promise<PreparedAttempt>[], lane: Lane, model: FakeModel): typeof fetch {
  return async (input, init) => {
    let next = pending.shift();
    if (next === undefined) {
      throw new Error('mock provider received an unscheduled fetch');
    }
    let attempt = await next;
    while (attempt.signal?.aborted === true && pending.length > 0) {
      next = pending.shift()!;
      attempt = await next;
    }
    if (attempt.fault !== undefined && attempt.step === undefined) throw providerFault(attempt.fault);
    if (attempt.step !== undefined) lane.script(attempt.step);
    const pause = attempt.pause;
    if (pause === undefined) {
      const response = await model.fetch(input, init);
      return attempt.fault === undefined ? response : failingAfterBody(response, providerFault(attempt.fault));
    }
    const reader = trackedReader();
    void model
      .hold(pause.name)
      .reached()
      .then(async () => {
        if (attempt.step !== undefined && unitsOf(attempt.step) > 0) await reader.drained();
        await pause.onStream?.();
        if (!pause.hangs) model.hold(pause.name).release();
      })
      .catch(() => undefined);
    return reader.wrap(await model.fetch(input, init));
  };
}

function trackedReader(): { wrap(response: Response): Response; drained(): Promise<void> } {
  let waiting = false;
  const waiters: Array<() => void> = [];
  const settle = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  return {
    wrap: (response) => {
      const source = response.body?.getReader();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (source === undefined) {
              controller.close();
              return;
            }
            waiting = true;
            settle();
            try {
              const chunk = await source.read();
              waiting = false;
              if (chunk.done) controller.close();
              else controller.enqueue(chunk.value);
            } catch (error) {
              waiting = false;
              controller.error(error);
            }
          },
          cancel: (reason) => source?.cancel(reason),
        }, { highWaterMark: 0 }),
        { status: response.status, headers: response.headers },
      );
    },
    drained: async () => {
      for (;;) {
        if (!waiting) await new Promise<void>((resolve) => waiters.push(resolve));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (waiting) return;
      }
    },
  };
}

function providerFault(error: unknown): Error {
  const message = llmMessageFromError(error);
  if (message !== undefined) return errorFromLlmMessage(message);
  return error instanceof Error ? error : new Error(String(error));
}

function failingAfterBody(response: Response, fault: Error): Response {
  const reader = response.body?.getReader();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader?.read();
          if (chunk === undefined || chunk.done) {
            controller.error(fault);
            return;
          }
          controller.enqueue(chunk.value);
        } catch {
          controller.error(fault);
        }
      },
      cancel: (reason) => reader?.cancel(reason),
    }),
    { status: response.status, headers: response.headers },
  );
}

function leftoverProblems(responses: MockProviderResponse[]): string[] {
  if (responses.length === 0) return [];
  const leftovers = responses.splice(0).map(responseSummary);
  const count = leftovers.length;
  return [`${String(count)} scripted repl${count === 1 ? 'y was' : 'ies were'} never requested: ${leftovers.join(', ')}`];
}

function responseSummary(response: MockProviderResponse): string {
  const shown = response.step?.label ?? JSON.stringify(response.httpError ?? response.parts ?? response.message?.content ?? null);
  return shown.length > 80 ? `${shown.slice(0, 77)}...` : shown;
}

function attemptOf(request: LlmRequest, response: MockProviderResponse, index: number): PreparedAttempt {
  if (response.error instanceof Promise) response.error.catch(() => undefined);
  const faults = response.error !== undefined && !(response.error instanceof Promise) && response.httpError === undefined;
  if (!faults) return { request, ...stepOf(request, response, index) };
  const { step } = stepOf(request, { ...response, error: undefined }, index);
  if (step.kind !== 'reply' || step.parts.length === 0) return { request, fault: response.error };
  return { request, step: disconnect(step, { afterUsage: response.usage !== null }), fault: response.error };
}

function stepOf(request: LlmRequest, response: MockProviderResponse, index: number): { readonly step: ScriptedStep; readonly pause?: StreamPause } {
  const base = response.step === undefined
    ? replyOf(request, response, index)
    : response.step.kind === 'reply' && response.step.responseId === undefined
      ? withResponseId(`mock-${String(index + 1)}`, response.step)
      : response.step;
  const step = base.kind === 'reply' ? withRequestId(response.requestId, base) : base;
  const failed = failureOf(response, step);
  const hangs = response.error instanceof Promise;
  if ((!hangs && response.onStream === undefined) || failed.kind !== 'reply') return { step: failed };
  const name = `reply-${String(index)}`;
  return { step: held(name, failed, unitsOf(failed)), pause: { name, hangs, onStream: response.onStream } };
}

function replyOf(request: LlmRequest, response: MockProviderResponse, index: number): ReplyStep {
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
  const rawFinishReason = response.rawFinishReason === undefined
    ? defaultRawFinishReason(finishReason, protocolKind(request))
    : response.rawFinishReason;
  const usage = response.usage === undefined
    ? {
        inputOther: estimateTokensForMessages(normalizeMessagesForTokenEstimates(request.content.messages)),
        output: estimateTokensForMessages(normalizeMessagesForTokenEstimates([message])),
        inputCacheRead: 0,
        inputCacheCreation: 0,
      }
    : response.usage;
  let step = replyFromParts(parts);
  step = withUsage(
    usage === null
      ? null
      : { input: usage.inputOther ?? 0, output: usage.output ?? 0, cacheRead: usage.inputCacheRead ?? 0, cacheWrite: usage.inputCacheCreation ?? 0 },
    step,
  );
  step = finishWith(rawFinishReason === null ? null : { raw: rawFinishReason }, step);
  const id = response.id === undefined ? `mock-${String(index + 1)}` : response.id;
  return id === null ? step : withResponseId(id, step);
}

function withRequestId(requestId: string | null | undefined, step: ReplyStep): ReplyStep {
  if (requestId === undefined || requestId === null) return step;
  return { ...step, headers: { ...step.headers, 'x-request-id': requestId, 'x-trace-id': requestId } };
}

function failureOf(response: MockProviderResponse, step: ScriptedStep): ScriptedStep {
  if (response.httpError !== undefined) {
    const failure = response.httpError;
    const options: HttpErrorOptions = {
      message: failure.message,
      type: 'provider_error',
      code: failure.code ?? failure.statusCode,
      requestId: failure.requestId ?? undefined,
      traceId: failure.traceId ?? failure.requestId ?? undefined,
      retryAfterMs: failure.retryAfterMs ?? undefined,
      body: {
        error: {
          message: failure.message,
          type: 'provider_error',
          code: failure.code ?? failure.statusCode,
          status: googleErrorStatus(failure.statusCode),
          requestId: failure.requestId,
        },
      },
    };
    if (step.kind === 'reply' && step.parts.length > 0) return streamError(step, { ...options, status: failure.statusCode });
    return httpError(failure.statusCode, options);
  }
  return step;
}

function replyFromParts(parts: readonly StreamedMessagePart[]): ReplyStep {
  interface PendingCall {
    readonly kind: 'call';
    readonly name: string;
    readonly id: string;
    readonly streamIndex?: number | string;
    readonly extras?: Readonly<Record<string, unknown>>;
    raw: string;
    chunks: number;
  }
  const entries: Array<ReplyStep | PendingCall> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      entries.push(say(part.text));
    } else if (part.type === 'think') {
      entries.push(part.encrypted === undefined ? think(part.think) : thinkSigned(part.think, part.encrypted));
    } else if (part.type === 'function') {
      entries.push({
        kind: 'call',
        name: part.name,
        id: part.id,
        streamIndex: part._streamIndex,
        extras: part.extras,
        raw: part.arguments ?? '',
        chunks: 1,
      });
    } else if (part.type === 'tool_call_part') {
      const calls = entries.filter((entry): entry is PendingCall => entry.kind === 'call');
      const target = calls.find((entry) => part.index !== undefined && entry.streamIndex === part.index) ?? calls.at(-1);
      if (target === undefined) throw new ScriptTranslationError('a tool_call_part arrived before any tool call');
      target.raw += part.argumentsPart ?? '';
      target.chunks += 1;
    } else {
      throw new ScriptTranslationError(`the testkit model cannot send a ${part.type} part in a reply`);
    }
  }
  return reply(...entries.map((entry) => (entry.kind === 'call' ? callStep(entry) : entry)));
}

function callStep(entry: { readonly name: string; readonly id: string; readonly raw: string; readonly chunks: number; readonly extras?: Readonly<Record<string, unknown>> }): ReplyStep {
  let args: Record<string, unknown> = {};
  let invalid = false;
  try {
    const parsed: unknown = JSON.parse(entry.raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    else invalid = true;
  } catch {
    invalid = true;
  }
  return call(entry.name, args, {
    id: entry.id,
    rawArguments: entry.raw,
    argumentChunks: Math.max(1, Math.min(entry.chunks, Array.from(entry.raw).length)),
    invalid,
    extras: entry.extras,
  });
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

function protocolKind(request: LlmRequest): 'openai' | 'anthropic' | 'responses' | 'google' {
  const base = request.protocol.base;
  if (base.client === anthropicProtocol.client || base.client === kimiAnthropicProtocol.client) return 'anthropic';
  if (base.client === openAIResponsesProtocol.client || base.client === kimiResponsesProtocol.client) return 'responses';
  if (base.client === googleGenAIProtocol.client) return 'google';
  return 'openai';
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
