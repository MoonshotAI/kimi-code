import { describe, expect, it } from 'vitest';

import { createDecoder as createOpenAIDecoder } from '#/llm/builtin/protocol/openai/decode';
import { lowerMessage } from '#/llm/builtin/protocol/openai/lower';
import { createMessageAccumulator, type AssistantMessage } from '#/llm/message';
import type { DecodeSink } from '#/llm/protocol/protocol';

function decodeDeltas(deltas: Array<Record<string, unknown>>): AssistantMessage {
  const accumulator = createMessageAccumulator();
  const decoder = createOpenAIDecoder({
    onDelta: (part) => {
      accumulator.push(part);
    },
    onFinish: () => {},
    onMessageId: () => {},
    onUsage: () => {},
    onError: () => {},
    onToolCallEnd: (index) => accumulator.toolCallEnd(index),
  });
  for (const [idx, delta] of deltas.entries()) {
    const isLast = idx === deltas.length - 1;
    const hasTools = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
    decoder.push({
      choices: [
        {
          index: 0,
          delta: delta as never,
          finish_reason: isLast ? (hasTools ? 'tool_calls' : 'stop') : null,
        },
      ],
    });
  }
  return accumulator.finish();
}

describe('openai empty reasoning deduplication and marker preservation', () => {
  it('keeps whitespace-only reasoning deltas between non-empty chunks', () => {
    const message = decodeDeltas([
      { reasoning: 'First' },
      { reasoning: '\n\n' },
      { reasoning: 'Second' },
    ]);
    expect(message.content).toEqual([
      { type: 'think', think: 'First\n\nSecond', reasoningKey: 'reasoning' },
    ]);
  });

  it('keeps an empty marker deferred by a standalone delta when a tool call repeats it', () => {
    const message = decodeDeltas([
      { content: 'hello' },
      { reasoning: '' },
      { content: ' world' },
      {
        reasoning: '',
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
    ]);
    expect(message.content).toEqual([
      { type: 'text', text: 'hello world' },
      { type: 'think', think: '', reasoningKey: 'reasoning' },
    ]);
  });

  it('deduplicates empty markers after a tool header flushes one', () => {
    const message = decodeDeltas([
      { content: 'hello' },
      {
        reasoning: '',
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '' } },
        ],
      },
      {
        reasoning: '',
        tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }],
      },
    ]);
    expect(message.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'think', think: '', reasoningKey: 'reasoning' },
    ]);
    expect(message.toolCalls).toEqual([
      expect.objectContaining({ id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }),
    ]);
  });

  it('keeps a replayed empty marker eligible when the same chunk only routes arguments', () => {
    const message = decodeDeltas([
      {
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '' } },
        ],
      },
      { content: 'hello' },
      {
        reasoning: '',
        content: ' world',
        tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }],
      },
      { content: '!' },
      {
        reasoning: '',
        tool_calls: [
          { index: 1, id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
    ]);
    expect(message.content).toEqual([
      { type: 'text', text: 'hello world!' },
      { type: 'think', think: '', reasoningKey: 'reasoning' },
    ]);
    expect(message.toolCalls).toEqual([
      expect.objectContaining({ id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }),
      expect.objectContaining({ id: 'call_2', name: 'lookup', arguments: '{}' }),
    ]);
    const [wire] = lowerMessage(message, {
      reasoningKey: 'reasoning_content',
      preserveThinking: false,
      toolMessageConversion: undefined,
    });
    expect(wire).toMatchObject({
      role: 'assistant',
      content: 'hello world!',
      reasoning: '',
    });
  });

  it('keeps an empty reasoning marker when argument deltas route to a flushed tool', () => {
    const message = decodeDeltas([
      {
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '' } },
        ],
      },
      {
        content: 'hello',
        tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }],
      },
      { reasoning: '', content: ' world' },
      {
        reasoning: '',
        tool_calls: [
          { index: 1, id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
    ]);
    expect(message.content).toEqual([
      { type: 'text', text: 'hello world' },
      { type: 'think', think: '', reasoningKey: 'reasoning' },
    ]);
    const [wire] = lowerMessage(message, {
      reasoningKey: 'reasoning_content',
      preserveThinking: false,
      toolMessageConversion: undefined,
    });
    expect(wire).toMatchObject({
      role: 'assistant',
      content: 'hello world',
      reasoning: '',
    });
  });

  it('keeps one empty reasoning marker when text clears the first and a tool call repeats it', () => {
    const message = decodeDeltas([
      { content: 'hello' },
      { content: ' world', reasoning: '' },
      {
        reasoning: '',
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
    ]);
    expect(message.content).toEqual([
      { type: 'text', text: 'hello world' },
      { type: 'think', think: '', reasoningKey: 'reasoning' },
    ]);
    const [wire] = lowerMessage(message, {
      reasoningKey: 'reasoning_content',
      preserveThinking: false,
      toolMessageConversion: undefined,
    });
    expect(wire).toMatchObject({
      role: 'assistant',
      content: 'hello world',
      reasoning: '',
    });
  });

  it('keeps one empty reasoning marker per key when a delta with text and a tool header repeats both', () => {
    const message = decodeDeltas([
      { content: 'hello' },
      {
        content: ' world',
        reasoning_content: '',
        reasoning: '',
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
    ]);
    expect(message.content).toEqual([
      { type: 'text', text: 'hello world' },
      { type: 'think', think: '', reasoningKey: 'reasoning_content' },
      { type: 'think', think: '', reasoningKey: 'reasoning' },
    ]);
    const [wire] = lowerMessage(message, {
      reasoningKey: 'reasoning_content',
      preserveThinking: false,
      toolMessageConversion: undefined,
    });
    expect(wire).toMatchObject({
      role: 'assistant',
      content: 'hello world',
      reasoning_content: '',
      reasoning: '',
    });
  });
});

describe('openai decoder tool-call ordering', () => {
  function recordingSink(): { sink: DecodeSink; events: string[] } {
    const events: string[] = [];
    const sink: DecodeSink = {
      onDelta: (part) => {
        if (part.type === 'function') events.push(`function:${part.name}:${part.arguments ?? ''}`);
        else if (part.type === 'tool_call_part') events.push(`args:${String(part.index)}:${part.argumentsPart ?? ''}`);
        else if (part.type === 'think') events.push(`think:${part.reasoningKey ?? ''}:${part.think}`);
        else if (part.type === 'text') events.push(`text:${part.text}`);
      },
      onFinish: () => {},
      onMessageId: () => {},
      onUsage: () => {},
      onError: () => {},
      onToolCallEnd: (index) => events.push(`end:${String(index)}`),
    };
    return { sink, events };
  }

  it('emits each tool call before ending it when one delta carries two headers', () => {
    const { sink, events } = recordingSink();
    const decoder = createOpenAIDecoder(sink);
    decoder.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'a', function: { name: 'first', arguments: '{}' } },
              { index: 1, id: 'b', function: { name: 'second', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(events).toEqual(['function:first:{}', 'end:0', 'function:second:{}', 'end:1']);
  });

  it("emits the active call's final arguments before a new header ends it", () => {
    const { sink, events } = recordingSink();
    const decoder = createOpenAIDecoder(sink);
    decoder.push({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{"q":' } }] },
          finish_reason: null,
        },
      ],
    });
    decoder.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '1}' } },
              { index: 1, id: 'b', function: { name: 'second', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(events).toEqual([
      'function:first:{"q":',
      'args:0:1}',
      'end:0',
      'function:second:{}',
      'end:1',
    ]);
  });
});
