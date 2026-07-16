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

  it('maps customBody through to transport providers', () => {
    const customBody = { nested: { enabled: false }, tools: null };
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol: 'openai',
      baseUrl: 'https://example.test/v1',
      modelName: 'wire-name',
      apiKey: 'sk',
      providerOptions: { customBody },
    });

    expect(Reflect.get(provider, '_customBody')).toEqual(customBody);
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
        supportEfforts: ['low', 'high'],
        kimiThinking: true,
        betaApi: true,
        metadata: { user_id: 'session-test' },
      },
    });

    expect(Reflect.get(provider, '_generationKwargs')).toMatchObject({ max_tokens: 12345 });
    expect(Reflect.get(provider, '_adaptiveThinking')).toBe(false);
    expect(Reflect.get(provider, '_supportEfforts')).toEqual(['low', 'high']);
    expect(Reflect.get(provider, '_kimiThinking')).toBe(true);
    expect(Reflect.get(provider, '_betaApi')).toBe(true);
    expect(Reflect.get(provider, '_metadata')).toEqual({ user_id: 'session-test' });
  });

  it('passes concrete efforts through the Kimi provider config', () => {
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol: 'kimi',
      baseUrl: 'https://example.test/v1',
      modelName: 'kimi-for-coding',
      apiKey: 'sk',
    });

    expect(Reflect.get(provider.withThinking('high'), '_generationKwargs')).toEqual({
      extra_body: { thinking: { type: 'enabled', effort: 'high' } },
    });
    expect(provider.withThinking('high').thinkingEffort).toBe('high');
    expect(Reflect.get(provider.withThinking('medium'), '_generationKwargs')).toEqual({
      extra_body: { thinking: { type: 'enabled', effort: 'medium' } },
    });
    expect(provider.withThinking('medium').thinkingEffort).toBe('medium');
    expect(Reflect.get(provider.withThinking('xhigh'), '_generationKwargs')).toEqual({
      extra_body: { thinking: { type: 'enabled', effort: 'xhigh' } },
    });
    expect(provider.withThinking('xhigh').thinkingEffort).toBe('xhigh');
    expect(
      Reflect.get(provider.withThinking('high').withThinking('off'), '_generationKwargs'),
    ).toEqual({
      extra_body: { thinking: { type: 'disabled' } },
    });
    expect(provider.withThinking('high').withThinking('off').thinkingEffort).toBe('off');
  });

  it('passes concrete efforts through the OpenAI provider config', () => {
    const provider = new ProtocolAdapterRegistry().createChatProvider({
      protocol: 'openai',
      baseUrl: 'https://example.test/v1',
      modelName: 'kimi-for-coding',
      apiKey: 'sk',
    });

    expect(provider.withThinking('max').thinkingEffort).toBe('max');
    expect(provider.withThinking('medium').thinkingEffort).toBe('medium');
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
