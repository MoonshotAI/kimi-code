/**
 * Scenario: workspace MCP config — the initial file+plugin merge (file wins
 * name collisions) and watch/plugin-reload-driven reconciliation published
 * as already-diffed change events.
 *
 * Exercises the real `WorkspaceMcpConfigService` against real temp config
 * files with a manually-fired fs-watch stub. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceMcpConfig/workspaceMcpConfig.test.ts`.
 */

import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { MCP_SECTION, type McpSection } from '#/app/mcpConfig/configSection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import type { ReloadSummary } from '#/app/plugin/types';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  IHostFsWatchService,
  type HostFsChange,
  type IHostFsWatchHandle,
} from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  IWorkspaceTrust,
  type WorkspaceTrustChange,
} from '#/workspace/workspaceTrust/workspaceTrust';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import { WorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfigService';

import { stubLog } from '../../_base/log/stubs';

function stdioConfig(command: string): McpServerConfig {
  return { transport: 'stdio', command, args: [] };
}

describe('WorkspaceMcpConfigService', () => {
  let cwd: string;
  let homeDir: string;
  let disposables: DisposableStore;
  let watchFires: Map<string, Emitter<HostFsChange>>;
  let pluginServers: Record<string, McpServerConfig>;
  let pluginReloads: Emitter<ReloadSummary>;
  let trusted: boolean;
  let trustFlips: Emitter<WorkspaceTrustChange>;
  let changes: McpServersChange[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-config-cwd-'));
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-config-home-'));
    disposables = new DisposableStore();
    watchFires = new Map();
    pluginServers = {};
    pluginReloads = new Emitter<ReloadSummary>();
    trusted = true;
    trustFlips = new Emitter<WorkspaceTrustChange>();
    changes = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    disposables.dispose();
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(homeDir, { recursive: true, force: true }),
    ]);
  });

  function fsWatchStub(): IHostFsWatchService {
    return {
      _serviceBrand: undefined,
      watch: (path: string): IHostFsWatchHandle => {
        let emitter = watchFires.get(path);
        if (emitter === undefined) {
          emitter = new Emitter<HostFsChange>();
          watchFires.set(path, emitter);
        }
        return { ready: Promise.resolve(), onDidChange: emitter.event, dispose: () => {} };
      },
    };
  }

  function createService(mcpSection?: McpSection): IWorkspaceMcpConfigService {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IBootstrapService, { homeDir });
        reg.definePartialInstance(IWorkspaceContext, { cwd });
        reg.definePartialInstance(IPluginService, {
          enabledMcpServers: async () => pluginServers,
          onDidReload: pluginReloads.event,
        });
        reg.defineInstance(ILogService, stubLog());
        reg.definePartialInstance(IConfigService, {
          ready: Promise.resolve(),
          get: (<T = unknown>(domain: string): T =>
            (domain === MCP_SECTION ? mcpSection : undefined) as T),
        });
        reg.defineInstance(IHostFsWatchService, fsWatchStub());
        reg.defineInstance(IHostFileSystem, new HostFileSystem());
        reg.definePartialInstance(IWorkspaceTrust, {
          ready: Promise.resolve(),
          isTrusted: () => trusted,
          onDidChange: trustFlips.event,
        });
        reg.define(IWorkspaceMcpConfigService, WorkspaceMcpConfigService);
      },
    });
    const service = ix.get(IWorkspaceMcpConfigService);
    service.onDidChange((change) => changes.push(change));
    return service;
  }

  async function writeProjectConfig(servers: Record<string, McpServerConfig>): Promise<string> {
    const dir = join(cwd, '.kimi-code');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'mcp.json');
    await writeFile(file, JSON.stringify({ mcpServers: servers }), 'utf8');
    return file;
  }

  it('merges file and plugin servers in the initial resolve (file wins name collisions)', async () => {
    await writeProjectConfig({ shared: stdioConfig('file-version'), fileOnly: stdioConfig('file') });
    pluginServers = { shared: stdioConfig('plugin-version'), pluginOnly: stdioConfig('plugin') };

    const service = createService();
    await service.ready;

    expect(service.servers()).toEqual({
      shared: stdioConfig('file-version'),
      fileOnly: stdioConfig('file'),
      pluginOnly: stdioConfig('plugin'),
    });
    expect(changes).toEqual([]);
  });

  it('skips the project-level config files while the workspace is untrusted', async () => {
    await writeProjectConfig({ fileOnly: stdioConfig('file') });
    pluginServers = { pluginOnly: stdioConfig('plugin') };
    trusted = false;

    const service = createService();
    await service.ready;

    expect(service.servers()).toEqual({ pluginOnly: stdioConfig('plugin') });
  });

  it('picks up the project servers when the workspace becomes trusted', async () => {
    await writeProjectConfig({ fileOnly: stdioConfig('file') });
    trusted = false;
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({});

    trusted = true;
    trustFlips.fire({ trusted: true });

    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: { fileOnly: stdioConfig('file') }, remove: [] }]);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(service.servers()).toEqual({ fileOnly: stdioConfig('file') });
  }, 20000);

  it('drops the project servers when the workspace loses trust', async () => {
    await writeProjectConfig({ fileOnly: stdioConfig('file') });
    pluginServers = { pluginOnly: stdioConfig('plugin') };
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({
      fileOnly: stdioConfig('file'),
      pluginOnly: stdioConfig('plugin'),
    });

    trusted = false;
    trustFlips.fire({ trusted: false });

    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: {}, remove: ['fileOnly'] }]);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(service.servers()).toEqual({ pluginOnly: stdioConfig('plugin') });
  }, 20000);

  it('exposes the [mcp] section as tunables, resolved live', async () => {
    const service = createService({ startupTimeoutMs: 1234, toolTimeoutMs: 5678 });
    await service.ready;

    expect(service.tunables()).toEqual({ startupTimeoutMs: 1234, toolTimeoutMs: 5678 });
  });

  it('publishes the diff when a watched config file changes', async () => {
    const file = await writeProjectConfig({ alpha: stdioConfig('alpha') });
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({ alpha: stdioConfig('alpha') });

    await writeProjectConfig({ beta: stdioConfig('beta') });
    watchFires.get(cwd)?.fire({ path: file, action: 'modified', kind: 'file' });

    await vi.waitFor(
      () => {
        expect(changes).toEqual([
          { upsert: { beta: stdioConfig('beta') }, remove: ['alpha'] },
        ]);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(service.servers()).toEqual({ beta: stdioConfig('beta') });
  }, 20000);

  it('falls back to the same-named plugin server when a file server vanishes', async () => {
    const file = await writeProjectConfig({ shared: stdioConfig('file-version') });
    pluginServers = { shared: stdioConfig('plugin-version') };
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({ shared: stdioConfig('file-version') });

    await writeProjectConfig({});
    watchFires.get(cwd)?.fire({ path: file, action: 'modified', kind: 'file' });

    await vi.waitFor(
      () => {
        expect(changes).toEqual([
          { upsert: { shared: stdioConfig('plugin-version') }, remove: [] },
        ]);
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('publishes a plugin server that appears on plugin reload', async () => {
    const service = createService();
    await service.ready;

    pluginServers = { gamma: stdioConfig('gamma') };
    pluginReloads.fire({ added: [], removed: [], errors: [] });

    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: { gamma: stdioConfig('gamma') }, remove: [] }]);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(service.servers()).toEqual({ gamma: stdioConfig('gamma') });
  }, 20000);

  it('removes a plugin server that vanishes on plugin reload', async () => {
    pluginServers = { alpha: stdioConfig('alpha') };
    const service = createService();
    await service.ready;

    pluginServers = {};
    pluginReloads.fire({ added: [], removed: [], errors: [] });

    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: {}, remove: ['alpha'] }]);
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('stays silent when a vanished plugin server leaves the same-named file entry in place', async () => {
    await writeProjectConfig({ shared: stdioConfig('file-version') });
    pluginServers = { shared: stdioConfig('plugin-version') };
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({ shared: stdioConfig('file-version') });

    pluginServers = {};
    pluginReloads.fire({ added: [], removed: [], errors: [] });

    // The merged view is unchanged (the file entry still wins), so no event
    // fires and the snapshot stays put.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    expect(changes).toEqual([]);
    expect(service.servers()).toEqual({ shared: stdioConfig('file-version') });
  }, 20000);
});
