import { describe, expect, it } from 'vitest';

import { openAIProtocol, type OpenAIRawChunk } from '#/llm/builtin/protocol/openai/index';
import type { StreamedMessagePart } from '#/llm/message';
import type { DecodeSink } from '#/llm/protocol/protocol';

import {
  accumulatedMessage,
  runDecodeFixtures,
  runEncodeFixtures,
  runTransportFixtures,
  testModule,
} from '../harness';
import { openAIDecodeFixtures } from './fixtures/decode';
import { openAIEncodeFixtures } from './fixtures/encode';
import { openAITransportFixtures } from './fixtures/transport';

describe('OpenAI encode fixtures', () => {
  runEncodeFixtures(openAIProtocol, openAIEncodeFixtures);
});

describe('OpenAI decode fixtures', () => {
  runDecodeFixtures(openAIProtocol, openAIDecodeFixtures);
});

describe('OpenAI transport fixtures', () => {
  runTransportFixtures(openAIProtocol, openAITransportFixtures, 'openai-chat');
});

describe('OpenAI Gemini tool-call context', () => {
  function decodeParts(chunks: Iterable<OpenAIRawChunk>): StreamedMessagePart[] {
    const parts: StreamedMessagePart[] = [];
    const sink: DecodeSink = {
      onDelta: (part) => parts.push(part),
      onFinish: () => {},
      onMessageId: () => {},
      onUsage: () => {},
      onError: () => {},
      onToolCallEnd: () => {},
    };
    const decoder = openAIProtocol.decoder(testModule(), sink);
    for (const chunk of chunks) decoder.push(chunk);
    decoder.end();
    return parts;
  }

  function expectThoughtSignatureRoundTrip(chunks: Iterable<OpenAIRawChunk>): void {
    const assistant = accumulatedMessage(decodeParts(chunks));
    expect(assistant.toolCalls[0]?.extras).toEqual({
      existing: 'preserved',
      extra_content: { google: { thought_signature: 'sig-tool' } },
    });

    const nextRequest = openAIProtocol.encode(testModule({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
        assistant,
        {
          role: 'tool',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'sunny' }],
        },
      ],
    }));
    expect(nextRequest.params.messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{
        id: 'call_1',
        extra_content: { google: { thought_signature: 'sig-tool' } },
      }],
    });
  }

  it.each(['stream', 'non-stream'] as const)(
    'keeps thought_signature on the request after a %s tool call',
    (mode) => {
      const toolCall = {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'weather', arguments: '{"city":"sf"}' },
        extras: { existing: 'preserved' },
        extra_content: { google: { thought_signature: 'sig-tool' } },
      };
      const chunks: Iterable<OpenAIRawChunk> = mode === 'stream'
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : openAIProtocol.replay({
            choices: [{ message: { tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
          });
      expectThoughtSignatureRoundTrip(chunks);
    },
  );

  it.each([
    {
      name: 'extras before extra_content',
      first: { extras: { existing: 'preserved' } },
      second: { extra_content: { google: { thought_signature: 'sig-tool' } } },
    },
    {
      name: 'extra_content before extras',
      first: { extra_content: { google: { thought_signature: 'sig-tool' } } },
      second: { extras: { existing: 'preserved' } },
    },
  ])('merges $name across stream deltas', ({ first, second }) => {
    expectThoughtSignatureRoundTrip([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { arguments: '{"city":' },
              ...first,
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: 'weather', arguments: '"sf"}' },
              ...second,
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
  });

  it.each([
    {
      name: 'extras before extra_content',
      first: { extras: { existing: 'preserved' } },
      second: { extra_content: { google: { thought_signature: 'sig-tool' } } },
    },
    {
      name: 'extra_content before extras',
      first: { extra_content: { google: { thought_signature: 'sig-tool' } } },
      second: { extras: { existing: 'preserved' } },
    },
  ])('propagates $name after the function name', ({ first, second }) => {
    expectThoughtSignatureRoundTrip([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'weather', arguments: '{"city":' },
              ...first,
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '"sf"}' },
              ...second,
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
  });

  it('preserves metadata for indexless continuation deltas', () => {
    expectThoughtSignatureRoundTrip([
      {
        choices: [{
          delta: {
            tool_calls: [{
              id: 'call_1',
              function: { name: 'weather', arguments: '{"city":' },
              extras: { existing: 'preserved' },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              function: { arguments: '"sf"}' },
              extra_content: { google: { thought_signature: 'sig-tool' } },
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
  });

  it('replays extra_content only within the originating provider', () => {
    const assistant = accumulatedMessage(decodeParts([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'weather', arguments: '{}' },
              extra_content: { google: { thought_signature: 'sig-tool' } },
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]));
    assistant.attributes = { model: { provider: 'gemini-openai', model: 'gemini-test' } };
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'weather?' }] },
      assistant,
      {
        role: 'tool' as const,
        toolCallId: 'call_1',
        content: [{ type: 'text' as const, text: 'sunny' }],
      },
    ];
    const sameProvider = openAIProtocol.encode(testModule({
      model: { spec: { provider: 'gemini-openai', name: 'gemini-test' } },
      messages,
    }));
    expect(sameProvider.params.messages[1]).toMatchObject({
      tool_calls: [{ extra_content: { google: { thought_signature: 'sig-tool' } } }],
    });

    const otherProvider = openAIProtocol.encode(testModule({
      model: { spec: { provider: 'openai', name: 'gpt-test' } },
      messages,
    }));
    expect(otherProvider.params.messages[1]).not.toHaveProperty('tool_calls[0].extra_content');
  });

  it('does not create empty extras from null provider metadata', () => {
    const assistant = accumulatedMessage(decodeParts([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'weather', arguments: '{}' },
              extras: null,
            }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]));
    expect(assistant.toolCalls[0]).not.toHaveProperty('extras');
  });
});
