import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicChatProvider } from '../src/providers/anthropic';
import { catalogProviderModels } from '../src/catalog';
import { withCurrentMiniMaxModels } from '../src/minimax-catalog';
import type { Message } from '../src/message';

const history: Message[] = [
  { role: 'user', toolCalls: [], content: [
    { type: 'text', text: 'Inspect this clip' },
    { type: 'image_url', imageUrl: { url: 'https://example.test/image.png' } },
    { type: 'video_url', videoUrl: { url: 'https://example.test/video.mp4' } },
  ] },
  { role: 'assistant', content: [{ type: 'think', think: 'Inspect the file first', encrypted: 'saved-signature' }],
    toolCalls: [{ id: 'call_1', type: 'function', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
  { role: 'tool', toolCalls: [], toolCallId: 'call_1', content: [{ type: 'text', text: 'export const a = 1;' }] },
];

function capture(model: string, baseUrl: string, stream = false) {
  const requests: { url: string; body: {
    model: string;
    stream: boolean;
    thinking?: unknown;
    output_config?: unknown;
    service_tier?: unknown;
    messages: { content: unknown[] }[];
  } }[] = [];
  const provider = new AnthropicChatProvider({
    model, baseUrl, apiKey: 'fixture-only', stream, defaultMaxTokens: 4096,
    clientFactory: () => new Anthropic({
      apiKey: 'fixture-only', authToken: null, baseURL: baseUrl, maxRetries: 0,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({ url: request.url, body: JSON.parse(await request.text()) });
        if (stream) {
          return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response(JSON.stringify({
          id: 'fixture', type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        }), { headers: { 'content-type': 'application/json' } });
      },
    }),
  });
  return { provider, requests };
}

const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

describe('MiniMax serialized Anthropic requests', () => {
  for (const baseUrl of ['https://api.minimax.io/anthropic', 'https://api.minimaxi.com/anthropic']) {
    it(`${baseUrl}: catalog default sends Flash and preserves multimodal tool history`, async () => {
      const catalog = withCurrentMiniMaxModels({ minimax: {
        id: 'minimax', api: baseUrl, npm: '@ai-sdk/anthropic', models: {},
      } });
      const selected = catalogProviderModels(catalog['minimax']!)[0]!;
      const { provider, requests } = capture(selected.id, baseUrl);
      await provider.withThinking(selected.defaultEffort!).generate('Help with code', tools, history);
      expect(requests[0]!.url).toBe(`${baseUrl}/v1/messages`);
      const body = requests[0]!.body;
      expect(body.model).toBe('MiniMax-M3.1-Flash');
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'max' });
      expect(body.service_tier).toBeUndefined();
      expect(body.messages[0]!.content).toEqual(expect.arrayContaining([
        { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
        { type: 'video', source: { type: 'url', url: 'https://example.test/video.mp4' } },
      ]));
      expect(body.messages[1]!.content).toEqual(expect.arrayContaining([
        { type: 'thinking', thinking: 'Inspect the file first', signature: 'saved-signature' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
      ]));
      expect(body.messages[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
    });

    it.each(['low', 'medium', 'high', 'xhigh', 'max'])(`${baseUrl}: serializes Flash effort %s`, async (effort) => {
      const { provider, requests } = capture('MiniMax-M3.1-Flash', baseUrl);
      await provider.withThinking(effort).generate('', [], [{ role: 'user', toolCalls: [], content: [{ type: 'text', text: 'Hi' }] }]);
      expect(requests[0]!.body.thinking).toEqual({ type: 'adaptive' });
      expect(requests[0]!.body.output_config).toEqual({ effort });
    });

    it.each(['off', 'none'])(`${baseUrl}: rejects invalid Flash effort %s before transport`, (effort) => {
      const { provider, requests } = capture('MiniMax-M3.1-Flash', baseUrl);
      expect(() => provider.withThinking(effort)).toThrow(/does not support/);
      expect(requests).toEqual([]);
    });

    it(`${baseUrl}: M3 keeps omitted/disabled/adaptive semantics without Flash effort`, async () => {
      const { provider, requests } = capture('MiniMax-M3', baseUrl);
      await provider.generate('', [], history);
      await provider.withThinking('off').generate('', [], history);
      await provider.withThinking('max').generate('', [], history);
      expect(requests.map(({ body }) => body.thinking)).toEqual([undefined, { type: 'disabled' }, { type: 'adaptive' }]);
      expect(requests.every(({ body }) => body.output_config === undefined)).toBe(true);
    });
  }

  it('serializes the streaming request with the default Flash effort', async () => {
    const { provider, requests } = capture('MiniMax-M3.1-Flash', 'https://api.minimax.io/anthropic', true);
    const response = await provider.withThinking('max').generate('', tools, history);
    const parts = [];
    for await (const part of response) parts.push(part);
    expect(parts).toEqual([]);
    expect(requests[0]!.body.stream).toBe(true);
    expect(requests[0]!.body.output_config).toEqual({ effort: 'max' });
  });

  it.each(['MiniMax-M2.7', 'my-custom-model'])("preserves explicit model '%s' on custom endpoints", async (model) => {
    const { provider, requests } = capture(model, 'https://custom.example/anthropic');
    await provider.withThinking('off').generate('', [], history);
    expect(requests[0]!.body.model).toBe(model);
    expect(requests[0]!.body.thinking).toEqual({ type: 'disabled' });
  });
});
