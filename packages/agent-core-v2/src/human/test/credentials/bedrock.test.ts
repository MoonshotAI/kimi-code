import { describe, expect, it } from 'vitest';

import {
  bedrockCredential,
  createBedrockTokenProvider,
  createStaticBedrockCredentialProvider,
  type BedrockTokenProviderOptions,
} from '#/llm/builtin/provider/bedrock/credentials';
import { getAnthropicModelCapability } from '#/llm/builtin/protocol/anthropic/capability';
import { getOpenAILegacyModelCapability } from '#/llm/builtin/protocol/openai/capability';
import { getOpenAIResponsesModelCapability } from '#/llm/builtin/protocol/openai-responses/capability';
import {
  bedrockModelCapability,
  inferBedrockProtocol,
  resolveBedrockBaseUrl,
  stripBedrockInferenceProfilePrefix,
} from '#/llm/builtin/provider/bedrock/routing';

function tokenProviderOptions(
  tokens: readonly (string | Error)[],
  overrides: Partial<BedrockTokenProviderOptions> = {},
): { options: BedrockTokenProviderOptions; calls: number[] } {
  const calls: number[] = [];
  let index = 0;
  return {
    calls,
    options: {
      now: () => 1_000_000,
      createProvideToken: () => async () => {
        calls.push(index);
        const token = tokens[Math.min(index, tokens.length - 1)];
        index += 1;
        if (token instanceof Error) throw token;
        return token as string;
      },
      ...overrides,
    },
  };
}

describe('createBedrockTokenProvider', () => {
  it('resolves a token and caches it across resolves', async () => {
    const { options, calls } = tokenProviderOptions(['tok-1']);
    const provider = createBedrockTokenProvider(options);

    await expect(provider.resolve()).resolves.toEqual(bedrockCredential('tok-1'));
    await expect(provider.resolve()).resolves.toEqual(bedrockCredential('tok-1'));
    expect(calls).toHaveLength(1);
  });

  it('regenerates once the cached token passes the expiry margin', async () => {
    let now = 1_000_000;
    const { options, calls } = tokenProviderOptions(['tok-1', 'tok-2'], { now: () => now });
    const provider = createBedrockTokenProvider(options);

    await expect(provider.resolve()).resolves.toEqual(bedrockCredential('tok-1'));
    now += 12 * 60 * 60 * 1000;
    await expect(provider.resolve()).resolves.toEqual(bedrockCredential('tok-2'));
    expect(calls).toHaveLength(2);
  });

  it('coalesces concurrent resolves into one generation', async () => {
    const { options, calls } = tokenProviderOptions(['tok-1']);
    const provider = createBedrockTokenProvider(options);

    const [a, b] = await Promise.all([provider.resolve(), provider.resolve()]);
    expect(a).toEqual(bedrockCredential('tok-1'));
    expect(b).toEqual(bedrockCredential('tok-1'));
    expect(calls).toHaveLength(1);
  });

  it('invalidates eagerly and consumes the refresh on the next resolve', async () => {
    const { options, calls } = tokenProviderOptions(['tok-1', 'tok-2']);
    const provider = createBedrockTokenProvider(options);

    await expect(provider.resolve()).resolves.toEqual(bedrockCredential('tok-1'));
    provider.invalidate?.();
    expect(calls).toHaveLength(2);
    await expect(provider.resolve()).resolves.toEqual(bedrockCredential('tok-2'));
    await expect(provider.resolve()).resolves.toEqual(bedrockCredential('tok-2'));
    expect(calls).toHaveLength(2);
  });

  it('coalesces repeated invalidates into a single regeneration', async () => {
    const { options, calls } = tokenProviderOptions(['tok-1', 'tok-2']);
    const provider = createBedrockTokenProvider(options);

    await provider.resolve();
    provider.invalidate?.();
    provider.invalidate?.();
    await provider.resolve();
    expect(calls).toHaveLength(2);
  });

  it('rejects with the credential-chain error and retries on the next resolve', async () => {
    const { options, calls } = tokenProviderOptions([new Error('no credentials'), 'tok-2']);
    const provider = createBedrockTokenProvider(options);

    await expect(provider.resolve()).rejects.toThrow('no credentials');
    await expect(provider.resolve()).resolves.toEqual(bedrockCredential('tok-2'));
    expect(calls).toHaveLength(2);
  });

  it('surfaces a failed eager refresh on the next resolve without an unhandled rejection', async () => {
    const { options, calls } = tokenProviderOptions(['tok-1', new Error('sso expired'), 'tok-3']);
    const provider = createBedrockTokenProvider(options);

    await expect(provider.resolve()).resolves.toEqual(bedrockCredential('tok-1'));
    provider.invalidate?.();
    await expect(provider.resolve()).rejects.toThrow('sso expired');
    await expect(provider.resolve()).resolves.toEqual(bedrockCredential('tok-3'));
    expect(calls).toHaveLength(3);
  });

  it('recovers only from 401 errors', () => {
    const { options } = tokenProviderOptions(['tok-1']);
    const provider = createBedrockTokenProvider(options);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 403 }))).toBe(false);
    expect(provider.canRecover?.(new Error('boom'))).toBe(false);
  });
});

describe('bedrockCredential', () => {
  it('carries the token as both an apiKey and a Bearer authorization header', () => {
    expect(bedrockCredential('tok-1')).toEqual({
      apiKey: 'tok-1',
      headers: { authorization: 'Bearer tok-1' },
    });
  });
});

describe('createStaticBedrockCredentialProvider', () => {
  it('resolves the configured token as a bedrock credential', () => {
    expect(createStaticBedrockCredentialProvider('tok-1').resolve()).toEqual(
      bedrockCredential('tok-1'),
    );
  });

  it('resolves undefined for a blank token', () => {
    expect(createStaticBedrockCredentialProvider('   ').resolve()).toBeUndefined();
  });
});

describe('stripBedrockInferenceProfilePrefix', () => {
  it('strips documented cross-region inference profile prefixes', () => {
    for (const prefix of ['global', 'us', 'eu', 'apac', 'au', 'jp', 'in']) {
      expect(stripBedrockInferenceProfilePrefix(`${prefix}.anthropic.claude-sonnet-4-6`)).toBe(
        'anthropic.claude-sonnet-4-6',
      );
    }
    expect(stripBedrockInferenceProfilePrefix('eu.openai.gpt-oss-120b-1:0')).toBe(
      'openai.gpt-oss-120b-1:0',
    );
  });

  it('treats any two-letter prefix as a geography, including undocumented ones', () => {
    expect(stripBedrockInferenceProfilePrefix('ca.anthropic.claude-sonnet-4-6')).toBe(
      'anthropic.claude-sonnet-4-6',
    );
    expect(stripBedrockInferenceProfilePrefix('sa.meta.llama3-3-70b-instruct-v1:0')).toBe(
      'meta.llama3-3-70b-instruct-v1:0',
    );
  });

  it('leaves vendor namespaces and base model ids untouched', () => {
    expect(stripBedrockInferenceProfilePrefix('anthropic.claude-sonnet-4-6')).toBe(
      'anthropic.claude-sonnet-4-6',
    );
    expect(stripBedrockInferenceProfilePrefix('moonshotai.kimi-k3')).toBe('moonshotai.kimi-k3');
    expect(stripBedrockInferenceProfilePrefix('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('inferBedrockProtocol', () => {
  it('maps anthropic model ids to the anthropic wire', () => {
    expect(inferBedrockProtocol('anthropic.claude-sonnet-4-6')).toBe('anthropic');
    expect(inferBedrockProtocol('global.anthropic.claude-opus-5')).toBe('anthropic');
  });

  it('maps openai gpt ids to the responses wire', () => {
    expect(inferBedrockProtocol('openai.gpt-6-astra')).toBe('openai_responses');
    expect(inferBedrockProtocol('global.openai.gpt-6.1-sol')).toBe('openai_responses');
    expect(inferBedrockProtocol('us.openai.gpt-5.4')).toBe('openai_responses');
  });

  it('maps openai gpt-oss ids to the chat completions wire', () => {
    expect(inferBedrockProtocol('openai.gpt-oss-120b-1:0')).toBe('openai');
    expect(inferBedrockProtocol('openai.gpt-oss-20b-1:0')).toBe('openai');
    expect(inferBedrockProtocol('openai.gpt-oss-safeguard-120b')).toBe('openai');
  });

  it('maps moonshot model ids to the chat completions wire', () => {
    expect(inferBedrockProtocol('global.moonshotai.kimi-k3')).toBe('openai');
    expect(inferBedrockProtocol('moonshotai.kimi-k2.5')).toBe('openai');
    expect(inferBedrockProtocol('moonshot.kimi-k2-thinking')).toBe('openai');
  });

  it('returns undefined for other model families', () => {
    expect(inferBedrockProtocol('meta.llama3-3-70b-instruct-v1:0')).toBeUndefined();
    expect(inferBedrockProtocol('amazon.nova-pro-v1:0')).toBeUndefined();
  });
});

describe('resolveBedrockBaseUrl', () => {
  it('derives the bedrock-runtime url from AWS_REGION', () => {
    expect(resolveBedrockBaseUrl('anthropic', { AWS_REGION: 'eu-west-1' })).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/anthropic',
    );
    expect(resolveBedrockBaseUrl('openai', { AWS_REGION: 'us-east-1' })).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    );
  });

  it('honors AWS_DEFAULT_REGION when AWS_REGION is unset', () => {
    expect(resolveBedrockBaseUrl('openai', { AWS_DEFAULT_REGION: 'ap-southeast-2' })).toBe(
      'https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1',
    );
  });

  it('prefers AWS_REGION over AWS_DEFAULT_REGION and trims blanks', () => {
    expect(
      resolveBedrockBaseUrl('anthropic', { AWS_REGION: ' us-west-2 ', AWS_DEFAULT_REGION: 'x' }),
    ).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/anthropic');
    expect(resolveBedrockBaseUrl('anthropic', { AWS_REGION: '   ' })).toBeUndefined();
  });

  it('returns undefined when no region is available', () => {
    expect(resolveBedrockBaseUrl('anthropic', {})).toBeUndefined();
  });
});

describe('bedrockModelCapability', () => {
  it('strips geo and vendor prefixes and dispatches to the matching vendor detector', () => {
    expect(bedrockModelCapability('anthropic.claude-sonnet-5-5')).toEqual(
      getAnthropicModelCapability('claude-sonnet-5-5'),
    );
    expect(bedrockModelCapability('global.anthropic.claude-sonnet-5-5')).toEqual(
      getAnthropicModelCapability('claude-sonnet-5-5'),
    );
    expect(bedrockModelCapability('openai.gpt-oss-120b-1:0')).toEqual(
      getOpenAILegacyModelCapability('gpt-oss-120b-1:0'),
    );
    expect(bedrockModelCapability('us.openai.gpt-6-astra')).toEqual(
      getOpenAIResponsesModelCapability('gpt-6-astra'),
    );
    expect(bedrockModelCapability('moonshotai.kimi-k3.1')).toEqual(
      getOpenAILegacyModelCapability('kimi-k3.1'),
    );
  });

  it('returns undefined for model families with no inferred protocol', () => {
    expect(bedrockModelCapability('meta.llama3-3-70b-instruct-v1:0')).toBeUndefined();
    expect(bedrockModelCapability('amazon.nova-pro-v1:0')).toBeUndefined();
  });
});
