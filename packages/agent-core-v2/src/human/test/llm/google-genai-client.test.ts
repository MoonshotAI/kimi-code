import { beforeEach, describe, expect, it, vi } from 'vitest';

import { googleGenAIRequester } from '@moonshot-ai/core/llm/builtin/provider/google';
import { googleGenAIProtocol } from '@moonshot-ai/core/llm/builtin/protocol/google-genai/index';
import type { GoogleGenAIRequest } from '@moonshot-ai/core/llm/builtin/protocol/google-genai/index';
import { cleanMessages } from '@moonshot-ai/core/llm/protocol/rules/structure';
import type { AssistantMessage, Message } from '@moonshot-ai/core/llm/message';
import { toCoreMessage } from '#/message';

async function* responsesOf(chunks: readonly Record<string, unknown>[]) {
  yield* chunks;
}

function responseClient(
  captured: GoogleGenAIRequest['params'][],
  responses: readonly (readonly Record<string, unknown>[])[],
) {
  let index = 0;
  return {
    models: {
      generateContentStream: async (params: GoogleGenAIRequest['params']) => {
        captured.push(params);
        return responsesOf(responses[index++] ?? []);
      },
    },
  };
}

const constructor = vi.hoisted(() => vi.fn());

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor(options: unknown) {
      constructor(options);
    }
  },
}));

describe('google-genai conversation replay', () => {
  it('replays text signatures and matching native tool ids across two requests', async () => {
    const requests: GoogleGenAIRequest['params'][] = [];
    const client = responseClient(requests, [
      [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'ORCHID', thoughtSignature: 'sig-text-1' },
                  { text: '-426', thoughtSignature: 'sig-text-2' },
                  { text: '', thoughtSignature: 'sig-text-end' },
                  {
                    functionCall: { id: 'call_weather', name: 'get_weather', args: { city: 'sf' } },
                    thoughtSignature: 'sig-tool',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ],
      [{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }],
    ]);
    const model = {
      spec: {
        provider: 'google',
        name: 'gemini-4-example',
        capability: { image_in: true, tool_use: true, thinking: true },
      },
    };
    const endpoint = { apiKey: undefined, clientFactory: () => client };
    const profile = {
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    };
    const first = await googleGenAIRequester.generate(
      {
        model,
        endpoint,
        profile,
        content: {
          messages: [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }],
        },
      },
      { signal: new AbortController().signal },
    );
    expect(first.type).toBe('done');
    if (first.type !== 'done') return;
    expect(first.message.content).toEqual([
      { type: 'text', text: 'ORCHID', meta: { thought_signature_b64: 'sig-text-1' } },
      { type: 'text', text: '-426', meta: { thought_signature_b64: 'sig-text-2' } },
      { type: 'text', text: '', meta: { thought_signature_b64: 'sig-text-end' } },
    ]);
    const call = first.message.toolCalls[0];
    expect(call?.rawId).toBe('call_weather');
    expect(call?.id).not.toBe(call?.rawId);
    if (call === undefined) return;
    const restored = JSON.parse(JSON.stringify(toCoreMessage(first.message))) as AssistantMessage;
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      restored,
      {
        role: 'tool',
        toolCallId: call.id,
        content: [
          { type: 'text', text: 'sunny' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ];
    const cleaned = cleanMessages(history, () => {});
    expect(cleaned).toHaveLength(history.length);
    const second = await googleGenAIRequester.generate(
      { model, endpoint, profile, content: { messages: cleaned } },
      { signal: new AbortController().signal },
    );
    expect(second.type).toBe('done');
    expect(requests[1]?.['contents']).toEqual([
      { role: 'user', parts: [{ text: 'weather?' }] },
      {
        role: 'model',
        parts: [
          { text: 'ORCHID', thoughtSignature: 'sig-text-1' },
          { text: '-426', thoughtSignature: 'sig-text-2' },
          { text: '', thoughtSignature: 'sig-text-end' },
          {
            functionCall: { id: 'call_weather', name: 'get_weather', args: { city: 'sf' } },
            thoughtSignature: 'sig-tool',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { text: 'thanks' },
          {
            functionResponse: {
              id: 'call_weather',
              name: 'get_weather',
              response: { output: 'sunny' },
              parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
            },
          },
        ],
      },
    ]);
  });

  it('keeps the legacy media placement and unsigned call ids for gemini-2.5', async () => {
    const requests: GoogleGenAIRequest['params'][] = [];
    const client = responseClient(requests, [
      [{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }],
    ]);
    const outcome = await googleGenAIRequester.generate(
      {
        model: { spec: { provider: 'google', name: 'gemini-2.5-flash' } },
        endpoint: { apiKey: undefined, clientFactory: () => client },
        content: {
          messages: [
            {
              role: 'assistant',
              content: [],
              toolCalls: [
                { type: 'function', id: 'local_call', name: 'get_weather', arguments: '{}' },
              ],
            },
            {
              role: 'tool',
              toolCallId: 'local_call',
              content: [
                { type: 'text', text: 'sunny' },
                { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
              ],
            },
          ],
        },
      },
      { signal: new AbortController().signal },
    );
    expect(outcome.type).toBe('done');
    expect(requests[0]?.['contents']).toEqual([
      {
        role: 'model',
        parts: [{ functionCall: { id: undefined, name: 'get_weather', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: undefined,
              name: 'get_weather',
              response: { output: 'sunny' },
              parts: undefined,
            },
          },
          { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
        ],
      },
    ]);
  });

  it('nests only function-response media types for gemini-3 and keeps the rest outside', async () => {
    const requests: GoogleGenAIRequest['params'][] = [];
    const client = responseClient(requests, [
      [{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }],
    ]);
    await googleGenAIRequester.generate(
      {
        model: { spec: { provider: 'google', name: 'gemini-3-pro-preview' } },
        endpoint: { apiKey: undefined, clientFactory: () => client },
        content: {
          messages: [
            {
              role: 'assistant',
              content: [],
              toolCalls: [
                { type: 'function', id: 'local_call', name: 'read_media', arguments: '{}' },
              ],
            },
            {
              role: 'tool',
              toolCallId: 'local_call',
              content: [
                { type: 'text', text: 'loaded' },
                { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
                { type: 'image_url', imageUrl: { url: 'data:image/gif;base64,BBBB' } },
                { type: 'audio_url', audioUrl: { url: 'data:audio/wav;base64,CCCC' } },
                { type: 'image_url', imageUrl: { url: 'https://example.com/a.webp' } },
              ],
            },
          ],
        },
      },
      { signal: new AbortController().signal },
    );
    expect(requests[0]?.['contents']?.[1]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: undefined,
            name: 'read_media',
            response: { output: 'loaded' },
            parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
          },
        },
        { inlineData: { mimeType: 'image/gif', data: 'BBBB' } },
        { inlineData: { mimeType: 'audio/wav', data: 'CCCC' } },
        { fileData: { fileUri: 'https://example.com/a.webp', mimeType: 'image/webp' } },
      ],
    });
  });
});

describe('google-genai client base URL', () => {
  beforeEach(() => {
    constructor.mockClear();
  });

  it.each([
    ['https://gateway.example.test/v1beta', 'https://gateway.example.test/'],
    ['https://gateway.example.test/v1beta/', 'https://gateway.example.test/'],
    ['https://gateway.example.test/proxy/v1beta', 'https://gateway.example.test/proxy'],
    ['https://gateway.example.test', 'https://gateway.example.test'],
  ])('strips a trailing Gemini version from %s', (baseUrl, expected) => {
    googleGenAIProtocol.client({ baseUrl, apiKey: 'key' }, undefined);

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'key',
        httpOptions: { baseUrl: expected },
      }),
    );
  });

  it('strips the Vertex version instead of the Gemini version', () => {
    googleGenAIProtocol.client(
      { baseUrl: 'https://gateway.example.test/v1beta1', apiKey: 'key' },
      { vertexai: true },
    );

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        vertexai: true,
        httpOptions: { baseUrl: 'https://gateway.example.test/' },
      }),
    );
  });

  it('leaves an invalid base URL for the SDK to reject', () => {
    googleGenAIProtocol.client({ baseUrl: 'not a url', apiKey: 'key' }, undefined);

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: { baseUrl: 'not a url' },
      }),
    );
  });
});
