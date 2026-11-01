import { resolveEndpoint } from '#/llm/endpoint';
import { isAbortError, toLlmErrorMessage, toLlmSyntaxErrorMessage } from '#/llm/protocol/errors';
import type { DecodeSink, LlmModule, ProtocolReply } from '#/llm/protocol/protocol';
import { withProtocolCapabilities } from '#/llm/protocol/rules/model';
import type { LlmRequest } from '#/llm/request';
import type { LlmErrorMessage, LlmRemoteErrorMessage, LlmStreamEvent } from '#/llm/response';

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

function remoteErrorOf(request: LlmRequest, error: unknown): LlmRemoteErrorMessage {
  if (isAbortError(error)) return toLlmErrorMessage(error);
  return request.protocol.base.decodeError(error);
}

interface EventSink extends DecodeSink {
  readonly failed: () => boolean;
}

function createEventSink(onEvent: ((event: LlmAttemptEvent) => void) | undefined): EventSink {
  let messageId: string | undefined;
  let failed = false;
  return {
    onDelta: (part) => onEvent?.({ type: 'llm.streaming.part', part }),
    onFinish: (finish) => onEvent?.({ type: 'llm.streaming.finish', finish }),
    onMessageId: (id) => {
      if (id === messageId) return;
      messageId = id;
      onEvent?.({ type: 'llm.streaming.message_id', messageId: id });
    },
    onUsage: (usage) => onEvent?.({ type: 'llm.streaming.usage', usage }),
    onError: (message) => {
      failed = true;
      onEvent?.({ type: 'attempt.failed', error: message });
    },
    onToolCallEnd: (index) => onEvent?.({ type: 'attempt.tool_call_end', index }),
    failed: () => failed,
  };
}

function receive<TBody>(
  reply: ProtocolReply<TBody>,
  onEvent: ((event: LlmAttemptEvent) => void) | undefined,
): TBody {
  if (reply.headers !== undefined) {
    onEvent?.({ type: 'llm.streaming.headers', headers: reply.headers });
  }
  return reply.body;
}

export async function generate(request: LlmRequest, control: LlmAttemptControl): Promise<void> {
  const { base, options, stream = true } = request.protocol;
  const { signal, onEvent } = control;
  const module = moduleOf(request);
  let encodedRequest: unknown;
  try {
    encodedRequest = base.encode(module, {
      report: (notice) => onEvent?.({ type: 'llm.notice', notice }),
    });
  } catch (error) {
    onEvent?.({ type: 'attempt.failed', error: toLlmSyntaxErrorMessage(error) });
    return;
  }
  try {
    const endpoint = await resolveEndpoint(request.endpoint);
    const clientFactory = request.endpoint?.clientFactory;
    const client =
      clientFactory === undefined
        ? base.client(endpoint, options)
        : clientFactory(endpoint);
    const sink = createEventSink(onEvent);
    onEvent?.({ type: 'attempt.sending' });
    const chunks = stream
      ? receive(await base.sendStream(client, encodedRequest, signal), onEvent)
      : base.replay(receive(await base.send(client, encodedRequest, signal), onEvent));
    const decoder = base.decoder(module, sink);
    for await (const chunk of chunks) {
      decoder.push(chunk);
      if (sink.failed()) return;
    }
    decoder.end();
  } catch (error) {
    onEvent?.({ type: 'attempt.failed', error: remoteErrorOf(request, error), rawError: error });
  }
}
