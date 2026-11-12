import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiConfigRpc, KimiAuthFacade } from '#/index';
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

  it('keeps a valid [environments] section through parseConfigString', () => {
    const text = `
[environments.dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/remote/dev"

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
    });
    expect(config.environments?.['sandbox']).toEqual({
      command: 'bwrap',
      args: ['--unshare-all'],
      env: { SANDBOX_TOKEN: 'x' },
    });
  });

  it('preserves underscored environment ids and camel-cases entry fields', () => {
    const text = `
[environments]
default = "dev_box"

[environments.dev_box]
type = "ssh"
host = "dev-box"
default_cwd = "/remote/dev"
remote_bin = "~/.kimi-code/bin/kimi"
`;
    const config = parseConfigString(text);
    expect(config.environments?.default).toBe('dev_box');
    expect(config.environments?.['dev_box']).toEqual({
      type: 'ssh',
      host: 'dev-box',
      defaultCwd: '/remote/dev',
      remoteBin: '~/.kimi-code/bin/kimi',
    });
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

  it('preserves and removes provider search_url and feedback_url', () => {
    const config = parseConfigString(`
[providers.acme]
type = "kimi"
base_url = "https://registry.example.test/v1"
api_key = "YOUR_API_KEY"
search_url = "https://registry.example.test/v1/search"
feedback_url = "https://registry.example.test/v1/feedback"
`);

    expect(config.providers['acme']).toMatchObject({
      searchUrl: 'https://registry.example.test/v1/search',
      feedbackUrl: 'https://registry.example.test/v1/feedback',
    });

    config.providers['acme'] = {
      type: 'kimi',
      baseUrl: 'https://registry.example.test/v1',
      apiKey: 'YOUR_API_KEY',
      searchUrl: 'https://registry.example.test/v1/search',
    };
    const updatedProviders = configToTomlData(config)['providers'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(updatedProviders['acme']).toMatchObject({
      search_url: 'https://registry.example.test/v1/search',
    });
    expect(updatedProviders['acme']).not.toHaveProperty('feedback_url');
  });

  it('submits feedback and uploads to provider feedbackUrl with provider apiKey', async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, 'config.toml');
    await writeFile(
      configPath,
      `
[providers.acme]
type = "kimi"
base_url = "https://registry.example.test/v1"
api_key = "YOUR_API_KEY"
feedback_url = "https://registry.example.test/v1/feedback"
`,
      'utf8',
    );

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/feedback')) {
        return new Response(JSON.stringify({ feedback_id: 99 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/upload_url')) {
        return new Response(
          JSON.stringify({
            upload: {
              id: 55,
              parts: [{ part_number: 1, url: 'https://storage.example.test/p1', method: 'PUT', size: 4 }],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const facade = new KimiAuthFacade({ homeDir: dir, configPath });
      const submitted = await facade.submitFeedback(
        {
          content: 'test',
          sessionId: 's1',
          version: 'kimi-code-1.0.0',
          os: 'Darwin',
          model: 'acme/k3',
        },
        'acme',
      );
      expect(submitted).toEqual({ kind: 'ok', feedbackId: 99 });

      const upload = await facade.createFeedbackUploadUrl(
        { feedbackId: 99, filename: 'session.zip', size: 4, sha256: 'abc' },
        'acme',
      );
      expect(upload).toMatchObject({ kind: 'ok', uploadId: 55 });

      const completed = await facade.completeFeedbackUpload(
        { uploadId: 55, parts: [{ partNumber: 1, etag: '"e1"' }] },
        'acme',
      );
      expect(completed).toEqual({ kind: 'ok' });

      const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
      expect(calls.map(([u]) => u)).toEqual([
        'https://registry.example.test/v1/feedback',
        'https://registry.example.test/v1/feedback/upload_url',
        'https://registry.example.test/v1/feedback/upload_complete',
      ]);
      for (const [, init] of calls) {
        expect((init.headers as Record<string, string>)['Authorization']).toBe(
          'Bearer YOUR_API_KEY',
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
