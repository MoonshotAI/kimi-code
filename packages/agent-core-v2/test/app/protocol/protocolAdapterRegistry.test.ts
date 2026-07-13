/**
 * `protocol` domain tests — covers the adapter registry's kosong config
 * mapping.
 */

import { describe, expect, it } from 'vitest';

import { ProtocolAdapterRegistry } from '#/app/protocol/protocolAdapterRegistry';

describe('ProtocolAdapterRegistry', () => {
  it('maps adapter defaultHeaders into the Kimi provider defaults', () => {
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol: 'kimi',
      baseUrl: 'https://example.test/v1',
      modelName: 'wire-name',
      apiKey: 'sk',
      defaultHeaders: { 'X-Test': '1' },
    });

    expect(Reflect.get(provider, '_defaultHeaders')).toEqual({ 'X-Test': '1' });
  });

  it('maps providerOptions into OpenAI provider config', () => {
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol: 'openai',
      baseUrl: 'https://example.test/v1',
      modelName: 'deepseek-v4-flash',
      apiKey: 'sk',
      providerOptions: { reasoningKey: 'reasoning_content' },
    });

    expect(Reflect.get(provider, '_reasoningKey')).toBe('reasoning_content');
  });

  it('maps providerOptions into Anthropic provider config', () => {
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol: 'anthropic',
      baseUrl: 'https://example.test/v1',
      modelName: 'unknown-model',
      apiKey: 'sk',
      providerOptions: {
        defaultMaxTokens: 12345,
        adaptiveThinking: false,
        betaApi: true,
        metadata: { user_id: 'session-test' },
      },
    });

    expect(Reflect.get(provider, '_generationKwargs')).toMatchObject({ max_tokens: 12345 });
    expect(Reflect.get(provider, '_adaptiveThinking')).toBe(false);
    expect(Reflect.get(provider, '_betaApi')).toBe(true);
    expect(Reflect.get(provider, '_metadata')).toEqual({ user_id: 'session-test' });
  });

  it('maps providerOptions into Kimi provider config', () => {
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol: 'kimi',
      baseUrl: 'https://example.test/v1',
      modelName: 'kimi-for-coding',
      apiKey: 'sk',
      providerOptions: { supportEfforts: ['low', 'high', 'max'] },
    });

    expect(Reflect.get(provider, '_supportEfforts')).toEqual(['low', 'high', 'max']);
    expect(Reflect.get(provider.withThinking('high'), '_generationKwargs')).toEqual({
      extra_body: { thinking: { type: 'enabled', effort: 'high' } },
    });
    expect(provider.withThinking('high').thinkingEffort).toBe('high');
    expect(Reflect.get(provider.withThinking('medium'), '_generationKwargs')).toEqual({
      extra_body: { thinking: { type: 'enabled' } },
    });
    expect(provider.withThinking('medium').thinkingEffort).toBe('on');
    expect(
      Reflect.get(provider.withThinking('high').withThinking('off'), '_generationKwargs'),
    ).toEqual({
      extra_body: { thinking: { type: 'disabled' } },
    });
    expect(provider.withThinking('high').withThinking('off').thinkingEffort).toBe('off');
  });

  it('maps providerOptions into Vertex provider config', () => {
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol: 'vertexai',
      baseUrl: 'https://us-central1-aiplatform.googleapis.com',
      modelName: 'gemini-1.5-pro',
      providerOptions: {
        vertexai: true,
        project: 'my-project',
        location: 'us-central1',
      },
    });

    expect(Reflect.get(provider, '_vertexai')).toBe(true);
    expect(Reflect.get(provider, '_project')).toBe('my-project');
    expect(Reflect.get(provider, '_location')).toBe('us-central1');
  });

  it('maps baseUrl into Google GenAI provider config', () => {
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol: 'google-genai',
      baseUrl: 'https://generativelanguage.example.com',
      modelName: 'gemini-1.5-pro',
      apiKey: 'test-key',
    });

    expect(Reflect.get(provider, '_baseUrl')).toBe('https://generativelanguage.example.com');
  });
});
