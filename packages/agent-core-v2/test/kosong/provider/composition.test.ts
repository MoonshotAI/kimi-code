/**
 * `kosong/provider` composition probes — the runtime invariants of the L2
 * layer, exercised through the real registry path with every base contrib and
 * the Kimi definition registered:
 *
 *  1. Composing Kimi without a config apiKey and without env vars must NOT
 *     silently pick up `OPENAI_API_KEY` (the `apiKey ?? ''` suppression in
 *     the openai contrib factory).
 *  2. Config `defaultHeaders` always win over trait-declared headers (the
 *     trailing synthetic trait).
 *  4. `supportedProtocols()` is derived from the registered bases and never
 *     contains `kimi` — a vendor is not a protocol.
 *
 * Plus the registry resolution contract: `resolveAdapterIdentity` branches,
 * `resolveProviderBaseId`, the `resolveCapability` fallback chain, and the
 * composed-provider shape (`name` is the base's, `uploadVideo` is bound only
 * when a trait declares it).
 *
 * Note: base/definition registries are module-level state shared across this
 * file, so the contribs and test-vendor definitions are imported/registered
 * exactly once here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isUnknownCapability, UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { APIConnectionError } from '#/kosong/contract/errors';
import '#/kosong/provider/bases/anthropic.contrib';
import '#/kosong/provider/bases/google-genai.contrib';
import '#/kosong/provider/bases/openai-responses.contrib';
import '#/kosong/provider/bases/openai.contrib';
import '#/kosong/provider/bases/vertexai.contrib';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import {
  getProviderDefinition,
  registerProviderDefinition,
  resolveProviderEndpoint,
} from '#/kosong/provider/providerDefinition';
import '#/kosong/provider/providers/kimi/kimi.contrib';

registerProviderDefinition({
  id: 'header-vendor',
  base: 'openai',
  traits: [
    {
      defaultHeaders: () => ({ 'x-shared': 'trait', 'x-trait-only': 'trait' }),
    },
  ],
});

registerProviderDefinition({
  id: 'cap-vendor',
  base: 'openai',
  traits: [
    {
      capability: (modelName) =>
        modelName === 'special-model'
          ? {
              image_in: true,
              video_in: false,
              audio_in: false,
              thinking: false,
              tool_use: true,
              max_context_tokens: 0,
            }
          : undefined,
    },
  ],
});

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'GOOGLE_API_KEY',
] as const;

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const registry = new ProtocolAdapterRegistry();

describe('supportedProtocols (probe 4)', () => {
  it('is derived from the registered bases and never contains kimi', () => {
    const protocols = registry.supportedProtocols();
    expect(protocols).toHaveLength(5);
    expect([...protocols].toSorted()).toEqual(
      ['anthropic', 'google-genai', 'openai', 'openai_responses', 'vertexai'].toSorted(),
    );
    expect(protocols).not.toContain('kimi');
  });
});

describe('apiKey env suppression (probe 1)', () => {
  it('does not pick up OPENAI_API_KEY when composing kimi without any key', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    await expect(provider.generate('sys', [], [])).rejects.toThrow(/apiKey is required/);

    // Even with a stray OPENAI_API_KEY in the environment, the composed Kimi
    // provider must not silently use it.
    process.env['OPENAI_API_KEY'] = 'sk-openai-must-not-leak';
    const withStrayEnv = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    await expect(withStrayEnv.generate('sys', [], [])).rejects.toThrow(/apiKey is required/);
  });

  it('uses the KIMI_API_KEY env fallback when composing kimi', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-from-env';
    process.env['OPENAI_API_KEY'] = 'sk-openai-must-not-win';
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    const apiKey = (provider as unknown as { _apiKey?: string })._apiKey;
    expect(apiKey).toBe('sk-kimi-from-env');
  });

  it('keeps the base env fallback for plain openai (no endpoint declared)', async () => {
    const noKey = registry.createChatProvider({ protocol: 'openai', modelName: 'gpt-4o' });
    await expect(noKey.generate('sys', [], [])).rejects.toThrow(/apiKey is required/);

    process.env['OPENAI_API_KEY'] = 'sk-openai-env';
    const withKey = registry.createChatProvider({
      protocol: 'openai',
      modelName: 'gpt-4o',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    // The request is attempted (key found via the base default) and fails on
    // the connection — not on a missing key.
    await expect(withKey.generate('sys', [], [])).rejects.toThrow(APIConnectionError);
  });

  it('prefers an explicit config apiKey over the env chain', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-from-env';
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
      apiKey: 'sk-explicit-config',
    });
    const apiKey = (provider as unknown as { _apiKey?: string })._apiKey;
    expect(apiKey).toBe('sk-explicit-config');
  });
});

describe('config defaultHeaders win (probe 2)', () => {
  it('merges trait headers under config headers via the trailing synthetic trait', () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'header-vendor',
      modelName: 'm',
      defaultHeaders: { 'x-shared': 'config', 'x-config-only': 'config' },
    });
    const headers = (provider as unknown as { _defaultHeaders?: Record<string, string> })
      ._defaultHeaders;
    expect(headers).toEqual({
      'x-shared': 'config',
      'x-trait-only': 'trait',
      'x-config-only': 'config',
    });
  });

  it('passes trait headers through when no config headers are set', () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'header-vendor',
      modelName: 'm',
    });
    const headers = (provider as unknown as { _defaultHeaders?: Record<string, string> })
      ._defaultHeaders;
    expect(headers).toEqual({ 'x-shared': 'trait', 'x-trait-only': 'trait' });
  });
});

describe('resolveAdapterIdentity', () => {
  it('resolves the native branch: definition traits plus the trailing synthetic trait', () => {
    const identity = registry.resolveAdapterIdentity('openai', 'kimi');
    expect(identity.baseId).toBe('openai');
    expect(identity.traits).toHaveLength(7); // 6 vendor traits + synthetic
  });

  it('resolves the cross-transport branch: only the dialects slice', () => {
    const identity = registry.resolveAdapterIdentity('anthropic', 'kimi');
    expect(identity.baseId).toBe('anthropic');
    expect(identity.traits).toHaveLength(2); // 1 dialect trait + synthetic
  });

  it('resolves the unregistered-vendor branch: protocol itself as base, no vendor traits', () => {
    const identity = registry.resolveAdapterIdentity('openai', 'no-such-vendor');
    expect(identity.baseId).toBe('openai');
    expect(identity.traits).toHaveLength(1); // synthetic only
  });

  it('resolves the no-providerType branch identically', () => {
    const identity = registry.resolveAdapterIdentity('openai');
    expect(identity.baseId).toBe('openai');
    expect(identity.traits).toHaveLength(1);
  });
});

describe('resolveProviderBaseId', () => {
  it('returns the definition base when it matches the protocol', () => {
    expect(registry.resolveProviderBaseId('openai', 'kimi')).toBe('openai');
  });

  it('returns the protocol itself otherwise', () => {
    expect(registry.resolveProviderBaseId('anthropic', 'kimi')).toBe('anthropic');
    expect(registry.resolveProviderBaseId('openai', 'no-such-vendor')).toBe('openai');
    expect(registry.resolveProviderBaseId('openai')).toBe('openai');
  });
});

describe('resolveCapability', () => {
  it('lets the definition win outright — kimi is UNKNOWN even though the base knows gpt models', () => {
    expect(registry.resolveCapability('openai', 'gpt-4o', 'kimi')).toBe(UNKNOWN_CAPABILITY);
  });

  it('falls back to trait capability hooks before the base catalog', () => {
    const fromTrait = registry.resolveCapability('openai', 'special-model', 'cap-vendor');
    expect(fromTrait.image_in).toBe(true);
    const fromBase = registry.resolveCapability('openai', 'gpt-4o', 'cap-vendor');
    expect(fromBase.image_in).toBe(true);
  });

  it('falls back to the base catalog and then to UNKNOWN', () => {
    expect(registry.resolveCapability('openai', 'gpt-4o').image_in).toBe(true);
    expect(isUnknownCapability(registry.resolveCapability('openai', 'mystery-model'))).toBe(true);
    expect(registry.resolveCapability('anthropic', 'claude-opus-4-1').thinking).toBe(true);
  });
});

describe('createChatProvider', () => {
  it('composes kimi as the openai base with the upload capability bound', () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    // The composed provider's name is the base's — there is no vendor name.
    expect(provider.name).toBe('openai');
    expect(provider.modelName).toBe('kimi-k2');
    expect(typeof provider.uploadVideo).toBe('function');
  });

  it('composes plain openai without the upload capability', () => {
    const provider = registry.createChatProvider({ protocol: 'openai', modelName: 'gpt-4o' });
    expect(provider.name).toBe('openai');
    expect(provider.uploadVideo).toBeUndefined();
  });
});

describe('resolveProviderEndpoint', () => {
  it('resolves the kimi endpoint chain from process.env', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-env';
    expect(resolveProviderEndpoint('kimi')).toEqual({
      apiKey: 'sk-kimi-env',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
  });

  it('reads a caller-supplied env bag instead of process.env', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-env';
    expect(resolveProviderEndpoint('kimi', { KIMI_BASE_URL: 'https://example.com/v1' })).toEqual({
      baseUrl: 'https://example.com/v1',
    });
  });

  it('returns {} for unregistered vendors', () => {
    expect(resolveProviderEndpoint('no-such-vendor')).toEqual({});
  });
});

describe('kimi provider definition', () => {
  it('registers the declarative shape of appendix A', () => {
    const definition = getProviderDefinition('kimi');
    expect(definition).toBeDefined();
    expect(definition?.base).toBe('openai');
    expect(definition?.traits).toHaveLength(6);
    expect(definition?.dialects?.['anthropic']).toHaveLength(1);
    expect(definition?.hostHeaders).toBe('full');
    expect(definition?.modelSource).toBe('oauth-catalog');
    expect(definition?.capability).toBe(UNKNOWN_CAPABILITY);
  });
});
