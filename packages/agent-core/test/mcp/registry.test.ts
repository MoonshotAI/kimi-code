/**
 * Scenario: the unified MCP server registry merges the layered config files
 * (global) and plugin manifests (plugin, read-only, effective config) into
 * one management-plane view.
 *
 * Run with `pnpm --filter @moonshot-ai/agent-core exec vitest run test/mcp/registry.test.ts`.
 */

import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';

import { describe, expect, it } from 'vitest';

import { GlobalMcpConfigStore } from '../../src/mcp/global-config';
import { McpServerRegistry, mcpServerConfigsEqual } from '../../src/mcp/registry';
import { PluginManager } from '../../src/plugin/manager';

async function makeKimiHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kimi-mcp-registry-home-'));
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function makePlugin(
  name: string,
  mcpServers: Record<string, unknown>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `kimi-mcp-registry-plugin-`));
  await writeJson(join(root, 'kimi.plugin.json'), { name, mcpServers });
  return realpath(root);
}

async function installPlugin(home: string, root: string): Promise<PluginManager> {
  const manager = new PluginManager({ kimiHomeDir: home });
  await manager.load();
  await manager.install(root);
  return manager;
}

describe('McpServerRegistry', () => {
  it('lists user-level global entries without a cwd', async () => {
    const home = await makeKimiHome();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        fs: { command: 'fs-mcp', args: ['--readonly'] },
        docs: { transport: 'http', url: 'https://example.com/mcp' },
      },
    });
    const registry = new McpServerRegistry({
      homeDir: home,
      store: new GlobalMcpConfigStore(home),
      plugins: new PluginManager({ kimiHomeDir: home }),
    });

    const entries = await registry.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      name: 'fs',
      config: { transport: 'stdio', command: 'fs-mcp', args: ['--readonly'] },
      source: 'global',
      origin: join(home, 'mcp.json'),
      mutable: true,
      plugin: undefined,
    });
    expect(entries[1]).toMatchObject({ name: 'docs', source: 'global', mutable: true });
  });

  it('merges project layers when a cwd is given, tracking origin and mutability', async () => {
    const home = await makeKimiHome();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        shared: { command: 'user-version' },
        userOnly: { command: 'user-only' },
      },
    });
    const project = await realpath(await mkdtemp(join(tmpdir(), 'kimi-mcp-registry-proj-')));
    await writeJson(join(project, '.git', 'keep'), {});
    await writeJson(join(project, '.mcp.json'), {
      mcpServers: {
        shared: { command: 'repo-version', cwd: './bin' },
        repoOnly: { command: 'repo-only' },
      },
    });
    const sub = join(project, 'pkg');
    await writeJson(join(sub, '.kimi-code', 'mcp.json'), {
      mcpServers: { localOnly: { command: 'local-only' } },
    });
    const registry = new McpServerRegistry({
      homeDir: home,
      store: new GlobalMcpConfigStore(home),
      plugins: new PluginManager({ kimiHomeDir: home }),
    });

    const entries = await registry.list({ cwd: sub });
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    // Later layers override; the origin follows the winning definition.
    expect(byName.get('shared')).toMatchObject({
      source: 'global',
      mutable: false,
      origin: join(project, '.mcp.json'),
    });
    // Repo-root stdio cwd resolves against the repo root.
    expect(byName.get('shared')?.config).toMatchObject({
      command: 'repo-version',
      cwd: join(project, 'bin'),
    });
    expect(byName.get('userOnly')).toMatchObject({
      mutable: true,
      origin: join(home, 'mcp.json'),
    });
    expect(byName.get('repoOnly')?.mutable).toBe(false);
    expect(byName.get('localOnly')).toMatchObject({
      mutable: false,
      origin: join(sub, '.kimi-code', 'mcp.json'),
    });
  });

  it('exposes plugin servers as read-only entries with their effective config', async () => {
    const home = await makeKimiHome();
    const pluginRoot = await makePlugin('demo', {
      finance: { command: 'finance-mcp' },
      docs: { transport: 'http', url: 'https://example.com/mcp' },
    });
    const plugins = await installPlugin(home, pluginRoot);
    const managedRoot = await realpath(join(home, 'plugins', 'managed', 'demo'));
    const registry = new McpServerRegistry({
      homeDir: home,
      store: new GlobalMcpConfigStore(home),
      plugins,
      managedPluginEnv: () => ({ KIMI_CODE_BASE_URL: 'https://managed.example.com' }),
    });

    const entries = await registry.list();
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    const finance = byName.get('plugin-demo:finance');
    expect(finance).toMatchObject({
      source: 'plugin',
      mutable: false,
      origin: 'demo',
      plugin: { id: 'demo', name: 'finance' },
    });
    expect(finance?.config).toMatchObject({
      transport: 'stdio',
      command: 'finance-mcp',
      cwd: managedRoot,
      enabled: true,
    });
    const env = (finance?.config as { env?: Record<string, string> }).env;
    expect(env).toMatchObject({
      KIMI_CODE_HOME: home,
      KIMI_PLUGIN_ROOT: managedRoot,
      KIMI_CODE_BASE_URL: 'https://managed.example.com',
    });

    // The managed env only applies to stdio servers.
    const docs = byName.get('plugin-demo:docs');
    expect(docs?.config).not.toHaveProperty('env');
    expect(docs?.source).toBe('plugin');

    // Disabling the plugin keeps the entry visible but effectively disabled.
    await plugins.setEnabled('demo', false);
    const after = await registry.list();
    const disabled = after.find((entry) => entry.name === 'plugin-demo:finance');
    expect(disabled?.config.enabled).toBe(false);
  });

  it('get() rejects unknown names with the shared not-found error', async () => {
    const home = await makeKimiHome();
    const registry = new McpServerRegistry({
      homeDir: home,
      store: new GlobalMcpConfigStore(home),
      plugins: new PluginManager({ kimiHomeDir: home }),
    });
    await expect(registry.get('missing')).rejects.toMatchObject({
      code: 'mcp.server_not_found',
      message: 'MCP server "missing" was not found',
    });
  });

  it('resolveRuntimeTarget picks the enabled plugin winner and falls back when it is disabled', async () => {
    const home = await makeKimiHome();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { 'plugin-demo:api': { command: 'user-version' } },
    });
    const plugins = await installPlugin(
      home,
      await makePlugin('demo', { api: { transport: 'http', url: 'https://example.com/mcp' } }),
    );
    const registry = new McpServerRegistry({
      homeDir: home,
      store: new GlobalMcpConfigStore(home),
      plugins,
    });

    // An enabled plugin entry wins the runtime-name collision.
    await expect(registry.resolveRuntimeTarget('plugin-demo:api')).resolves.toMatchObject({
      source: 'plugin',
      config: { url: 'https://example.com/mcp' },
    });

    // A disabled plugin descriptor is treated as absent, falling back to the
    // file-layer entry (what session start would have connected).
    await plugins.setMcpServerEnabled('demo', 'api', false);
    await expect(registry.resolveRuntimeTarget('plugin-demo:api')).resolves.toMatchObject({
      source: 'global',
      config: { command: 'user-version' },
    });

    // With the file layer gone too, the name no longer resolves at all.
    await new GlobalMcpConfigStore(home).remove('plugin-demo:api');
    await expect(registry.resolveRuntimeTarget('plugin-demo:api')).resolves.toBeUndefined();

    // A disabled descriptor alone never becomes the runtime target.
    await plugins.setEnabled('demo', true);
    await expect(registry.resolveRuntimeTarget('plugin-demo:api')).resolves.toBeUndefined();
  });
});

describe('mcpServerConfigsEqual', () => {
  it('ignores key order and undefined fields', () => {
    expect(
      mcpServerConfigsEqual(
        { transport: 'stdio', command: 'a', args: ['x'], enabled: true },
        { command: 'a', transport: 'stdio', args: ['x'], enabled: true, cwd: undefined },
      ),
    ).toBe(true);
    expect(
      mcpServerConfigsEqual(
        { transport: 'stdio', command: 'a' },
        { transport: 'stdio', command: 'a', args: [] },
      ),
    ).toBe(false);
  });
});
