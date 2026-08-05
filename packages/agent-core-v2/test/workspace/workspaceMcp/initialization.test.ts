/**
 * Scenario: workspace MCP initialization — config-readiness gating and the
 * global `[mcp]` timeout preferences, end to end.
 *
 * Exercises the real `WorkspaceMcpService` + `WorkspaceMcpConfigService`
 * through DI against real temp config files and stdio fixture servers. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceMcp/initialization.test.ts`.
 */

import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { MCP_SECTION, type McpSection } from '#/app/mcpConfig/configSection';
import { IMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import type { ReloadSummary } from '#/app/plugin/types';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  IHostFsWatchService,
  type HostFsChange,
  type IHostFsWatchHandle,
} from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { IWorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import { WorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfigService';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { WorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcpService';

import { stubLog } from '../../_base/log/stubs';
import { registerAgentIdentityStub } from '../../app/agentIdentity/stubs';
import {
  createMemoryMcpOAuthStore,
  slowToolStdioFixture,
  stdioFixture,
} from '../../mcpCore/stubs';

describe('Workspace MCP initialization', () => {
  let cwd: string;
  let homeDir: string;
  let disposables: DisposableStore;
  let manager: McpConnectionManager | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-session-mcp-cwd-'));
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-session-mcp-home-'));
    disposables = new DisposableStore();
    manager = undefined;
  });

  afterEach(async () => {
    await manager?.shutdown();
    disposables.dispose();
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(homeDir, { recursive: true, force: true }),
    ]);
  });

  function createWorkspaceMcpService(ready: Promise<void>, mcpSection?: McpSection) {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IBootstrapService, { homeDir });
        reg.definePartialInstance(IWorkspaceContext, { cwd });
        reg.definePartialInstance(IPluginService, {
          enabledMcpServers: async () => ({}),
          onDidReload: Event.None as Event<ReloadSummary>,
        });
        reg.definePartialInstance(IMcpOAuthStore, createMemoryMcpOAuthStore());
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        reg.definePartialInstance(IConfigService, {
          ready,
          get: (<T = unknown>(domain: string): T =>
            (domain === MCP_SECTION ? mcpSection : undefined) as T),
        });
        reg.definePartialInstance(IHostFsWatchService, {
          watch: (): IHostFsWatchHandle => ({
            onDidChange: Event.None as Event<HostFsChange>,
            dispose: () => {},
          }),
        });
        reg.defineInstance(IHostFileSystem, new HostFileSystem());
        reg.definePartialInstance(IWorkspaceTrust, {
          ready: Promise.resolve(),
          isTrusted: () => true,
          onDidChange: Event.None as IWorkspaceTrust['onDidChange'],
        });
        reg.define(IWorkspaceMcpConfigService, WorkspaceMcpConfigService);
        registerAgentIdentityStub(reg);
        reg.define(IWorkspaceMcpService, WorkspaceMcpService);
      },
    });
    return ix.get(IWorkspaceMcpService);
  }

  it('exposes the connection manager before config is ready and starts connecting once ready', async () => {
    let resolveConfigReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveConfigReady = resolve;
    });
    await writeProjectMcpJson(cwd, {
      alpha: {
        transport: 'stdio',
        command: process.execPath,
        args: [stdioFixture],
      },
    });
    const service = createWorkspaceMcpService(ready);
    // The manager is available synchronously, independent of config readiness.
    manager = service.connectionManager();
    expect(manager.list()).toEqual([]);

    // The initial connect is gated on config.ready: no entry exists yet.
    await sleep(50);
    expect(manager.list()).toEqual([]);

    resolveConfigReady();
    await service.ready;
    expect(manager.get('alpha')?.status).toBe('connected');
  }, 15000);

  it('times out tool calls using the session MCP timeout preference', async () => {
    await writeProjectMcpJson(cwd, {
      slowTool: {
        transport: 'stdio',
        command: process.execPath,
        args: [slowToolStdioFixture],
        env: { KIMI_TEST_MCP_TOOL_DELAY_MS: '300' },
      },
    });
    const service = createWorkspaceMcpService(Promise.resolve(), { toolTimeoutMs: 1 });
    await service.ready;
    manager = service.connectionManager();
    const client = manager.resolved('slowTool')?.client;
    if (client === undefined) throw new Error('expected a connected client');
    await expect(client.callTool('slow_echo', { text: 'hi' })).rejects.toThrow(/timed out/i);
  }, 15000);
});

async function writeProjectMcpJson(
  cwd: string,
  servers: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(cwd, '.kimi-code'), { recursive: true });
  await writeFile(
    join(cwd, '.kimi-code', 'mcp.json'),
    JSON.stringify({ mcpServers: servers }),
    'utf8',
  );
}
