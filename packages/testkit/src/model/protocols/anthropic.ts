import { emissionsOf, type Emission } from '#/model/emission';
import { jsonResponse, objectArguments, SSE_HEADERS, type ProtocolCodec, type ResolvedUsage } from '#/model/protocols/codec';
import { pickedFields, promptSegment, type PromptPrefix } from '#/model/prompt-cache';
import { asArray, asRecord, optionalString, stringOf } from '#/model/protocols/json';
import type { ReplyStep, RequestView, ViewCall, ViewMessage, ViewPart } from '#/model/types';
import { textOfParts } from '#/model/view';

export const anthropicCodec: ProtocolCodec = {
  name: 'anthropic',
  matches: (path) => path.endsWith('/messages') && !path.endsWith('/chat/completions'),
  parseRequest,
  promptPrefix,
  encodeStream(step, context) {
    const emissions = emissionsOf({ ...step, interleaveCalls: false }, (callIndex, call) => context.callId(callIndex, call));
    const start = event('message_start', {
      type: 'message_start',
      message: {
        id: context.responseId,
        type: 'message',
        role: 'assistant',
        model: context.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...inputUsage(context.usage), output_tokens: 0 },
      },
    });
    const blocks = blockIndexes(emissions);
    const segments = emissions.map((emission, unit) => ({
      unit,
      data: `${unit === 0 ? start : ''}${eventsOf(emission, blocks[unit] ?? 0)}`,
    }));
    const trailer = [
      emissions.length === 0 ? start : '',
      event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReasonOf(step), stop_sequence: null },
        usage: { ...inputUsage(context.usage), output_tokens: context.usage?.output ?? 0 },
      }),
      event('message_stop', { type: 'message_stop' }),
    ].filter((data) => data !== '');
    return { headers: SSE_HEADERS, segments, trailer };
  },
  encodeStreamError(error) {
    return event('error', { type: 'error', error: { type: error.type ?? errorTypeOf(error.status), message: error.message } });
  },
  encodeJson(step, context) {
    let callIndex = 0;
    const content = step.parts.map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'think') return { type: 'thinking', thinking: part.text, signature: part.signature ?? '' };
      const id = context.callId(callIndex, part.call);
      callIndex += 1;
      return { type: 'tool_use', id, name: part.call.name, input: objectArguments(part.call, 'anthropic') };
    });
    return jsonResponse(200, {
      id: context.responseId,
      type: 'message',
      role: 'assistant',
      model: context.model,
      content,
      stop_reason: stopReasonOf(step),
      stop_sequence: null,
      usage: { ...inputUsage(context.usage), output_tokens: context.usage?.output ?? 0 },
    });
  },
  encodeError(error) {
    return jsonResponse(
      error.status,
      error.body ?? { type: 'error', error: { type: error.type ?? errorTypeOf(error.status), message: error.message } },
      error.headers,
    );
  },
};

function event(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function blockIndexes(emissions: readonly Emission[]): number[] {
  let next = -1;
  return emissions.map((emission) => {
    if (emission.type !== 'call-arguments') next += 1;
    return next;
  });
}

function eventsOf(emission: Emission, index: number): string {
  switch (emission.type) {
    case 'text':
      return [
        event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
        event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: emission.text } }),
        event('content_block_stop', { type: 'content_block_stop', index }),
      ].join('');
    case 'think':
      return [
        event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }),
        event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: emission.text } }),
        emission.signature === undefined
          ? ''
          : event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: emission.signature } }),
        event('content_block_stop', { type: 'content_block_stop', index }),
      ].join('');
    case 'call-start':
      return event('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: emission.id, name: emission.call.name, input: {} },
      });
    case 'call-arguments':
      return [
        event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: emission.piece } }),
        emission.last ? event('content_block_stop', { type: 'content_block_stop', index }) : '',
      ].join('');
  }
}

function inputUsage(usage: ResolvedUsage | null): Record<string, number> {
  return {
    input_tokens: usage?.input ?? 0,
    cache_read_input_tokens: usage?.cacheRead ?? 0,
    cache_creation_input_tokens: usage?.cacheWrite ?? 0,
  };
}

function stopReasonOf(step: ReplyStep): string | null {
  const finish = step.finish;
  if (finish === null) return null;
  if (finish === undefined) return step.parts.some((part) => part.type === 'call') ? 'tool_use' : 'end_turn';
  if (typeof finish === 'object') return finish.raw;
  switch (finish) {
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
  }
}

function errorTypeOf(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 413:
      return 'request_too_large';
    case 429:
      return 'rate_limit_error';
    case 529:
      return 'overloaded_error';
    default:
      return 'api_error';
  }
}

function promptPrefix(body: unknown): PromptPrefix {
  const record = asRecord(withoutCacheControl(body));
  return {
    cacheKey: optionalString(asRecord(record['metadata'])['user_id']),
    segments: [
      promptSegment('params', 'params', pickedFields(record, ['model', 'thinking'])),
      ...asArray(record['tools']).map((tool, index) => promptSegment('tools', `tools[${index}] ${stringOf(asRecord(tool)['name'])}`, tool)),
      ...contentBlocks(record['system']).map((block, index) => promptSegment('system', `system[${index}]`, block)),
      ...asArray(record['messages']).map((raw, index) => {
        const message = asRecord(raw);
        return promptSegment('messages', `messages[${index}] ${stringOf(message['role'])}`, { ...message, content: contentBlocks(message['content']) });
      }),
    ],
  };
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, inner]) => [key, withoutCacheControl(inner)]),
  );
}

function contentBlocks(content: unknown): readonly unknown[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : asArray(content);
}

function parseRequest(body: unknown): RequestView {
  const record = asRecord(body);
  const messages: ViewMessage[] = [];
  for (const raw of asArray(record['messages'])) {
    const message = asRecord(raw);
    const blocks = typeof message['content'] === 'string' ? [{ type: 'text', text: message['content'] }] : asArray(message['content']);
    if (message['role'] === 'assistant') {
      messages.push(assistantOf(blocks));
      continue;
    }
    let parts: ViewPart[] = [];
    const flushUserParts = (): void => {
      if (parts.length > 0 || blocks.length === 0) messages.push({ role: 'user', text: textOfParts(parts), parts, calls: [] });
      parts = [];
    };
    for (const rawBlock of blocks) {
      const block = asRecord(rawBlock);
      if (block['type'] === 'tool_result') {
        flushUserParts();
        const resultParts = typeof block['content'] === 'string' ? [{ type: 'text' as const, text: block['content'] }] : asArray(block['content']).map(partOf);
        messages.push({ role: 'tool', text: textOfParts(resultParts), parts: resultParts, calls: [], callId: optionalString(block['tool_use_id']) });
      } else {
        parts.push(partOf(block));
      }
    }
    flushUserParts();
  }
  return {
    model: optionalString(record['model']),
    stream: record['stream'] === true,
    system: systemText(record['system']),
    tools: asArray(record['tools']).map((tool) => {
      const definition = asRecord(tool);
      return { name: stringOf(definition['name']), description: optionalString(definition['description']), parameters: definition['input_schema'] };
    }),
    messages,
  };
}

function assistantOf(blocks: readonly unknown[]): ViewMessage {
  const parts: ViewPart[] = [];
  const calls: ViewCall[] = [];
  const reasoning: string[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    switch (block['type']) {
      case 'tool_use':
        calls.push({ id: stringOf(block['id']), name: stringOf(block['name']), arguments: JSON.stringify(block['input'] ?? {}) });
        break;
      case 'thinking':
        reasoning.push(stringOf(block['thinking']));
        break;
      case 'redacted_thinking':
        break;
      default:
        parts.push(partOf(block));
    }
  }
  return { role: 'assistant', text: textOfParts(parts), parts, calls, reasoning: reasoning.length === 0 ? undefined : reasoning.join('') };
}

function partOf(raw: unknown): ViewPart {
  const block = asRecord(raw);
  if (block['type'] === 'text') return { type: 'text', text: stringOf(block['text']) };
  if (block['type'] === 'image') {
    const source = asRecord(block['source']);
    const mediaType = optionalString(source['media_type']);
    const url = source['type'] === 'base64' ? `data:${mediaType ?? 'image/png'};base64,${stringOf(source['data'])}` : stringOf(source['url']);
    return { type: 'image', url, mediaType };
  }
  return { type: 'other', raw };
}

function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  return asArray(system)
    .map((block) => stringOf(asRecord(block)['text']))
    .join('\n');
}
