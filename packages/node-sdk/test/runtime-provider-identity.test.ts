import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { KimiConfig } from '@moonshot-ai/agent-core';
import { createKimiDefaultHeaders, KIMI_CODE_PLATFORM } from '@moonshot-ai/kimi-code-oauth';

import { ProviderManager } from '../../agent-core/src/session/provider-manager';
import { SDKRpcClient } from '#/index';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

function resolveRuntimeProvider(options: {
  readonly config: KimiConfig;
  readonly model?: string;
  readonly kimiRequestHeaders?: Record<string, string>;
}) {
  const manager = new ProviderManager({
    config: options.config,
    kimiRequestHeaders: options.kimiRequestHeaders,
  });
  const model = options.model ?? options.config.defaultModel;
  if (model === undefined) {
    throw new Error('No model selected');
  }
  return manager.resolveProviderConfig(model);
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-provider-identity-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('runtime provider identity headers', () => {
  it('preserves the host user agent suffix in SDK RPC headers', async () => {
    const homeDir = await makeTempDir();
    const client = new SDKRpcClient({
      homeDir,
      identity: {
        ...TEST_IDENTITY,
        userAgentSuffix: 'web-runtime',
      },
    });
    const core = client.core as unknown as {
      readonly kimiRequestHeaders?: Record<string, string>;
    };

    try {
      expect(core.kimiRequestHeaders).toMatchObject({
        'User-Agent': 'kimi-code-cli/0.0.0-test (web-runtime)',
        'X-Msh-Version': '0.0.0-test',
      });
    } finally {
      await client.close();
    }
  });

  it('adds kimi-code-cli User-Agent and complete X-Msh headers to the default Kimi provider', async () => {
    const homeDir = await makeTempDir();
    const kimiRequestHeaders = createKimiDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'kimi-model',
        providers: {
          kimi: {
            type: 'kimi',
            apiKey: 'test-key',
          },
        },
        models: {
          'kimi-model': {
            provider: 'kimi',
            model: 'kimi-model',
            maxContextSize: 1000,
          },
        },
      },
      kimiRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      defaultHeaders: expect.objectContaining({
        'User-Agent': 'kimi-code-cli/0.0.0-test',
        'X-Msh-Platform': KIMI_CODE_PLATFORM,
        'X-Msh-Version': '0.0.0-test',
        'X-Msh-Device-Name': expect.any(String),
        'X-Msh-Device-Model': expect.any(String),
        'X-Msh-Os-Version': expect.any(String),
        'X-Msh-Device-Id': expect.stringMatching(/^[0-9a-f-]+$/),
      }),
    });
  });

  it('lets Kimi provider customHeaders override default identity headers', async () => {
    const homeDir = await makeTempDir();
    const kimiRequestHeaders = createKimiDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const config: KimiConfig = {
      providers: {
        kimi: {
          type: 'kimi',
          apiKey: 'test-key',
          customHeaders: {
            'User-Agent': 'Custom/1',
            'X-Msh-Version': 'override-version',
          },
        },
      },
      defaultProvider: 'kimi',
      defaultModel: 'kimi-model',
      models: {
        'kimi-model': {
          provider: 'kimi',
          model: 'kimi-model',
          maxContextSize: 1000,
        },
      },
    };

    const resolved = resolveRuntimeProvider({
      config,
      kimiRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      defaultHeaders: expect.objectContaining({
        'User-Agent': 'Custom/1',
        'X-Msh-Version': 'override-version',
        'X-Msh-Platform': KIMI_CODE_PLATFORM,
      }),
    });
  });

  it('does not add Kimi identity headers to non-Kimi providers', async () => {
    const homeDir = await makeTempDir();
    const kimiRequestHeaders = createKimiDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const config: KimiConfig = {
      providers: {
        openai: {
          type: 'openai',
          baseUrl: 'https://example.test/v1',
          apiKey: 'sk-test',
        },
      },
      defaultProvider: 'openai',
      defaultModel: 'gpt-test',
      models: {
        'gpt-test': {
          provider: 'openai',
          model: 'gpt-test',
          maxContextSize: 1000,
        },
      },
    };

    const resolved = resolveRuntimeProvider({
      config,
      kimiRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-test',
    });
    expect(resolved.provider).not.toHaveProperty('defaultHeaders');
  });
});
