import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { KimiCore } from '../../src/rpc/core-impl';

describe('KimiCore plugin RPCs', () => {
  it('install → list → setEnabled → remove round trip', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await mkdtemp(path.join(tmpdir(), 'plugin-'));
    await writeFile(
      path.join(pluginRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'utf8',
    );

    const core = new KimiCore(async () => ({}) as never, { homeDir: home });
    await new Promise((r) => setImmediate(r));

    const installed = await core.installPlugin({ source: pluginRoot });
    expect(installed.id).toBe('demo');
    expect(installed.version).toBe('1.0.0');

    const list = await core.listPlugins({});
    expect(list).toHaveLength(1);

    await core.setPluginEnabled({ id: 'demo', enabled: false });
    const after = await core.listPlugins({});
    expect(after[0]?.enabled).toBe(false);

    await core.removePlugin({ id: 'demo' });
    await expect(core.listPlugins({})).resolves.toEqual([]);
  });

  it('installPlugin ignores forged marketplace context from public RPC callers', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await mkdtemp(path.join(tmpdir(), 'plugin-'));
    await writeFile(
      path.join(pluginRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'utf8',
    );

    const core = new KimiCore(async () => ({}) as never, { homeDir: home });
    await new Promise((r) => setImmediate(r));

    const installed = await core.installPlugin({
      source: pluginRoot,
      marketplace: { id: 'demo', tier: 'official' },
    } as never);

    expect((installed as { marketplace?: unknown }).marketplace).toBeUndefined();
  });

  it('setPluginMcpServerEnabled toggles plugin MCP state', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await mkdtemp(path.join(tmpdir(), 'plugin-'));
    await writeFile(
      path.join(pluginRoot, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo',
        mcpServers: {
          finance: { command: 'finance-mcp' },
        },
      }),
      'utf8',
    );

    const core = new KimiCore(async () => ({}) as never, { homeDir: home });
    await new Promise((r) => setImmediate(r));

    await core.installPlugin({ source: pluginRoot });
    await core.setPluginMcpServerEnabled({ id: 'demo', server: 'finance', enabled: true });

    await expect(core.getPluginInfo({ id: 'demo' })).resolves.toEqual(
      expect.objectContaining({
        mcpServers: expect.arrayContaining([
          expect.objectContaining({ name: 'finance', enabled: true }),
        ]),
      }),
    );
  });

  it('injects persisted managed Kimi Code environment into the datasource plugin MCP server', async () => {
    const previousBaseUrl = process.env['KIMI_CODE_BASE_URL'];
    const previousCodeOAuthHost = process.env['KIMI_CODE_OAUTH_HOST'];
    const previousOAuthHost = process.env['KIMI_OAUTH_HOST'];
    delete process.env['KIMI_CODE_BASE_URL'];
    delete process.env['KIMI_CODE_OAUTH_HOST'];
    delete process.env['KIMI_OAUTH_HOST'];

    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await mkdtemp(path.join(tmpdir(), 'plugin-'));
    try {
      await writeFile(
        path.join(home, 'config.toml'),
        `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.dev.example.test/coding/v1"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code-env-1234", oauth_host = "https://auth.dev.example.test" }
`,
        'utf8',
      );
      await writeFile(
        path.join(pluginRoot, 'kimi.plugin.json'),
        JSON.stringify({
          name: 'kimi-datasource',
          mcpServers: {
            data: { command: 'node', args: ['./bin/kimi-datasource.mjs'] },
          },
        }),
        'utf8',
      );

      const core = new KimiCore(async () => ({}) as never, { homeDir: home });
      await new Promise((r) => setImmediate(r));
      await core.installPlugin({ source: pluginRoot });

      const mcpConfig = (
        core as unknown as {
          mergePluginMcpConfig(base: undefined): {
            servers: Record<string, { env?: Record<string, string> }>;
          };
        }
      ).mergePluginMcpConfig(undefined);

      expect(mcpConfig.servers['plugin-kimi-datasource:data']?.env).toEqual(
        expect.objectContaining({
          KIMI_CODE_BASE_URL: 'https://api.dev.example.test/coding/v1',
          KIMI_CODE_OAUTH_HOST: 'https://auth.dev.example.test',
        }),
      );
    } finally {
      restoreEnv('KIMI_CODE_BASE_URL', previousBaseUrl);
      restoreEnv('KIMI_CODE_OAUTH_HOST', previousCodeOAuthHost);
      restoreEnv('KIMI_OAUTH_HOST', previousOAuthHost);
    }
  });

  it('throws PLUGIN_LOAD_FAILED on every RPC when installed.json is corrupt', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    await mkdir(path.join(home, 'plugins'), { recursive: true });
    await writeFile(path.join(home, 'plugins', 'installed.json'), '{ not json', 'utf8');

    const core = new KimiCore(async () => ({}) as never, { homeDir: home });

    // Driving an awaiting RPC first ensures the load promise has settled
    // and captured pluginsLoadError before the read RPCs run.
    await expect(core.installPlugin({ source: '/tmp/nonexistent' })).rejects.toThrow(/load/i);
    await expect(core.listPlugins({})).rejects.toThrow(/load/i);
    await expect(core.getPluginInfo({ id: 'demo' })).rejects.toThrow(/load/i);
    await expect(core.setPluginEnabled({ id: 'demo', enabled: false })).rejects.toThrow(/load/i);
    await expect(
      core.setPluginMcpServerEnabled({ id: 'demo', server: 'finance', enabled: true }),
    ).rejects.toThrow(/load/i);
    await expect(core.removePlugin({ id: 'demo' })).rejects.toThrow(/load/i);

    // installed.json must NOT have been overwritten by the failed install.
    const { readFile } = await import('node:fs/promises');
    const onDisk = await readFile(path.join(home, 'plugins', 'installed.json'), 'utf8');
    expect(onDisk).toBe('{ not json');

    // Fixing the file and calling reload clears the error state.
    await writeFile(
      path.join(home, 'plugins', 'installed.json'),
      JSON.stringify({ version: 1, plugins: [] }),
      'utf8',
    );
    await core.reloadPlugins({});
    await expect(core.listPlugins({})).resolves.toEqual([]);
  });

  it('listPlugins waits for initial plugin load', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await mkdtemp(path.join(tmpdir(), 'plugin-'));
    await writeFile(
      path.join(pluginRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo' }),
      'utf8',
    );
    await mkdir(path.join(home, 'plugins'), { recursive: true });
    await writeFile(
      path.join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root: pluginRoot,
            source: 'local-path',
            enabled: true,
            installedAt: '2026-05-25T09:00:00Z',
          },
        ],
      }),
      'utf8',
    );

    const core = new KimiCore(async () => ({}) as never, { homeDir: home });

    await expect(core.listPlugins({})).resolves.toContainEqual(
      expect.objectContaining({ id: 'demo' }),
    );
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
