import { assign, shake } from 'radashi';

import { toLlmSyntaxErrorMessage } from '#/llm/errors';
import {
  mergeRequestHeaders,
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestControl,
  type LlmRequester,
} from '#/llm/requester/requester';
import { normalizeToolCallIdsForProvider } from '#/llm/protocol/tool-call-id';

import type { TraitContext } from './base';
import { resolveModelConnection } from './connection';
import {
  formatRequestInput,
  type FormatRequestInput,
  type StreamParseSink,
} from './format';
import type {
  ComposeProtocolPorts,
  ProtocolHandle,
  RequestTrait,
} from './protocol';

export async function composeProtocolRequest<
  TNative,
  TAssembled,
  TRequest,
  TTrait extends RequestTrait<TNative>,
>(
  input: FormatRequestInput,
  trait: TTrait | undefined,
  ports: ComposeProtocolPorts<TNative, TAssembled, TRequest, TTrait>,
): Promise<TRequest> {
  const ctx: TraitContext = { model: input.model };
  const encoded = ports.encodeKwargs(input, trait, ctx);
  let kwargs = shake(
    assign(
      assign(encoded.kwargs, ports.encodeSampling(input.sampling)),
      (ports.extras ?? {}) as Record<string, unknown>,
    ),
  );
  if (ports.sealKwargs !== undefined) {
    kwargs = ports.sealKwargs(kwargs, input, trait, ctx);
  }

  const converted = (await ports.lower(input, trait, ctx, {
    preserveThinking: encoded.preserveThinking,
  })).flatMap(({ source, message }) => {
    if (trait?.convertMessage === undefined || source === undefined) {
      return [message];
    }
    const hooked = trait.convertMessage(source, message, ctx);
    return hooked === null ? [] : [hooked];
  });
  const merged =
    trait?.mergeHistory?.(converted, ctx) ?? ports.defaultMergeHistory?.(converted) ?? converted;
  const tools = input.tools.map(
    (tool) => trait?.convertTool?.(tool, ctx) ?? ports.defaultTool(tool),
  );
  return ports.encode(ports.assemble(input, { messages: merged, tools, kwargs }), (params) =>
    trait?.buildParams?.(params, ctx) ?? params,
  );
}

export async function runProtocolRequest<TRequest, TChunk, TClient>(
  handle: ProtocolHandle<TRequest, TChunk, TClient>,
  config: LlmRequestConfig,
  content: LlmRequestContent,
  control: LlmRequestControl,
): Promise<void> {
  const model = resolveModelConnection(config.model, handle.connection);
  const { signal, onEvent } = control;
  const ctx: TraitContext = { model };
  let request: TRequest;
  try {
    const policy = handle.toolCallIdPolicy;
    request = await handle.prepare(
      formatRequestInput(config, content, {
        model,
        messages:
          policy === undefined
            ? content.messages
            : normalizeToolCallIdsForProvider(content.messages, policy),
        media: content.media,
        signal,
      }),
      ctx,
    );
  } catch (error) {
    onEvent?.({ type: 'llm.failed.syntax', error: toLlmSyntaxErrorMessage(error) });
    return;
  }
  try {
    const client = handle.createClient({
      model,
      headers: mergeRequestHeaders(
        mergeRequestHeaders(handle.connection?.defaultHeaders?.(ctx), model.defaultHeaders),
        handle.requestHeaders?.(request),
      ),
    });
    onEvent?.({ type: 'llm.sent' });
    const { stream, headers } = await handle.send(client, request, signal);
    if (headers !== undefined) {
      onEvent?.({ type: 'llm.streaming.headers', headers });
    }
    const parse = handle.createStreamParser(ctx);
    let messageId: string | undefined;
    let failed = false;
    const sink: StreamParseSink = {
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
        onEvent?.({ type: 'llm.failed.remote', error: message });
      },
    };
    for await (const chunk of stream) {
      failed = false;
      parse(chunk, sink);
      if (failed) {
        return;
      }
    }
    onEvent?.({ type: 'llm.done' });
  } catch (error) {
    onEvent?.({
      type: 'llm.failed.remote',
      error: handle.classifyError(error),
    });
  }
}

export function createRequesterFromHandle<TRequest, TChunk, TClient>(
  handle: ProtocolHandle<TRequest, TChunk, TClient>,
): LlmRequester {
  return {
    generate: (config, content, control) =>
      runProtocolRequest(handle, config, content, control),
  };
}
