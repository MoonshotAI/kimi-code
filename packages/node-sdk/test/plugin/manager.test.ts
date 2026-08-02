/**
 * PluginManager read-surface tests — the SDK host's plugin read path
 * (load / enabledMcpServers / enabledHooks / list / summaries). The install
 * pipeline is not ported (see legacy/plugin/manager.ts), so these tests seed
 * the installed registry + plugin directory directly.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PluginManager } from '#/legacy/plugin/manager';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = join(tmpdir(), `kimi-plugin-mgr-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(dir);
  return dir;
}

async function seedPlugin(kimiHomeDir: string, id: string, manifest: Record<string, unknown>): Promise<void> {
  const root = join(kimiHomeDir, 'plugins', 'managed', id);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'kimi.plugin.json'), JSON.stringify(manifest), 'utf-8');
  // Manifest cwd validation resolves real paths inside the plugin, so create
  // the referenced tools/mcp directory.
  await mkdir(join(root, 'tools', 'mcp'), { recursive: true });
  await writeFile(
    join(kimiHomeDir, 'plugins', 'installed.json'),
    JSON.stringify({
      version: 1,
      plugins: [{ id, root, source: 'local-path', enabled: true, installedAt: new Date().toISOString() }],
    }),
    'utf-8',
  );
}

describe('PluginManager read surface', () => {
  it('loads a plugin with an MCP server and exposes it as enabled', async () => {
    const home = makeTempDir();
    await seedPlugin(home, 'demo', {
      name: 'demo',
      version: '1.0.0',
      mcpServers: { ping: { command: 'node', cwd: './tools/mcp' } },
    });

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    expect(manager.list().map((p) => p.id)).toEqual(['demo']);
    const servers = manager.enabledMcpServers();
    expect(Object.keys(servers)).toEqual(['plugin-demo:ping']);
    const ping = servers['plugin-demo:ping']!;
    expect('command' in ping ? ping.command : undefined).toBe('node');
  });

  it('loads a plugin with hooks and exposes them as enabled', async () => {
    const home = makeTempDir();
    await seedPlugin(home, 'hooks-demo', {
      name: 'hooks-demo',
      version: '1.0.0',
      hooks: [{ event: 'UserPromptSubmit', command: 'echo hi' }],
    });

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    const hooks = manager.enabledHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.event).toBe('UserPromptSubmit');
    expect(hooks[0]!.env).toMatchObject({ KIMI_CODE_HOME: home });
  });

  it('skips a plugin with a broken manifest', async () => {
    const home = makeTempDir();
    const root = join(home, 'plugins', 'managed', 'broken');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'kimi.plugin.json'), '{not json', 'utf-8');
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [{ id: 'broken', root, source: 'local-path', enabled: true, installedAt: new Date().toISOString() }],
      }),
      'utf-8',
    );

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    const record = manager.get('broken');
    expect(record?.state).toBe('error');
    expect(manager.enabledMcpServers()).toEqual({});
  });
});
