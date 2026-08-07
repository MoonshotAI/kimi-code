/**
 * Scenario: workspace MCP — the shared connection manager is driven by the
 * config domain: the initial connect consumes its snapshot, and its diffed
 * change events are applied incrementally after the initial connect settles.
 *
 * Exercises the real `WorkspaceMcpService` against a stubbed
 * `IWorkspaceMcpConfigService` and real stdio fixture servers. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceMcp/workspaceMcp.test.ts`.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';
import { IMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
  type McpTunables,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { WorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcpService';

import { stubLog } from '../../_base/log/stubs';
import { createMemoryMcpOAuthStore, stdioFixture } from '../../mcpCore/stubs';
import { registerAgentIdentityStub } from '../../app/agentIdentity/stubs';

function stdioServer(): McpServerConfig {
  return { transport: 'stdio', command: process.execPath, args: [stdioFixture] };
}

describe('WorkspaceMcpService', () => {
  let cwd: string;
  let disposables: DisposableStore;
  let current: Record<string, McpServerConfig>;
  let tunablesValue: McpTunables;
  let tunablesFn: Mock<() => McpTunables>;
  let configChanges: Emitter<McpServersChange>;
  let manager: InstanceType<typeof McpConnectionManager> | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-cwd-'));
    disposables = new DisposableStore();
    current = {};
    tunablesValue = {};
    tunablesFn = vi.fn(() => tunablesValue);
    configChanges = new Emitter<McpServersChange>();
    manager = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager?.shutdown();
    disposables.dispose();
    await rm(cwd, { recursive: true, force: true });
  });

  function mcpConfigStub(): IWorkspaceMcpConfigService {
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      servers: () => current,
      tunables: () => tunablesFn() as McpTunables,
      onDidChange: configChanges.event,
    };
  }

  function createService(): IWorkspaceMcpService {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IWorkspaceContext, { cwd });
        reg.defineInstance(IWorkspaceMcpConfigService, mcpConfigStub());
        reg.definePartialInstance(IMcpOAuthStore, createMemoryMcpOAuthStore());
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        registerAgentIdentityStub(reg);
        reg.define(IWorkspaceMcpService, WorkspaceMcpService);
      },
    });
    return ix.get(IWorkspaceMcpService);
  }

  it('connects the config snapshot in the initial load', async () => {
    current = { alpha: stdioServer(), beta: stdioServer() };
    const connectAll = vi
      .spyOn(McpConnectionManager.prototype, 'connectAll')
      .mockResolvedValue(undefined);

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    expect(connectAll).toHaveBeenCalledTimes(1);
    expect(Object.keys(connectAll.mock.calls[0]?.[0] ?? {}).toSorted()).toEqual(['alpha', 'beta']);
  });

  it('reads timeout tunables from the config domain at connect', async () => {
    tunablesValue = { startupTimeoutMs: 4321, toolTimeoutMs: 9876 };
    current = { alpha: stdioServer() };

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    expect(manager.get('alpha')?.status).toBe('connected');
    expect(tunablesFn).toHaveBeenCalled();
  }, 20000);

  it('applies upserts and removals from config change events', async () => {
    current = { alpha: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    expect(manager.get('alpha')?.status).toBe('connected');

    configChanges.fire({ upsert: { beta: stdioServer() }, remove: ['alpha'] });

    await vi.waitFor(
      () => {
        expect(manager?.get('alpha')?.status).toBe('removed');
        expect(manager?.get('beta')?.status).toBe('connected');
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('queues change events until the initial connect settles', async () => {
    current = { alpha: stdioServer() };
    let settleConnectAll: () => void = () => undefined;
    vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleConnectAll = resolve;
        }),
    );
    const connect = vi
      .spyOn(McpConnectionManager.prototype, 'connect')
      .mockResolvedValue(undefined as never);
    const markRemoved = vi
      .spyOn(McpConnectionManager.prototype, 'markRemoved')
      .mockResolvedValue(true as never);

    const service = createService();
    manager = service.connectionManager();

    configChanges.fire({ upsert: { beta: stdioServer() }, remove: ['alpha'] });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    expect(connect).not.toHaveBeenCalled();
    expect(markRemoved).not.toHaveBeenCalled();

    settleConnectAll();
    await service.ready;
    await vi.waitFor(
      () => {
        expect(markRemoved).toHaveBeenCalledWith('alpha');
        expect(connect).toHaveBeenCalledWith('beta', stdioServer());
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('sessionHandle admits servers connecting before ready settles and freezes the baseline after', async () => {
    current = { alpha: stdioServer() };
    let settleConnectAll: () => void = () => undefined;
    vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockImplementation(function (
      this: McpConnectionManager,
      servers: Readonly<Record<string, McpServerConfig>>,
    ) {
      for (const [name, config] of Object.entries(servers)) {
        void this.connect(name, config);
      }
      return new Promise<void>((resolve) => {
        settleConnectAll = resolve;
      });
    });

    const service = createService();
    manager = service.connectionManager();
    const handle = service.sessionHandle();

    // 'alpha' appears (connecting) while the initial load is still unsettled:
    // admitted into the baseline. A name the view does not know is not.
    await vi.waitFor(() => {
      expect(manager?.get('alpha')).toBeDefined();
    });
    expect(handle.isBaselineServer('alpha')).toBe(true);
    expect(handle.isBaselineServer('ghost')).toBe(false);

    settleConnectAll();
    await service.ready;

    // Once the initial connect settles the baseline is closed: a server that
    // connects afterwards (a plugin install or a config edit) stays outside.
    await manager?.connect('late', stdioServer());
    expect(handle.isBaselineServer('late')).toBe(false);
    expect(handle.isBaselineServer('alpha')).toBe(true);

    // A session materializing now captures a fresh baseline that includes it.
    expect(service.sessionHandle().isBaselineServer('late')).toBe(true);
  }, 20000);

  it('sessionOverlay marks the ephemeral server names as baseline by construction', async () => {
    current = { base: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    const overlay = service.sessionOverlay({ eph: stdioServer() });
    // True even before the overlay's own connect settles.
    expect(overlay.handle.isBaselineServer('eph')).toBe(true);
    expect(overlay.handle.isBaselineServer('base')).toBe(true);

    await overlay.handle.ready;
    expect(overlay.handle.isBaselineServer('eph')).toBe(true);
    expect(overlay.handle.isBaselineServer('late')).toBe(false);

    await overlay.shutdown();
  }, 20000);

  it('sessionOverlay freezes the workspace baseline on workspace ready even while the overlay connect is pending', async () => {
    current = { base: stdioServer() };
    let settleOverlay: () => void = () => undefined;
    vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockImplementation(function (
      this: McpConnectionManager,
      servers: Readonly<Record<string, McpServerConfig>>,
    ) {
      if ('eph' in servers) {
        // Slow ephemeral connect: keeps the overlay's combined readiness open
        // long after the workspace initial load has settled.
        return new Promise<void>((resolve) => {
          settleOverlay = resolve;
        });
      }
      for (const [name, config] of Object.entries(servers)) {
        void this.connect(name, config);
      }
      return Promise.resolve();
    });

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    const overlay = service.sessionOverlay({ eph: stdioServer() });
    expect(overlay.handle.isBaselineServer('eph')).toBe(true);
    expect(overlay.handle.isBaselineServer('base')).toBe(true);

    // The overlay connect is still pending, but the workspace portion of the
    // baseline closed with the workspace initial load: a workspace server
    // added now (plugin install, config edit) must not leak into the session.
    await manager?.connect('late', stdioServer());
    expect(overlay.handle.isBaselineServer('late')).toBe(false);

    settleOverlay();
    await overlay.handle.ready;
    expect(overlay.handle.isBaselineServer('late')).toBe(false);
    expect(overlay.handle.isBaselineServer('eph')).toBe(true);

    await overlay.shutdown();
  }, 20000);

  it('sessionOverlay connects ephemeral servers on a session-owned manager, released by shutdown', async () => {
    current = { base: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    const overlay = service.sessionOverlay({ eph: stdioServer() });
    await overlay.handle.ready;

    const view = overlay.handle.connectionManager;
    expect(view.get('eph')?.status).toBe('connected');
    expect(view.get('base')?.status).toBe('connected');
    // Isolation: the shared manager (and thus the handler's other sessions)
    // never sees the ephemeral server, and the config domain's effective set
    // is untouched — nothing is persisted.
    expect(manager?.get('eph')).toBeUndefined();
    expect(Object.keys(current)).toEqual(['base']);

    await overlay.shutdown();
    expect(view.get('eph')).toBeUndefined();
    expect(view.get('base')?.status).toBe('connected');
  }, 20000);
});

describe('MergedMcpConnectionView', () => {
  let base: McpConnectionManager;
  let overlay: McpConnectionManager;

  beforeEach(() => {
    base = new McpConnectionManager();
    overlay = new McpConnectionManager();
  });

  afterEach(async () => {
    await base.shutdown();
    await overlay.shutdown();
  });

  function disabledStdio(command: string): McpServerConfig {
    return { transport: 'stdio', command, enabled: false };
  }

  it('shadows same-named base entries with overlay entries and filters their statuses', async () => {
    await base.connect('shared', disabledStdio('base-cmd'));
    await base.connect('base-only', disabledStdio('base-cmd'));
    await overlay.connect('shared', {
      transport: 'http',
      url: 'https://example.com/mcp',
      enabled: false,
    });
    await overlay.connect('eph', disabledStdio('eph-cmd'));
    const view = new MergedMcpConnectionView(base, overlay, new Set(['shared', 'eph']));

    expect(view.list().map((entry) => entry.name).toSorted()).toEqual([
      'base-only',
      'eph',
      'shared',
    ]);
    expect(view.get('shared')?.transport).toBe('http');
    expect(view.get('base-only')?.transport).toBe('stdio');

    const seen: string[] = [];
    const unsubscribe = view.onStatusChange((entry) => seen.push(entry.name));
    await base.connect('shared', disabledStdio('base-cmd'));
    await base.connect('base-only', disabledStdio('base-cmd'));
    await overlay.connect('shared', {
      transport: 'http',
      url: 'https://example.com/mcp',
      enabled: false,
    });
    unsubscribe();

    expect(seen).toEqual(['base-only', 'shared']);
  });

  it('routes reconnect to the name owner and aggregates initial-load readiness', async () => {
    await base.connect('shared', disabledStdio('base-cmd'));
    // Enabled but unreachable: the entry exists with a failed status, so a
    // routed reconnect re-attempts instead of raising disabled/not-found.
    await overlay.connect('shared', { transport: 'http', url: 'http://127.0.0.1:1/mcp' });
    expect(overlay.get('shared')?.status).toBe('failed');
    const view = new MergedMcpConnectionView(base, overlay, new Set(['shared']));

    await expect(view.reconnect('shared')).resolves.toBeUndefined();
    await expect(view.reconnect('unknown')).rejects.toThrow('Unknown MCP server: unknown');

    await view.waitForInitialLoad();
    expect(view.initialLoadDurationMs()).toBe(0);
  });
});
