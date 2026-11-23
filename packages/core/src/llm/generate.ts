import { resolveEndpoint } from '#/llm/endpoint';
import { isAbortError, toLlmErrorMessage, toLlmSyntaxErrorMessage } from '#/llm/protocol/errors';
import type { DecodeSink, LlmModule, ProtocolReply } from '#/llm/protocol/protocol';
import { withProtocolCapabilities } from '#/llm/protocol/rules/model';
import type { LlmRequest } from '#/llm/request';
import type {
  LlmDeltaEvent,
  LlmErrorMessage,
  LlmNoticeEvent,
  LlmRemoteErrorMessage,
  LlmTiming,
} from '#/llm/response';
import { clock } from '#/utils/clock';
import { log } from '#/utils/log';

export type LlmGenerateEvent = Exclude<LlmDeltaEvent, { readonly type: 'llm.delta.tool_call_end' }> | LlmNoticeEvent;

export interface LlmGenerateFailure {
  readonly error: LlmErrorMessage;
  readonly rawError?: unknown;
}

export interface LlmGenerateControl {
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmGenerateEvent) => void;
  readonly onToolCallEnd?: (index?: number | string) => void;
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
  readonly failure: () => LlmGenerateFailure | undefined;
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
  control: Pick<LlmGenerateControl, 'onEvent' | 'onToolCallEnd'>,
  attemptClock: AttemptClock,
): EventSink {
  const { onEvent, onToolCallEnd } = control;
  let messageId: string | undefined;
  let failure: LlmGenerateFailure | undefined;
  return {
    onDelta: (part) => {
      const arrivedAt = attemptClock.partArrived();
      const event: LlmGenerateEvent = { type: 'llm.delta.part', part };
      log.debug({ ...event }, 'llm event');
      onEvent?.(event);
      attemptClock.partConsumed(arrivedAt);
    },
    onFinish: (finish) => {
      const event: LlmGenerateEvent = { type: 'llm.delta.finish', finish };
      log.debug({ ...event }, 'llm event');
      onEvent?.(event);
    },
    onMessageId: (id) => {
      if (id === messageId) return;
      messageId = id;
      const event: LlmGenerateEvent = { type: 'llm.delta.message_id', messageId: id };
      log.debug({ ...event }, 'llm event');
      onEvent?.(event);
    },
    onUsage: (usage) => {
      const event: LlmGenerateEvent = { type: 'llm.delta.usage', usage };
      log.debug({ ...event }, 'llm event');
      onEvent?.(event);
    },
    onError: (message) => {
      failure = { error: message };
      log.info({ error: message }, 'llm decoder failed');
    },
    onToolCallEnd: (index) => {
      log.info({ index }, 'llm tool call ended');
      onToolCallEnd?.(index);
    },
    failure: () => failure,
  };
}

function receive<TBody>(
  request: LlmRequest,
  reply: ProtocolReply<TBody>,
  onEvent: ((event: LlmGenerateEvent) => void) | undefined,
): TBody {
  if (reply.headers !== undefined) {
    const headersEvent: LlmGenerateEvent = { type: 'llm.delta.response_header', headers: reply.headers };
    log.debug({ ...headersEvent }, 'llm event');
    onEvent?.(headersEvent);
    const requestId = request.protocol.base.requestId?.(reply.headers);
    if (typeof requestId === 'string' && requestId.length > 0) {
      const requestIdEvent: LlmGenerateEvent = { type: 'llm.delta.request_id', requestId };
      log.debug({ ...requestIdEvent }, 'llm event');
      onEvent?.(requestIdEvent);
    }
  }
  return reply.body;
}

export async function generate(
  request: LlmRequest,
  control: LlmGenerateControl,
): Promise<LlmGenerateFailure | undefined> {
  const { base, options, stream = true } = request.protocol;
  const { signal, onEvent, onToolCallEnd } = control;
  const attemptClock = createAttemptClock();
  const emitTiming = (): void => {
    const timing = attemptClock.timing();
    if (timing === undefined) return;
    const event: LlmGenerateEvent = { type: 'llm.delta.timing', ...timing };
    log.info({ ...event }, 'llm event');
    onEvent?.(event);
  };
  const module = moduleOf(request);
  let encodedRequest: unknown;
  try {
    encodedRequest = base.encode(module, {
      report: (notice) => {
        const event: LlmGenerateEvent = { type: 'llm.notice', notice };
        log.info({ ...event }, 'llm event');
        onEvent?.(event);
      },
    });
  } catch (error) {
    const failure: LlmGenerateFailure = { error: toLlmSyntaxErrorMessage(error) };
    log.info({ ...failure }, 'llm encode failed');
    return failure;
  }
  let streamStarted = false;
  try {
    const endpoint = await resolveEndpoint(request.endpoint);
    const clientFactory = request.endpoint?.clientFactory;
    const client =
      clientFactory === undefined
        ? base.client(endpoint, options)
        : clientFactory(endpoint);
    const sink = createEventSink({ onEvent, onToolCallEnd }, attemptClock);
    attemptClock.sent();
    const chunks = stream
      ? receive(request, await base.sendStream(client, encodedRequest, signal), onEvent)
      : base.replay(receive(request, await base.send(client, encodedRequest, signal), onEvent));
    streamStarted = stream;
    const decoder = base.decoder(module, sink);
    for await (const chunk of chunks) {
      decoder.push(chunk);
      const failure = sink.failure();
      if (failure !== undefined) {
        emitTiming();
        return failure;
      }
    }
    decoder.end();
    emitTiming();
    return sink.failure();
  } catch (error) {
    emitTiming();
    const failure: LlmGenerateFailure = {
      error: remoteErrorOf(request, error, streamStarted ? 'stream' : undefined),
      rawError: error,
    };
    log.info({ ...failure, err: error }, 'llm transport failed');
    return failure;
  }
}
