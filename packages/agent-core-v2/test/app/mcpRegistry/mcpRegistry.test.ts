import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { createServices } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  IMcpConfigStore,
  McpConfigStore,
  type GlobalMcpServerConfig,
} from '#/app/mcpConfig/configStore';
import { IPluginService } from '#/app/plugin/plugin';
import type { PluginMcpServerEntry } from '#/app/plugin/types';
import { IMcpRegistryService, mcpServerConfigsEqual } from '#/app/mcpRegistry/mcpRegistry';
import { McpRegistryService } from '#/app/mcpRegistry/mcpRegistryService';
import { ErrorCodes } from '#/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

function stdioServer(name: string, command = 'npx'): GlobalMcpServerConfig {
  return { name, transport: 'stdio', command };
}

function pluginEntry(
  pluginId: string,
  serverName: string,
  config: PluginMcpServerEntry['config'],
): PluginMcpServerEntry {
  return { name: `plugin-${pluginId}:${serverName}`, config, pluginId, serverName };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(value), 'utf8');
}

describe('McpRegistryService', () => {
  let home: string;
  let disposables: DisposableStore;
  let tempDirs: string[];
  let store: IMcpConfigStore;
  let pluginEntries: PluginMcpServerEntry[];
  let pluginError: Error | undefined;
  let trusted: boolean;
  let trustedKey: string | undefined;
  let registry: IMcpRegistryService;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kimi-mcp-registry-home-'));
    vi.stubEnv('KIMI_CODE_HOME', home);
    disposables = new DisposableStore();
    tempDirs = [home];
    pluginEntries = [];
    pluginError = undefined;
    trusted = true;
    trustedKey = undefined;
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, new InMemoryStorageService());
        reg.definePartialInstance(IBootstrapService, { homeDir: home });
        reg.define(IMcpConfigStore, McpConfigStore);
        reg.definePartialInstance(IPluginService, {
          mcpServerEntries: async () => {
            if (pluginError !== undefined) throw pluginError;
            return pluginEntries;
          },
        });
        reg.defineInstance(IHostFileSystem, new HostFileSystem());
        reg.definePartialInstance(IAtomicDocumentStore, {
          get: async <T>(_scope: string, key: string) => {
            if (!trusted || (trustedKey !== undefined && key !== encodeWorkDirKey(trustedKey))) {
              return undefined;
            }
            return {} as T;
          },
        });
        reg.define(IMcpRegistryService, McpRegistryService);
      },
    });
    store = ix.get(IMcpConfigStore);
    registry = ix.get(IMcpRegistryService);
  });

  afterEach(async () => {
    disposables.dispose();
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeProject(): Promise<{ project: string; sub: string }> {
    const project = mkdtempSync(join(tmpdir(), 'kimi-mcp-registry-proj-'));
    tempDirs.push(project);
    await mkdir(join(project, '.git'), { recursive: true });
    const sub = join(project, 'pkg');
    await mkdir(sub, { recursive: true });
    return { project, sub };
  }

  describe('list', () => {
    it('lists user-level entries with the store path as origin when no cwd is given', async () => {
      await store.add({
        name: 'fs',
        transport: 'stdio',
        command: 'fs-mcp',
        args: ['--readonly'],
      });
      await store.add({ name: 'docs', transport: 'http', url: 'https://example.com/mcp' });

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
      expect(entries[1]).toMatchObject({
        name: 'docs',
        source: 'global',
        origin: join(home, 'mcp.json'),
        mutable: true,
      });
    });

    it('merges the three file layers with origin and mutability tracking when a cwd is given', async () => {
      await writeJson(join(home, 'mcp.json'), {
        mcpServers: {
          shared: { command: 'user-version' },
          userOnly: { command: 'user-only' },
        },
      });
      const { project, sub } = await makeProject();
      await writeJson(join(project, '.mcp.json'), {
        mcpServers: {
          shared: { command: 'repo-version', cwd: './bin' },
          repoOnly: { command: 'repo-only' },
        },
      });
      await writeJson(join(sub, '.kimi-code', 'mcp.json'), {
        mcpServers: { localOnly: { command: 'local-only' } },
      });

      const entries = await registry.list({ cwd: sub });
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      expect([...byName.keys()].toSorted()).toEqual([
        'localOnly',
        'repoOnly',
        'shared',
        'userOnly',
      ]);

      expect(byName.get('shared')).toMatchObject({
        source: 'global',
        mutable: false,
        origin: join(project, '.mcp.json'),
      });
      expect(byName.get('shared')?.config).toEqual({
        transport: 'stdio',
        command: 'repo-version',
        cwd: join(project, 'bin'),
      });
      expect(byName.get('userOnly')).toMatchObject({
        mutable: true,
        origin: join(home, 'mcp.json'),
      });
      expect(byName.get('repoOnly')).toMatchObject({
        mutable: false,
        origin: join(project, '.mcp.json'),
      });
      expect(byName.get('localOnly')).toMatchObject({
        mutable: false,
        origin: join(sub, '.kimi-code', 'mcp.json'),
      });
    });

    it('loads only user and plugin entries when the workspace is untrusted', async () => {
      await store.add(stdioServer('userOnly', 'user-only'));
      const { project, sub } = await makeProject();
      await writeJson(join(project, '.mcp.json'), {
        mcpServers: { repoOnly: { command: 'repo-only' } },
      });
      await writeJson(join(sub, '.kimi-code', 'mcp.json'), {
        mcpServers: { localOnly: { command: 'local-only' } },
      });
      pluginEntries = [
        pluginEntry('demo', 'api', { transport: 'stdio', command: 'plugin-only' }),
      ];
      trusted = false;

      const entries = await registry.list({ cwd: sub });

      expect(entries.map((entry) => entry.name).toSorted()).toEqual([
        'plugin-demo:api',
        'userOnly',
      ]);
    });

    it('checks trust at the queried cwd rather than the canonical git root', async () => {
      const { project, sub } = await makeProject();
      await writeJson(join(project, '.mcp.json'), {
        mcpServers: { projectOnly: { command: 'project-only' } },
      });
      trustedKey = project;

      const entries = await registry.list({ cwd: sub });

      expect(entries.map((entry) => entry.name)).not.toContain('projectOnly');
    });

    it('lists project layers when the queried subdirectory cwd itself is trusted', async () => {
      const { project, sub } = await makeProject();
      await writeJson(join(project, '.mcp.json'), {
        mcpServers: { projectOnly: { command: 'project-only' } },
      });
      await writeJson(join(sub, '.kimi-code', 'mcp.json'), {
        mcpServers: { localOnly: { command: 'local-only' } },
      });
      trustedKey = sub;

      const entries = await registry.list({ cwd: sub });

      expect(entries.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(['projectOnly', 'localOnly']),
      );
    });

    it('resolves a relative non-git cwd before checking workspace trust', async () => {
      const project = mkdtempSync(join(tmpdir(), 'kimi-mcp-registry-non-git-'));
      tempDirs.push(project);
      await writeJson(join(project, '.mcp.json'), {
        mcpServers: { relativeOnly: { command: 'relative-only' } },
      });
      trustedKey = project;

      const entries = await registry.list({ cwd: relative(process.cwd(), project) });

      expect(entries.map((entry) => entry.name)).toContain('relativeOnly');
    });

    it('exposes plugin servers as read-only entries with their effective config', async () => {
      pluginEntries = [
        pluginEntry('demo', 'finance', {
          transport: 'stdio',
          command: 'finance-mcp',
          enabled: true,
        }),
        pluginEntry('demo', 'docs', { transport: 'http', url: 'https://example.com/mcp' }),
      ];

      const entries = await registry.list();

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        name: 'plugin-demo:finance',
        config: { transport: 'stdio', command: 'finance-mcp', enabled: true },
        source: 'plugin',
        origin: 'demo',
        mutable: false,
        plugin: { id: 'demo', name: 'finance' },
      });
      expect(entries[1]).toMatchObject({
        name: 'plugin-demo:docs',
        source: 'plugin',
        origin: 'demo',
        mutable: false,
        plugin: { id: 'demo', name: 'docs' },
      });
    });

    it('keeps both sides of a runtime-name collision instead of hiding one', async () => {
      await store.add(stdioServer('plugin-demo:api', 'user-version'));
      pluginEntries = [
        pluginEntry('demo', 'api', { transport: 'http', url: 'https://example.com/mcp' }),
      ];

      const matches = (await registry.list()).filter((entry) => entry.name === 'plugin-demo:api');

      expect(matches).toHaveLength(2);
      expect(matches[0]).toMatchObject({ source: 'global', mutable: true });
      expect(matches[1]).toMatchObject({ source: 'plugin', mutable: false, origin: 'demo' });
    });

    it('propagates a plugin listing failure instead of reading as not configured', async () => {
      await store.add(stdioServer('fs'));
      pluginError = new Error('plugin state corrupt');

      await expect(registry.list()).rejects.toThrow('plugin state corrupt');
      await expect(registry.get('fs')).rejects.toThrow('plugin state corrupt');
      await expect(registry.resolveRuntimeTarget('fs')).rejects.toThrow('plugin state corrupt');
    });
  });

  describe('get', () => {
    it('returns the first match on a runtime-name collision (globals list first)', async () => {
      await store.add(stdioServer('plugin-demo:api', 'user-version'));
      pluginEntries = [
        pluginEntry('demo', 'api', { transport: 'http', url: 'https://example.com/mcp' }),
      ];

      const entry = await registry.get('plugin-demo:api');

      expect(entry).toMatchObject({
        source: 'global',
        mutable: true,
        config: { command: 'user-version' },
      });
    });

    it('rejects unknown names with the shared not-found error', async () => {
      await expect(registry.get('missing')).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
        message: 'MCP server "missing" was not found',
      });
    });
  });

  describe('resolveRuntimeTarget', () => {
    it('prefers the file entry over an enabled plugin entry', async () => {
      await store.add(stdioServer('plugin-demo:api', 'user-version'));
      pluginEntries = [
        pluginEntry('demo', 'api', { transport: 'http', url: 'https://example.com/mcp' }),
      ];

      await expect(registry.resolveRuntimeTarget('plugin-demo:api')).resolves.toMatchObject({
        source: 'global',
        config: { command: 'user-version' },
      });
    });

    it('lets a file entry win by presence even when the file entry is disabled', async () => {
      await store.add({ ...stdioServer('plugin-demo:api', 'user-version'), enabled: false });
      pluginEntries = [
        pluginEntry('demo', 'api', { transport: 'http', url: 'https://example.com/mcp' }),
      ];

      await expect(registry.resolveRuntimeTarget('plugin-demo:api')).resolves.toMatchObject({
        source: 'global',
        config: { command: 'user-version', enabled: false },
      });
    });

    it('treats a disabled plugin descriptor as absent and falls back to the file entry', async () => {
      await store.add(stdioServer('plugin-demo:api', 'user-version'));
      pluginEntries = [
        pluginEntry('demo', 'api', {
          transport: 'http',
          url: 'https://example.com/mcp',
          enabled: false,
        }),
      ];

      await expect(registry.resolveRuntimeTarget('plugin-demo:api')).resolves.toMatchObject({
        source: 'global',
        config: { command: 'user-version' },
      });

      await store.remove('plugin-demo:api');
      await expect(registry.resolveRuntimeTarget('plugin-demo:api')).resolves.toBeUndefined();
    });

    it('never picks a disabled plugin descriptor when it is the only entry', async () => {
      pluginEntries = [
        pluginEntry('demo', 'api', {
          transport: 'http',
          url: 'https://example.com/mcp',
          enabled: false,
        }),
      ];
      await expect(registry.resolveRuntimeTarget('plugin-demo:api')).resolves.toBeUndefined();
    });

    it('resolves an enabled plugin entry', async () => {
      pluginEntries = [
        pluginEntry('demo', 'api', { transport: 'http', url: 'https://example.com/mcp' }),
      ];
      await expect(registry.resolveRuntimeTarget('plugin-demo:api')).resolves.toMatchObject({
        source: 'plugin',
      });
    });

    it('returns undefined for a name no source defines', async () => {
      await expect(registry.resolveRuntimeTarget('ghost')).resolves.toBeUndefined();
    });
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
        { transport: 'stdio', command: 'a', env: { A: '1', B: '2' } },
        { transport: 'stdio', command: 'a', env: { B: '2', A: '1' } },
      ),
    ).toBe(true);
  });

  it('distinguishes structural differences', () => {
    expect(
      mcpServerConfigsEqual(
        { transport: 'stdio', command: 'a' },
        { transport: 'stdio', command: 'a', args: [] },
      ),
    ).toBe(false);
    expect(
      mcpServerConfigsEqual(
        { transport: 'stdio', command: 'a' },
        { transport: 'http', url: 'https://example.com/mcp' },
      ),
    ).toBe(false);
  });
});
