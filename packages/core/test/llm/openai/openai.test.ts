import { describe, expect, it } from 'vitest';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
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
      const chunks = mode === 'stream'
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : openAIProtocol.replay({
            choices: [{ message: { tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
          });
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
      const assistant = accumulatedMessage(parts);
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
    },
  );
});
