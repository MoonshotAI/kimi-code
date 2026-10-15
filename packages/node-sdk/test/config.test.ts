import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiConfigRpc } from '#/index';
import { configToTomlData, parseConfigString } from '#/config/index';

const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-config-'));
  tempDirs.push(dir);
  return dir;
}

describe('SDK config TOML', () => {
  it('resolves config paths through the config RPC wrapper', async () => {
    const dir = await makeTempDir();
    const rpc = createKimiConfigRpc();

    await expect(rpc.resolveConfigPath({ homeDir: dir })).resolves.toBe(toPosix(join(dir, 'config.toml')));
  });

  it('returns structured validation issues through the config RPC wrapper', async () => {
    const rpc = createKimiConfigRpc();

    await expect(
      rpc.validateConfigToml({
        text: `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
        filePath: 'broken.toml',
      }),
    ).rejects.toMatchObject({
      details: {
        validationIssues: [
          {
            path: ['models', 'kimi', 'maxContextSize'],
          },
        ],
      },
    });
  });

  it('parses a provider api_key_env into camelCase apiKeyEnv', async () => {
    const rpc = createKimiConfigRpc();
    const text = `
[providers.acme]
type = "openai"
api_key_env = "ACME_API_KEY"
`;

    await expect(rpc.validateConfigToml({ text })).resolves.toBeUndefined();
    expect(parseConfigString(text).providers['acme']?.apiKeyEnv).toBe('ACME_API_KEY');
  });

  it('preserves and removes model upgrade metadata', () => {
    const config = parseConfigString(`
[models."acme/current"]
provider = "acme"
model = "current"
max_context_size = 131072

[models."acme/current".upgrade]
model = "next"
migration_markdown = "Use {model_to}"
retirement_at = "2030-01-01T00:00:00Z"
`);

    expect(config.models?.['acme/current']?.upgrade).toEqual({
      model: 'next',
      migrationMarkdown: 'Use {model_to}',
      retirementAt: '2030-01-01T00:00:00Z',
    });

    const rawModels = configToTomlData(config)['models'] as Record<
      string,
      { upgrade?: Record<string, unknown> }
    >;
    expect(rawModels['acme/current']?.upgrade).toEqual({
      model: 'next',
      migration_markdown: 'Use {model_to}',
      retirement_at: '2030-01-01T00:00:00Z',
    });

    const current = config.models?.['acme/current'];
    if (current === undefined) throw new Error('missing test model');
    current.upgrade = { model: 'next', migrationMarkdown: 'Use {model_to}' };
    const withoutRetirement = configToTomlData(config)['models'] as Record<
      string,
      { upgrade?: Record<string, unknown> }
    >;
    expect(withoutRetirement['acme/current']?.upgrade).toEqual({
      model: 'next',
      migration_markdown: 'Use {model_to}',
    });

    delete current.upgrade;
    const withoutUpgrade = configToTomlData(config)['models'] as Record<
      string,
      { upgrade?: Record<string, unknown> }
    >;
    expect(withoutUpgrade['acme/current']).not.toHaveProperty('upgrade');
  });
});
