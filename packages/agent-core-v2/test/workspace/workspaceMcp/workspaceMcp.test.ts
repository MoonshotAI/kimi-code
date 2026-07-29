/**
 * Scenario: workspace MCP — shared initial connect, caller-server union
 * merge, and watch-driven file-config reconciliation.
 *
 * Exercises the real `WorkspaceMcpService` against real temp config files and
 * stdio fixture servers, with a manually-fired fs-watch stub. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceMcp/workspaceMcp.test.ts`.
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
import { McpConnectionManager } from '#/agent/mcp/connection-manager';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import { MCP_SECTION, type McpSection } from '#/agent/mcp/configSection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import type { ReloadSummary } from '#/app/plugin/types';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import {
  IHostFsWatchService,
  type HostFsChange,
  type IHostFsWatchHandle,
} from '#/os/interface/hostFsWatch';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { WorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcpService';

import { stubLog } from '../../_base/log/stubs';
import { stdioFixture } from '../../agent/mcp/stubs';

function stdioServer(): McpServerConfig {
  return { transport: 'stdio', command: process.execPath, args: [stdioFixture] };
}

describe('WorkspaceMcpService', () => {
  let cwd: string;
  let homeDir: string;
  let disposables: DisposableStore;
  let watchFires: Map<string, Emitter<HostFsChange>>;
  let pluginServers: Record<string, McpServerConfig>;
  let pluginReloads: Emitter<ReloadSummary>;
  let manager: InstanceType<typeof McpConnectionManager> | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-cwd-'));
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-home-'));
    disposables = new DisposableStore();
    watchFires = new Map();
    pluginServers = {};
    pluginReloads = new Emitter<ReloadSummary>();
    manager = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager?.shutdown();
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
        return { onDidChange: emitter.event, dispose: () => {} };
      },
    };
  }

  function createService(mcpSection?: McpSection): IWorkspaceMcpService {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IBootstrapService, { homeDir });
        reg.definePartialInstance(IWorkspaceContext, { cwd });
        reg.definePartialInstance(IPluginService, {
          enabledMcpServers: async () => pluginServers,
          onDidReload: pluginReloads.event,
        });
        reg.definePartialInstance(IAtomicDocumentStore, {});
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        reg.definePartialInstance(IConfigService, {
          ready: Promise.resolve(),
          get: (<T = unknown>(domain: string): T =>
            (domain === MCP_SECTION ? mcpSection : undefined) as T),
        });
        reg.defineInstance(IHostFsWatchService, fsWatchStub());
        reg.define(IWorkspaceMcpService, WorkspaceMcpService);
      },
    });
    return ix.get(IWorkspaceMcpService);
  }

  async function writeProjectConfig(servers: Record<string, McpServerConfig>): Promise<string> {
    const dir = join(cwd, '.kimi-code');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'mcp.json');
    await writeFile(file, JSON.stringify({ mcpServers: servers }), 'utf8');
    return file;
  }

  it('connects file and plugin servers in the initial load (file wins name collisions)', async () => {
    await writeProjectConfig({
      shared: { transport: 'stdio', command: 'file-version', args: [] },
      fileOnly: stdioServer(),
    });
    pluginServers = { shared: stdioServer() };
    const connectAll = vi
      .spyOn(McpConnectionManager.prototype, 'connectAll')
      .mockResolvedValue(undefined);

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    expect(connectAll).toHaveBeenCalledTimes(1);
    const arg = connectAll.mock.calls[0]?.[0] as Record<string, McpServerConfig>;
    expect(Object.keys(arg).toSorted()).toEqual(['fileOnly', 'shared']);
    expect(arg['shared']).toEqual({ transport: 'stdio', command: 'file-version', args: [] });
  });

  it('reconciles file-sourced servers when a watched config file changes', async () => {
    const file = await writeProjectConfig({ alpha: stdioServer() });
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    expect(manager.get('alpha')?.status).toBe('connected');

    await writeProjectConfig({ beta: stdioServer() });
    watchFires.get(cwd)?.fire({ path: file, action: 'modified', kind: 'file' });

    await vi.waitFor(
      () => {
        expect(manager?.get('alpha')).toBeUndefined();
        expect(manager?.get('beta')?.status).toBe('connected');
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('falls back to the same-named plugin server when a file server vanishes', async () => {
    const file = await writeProjectConfig({
      shared: { transport: 'stdio', command: 'definitely-not-a-real-command-xyz' },
    });
    pluginServers = { shared: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    // File wins the initial collision — the bogus file command fails.
    expect(manager.get('shared')?.status).toBe('failed');

    await writeProjectConfig({});
    watchFires.get(cwd)?.fire({ path: file, action: 'modified', kind: 'file' });

    // With the file entry gone, the same-named plugin server takes over.
    await vi.waitFor(
      () => {
        expect(manager?.get('shared')?.status).toBe('connected');
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('connects a plugin server that appears on plugin reload after materialization', async () => {
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    expect(manager.get('gamma')).toBeUndefined();

    pluginServers = { gamma: stdioServer() };
    pluginReloads.fire({ added: [], removed: [], errors: [] });

    await vi.waitFor(
      () => {
        expect(manager?.get('gamma')?.status).toBe('connected');
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('disconnects a plugin server that vanishes on plugin reload', async () => {
    pluginServers = { alpha: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    expect(manager.get('alpha')?.status).toBe('connected');

    pluginServers = {};
    pluginReloads.fire({ added: [], removed: [], errors: [] });

    await vi.waitFor(
      () => {
        expect(manager?.get('alpha')).toBeUndefined();
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('keeps the file entry when the same-named plugin server vanishes on reload', async () => {
    await writeProjectConfig({ shared: stdioServer() });
    pluginServers = { shared: { transport: 'stdio', command: 'definitely-not-a-real-command-xyz' } };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    // File wins the initial collision, so the valid file config connects.
    expect(manager.get('shared')?.status).toBe('connected');

    pluginServers = {};
    pluginReloads.fire({ added: [], removed: [], errors: [] });

    // The file entry stays (the fallback is a no-op reconnect to the same
    // file config) and never flips to the bogus plugin command's failure.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    expect(manager.get('shared')?.status).toBe('connected');
  }, 20000);
});
