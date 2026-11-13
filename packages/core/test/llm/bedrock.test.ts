import { describe, expect, it } from 'vitest';

import { getAnthropicModelCapability } from '#/llm/builtin/protocol/anthropic/capability';
import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { bedrockAnthropicProtocol } from '#/llm/builtin/provider/bedrock/anthropic';
import { createBedrockTokenProvider } from '#/llm/builtin/provider/bedrock/credentials';
import {
  bedrockModelCapability,
  inferBedrockProtocol,
  resolveBedrockBaseUrl,
  stripBedrockInferenceProfilePrefix,
} from '#/llm/builtin/provider/bedrock/routing';

describe('Bedrock provider', () => {
  it('keeps token lifecycle, routing, and Anthropic authentication provider-local', async () => {
    expect(
      [
        'global.anthropic.claude-sonnet-4-6',
        'openai.gpt-oss-120b-1:0',
        'global.openai.gpt-6-astra',
        'global.moonshotai.kimi-k3',
        'meta.llama-4',
      ].map(inferBedrockProtocol),
    ).toEqual(['anthropic', 'openai', 'openai_responses', 'openai', undefined]);
    expect(stripBedrockInferenceProfilePrefix('apac.moonshotai.kimi-k3')).toBe(
      'moonshotai.kimi-k3',
    );
    expect(resolveBedrockBaseUrl('anthropic', { AWS_REGION: 'us-west-2' })).toBe(
      'https://bedrock-runtime.us-west-2.amazonaws.com/anthropic',
    );
    expect(resolveBedrockBaseUrl('openai', { AWS_DEFAULT_REGION: 'us-east-1' })).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    );
    expect(bedrockModelCapability('global.anthropic.claude-sonnet-4-6')).toEqual(
      getAnthropicModelCapability('claude-sonnet-4-6'),
    );

    let now = 1_000_000;
    let calls = 0;
    let tokenConfig: unknown;
    const provider = createBedrockTokenProvider({
      region: 'us-west-2',
      profile: 'bedrock-test',
      now: () => now,
      createProvideToken: (config) => {
        tokenConfig = config;
        return async () => {
          calls += 1;
          return `bedrock-api-key-${calls}`;
        };
      },
    });
    const [first, concurrent] = await Promise.all([provider.resolve(), provider.resolve()]);
    expect(first).toEqual({ apiKey: 'bedrock-api-key-1' });
    expect(concurrent).toEqual(first);
    expect(calls).toBe(1);
    expect(tokenConfig).toEqual({
      region: 'us-west-2',
      profile: 'bedrock-test',
      expiresInSeconds: undefined,
    });
    now += 12 * 60 * 60 * 1000;
    await expect(provider.resolve()).resolves.toEqual({ apiKey: 'bedrock-api-key-2' });
    expect(provider.canRecover?.({ status: 401 })).toBe(true);
    expect(provider.canRecover?.({ status: 500 })).toBe(false);
    provider.invalidate?.();
    await expect(provider.resolve()).resolves.toEqual({ apiKey: 'bedrock-api-key-3' });
    expect(calls).toBe(3);

    let unavailable = true;
    const recovering = createBedrockTokenProvider({
      createProvideToken: () => async () => {
        if (unavailable) throw new Error('run aws sso login');
        return 'bedrock-api-key-recovered';
      },
    });
    await expect(recovering.resolve()).rejects.toThrow('run aws sso login');
    unavailable = false;
    await expect(recovering.resolve()).resolves.toEqual({
      apiKey: 'bedrock-api-key-recovered',
    });

    const requests: RequestInit[] = [];
    const fetchStub: typeof fetch = async (_input, init) => {
      requests.push(init ?? {});
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'PONG' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const input = {
      model: 'claude-test',
      max_tokens: 1,
      messages: [{ role: 'user' as const, content: 'Reply with PONG' }],
    };
    const bedrock = bedrockAnthropicProtocol.client(
      {
        apiKey: 'bedrock-api-key-transport',
        baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com/anthropic',
        fetch: fetchStub,
      },
      undefined,
    );
    await bedrock.messages.create(input);
    const bedrockHeaders = new Headers(requests[0]?.headers);
    expect(bedrockHeaders.get('authorization')).toBe('Bearer bedrock-api-key-transport');
    expect(bedrockHeaders.get('x-api-key')).toBeNull();

    const native = anthropicProtocol.client(
      {
        apiKey: 'upstream-key',
        baseUrl: 'https://example.test/anthropic',
        headers: { Authorization: 'Bearer gateway-token' },
        fetch: fetchStub,
      },
      undefined,
    );
    await native.messages.create(input);
    const nativeHeaders = new Headers(requests[1]?.headers);
    expect(nativeHeaders.get('x-api-key')).toBe('upstream-key');
    expect(nativeHeaders.get('authorization')).toBe('Bearer gateway-token');
  });
});
