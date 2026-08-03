/**
 * G5 rust-transport integration test — `pluginService` + `workspaceService` +
 * `hostFolderBrowser` through the klient facade (contract-validated outputs).
 *
 * Workspaces / host-folder-browsing / host plugin management are host-backed:
 * they run against a temp `homeDir` and never touch the engine. The plugin
 * read surface (listPlugins / getPluginInfo / listPluginCommands) is
 * engine-backed via rust-loop, so those assertions are shape-tolerant — they
 * pass whether the engine's plugin store is empty or populated.
 *
 * Run with `KIMI_AGENT_FORCE_STDIO=1` (the engine spawns over stdio).
 */
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKlientFromRust } from '#/transports/rust/index';
import type { Klient } from '#/core/klient';

/** Normalize a path for cross-platform equality (Windows casing/slashes). */
function normPath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/');
}

async function writeInstalledPlugin(homeDir: string): Promise<string> {
  const pluginRoot = join(homeDir, 'plugins', 'managed', 'fixture-plugin');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, 'kimi.plugin.json'),
    JSON.stringify({
      name: 'fixture-plugin',
      version: '1.0.0',
      description: 'A fixture plugin for the rust-transport test.',
      mcpServers: { helper: { transport: 'stdio', command: 'node', args: ['server.js'] } },
    }),
  );
  await mkdir(join(homeDir, 'plugins'), { recursive: true });
  await writeFile(
    join(homeDir, 'plugins', 'installed.json'),
    JSON.stringify({
      version: 1,
      plugins: [
        {
          id: 'fixture-plugin',
          root: pluginRoot,
          source: 'local-path',
          enabled: true,
          installedAt: new Date().toISOString(),
          capabilities: { mcpServers: { helper: { enabled: true } } },
        },
      ],
    }),
  );
  return pluginRoot;
}

describe('workspaceService (rust host registry)', () => {
  let homeDir: string;
  let wsRoot: string;
  let klient: Klient;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'klient-rust-ws-'));
    wsRoot = await mkdtemp(join(tmpdir(), 'klient-workspace-root-'));
    klient = createKlientFromRust({ homeDir });
  });

  afterEach(async () => {
    await klient.close();
    await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(wsRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('createOrTouch registers a workspace; list/get round-trip it', async () => {
    const created = await klient.global.workspaces.createOrTouch({
      root: wsRoot,
      name: 'My Project',
    });
    expect(created.root).toBe(wsRoot);
    expect(created.name).toBe('My Project');
    expect(created.id).toMatch(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/);
    expect(typeof created.createdAt).toBe('number');
    expect(typeof created.lastOpenedAt).toBe('number');

    const listed = await klient.global.workspaces.list();
    expect(listed.map((w) => w.id)).toContain(created.id);

    const fetched = await klient.global.workspaces.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.root).toBe(wsRoot);
  });

  it('createOrTouch without a name derives it from the root basename', async () => {
    const created = await klient.global.workspaces.createOrTouch({ root: wsRoot });
    expect(created.name).toBe(wsRoot.split(/[\\/]/).pop());
  });

  it('createOrTouch on the same root reuses the id and advances lastOpenedAt', async () => {
    const first = await klient.global.workspaces.createOrTouch({ root: wsRoot });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await klient.global.workspaces.createOrTouch({ root: wsRoot });
    expect(second.id).toBe(first.id);
    expect(second.lastOpenedAt).toBeGreaterThanOrEqual(first.lastOpenedAt);
    // One physical root is listed once.
    expect((await klient.global.workspaces.list()).filter((w) => w.id === first.id)).toHaveLength(1);
  });

  it('createOrTouch rejects a missing root with fs.path_not_found', async () => {
    await expect(
      klient.global.workspaces.createOrTouch({ root: join(wsRoot, 'does-not-exist') }),
    ).rejects.toMatchObject({ code: 40409 });
  });

  it('createOrTouch rejects a file path (not a directory)', async () => {
    const filePath = join(wsRoot, 'a-file');
    await writeFile(filePath, 'not a directory');
    await expect(klient.global.workspaces.createOrTouch({ root: filePath })).rejects.toMatchObject({
      code: 40409,
    });
  });

  it('update renames a workspace; unknown ids return undefined', async () => {
    const created = await klient.global.workspaces.createOrTouch({ root: wsRoot });
    const updated = await klient.global.workspaces.update({ id: created.id, patch: { name: 'Renamed' } });
    expect(updated?.name).toBe('Renamed');
    expect((await klient.global.workspaces.get(created.id))?.name).toBe('Renamed');
    expect(await klient.global.workspaces.update({ id: 'wd_missing_000000000000', patch: { name: 'x' } }))
      .toBeUndefined();
  });

  it('delete removes the workspace; get returns undefined', async () => {
    const created = await klient.global.workspaces.createOrTouch({ root: wsRoot });
    await klient.global.workspaces.delete(created.id);
    expect(await klient.global.workspaces.get(created.id)).toBeUndefined();
    expect((await klient.global.workspaces.list()).map((w) => w.id)).not.toContain(created.id);
  });
});

describe('hostFolderBrowser', () => {
  let homeDir: string;
  let wsRoot: string;
  let klient: Klient;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'klient-rust-fs-'));
    wsRoot = await mkdtemp(join(tmpdir(), 'klient-browse-root-'));
    klient = createKlientFromRust({ homeDir });
  });

  afterEach(async () => {
    await klient.close();
    await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(wsRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('browse lists only directories, dot-last sorted', async () => {
    await mkdir(join(wsRoot, 'zeta'));
    await mkdir(join(wsRoot, 'alpha'));
    await mkdir(join(wsRoot, '.hidden'));
    await writeFile(join(wsRoot, 'file.txt'), 'not a dir');
    const result = await klient.global.hostFs.browse(wsRoot);
    // `browse` realpaths its target; on Windows realpath may emit the 8.3
    // short-path spelling of the input (e.g. `ADMINI~1`), so compare against
    // the realpath-normalized form rather than the raw input.
    expect(result.path).toBe(await realpath(wsRoot));
    expect(typeof result.parent).toBe('string');
    const names = result.entries.map((e) => e.name);
    expect(names).toContain('alpha');
    expect(names).toContain('zeta');
    expect(names).toContain('.hidden');
    expect(names).not.toContain('file.txt');
    expect(result.entries.every((e) => e.is_dir === true)).toBe(true);
    // Dot-entries sort last.
    const sorted = result.entries.map((e) => e.name.startsWith('.'));
    expect(sorted).toEqual([...sorted].sort((a, b) => (a === b ? 0 : a ? 1 : -1)));
  });

  it('browse without an argument resolves to the OS home directory', async () => {
    const result = await klient.global.hostFs.browse();
    expect(normPath(result.path)).toBe(normPath(homedir()));
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it('browse rejects a relative path (validation.failed)', async () => {
    await expect(klient.global.hostFs.browse('relative/path')).rejects.toMatchObject({ code: 40001 });
  });

  it('browse rejects a missing path (fs.path_not_found)', async () => {
    await expect(
      klient.global.hostFs.browse(join(wsRoot, 'missing-dir')),
    ).rejects.toMatchObject({ code: 40409 });
  });

  it('home returns the OS home and recent_roots from the workspace registry', async () => {
    await klient.global.workspaces.createOrTouch({ root: wsRoot });
    const result = await klient.global.hostFs.home();
    expect(result.home).toBe(homedir());
    expect(result.recent_roots).toContain(wsRoot);
  });
});

describe('pluginService', () => {
  let homeDir: string;
  let klient: Klient;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'klient-rust-plugin-'));
    klient = createKlientFromRust({ homeDir });
  });

  afterEach(async () => {
    await klient.close();
    await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('listPlugins returns an array of contract-shaped summaries', async () => {
    const plugins = await klient.global.plugins.list();
    expect(Array.isArray(plugins)).toBe(true);
    for (const plugin of plugins) {
      expect(plugin).toMatchObject({
        id: expect.any(String),
        displayName: expect.any(String),
        enabled: expect.any(Boolean),
        state: expect.stringMatching(/^(ok|error)$/),
        skillCount: expect.any(Number),
        mcpServerCount: expect.any(Number),
        enabledMcpServerCount: expect.any(Number),
        hookCount: expect.any(Number),
        commandCount: expect.any(Number),
        hasErrors: expect.any(Boolean),
        source: expect.stringMatching(/^(local-path|zip-url|github)$/),
      });
    }
  });

  it('getPluginInfo for an unknown plugin rejects (engine has no such plugin)', async () => {
    await expect(klient.global.plugins.info('definitely-not-installed')).rejects.toMatchObject({
      code: 40001,
    });
  });

  it('listPluginCommands returns an array of contract-shaped command defs', async () => {
    const commands = await klient.global.plugins.listCommands();
    expect(Array.isArray(commands)).toBe(true);
    for (const command of commands) {
      expect(command).toMatchObject({
        pluginId: expect.any(String),
        name: expect.any(String),
        description: expect.any(String),
        body: expect.any(String),
        path: expect.any(String),
      });
    }
  });

  it('installPlugin rejects with a clear RPCError (no engine/sdk capability)', async () => {
    await expect(klient.global.plugins.install('https://example.com/plugin.zip')).rejects.toMatchObject({
      code: 50001,
    });
  });

  it('checkUpdates rejects with a clear RPCError (no engine/sdk capability)', async () => {
    await expect(klient.global.plugins.checkUpdates()).rejects.toMatchObject({ code: 50001 });
  });

  it('reload / setPluginEnabled / setPluginMcpServerEnabled / remove drive the host registry', async () => {
    await writeInstalledPlugin(homeDir);

    const reload = await klient.global.plugins.reload();
    expect(reload.errors).toEqual([]);

    await klient.global.plugins.setEnabled({ id: 'fixture-plugin', enabled: false });
    const afterDisable = JSON.parse(
      await readFile(join(homeDir, 'plugins', 'installed.json'), 'utf8'),
    ) as { plugins: Array<{ enabled: boolean }> };
    expect(afterDisable.plugins[0]?.enabled).toBe(false);

    await klient.global.plugins.setMcpServerEnabled({
      id: 'fixture-plugin',
      server: 'helper',
      enabled: false,
    });
    const afterMcp = JSON.parse(
      await readFile(join(homeDir, 'plugins', 'installed.json'), 'utf8'),
    ) as {
      plugins: Array<{ capabilities: { mcpServers: Record<string, { enabled: boolean }> } }>;
    };
    expect(afterMcp.plugins[0]?.capabilities.mcpServers['helper']?.enabled).toBe(false);

    await klient.global.plugins.remove('fixture-plugin');
    const afterRemove = JSON.parse(
      await readFile(join(homeDir, 'plugins', 'installed.json'), 'utf8'),
    ) as { plugins: unknown[] };
    expect(afterRemove.plugins).toEqual([]);
  });

  it('setPluginEnabled for an unknown plugin surfaces the host registry error', async () => {
    await expect(
      klient.global.plugins.setEnabled({ id: 'nope', enabled: true }),
    ).rejects.toThrow(/not installed/);
  });
});
