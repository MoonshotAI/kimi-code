import { AzureFoundryChatProvider } from '#/providers/azure-foundry';
import { describe, expect, it } from 'vitest';

import { createFakeProviderHarness, type FakeProviderHarness } from './e2e/fake-provider-harness';

async function withHarness<T>(fn: (harness: FakeProviderHarness) => Promise<T>): Promise<T> {
  const harness = await createFakeProviderHarness();
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

describe('AzureFoundryChatProvider', () => {
  it('uses the azure-foundry provider name', () => {
    const provider = new AzureFoundryChatProvider({
      model: 'gpt-4o',
      apiKey: 'test-key',
      baseUrl: 'https://example.openai.azure.com/openai/v1',
    });
    expect(provider.name).toBe('azure-foundry');
  });

  it('rejects a missing base_url before constructing the client', () => {
    expect(
      () =>
        new AzureFoundryChatProvider({
          model: 'gpt-4o',
          apiKey: 'test-key',
        }),
    ).toThrow(/baseUrl is required/);
  });

  it('rejects a blank base_url before constructing the client', () => {
    expect(
      () =>
        new AzureFoundryChatProvider({
          model: 'gpt-4o',
          apiKey: 'test-key',
          baseUrl: '   ',
        }),
    ).toThrow(/baseUrl is required/);
  });

  it('sends Foundry api-key auth instead of Bearer for chat completions', async () => {
    await withHarness(async (harness) => {
      harness.route('POST', '/openai/v1/chat/completions', async (request, reply) => {
        expect(request.headers['api-key']).toBe('foundry-key');
        expect(request.headers['authorization']).toBeUndefined();
        await reply.sseJson(200, [
          {
            id: 'chatcmpl-azure-1',
            object: 'chat.completion.chunk',
            created: 1234567890,
            model: 'gpt-4o',
            choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-azure-1',
            object: 'chat.completion.chunk',
            created: 1234567890,
            model: 'gpt-4o',
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop',
              },
            ],
          },
        ]);
      });

      const provider = new AzureFoundryChatProvider({
        model: 'gpt-4o',
        apiKey: 'foundry-key',
        baseUrl: `${harness.baseUrl}/openai/v1`,
      });
      const stream = await provider.generate('You are helpful.', [], [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ]);
      const parts = [];
      for await (const part of stream) {
        parts.push(part);
      }
      expect(parts).toEqual([{ type: 'text', text: 'Hello' }]);
    });
  });

  it('strips trailing slashes from base_url', async () => {
    await withHarness(async (harness) => {
      let capturedPath = '';
      harness.route('POST', '/openai/v1/chat/completions', async (request, reply) => {
        capturedPath = request.pathname;
        await reply.sseJson(200, [
          {
            id: 'chatcmpl-azure-2',
            object: 'chat.completion.chunk',
            created: 1234567890,
            model: 'gpt-4o',
            choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
          },
        ]);
      });

      const provider = new AzureFoundryChatProvider({
        model: 'gpt-4o',
        apiKey: 'foundry-key',
        baseUrl: `${harness.baseUrl}/openai/v1/`,
      });
      const stream = await provider.generate('', [], [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ]);
      for await (const _part of stream) {
        // drain
      }
      expect(capturedPath).toBe('/openai/v1/chat/completions');
    });
  });

  it('clamps max_tokens against the shared Foundry context window before sending', async () => {
    await withHarness(async (harness) => {
      let capturedBody: Record<string, unknown> | undefined;
      harness.route('POST', '/openai/v1/chat/completions', async (request, reply) => {
        capturedBody = request.bodyJson as Record<string, unknown>;
        await reply.sseJson(200, [
          {
            id: 'chatcmpl-azure-cap',
            object: 'chat.completion.chunk',
            created: 1234567890,
            model: 'Kimi-K2.6',
            choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
          },
        ]);
      });

      const provider = new AzureFoundryChatProvider({
        model: 'Kimi-K2.6',
        apiKey: 'foundry-key',
        baseUrl: `${harness.baseUrl}/openai/v1`,
        sharedContextWindowTokens: 262144,
      }).withMaxCompletionTokens(262144);
      const stream = await provider.generate('system prompt', [], [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      ]);
      for await (const _part of stream) {
        // drain
      }

      expect(capturedBody).toBeDefined();
      expect(capturedBody!['max_tokens']).toBeTypeOf('number');
      expect(capturedBody!['max_tokens'] as number).toBeLessThan(262144);
      expect(capturedBody!['max_tokens'] as number).toBeGreaterThan(0);
    });
  });
});
