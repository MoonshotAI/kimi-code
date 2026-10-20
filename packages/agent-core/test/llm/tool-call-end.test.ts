import { describe, expect, it } from 'vitest';

import { createDecoder as createAnthropicDecoder } from '#/llm/builtin/protocol/anthropic/decode';
import {
  createDecoder as createGenaiDecoder,
  replay as replayGenai,
} from '#/llm/builtin/protocol/google-genai/decode';
import { createDecoder as createOpenAIDecoder } from '#/llm/builtin/protocol/openai/decode';
import { createDecoder as createResponsesDecoder } from '#/llm/builtin/protocol/openai-responses/decode';
import type { StreamedMessagePart } from '#/llm/message';
import { createMessageAccumulator, settleLlmRequest } from '#/llm/policy/settle';
import type { Protocol } from '#/llm/protocol/protocol';
import type { LlmRequest } from '#/llm/request';
import type { LlmRemoteErrorMessage, LlmStreamEvent } from '#/llm/response';

import { sinkOf } from './sink';

function createRecordingSink() {
  const parts: StreamedMessagePart[] = [];
  const ends: (number | string | undefined)[] = [];
  const order: string[] = [];
  const sink = sinkOf({
    onDelta: (part) => {
      parts.push(part);
      order.push(`part:${part.type}`);
    },
    onFinish: () => {
      order.push('finish');
    },
    onToolCallEnd: (index) => {
      ends.push(index);
      order.push(`end:${String(index)}`);
    },
  });
  return { sink, parts, ends, order };
}

describe('decoder tool-call end boundaries', () => {
  it('anthropic emits an end only for tool_use blocks, at content_block_stop', () => {
    const { sink, ends, order } = createRecordingSink();
    const decoder = createAnthropicDecoder(sink);
    const chunks = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd"' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"ls"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'hi' } },
      { type: 'content_block_stop', index: 1 },
    ];
    for (const chunk of chunks) decoder.push(chunk as never);
    expect(ends).toEqual([0]);
    expect(order).toEqual([
      'part:function',
      'part:tool_call_part',
      'part:tool_call_part',
      'end:0',
      'part:text',
    ]);
  });

  it('openai-responses emits an end at output_item.done, after the arguments suffix', () => {
    const { sink, ends, order } = createRecordingSink();
    const decoder = createResponsesDecoder(sink);
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'item1', call_id: 'call1', name: 'Bash', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'item1', output_index: 0, delta: '{"a":1}' },
      {
        type: 'response.function_call_arguments.done',
        item_id: 'item1',
        output_index: 0,
        arguments: '{"a":1}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'item1', call_id: 'call1', name: 'Bash', arguments: '{"a":1}' },
      },
    ];
    for (const event of events) decoder.push(event as never);
    expect(ends).toEqual(['item1']);
    expect(order).toEqual(['part:function', 'part:tool_call_part', 'end:item1']);
  });

  it('google-genai emits an end right after each complete function part and finishes last, on both paths', () => {
    const chunk = {
      candidates: [
        { content: { parts: [{ functionCall: { name: 'Bash', args: { a: 1 } } }] }, finishReason: 'STOP' },
      ],
    };
    const stream = createRecordingSink();
    createGenaiDecoder(stream.sink).push(chunk);
    expect(stream.ends).toEqual([undefined]);
    expect(stream.order).toEqual(['part:function', 'end:undefined', 'finish']);

    const nonStream = createRecordingSink();
    const decoder = createGenaiDecoder(nonStream.sink);
    for (const replayed of replayGenai(chunk)) decoder.push(replayed);
    expect(nonStream.order).toEqual(stream.order);
  });

  it('chat completions closes the previous call at a new index and the last one before finish', () => {
    const { sink, ends, order } = createRecordingSink();
    const decoder = createOpenAIDecoder(sink);
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"a' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'Read', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    for (const chunk of chunks) decoder.push(chunk as never);
    expect(ends).toEqual([0, 1]);
    expect(order).toEqual([
      'part:function',
      'part:tool_call_part',
      'end:0',
      'part:function',
      'end:1',
      'finish',
    ]);
  });

  it('chat completions closes the last call at end() when finish_reason never arrives', () => {
    const { sink, ends } = createRecordingSink();
    const decoder = createOpenAIDecoder(sink);
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'Read', arguments: '{}' } }] } }] },
    ];
    for (const chunk of chunks) decoder.push(chunk as never);
    expect(ends).toEqual([0]);
    decoder.end();
    expect(ends).toEqual([0, 1]);
  });
});

describe('message accumulator toolCallEnd', () => {
  it('flushes the matching pending call once and ignores repeated or mismatched ends', () => {
    const accumulator = createMessageAccumulator();
    accumulator.push({ type: 'function', id: 'c1', name: 'Bash', arguments: '{"a"', _streamIndex: 0 });
    accumulator.push({ type: 'tool_call_part', argumentsPart: ':1}', index: 0 });
    expect(accumulator.toolCallEnd(0)).toMatchObject({ id: 'c1', name: 'Bash', arguments: '{"a":1}' });
    expect(accumulator.toolCallEnd(0)).toBeUndefined();

    accumulator.push({ type: 'text', text: 'hi' });
    expect(accumulator.toolCallEnd(1)).toBeUndefined();

    accumulator.push({ type: 'function', id: 'c2', name: 'Read', arguments: '{}' });
    expect(accumulator.toolCallEnd()).toMatchObject({ id: 'c2' });

    expect(accumulator.finish()).toMatchObject({
      toolCalls: [
        { id: 'c1', arguments: '{"a":1}' },
        { id: 'c2', arguments: '{}' },
      ],
    });
  });
});

describe('settle tool_call_end event', () => {
  it('emits llm.streaming.tool_call_end carrying the assembled tool call', async () => {
    const base: Protocol<unknown, unknown, string, string, unknown> = {
      media: { kinds: {} },
      encode: () => ({}),
      decoder: (_module, sink) => ({
        push: (chunk) => {
          if (chunk === 'start') {
            sink.onDelta({ type: 'function', id: 'c1', name: 'Bash', arguments: '{"a"', _streamIndex: 0 });
          } else if (chunk === 'delta') {
            sink.onDelta({ type: 'tool_call_part', argumentsPart: ':1}', index: 0 });
          } else {
            sink.onToolCallEnd(0);
          }
        },
        end: () => {},
      }),
      replay: (response) => [response],
      decodeError: (error) => error as LlmRemoteErrorMessage,
      client: () => ({}),
      send: () => Promise.resolve({ body: 'ok' }),
      sendStream: () =>
        Promise.resolve({
          body: (async function* () {
            yield 'start';
            yield 'delta';
            yield 'end';
          })(),
        }),
    };
    const request: LlmRequest = {
      protocol: { base },
      model: { spec: { provider: 'test', name: 'test' } },
      content: { messages: [] },
    };
    const events: LlmStreamEvent[] = [];
    const outcome = await settleLlmRequest(request, {
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    const ends = events.filter((event) => event.type === 'llm.streaming.tool_call_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      index: 0,
      toolCall: { id: 'c1', name: 'Bash', arguments: '{"a":1}' },
    });
    expect(events.map((event) => event.type as string)).not.toContain('attempt.tool_call_end');
    expect(outcome).toMatchObject({
      type: 'done',
      message: { toolCalls: [{ id: 'c1', name: 'Bash', arguments: '{"a":1}' }] },
    });
  });
});
