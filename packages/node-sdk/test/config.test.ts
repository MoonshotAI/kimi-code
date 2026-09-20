import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiConfigRpc } from '#/index';
import { parseConfigString } from '#/config/index';

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

  it('keeps a valid [environments] section through parseConfigString', () => {
    const text = `
[environments.dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/remote/dev"
idleTtlSeconds = 120

[environments.sandbox]
command = "bwrap"
args = ["--unshare-all"]
env = { SANDBOX_TOKEN = "x" }
`;
    const config = parseConfigString(text);
    expect(config.environments?.['dev-box']).toEqual({
      type: 'ssh',
      host: 'dev-box',
      defaultCwd: '/remote/dev',
      idleTtlSeconds: 120,
    });
    expect(config.environments?.['sandbox']).toEqual({
      command: 'bwrap',
      args: ['--unshare-all'],
      env: { SANDBOX_TOKEN: 'x' },
    });
  });

  it('rejects an invalid [environments] entry through parseConfigString', () => {
    expect(() =>
      parseConfigString(`
[environments.broken]
type = "ssh"
`),
    ).toThrow(/Invalid configuration/);
    expect(() =>
      parseConfigString(`
[environments.local]
type = "ssh"
host = "local"
`),
    ).toThrow(/Invalid configuration/);
  });
});
