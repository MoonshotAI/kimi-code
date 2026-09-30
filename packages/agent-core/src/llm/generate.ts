import { resolveEndpoint } from '#/llm/endpoint';
import { isAbortError, toLlmErrorMessage, toLlmSyntaxErrorMessage } from '#/llm/protocol/errors';
import type { DecodeSink, LlmModule, ProtocolReply } from '#/llm/protocol/protocol';
import { effectiveModelSpec } from '#/llm/protocol/rules/model';
import { uniqueToolCallIds } from '#/llm/protocol/rules/tool-call-ids';
import type { LlmRequest } from '#/llm/request';
import type { LlmErrorMessage, LlmRemoteErrorMessage, LlmStreamEvent } from '#/llm/response';

export type LlmAttemptEvent =
  | LlmStreamEvent
  | { readonly type: 'attempt.sending' }
  | { readonly type: 'attempt.failed'; readonly error: LlmErrorMessage; readonly rawError?: unknown };

export interface LlmAttemptControl {
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmAttemptEvent) => void;
}

function moduleOf(request: LlmRequest): LlmModule {
  return {
    model: { ...request.model, spec: effectiveModelSpec(request.protocol.base, request.model.spec) },
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
    const sink = uniqueToolCallIds(module.content.messages, createEventSink(onEvent));
    onEvent?.({ type: 'attempt.sending' });
    if (stream) {
      const chunks = receive(
        await base.sendStream(client, encodedRequest, signal),
        onEvent,
      );
      const decode = base.decodeStream(module);
      for await (const chunk of chunks) {
        decode(chunk, sink);
        if (sink.failed()) return;
      }
    } else {
      const response = receive(
        await base.send(client, encodedRequest, signal),
        onEvent,
      );
      base.decode(module, response, sink);
    }
  } catch (error) {
    onEvent?.({ type: 'attempt.failed', error: remoteErrorOf(request, error), rawError: error });
  }
}
