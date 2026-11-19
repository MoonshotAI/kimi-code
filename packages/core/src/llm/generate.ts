import { resolveEndpoint } from '#/llm/endpoint';
import { isAbortError, toLlmErrorMessage, toLlmSyntaxErrorMessage } from '#/llm/protocol/errors';
import type { DecodeSink, LlmModule, ProtocolReply } from '#/llm/protocol/protocol';
import { withProtocolCapabilities } from '#/llm/protocol/rules/model';
import type { LlmRequest } from '#/llm/request';
import type { LlmErrorMessage, LlmRemoteErrorMessage, LlmStreamEvent, LlmTiming } from '#/llm/response';
import { clock } from '#/utils/clock';
import { log } from '#/utils/log';

export type LlmAttemptEvent =
  | LlmStreamEvent
  | { readonly type: 'attempt.sending' }
  | { readonly type: 'attempt.tool_call_end'; readonly index?: number | string }
  | { readonly type: 'attempt.failed'; readonly error: LlmErrorMessage; readonly rawError?: unknown };

export interface LlmAttemptControl {
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmAttemptEvent) => void;
}

function moduleOf(request: LlmRequest): LlmModule {
  return {
    model: {
      ...request.model,
      spec: withProtocolCapabilities(request.model.spec, request.protocol.base),
    },
    profile: request.profile ?? {},
    content: request.content,
    options: request.protocol.options,
  };
}

function remoteErrorOf(
  request: LlmRequest,
  error: unknown,
  source?: 'stream',
): LlmRemoteErrorMessage {
  if (isAbortError(error)) return toLlmErrorMessage(error);
  return request.protocol.base.decodeError(error, source);
}

interface EventSink extends DecodeSink {
  readonly failed: () => boolean;
}

interface AttemptClock {
  sent(): void;
  partArrived(): number;
  partConsumed(arrivedAt: number): void;
  timing(): LlmTiming | undefined;
}

interface EluSnapshot {
  readonly active: number;
}

function eventLoopUtilization(previous?: EluSnapshot): EluSnapshot | undefined {
  return (
    performance as {
      eventLoopUtilization?: (previous?: EluSnapshot) => EluSnapshot,
    }
  ).eventLoopUtilization?.(previous);
}

function createAttemptClock(): AttemptClock {
  const startedAt = clock();
  let sentAt: number | undefined;
  let firstPartAt: number | undefined;
  let lastResumeAt = 0;
  let serverDecodeMs = 0;
  let clientConsumeMs = 0;
  let eluStart: EluSnapshot | undefined;
  return {
    sent: () => {
      sentAt = clock();
    },
    partArrived: () => {
      const arrivedAt = clock();
      if (firstPartAt === undefined) {
        firstPartAt = arrivedAt;
        eluStart = eventLoopUtilization();
      } else {
        serverDecodeMs += arrivedAt - lastResumeAt;
      }
      return arrivedAt;
    },
    partConsumed: (arrivedAt) => {
      lastResumeAt = clock();
      clientConsumeMs += lastResumeAt - arrivedAt;
    },
    timing: () => {
      if (firstPartAt === undefined) return undefined;
      const endedAt = clock();
      const sent = sentAt === undefined ? undefined : Math.min(Math.max(sentAt, startedAt), firstPartAt);
      const consumed = Math.round(clientConsumeMs);
      const active = eluStart === undefined ? undefined : eventLoopUtilization(eluStart)?.active;
      return {
        firstTokenLatencyMs: Math.round(firstPartAt - startedAt),
        streamDurationMs: Math.round(endedAt - firstPartAt),
        requestBuildMs: sent === undefined ? undefined : Math.round(sent - startedAt),
        serverFirstTokenMs: sent === undefined ? undefined : Math.round(firstPartAt - sent),
        serverDecodeMs: Math.round(serverDecodeMs + (endedAt - lastResumeAt)),
        clientConsumeMs: consumed,
        clientBlockedMs: active === undefined ? undefined : Math.max(0, Math.round(active) - consumed),
      };
    },
  };
}

function createEventSink(
  onEvent: ((event: LlmAttemptEvent) => void) | undefined,
  attemptClock: AttemptClock,
): EventSink {
  let messageId: string | undefined;
  let failed = false;
  return {
    onDelta: (part) => {
      const arrivedAt = attemptClock.partArrived();
      const event: LlmAttemptEvent = { type: 'llm.streaming.part', part };
      log.debug({ ...event }, 'llm event');
      onEvent?.(event);
      attemptClock.partConsumed(arrivedAt);
    },
    onFinish: (finish) => {
      const event: LlmAttemptEvent = { type: 'llm.streaming.finish', finish };
      log.debug({ ...event }, 'llm event');
      onEvent?.(event);
    },
    onMessageId: (id) => {
      if (id === messageId) return;
      messageId = id;
      const event: LlmAttemptEvent = { type: 'llm.streaming.message_id', messageId: id };
      log.debug({ ...event }, 'llm event');
      onEvent?.(event);
    },
    onUsage: (usage) => {
      const event: LlmAttemptEvent = { type: 'llm.streaming.usage', usage };
      log.debug({ ...event }, 'llm event');
      onEvent?.(event);
    },
    onError: (message) => {
      failed = true;
      const event: LlmAttemptEvent = { type: 'attempt.failed', error: message };
      log.info({ ...event }, 'llm event');
      onEvent?.(event);
    },
    onToolCallEnd: (index) => {
      const event: LlmAttemptEvent = { type: 'attempt.tool_call_end', index };
      log.info({ ...event }, 'llm event');
      onEvent?.(event);
    },
    failed: () => failed,
  };
}

function receive<TBody>(
  request: LlmRequest,
  reply: ProtocolReply<TBody>,
  onEvent: ((event: LlmAttemptEvent) => void) | undefined,
): TBody {
  if (reply.headers !== undefined) {
    const headersEvent: LlmAttemptEvent = { type: 'llm.streaming.headers', headers: reply.headers };
    log.debug({ ...headersEvent }, 'llm event');
    onEvent?.(headersEvent);
    const requestId = request.protocol.base.requestId?.(reply.headers);
    if (typeof requestId === 'string' && requestId.length > 0) {
      const requestIdEvent: LlmAttemptEvent = { type: 'llm.streaming.request_id', requestId };
      log.debug({ ...requestIdEvent }, 'llm event');
      onEvent?.(requestIdEvent);
    }
  }
  return reply.body;
}

export async function generate(request: LlmRequest, control: LlmAttemptControl): Promise<void> {
  const { base, options, stream = true } = request.protocol;
  const { signal, onEvent } = control;
  const attemptClock = createAttemptClock();
  const emitTiming = (): void => {
    const timing = attemptClock.timing();
    if (timing === undefined) return;
    const event: LlmAttemptEvent = { type: 'llm.timing', ...timing };
    log.info({ ...event }, 'llm event');
    onEvent?.(event);
  };
  const module = moduleOf(request);
  let encodedRequest: unknown;
  try {
    encodedRequest = base.encode(module, {
      report: (notice) => {
        const event: LlmAttemptEvent = { type: 'llm.notice', notice };
        log.info({ ...event }, 'llm event');
        onEvent?.(event);
      },
    });
  } catch (error) {
    const event: LlmAttemptEvent = { type: 'attempt.failed', error: toLlmSyntaxErrorMessage(error) };
    log.info({ ...event }, 'llm event');
    onEvent?.(event);
    return;
  }
  let streamStarted = false;
  try {
    const endpoint = await resolveEndpoint(request.endpoint);
    const clientFactory = request.endpoint?.clientFactory;
    const client =
      clientFactory === undefined
        ? base.client(endpoint, options)
        : clientFactory(endpoint);
    const sink = createEventSink(onEvent, attemptClock);
    attemptClock.sent();
    const sending: LlmAttemptEvent = { type: 'attempt.sending' };
    log.info({ ...sending }, 'llm event');
    onEvent?.(sending);
    const chunks = stream
      ? receive(request, await base.sendStream(client, encodedRequest, signal), onEvent)
      : base.replay(receive(request, await base.send(client, encodedRequest, signal), onEvent));
    streamStarted = stream;
    const decoder = base.decoder(module, sink);
    for await (const chunk of chunks) {
      decoder.push(chunk);
      if (sink.failed()) {
        emitTiming();
        return;
      }
    }
    decoder.end();
    emitTiming();
  } catch (error) {
    emitTiming();
    const event: LlmAttemptEvent = {
      type: 'attempt.failed',
      error: remoteErrorOf(request, error, streamStarted ? 'stream' : undefined),
      rawError: error,
    };
    log.info({ ...event, err: error }, 'llm event');
    onEvent?.(event);
  }
}
