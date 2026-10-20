import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicChatProvider } from '#/kosong/provider/bases/anthropic/anthropic';

async function request(model: string, baseUrl: string, thinkingEffort?: string) {
  const requests: { url: string; body: {
    model: string;
    thinking?: unknown;
    output_config?: unknown;
    service_tier?: unknown;
  } }[] = [];
  const provider = new AnthropicChatProvider({
    model, baseUrl, thinkingEffort, apiKey: 'fixture-only', stream: false, defaultMaxTokens: 4096,
    clientFactory: () => new Anthropic({
      apiKey: 'fixture-only', authToken: null, baseURL: baseUrl, maxRetries: 0,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({ url: request.url, body: JSON.parse(await request.text()) });
        return new Response(JSON.stringify({
          id: 'fixture', type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        }), { headers: { 'content-type': 'application/json' } });
      },
    }),
  });
  await provider.generate('', [], [{ role: 'user', toolCalls: [], content: [{ type: 'text', text: 'Hi' }] }]);
  return requests[0]!;
}

describe('v2 MiniMax serialized Anthropic requests', () => {
  for (const baseUrl of ['https://api.minimax.io/anthropic', 'https://api.minimaxi.com/anthropic']) {
    it.each([undefined, 'low', 'medium', 'high', 'xhigh', 'max'])(`${baseUrl}: Flash effort %s`, async (effort) => {
      const { url, body } = await request('MiniMax-M3.1-Flash', baseUrl, effort);
      expect(url).toBe(`${baseUrl}/v1/messages`);
      expect(body.model).toBe('MiniMax-M3.1-Flash');
      expect(body.thinking).toEqual(effort === undefined ? undefined : { type: 'adaptive' });
      expect(body.output_config).toEqual(effort === undefined ? undefined : { effort });
      expect(body.service_tier).toBeUndefined();
    });
    it.each(['off', 'none'])(`${baseUrl}: rejects Flash effort %s`, async (effort) => {
      await expect(request('MiniMax-M3.1-Flash', baseUrl, effort)).rejects.toThrow(/does not support/);
    });
    it.each([undefined, 'off', 'max'])(`${baseUrl}: M3 effort %s`, async (effort) => {
      const { body } = await request('MiniMax-M3', baseUrl, effort);
      expect(body.thinking).toEqual(effort === undefined ? undefined : { type: effort === 'off' ? 'disabled' : 'adaptive' });
      expect(body.output_config).toBeUndefined();
    });
  }
  it('preserves saved legacy requests on custom endpoints', async () => {
    const { body } = await request('MiniMax-M2.7', 'https://custom.example/anthropic', 'off');
    expect(body.model).toBe('MiniMax-M2.7');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });
});
