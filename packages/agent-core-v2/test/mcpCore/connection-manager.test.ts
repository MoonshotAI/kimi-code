import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'pathe';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Error2 } from '#/errors';
import { KIMI_MCP_CLIENT_NAME } from '#/mcpCore/client-shared';
import { McpConnectionManager, type McpConnectionManagerOptions, type McpServerEntry } from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import type { StoredMcpOAuthTokens } from '#/mcpCore/oauth/provider';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { HostProcessError, HostProcessErrorCode } from '#/os/interface/hostProcess';
import type { RuntimeBinding } from '#/runtime/runtime';

const testRuntimeBinding: RuntimeBinding = { workspaceId: 'test-workspace', runtimeId: 'local' };
const testProcess = new HostProcessService();
const testRuntime = Object.assign(
  new FakeRuntime({ ...testRuntimeBinding, generation: 'test-generation' }, {
    capabilities: ['process'],
  }),
  { process: testProcess },
);
const testRuntimeResolver = {
  _serviceBrand: undefined,
  inspect: () => testRuntime,
  acquire: () => ({
    runtime: testRuntime,
    track: <T extends { dispose(): void | Promise<void> }>(resource: T): T => resource,
    dispose: () => {},
  }),
};

function createManager(options: McpConnectionManagerOptions = {}): McpConnectionManager {
  return new McpConnectionManager({
    runtimeResolver: testRuntimeResolver,
    workspaceId: testRuntimeBinding.workspaceId,
    runtimeId: testRuntimeBinding.runtimeId,
    stdioCwd: process.cwd(),
    ...options,
  });
}

import {
  closeServer,
  crashAfterConnectFixture,
  createMemoryMcpOAuthStore,
  cwdStdioFixture,
  hangingListStdioFixture,
  slowStdioFixture,
  slowToolStdioFixture,
  startAnonymousDiscoveryHttpMcpServer,
  stderrThenExitFixture,
  stdioFixture,
} from './stubs';

function stdioConfig(args: string[] = [stdioFixture]) {
  return {
    transport: 'stdio' as const,
    command: process.execPath,
    args,
  };
}

function createPerSessionMcpHandler(name: string) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  return (req: IncomingMessage, res: ServerResponse): void => {
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (existing !== undefined) {
      void existing.handleRequest(req, res);
      return;
    }
    const mcpServer = new McpServer({ name, version: '0.0.1' });
    mcpServer.registerTool(
      'echo',
      { description: 'Echoes text', inputSchema: { text: z.string() } },
      ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    void mcpServer.connect(transport).then(() => transport.handleRequest(req, res));
  };
}

describe('McpConnectionManager', () => {
  it('connects servers in parallel and exposes connected entries with their tool count', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({ alpha: stdioConfig(), beta: stdioConfig() });
      const entries = cm.list();
      expect(entries.map((e) => e.name).toSorted()).toEqual(['alpha', 'beta']);
      for (const entry of entries) {
        expect(entry.status).toBe('connected');
        expect(entry.toolCount).toBe(4);
        expect(entry.transport).toBe('stdio');
      }
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('isolates permanent startup and discovery failures without retry or blocking the rest', async () => {
    const statuses: string[] = [];
    const cm = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
    });
    cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));
    try {
      await cm.connectAll({
        good: stdioConfig(),
        bad: { transport: 'stdio', command: '/this/path/does/not/exist/anywhere' },
      });
      expect(cm.get('good')?.status).toBe('connected');
      expect(cm.get('bad')?.status).toBe('failed');
      expect(cm.get('bad')?.error).toBeDefined();
      await sleep(300);
      expect(cm.get('bad')?.status).toBe('failed');
      expect(statuses.filter((s) => s.startsWith('bad:'))).toEqual(['bad:pending', 'bad:failed']);
    } finally {
      await cm.shutdown();
    }

    const connectSpy = vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
    const listTools = vi.spyOn(Client.prototype, 'listTools');
    const discovery = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
    });
    try {
      listTools.mockRejectedValue(new McpError(ErrorCode.MethodNotFound, 'tools/list is unavailable'));
      await discovery.connectAll({
        method: { transport: 'http', url: 'https://example.test/mcp' },
      });
      expect(discovery.get('method')).toMatchObject({ status: 'failed', nextRetryAt: undefined });

      for (const statusCode of [401, 403]) {
        listTools.mockRejectedValue(new StreamableHTTPError(statusCode, 'Forbidden'));
        await discovery.connect(`auth${statusCode}`, {
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer static-key' },
        });
        expect(discovery.get(`auth${statusCode}`)).toMatchObject({
          status: 'failed',
          nextRetryAt: undefined,
        });
      }

      listTools.mockResolvedValue({
        tools: [{ name: 'invalid', inputSchema: null }],
      } as never);
      await discovery.connect('schema', { transport: 'http', url: 'https://example.test/mcp' });
      expect(discovery.get('schema')).toMatchObject({ status: 'failed', nextRetryAt: undefined });
      await sleep(250);
      expect(listTools).toHaveBeenCalledTimes(4);
    } finally {
      await discovery.shutdown();
      connectSpy.mockRestore();
      listTools.mockRestore();
    }
  }, 20000);

  it('markRemoved tombstones the entry: client closed, entry kept, reconnect rejected, in-flight connects invalidated, re-connect revives', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(cm.get('alpha')?.status).toBe('connected');

      const statuses: string[] = [];
      cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));

      expect(await cm.markRemoved('alpha')).toBe(true);
      const entry = cm.get('alpha');
      expect(entry?.status).toBe('removed');
      expect(entry?.toolCount).toBe(0);
      expect(cm.resolved('alpha')).toBeUndefined();
      expect(cm.list().map((e) => e.name)).toEqual(['alpha']);
      expect(statuses).toContain('alpha:removed');
      await expect(cm.reconnect('alpha')).rejects.toThrow('Unknown MCP server: alpha');

      expect(await cm.markRemoved('missing')).toBe(false);

      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');
      expect(cm.resolved('alpha')).toBeDefined();

      const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
        pathToFileURL(stdioFixture).href,
      )}), 400)`;
      const connecting = cm.connect('slow', {
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', delayedMockServer],
        startupTimeoutMs: 5_000,
      });
      await sleep(50);
      expect(await cm.markRemoved('slow')).toBe(true);
      await connecting;
      await sleep(600);
      expect(cm.get('slow')?.status).toBe('removed');
      expect(cm.resolved('slow')).toBeUndefined();
      expect(statuses.filter((s) => s.startsWith('slow:'))).toEqual([
        'slow:pending',
        'slow:removed',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('connect with the identical config is a no-op for a live entry', async () => {
    const cm = createManager();
    const statuses: string[] = [];
    cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));
    try {
      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');
      statuses.length = 0;

      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');
      expect(statuses).toEqual([]);

      await cm.connect('alpha', { ...stdioConfig(), startupTimeoutMs: 5_000 });
      expect(cm.get('alpha')?.status).toBe('connected');
      expect(statuses).toEqual(['alpha:pending', 'alpha:connected']);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('marks remote servers failed without retry when the configured bearer token env var is missing', async () => {
    const cases = [
      { transport: 'http' as const, url: 'https://example.invalid/mcp', envVar: 'REMOTE_MCP_TOKEN' },
      { transport: 'sse' as const, url: 'https://example.invalid/sse', envVar: 'LEGACY_MCP_TOKEN' },
    ];
    for (const { transport, url, envVar } of cases) {
      const statuses: string[] = [];
      const cm = createManager({
        envLookup: () => undefined,
        reconnectRetryEnabled: true,
        resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
      });
      cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));
      try {
        await cm.connectAll({
          remote: { transport, url, bearerTokenEnvVar: envVar },
        });
        const entry = cm.get('remote');
        expect(entry?.transport).toBe(transport);
        expect(entry?.status).toBe('failed');
        expect(entry?.error).toContain(`"${envVar}" is not set or is empty`);
        await sleep(250);
        expect(cm.get('remote')?.status).toBe('failed');
        expect(statuses).toEqual(['remote:pending', 'remote:failed']);
      } finally {
        await cm.shutdown();
      }
    }
  });

  it('marks disabled servers without attempting a connection', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        off: { ...stdioConfig(), enabled: false },
      });
      const entry = cm.get('off');
      expect(entry?.status).toBe('disabled');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
    }
  });

  it('applies enabledTools / disabledTools filters to the resolved tool set', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        filtered: { ...stdioConfig(), enabledTools: ['echo'], disabledTools: ['boom'] },
      });
      const resolved = cm.resolved('filtered');
      expect([...(resolved?.enabledNames ?? [])]).toEqual(['echo']);
      expect(cm.get('filtered')?.toolCount).toBe(1);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('reflects the per-server deferred field and the resolved default in the resolved view', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        plain: stdioConfig(),
        pinned: { ...stdioConfig(), deferred: true },
      });
      expect(cm.resolved('plain')?.deferred).toBe(false);
      expect(cm.resolved('pinned')?.deferred).toBe(true);
    } finally {
      await cm.shutdown();
    }

    const defaulted = createManager({
      resolveDefaults: () => ({ defaultDeferred: true }),
    });
    try {
      await defaulted.connectAll({
        plain: stdioConfig(),
        optedOut: { ...stdioConfig(), deferred: false },
      });
      expect(defaulted.resolved('plain')?.deferred).toBe(true);
      expect(defaulted.resolved('optedOut')?.deferred).toBe(false);
      expect(defaulted.deferredOf('plain')).toBe(true);
      expect(defaulted.deferredOf('optedOut')).toBe(false);
    } finally {
      await defaulted.shutdown();
    }

    let liveDefault = true;
    const captured = createManager({
      resolveDefaults: () => ({ defaultDeferred: liveDefault }),
    });
    try {
      await captured.connectAll({ plain: stdioConfig() });
      expect(captured.resolved('plain')?.deferred).toBe(true);
      liveDefault = false;
      expect(captured.resolved('plain')?.deferred).toBe(true);
      await captured.reconnect('plain');
      expect(captured.resolved('plain')?.deferred).toBe(false);
    } finally {
      await captured.shutdown();
    }
  }, 15000);

  it('starts stdio servers in stdioCwd when config.cwd is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-manager-cwd-'));
    const cm = createManager({ stdioCwd: cwd });
    try {
      await cm.connectAll({
        cwd: stdioConfig([cwdStdioFixture]),
      });
      const resolved = cm.resolved('cwd');
      if (resolved === undefined) throw new Error('Expected cwd MCP server to connect');
      const result = await resolved.client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(cwd));
    } finally {
      await cm.shutdown();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15000);

  it('announces the resolved custom identity as the MCP client name', async () => {
    const cm = createManager({ resolveClientName: () => 'acme-dev' });
    try {
      await cm.connectAll({ mock: stdioConfig() });
      const resolved = cm.resolved('mock');
      if (resolved === undefined) throw new Error('Expected mock MCP server to connect');
      const result = await resolved.client.callTool('whoami', {});
      expect((result.content[0] as { type: 'text'; text: string }).text).toBe('acme-dev');
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('keeps the builtin MCP client name when no identity is configured', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({ mock: stdioConfig() });
      const resolved = cm.resolved('mock');
      if (resolved === undefined) throw new Error('Expected mock MCP server to connect');
      const result = await resolved.client.callTool('whoami', {});
      expect((result.content[0] as { type: 'text'; text: string }).text).toBe(
        KIMI_MCP_CLIENT_NAME,
      );
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('emits status transitions in order per server', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(seen.filter((s) => s.name === 'alpha').map((s) => s.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('reconnect cycles a failed server back through pending and into connected when fixed', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        flaky: { transport: 'stdio', command: '/no/such/binary' },
      });
      expect(cm.get('flaky')?.status).toBe('failed');

      await cm.shutdown();
      await cm.connectAll({ flaky: stdioConfig() });
      await cm.reconnect('flaky');
      expect(cm.get('flaky')?.status).toBe('connected');
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('joins in-flight startup and repeated initial loads without stale overwrites', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });
    const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
      pathToFileURL(stdioFixture).href,
    )}), 250)`;
    const config = {
      transport: 'stdio' as const,
      command: process.execPath,
      args: ['-e', delayedMockServer],
      startupTimeoutMs: 2_000,
    };

    const connect = cm.connectAll({ slow: config });
    let repeatedSettled = false;
    const repeated = cm.connectAll({ slow: config }).then(() => {
      repeatedSettled = true;
    });

    try {
      await sleep(50);
      expect(repeatedSettled).toBe(false);
      await cm.reconnect('slow');
      await Promise.all([connect, repeated]);

      expect(cm.get('slow')).toMatchObject({
        status: 'connected',
        toolCount: 4,
      });
      expect(seen.filter((event) => event.name === 'slow').map((event) => event.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
      await Promise.race([Promise.all([connect, repeated]).catch(() => {}), sleep(1_000)]);
    }
  }, 7000);

  it('reconnect throws a coded Error2 when the server name is unknown', async () => {
    const cm = createManager();
    try {
      await expect(cm.reconnect('nope')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnect('nope')).rejects.toMatchObject({ code: 'mcp.server_not_found' });
    } finally {
      await cm.shutdown();
    }
  });

  it('reconnect rejects disabled servers without connecting them', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        off: { ...stdioConfig(), enabled: false },
      });

      await expect(cm.reconnect('off')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnect('off')).rejects.toMatchObject({ code: 'mcp.server_disabled' });
      expect(cm.get('off')).toMatchObject({
        status: 'disabled',
        toolCount: 0,
      });
    } finally {
      await cm.shutdown();
    }
  });

  it('reconnectAndJoin joins an in-flight reconnect instead of starting a second one', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });
    const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
      pathToFileURL(stdioFixture).href,
    )}), 250)`;

    try {
      await cm.connectAll({
        slow: {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', delayedMockServer],
          startupTimeoutMs: 5_000,
        },
      });
      seen.length = 0;

      await Promise.all([cm.reconnectAndJoin('slow'), cm.reconnectAndJoin('slow')]);

      expect(cm.get('slow')?.status).toBe('connected');
      expect(seen.filter((event) => event.name === 'slow').map((event) => event.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('reconnectAndJoin rejects for unknown servers', async () => {
    const cm = createManager();
    try {
      await expect(cm.reconnectAndJoin('nope')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnectAndJoin('nope')).rejects.toMatchObject({
        code: 'mcp.server_not_found',
      });
    } finally {
      await cm.shutdown();
    }
  });

  it('serializes replacement close and tracks disabled or removed clients through shutdown', async () => {
    const cm = createManager();
    let releaseReplacement = (): void => {};
    let releaseDisable = (): void => {};
    let releaseRemoval = (): void => {};
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(cm.list()).toHaveLength(1);
      await cm.shutdown();
      expect(cm.list()).toEqual([]);

      const replacementGate = new Promise<void>((resolve) => {
        releaseReplacement = resolve;
      });
      vi.spyOn(Client.prototype, 'close').mockImplementation(() => replacementGate);
      await cm.connectAll({ alpha: stdioConfig() });
      let reconnectSettled = false;
      const reconnect = cm.reconnect('alpha').then(() => {
        reconnectSettled = true;
      });
      await sleep(50);
      expect(reconnectSettled).toBe(false);
      expect(cm.get('alpha')?.status).toBe('pending');
      releaseReplacement();
      vi.restoreAllMocks();
      await reconnect;
      expect(cm.get('alpha')?.status).toBe('connected');

      const disableGate = new Promise<void>((resolve) => {
        releaseDisable = resolve;
      });
      vi.spyOn(Client.prototype, 'close').mockImplementation(() => disableGate);
      let disableSettled = false;
      const disabling = cm.connect('alpha', { ...stdioConfig(), enabled: false }).then(() => {
        disableSettled = true;
      });
      await sleep(50);
      expect(disableSettled).toBe(false);
      releaseDisable();
      vi.restoreAllMocks();
      await disabling;
      expect(cm.get('alpha')?.status).toBe('disabled');
      await cm.connect('alpha', stdioConfig());
      expect(cm.get('alpha')?.status).toBe('connected');

      const removalGate = new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      vi.spyOn(Client.prototype, 'close').mockImplementation(() => removalGate);
      let removeSettled = false;
      let shutdownSettled = false;
      const removing = cm.remove('alpha').then(() => {
        removeSettled = true;
      });
      const shutting = cm.shutdown().then(() => {
        shutdownSettled = true;
      });
      await sleep(50);
      expect(removeSettled).toBe(false);
      expect(shutdownSettled).toBe(false);
      releaseRemoval();
      vi.restoreAllMocks();
      await Promise.all([removing, shutting]);
      expect(cm.list()).toEqual([]);
      await cm.shutdown();
    } finally {
      releaseReplacement();
      releaseDisable();
      releaseRemoval();
      vi.restoreAllMocks();
      await cm.shutdown();
    }
  }, 15000);

  it('shutdown cancels in-flight startup without late status updates', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });

    const connectPromise = cm.connectAll({
      slowList: {
        transport: 'stdio',
        command: process.execPath,
        args: [hangingListStdioFixture],
        startupTimeoutMs: 5_000,
      },
    });

    await sleep(50);
    await cm.shutdown();

    const result = await Promise.race([
      connectPromise.then(() => 'resolved' as const),
      sleep(1_000).then(() => 'hung' as const),
    ]);
    expect(result).toBe('resolved');
    expect(cm.list()).toEqual([]);
    expect(seen).toEqual([{ name: 'slowList', status: 'pending' }]);
  }, 2000);

  it('honors startupTimeoutMs from the entry or the resolved default by marking slow servers failed', async () => {
    const variants: Array<{
      options?: McpConnectionManagerOptions;
      startupTimeoutMs?: number;
    }> = [
      { startupTimeoutMs: 100 },
      { options: { resolveDefaults: () => ({ startupTimeoutMs: 100 }) } },
    ];
    for (const variant of variants) {
      const cm = createManager(variant.options);
      try {
        await cm.connectAll({
          slow: {
            transport: 'stdio',
            command: process.execPath,
            args: [slowStdioFixture],
            startupTimeoutMs: variant.startupTimeoutMs,
          },
        });
        const entry = cm.get('slow');
        expect(entry?.status).toBe('failed');
        expect(entry?.error?.toLowerCase()).toContain('timed out');
      } finally {
        await cm.shutdown();
      }
    }
  }, 15000);

  it('honors startupTimeoutMs while discovering tools', async () => {
    const cm = createManager();
    const connectPromise = cm.connectAll({
      slowList: {
        transport: 'stdio',
        command: process.execPath,
        args: [hangingListStdioFixture],
        startupTimeoutMs: 100,
      },
    });
    try {
      const result = await Promise.race([
        connectPromise.then(() => 'resolved' as const),
        sleep(1_000).then(() => 'hung' as const),
      ]);
      expect(result).toBe('resolved');

      const entry = cm.get('slowList');
      expect(entry?.status).toBe('failed');
      expect(entry?.error?.toLowerCase()).toContain('timed out');
    } finally {
      await cm.shutdown();
      await Promise.race([connectPromise.catch(() => {}), sleep(1_000)]);
    }
  }, 7000);

  it.each([
    ['stdio', stdioConfig()],
    ['http', { transport: 'http' as const, url: 'https://example.test/mcp' }],
    ['sse', { transport: 'sse' as const, url: 'https://example.test/sse' }],
  ])(
    'forwards the resolved default startup timeout above the SDK default over %s',
    async (_transport, config) => {
      const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      const listTools = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
      const cm = createManager({
        resolveDefaults: () => ({ startupTimeoutMs: 120_000 }),
      });
      try {
        await cm.connectAll({ server: config });
        expect(connect).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ timeout: 120_000 }),
        );
        expect(listTools).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ timeout: 120_000 }),
        );
      } finally {
        await cm.shutdown();
        connect.mockRestore();
        listTools.mockRestore();
      }
    },
  );

  it.each([
    ['stdio', stdioConfig()],
    ['http', { transport: 'http' as const, url: 'https://example.test/mcp' }],
    ['sse', { transport: 'sse' as const, url: 'https://example.test/sse' }],
  ])(
    'forwards per-server startupTimeoutMs above the SDK default over %s',
    async (_transport, config) => {
      const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      const listTools = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
      const cm = createManager({
        resolveDefaults: () => ({ startupTimeoutMs: 120_000 }),
      });
      try {
        await cm.connectAll({
          server: { ...config, startupTimeoutMs: 180_000 },
        });
        expect(connect).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ timeout: 180_000 }),
        );
        expect(listTools).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ timeout: 180_000 }),
        );
      } finally {
        await cm.shutdown();
        connect.mockRestore();
        listTools.mockRestore();
      }
    },
  );

  it('applies the resolved default tool timeout when the server entry omits toolTimeoutMs', async () => {
    const cm = createManager({
      resolveDefaults: () => ({ toolTimeoutMs: 100 }),
    });
    try {
      await cm.connectAll({
        slowTool: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowToolStdioFixture],
        },
      });
      const client = cm.resolved('slowTool')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      await expect(client.callTool('slow_echo', { text: 'hi' })).rejects.toThrow(/timed out/i);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('lets a per-server toolTimeoutMs override the resolved default tool timeout', async () => {
    const cm = createManager({
      resolveDefaults: () => ({ toolTimeoutMs: 100 }),
    });
    try {
      await cm.connectAll({
        slowTool: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowToolStdioFixture],
          toolTimeoutMs: 10_000,
        },
      });
      const client = cm.resolved('slowTool')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      const result = await client.callTool('slow_echo', { text: 'hi' });
      expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('flips HTTP servers into needs-auth when the server returns 401 and no static token is set', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({
      oauthService,
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
    });
    const statuses: string[] = [];
    cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('gated');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login gated');
      expect(entry?.toolCount).toBe(0);
      await sleep(250);
      expect(cm.get('gated')?.status).toBe('needs-auth');
      expect(statuses).toEqual(['gated:pending', 'gated:needs-auth']);
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('marks an explicitly OAuth HTTP server as needs-auth when non-auth headers accompany a 401', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { 'X-Tenant': 'example' },
          auth: 'oauth',
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('gated');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login gated');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('retries transient startup failures and reschedules existing waits with new tunables', async () => {
    const mcpServer = new McpServer({ name: 'cm-retry', version: '0.0.1' });
    mcpServer.registerTool(
      'echo',
      { description: 'Echoes text', inputSchema: { text: z.string() } },
      ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await mcpServer.connect(transport);
    let hits = 0;
    const httpServer = createHttpServer((req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(500).end();
        return;
      }
      void transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as HttpAddress).port;

    let retryDefaults = { reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 };
    const cm = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => retryDefaults,
    });
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('failed');
      const initialRetryAt = cm.get('remote')?.nextRetryAt;
      expect(initialRetryAt).toBeDefined();
      retryDefaults = { reconnectInitialDelayMs: 1, reconnectMaxDelayMs: 1 };
      cm.rescheduleRetries();
      expect(cm.get('remote')?.nextRetryAt).toBeLessThan(initialRetryAt!);

      for (let i = 0; i < 100; i++) {
        if (cm.get('remote')?.status === 'connected') break;
        await sleep(25);
      }
      const entry = cm.get('remote');
      expect(entry?.status).toBe('connected');
      expect(entry?.toolCount).toBe(1);
      expect(cm.resolved('remote')).toBeDefined();
      expect(seen.filter((s) => s.name === 'remote').map((s) => s.status)).toEqual([
        'pending',
        'failed',
        'failed',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
      await closeServer(httpServer);
    }

    const spawn = vi.spyOn(testProcess, 'spawn').mockRejectedValueOnce(
      new HostProcessError(HostProcessErrorCode.SpawnFailed, 'temporary resource pressure', {
        details: { errno: 'EAGAIN' },
        cause: Object.assign(new Error('resource pressure'), { code: 'EAGAIN' }),
      }),
    );
    const stdio = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
    });
    try {
      await stdio.connectAll({ resource: stdioConfig() });
      expect(stdio.get('resource')?.status).toBe('failed');
      expect(stdio.get('resource')?.nextRetryAt).toBeDefined();
      for (let i = 0; i < 100; i++) {
        if (stdio.get('resource')?.status === 'connected') break;
        await sleep(25);
      }
      expect(stdio.get('resource')?.status).toBe('connected');
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      spawn.mockRestore();
      await stdio.shutdown();
    }
  }, 15000);

  it('joins manual reconnects to an automatic handshake already in flight', async () => {
    let hits = 0;
    let releaseThird = (): void => {};
    const thirdGate = new Promise<void>((resolve) => {
      releaseThird = resolve;
    });
    const handler = createPerSessionMcpHandler('cm-coord');
    const httpServer = createHttpServer((req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(500).end();
        return;
      }
      if (hits === 3) {
        void thirdGate.then(() => {
          handler(req, res);
        });
        return;
      }
      handler(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as HttpAddress).port;

    const cm = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 150, reconnectMaxDelayMs: 300 }),
    });
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('failed');

      for (let i = 0; i < 100; i++) {
        if (hits >= 3) break;
        await sleep(25);
      }
      expect(hits).toBe(3);
      expect(cm.get('remote')?.status).toBe('pending');
      let joinedSettled = false;
      const joined = cm.reconnectAndJoin('remote').then(() => {
        joinedSettled = true;
      });
      await sleep(50);
      expect(hits).toBe(3);
      expect(joinedSettled).toBe(false);
      releaseThird();
      await joined;

      expect(cm.get('remote')?.status).toBe('connected');
      expect(cm.resolved('remote')).toBeDefined();
      expect(seen.filter((s) => s.name === 'remote').map((s) => s.status)).toEqual([
        'pending',
        'failed',
        'connected',
      ]);
    } finally {
      releaseThird();
      await cm.shutdown();
      await closeServer(httpServer);
    }
  }, 15000);

  it('marks HTTP servers with pinned static headers failed (not needs-auth) on 401/403 without retry', async () => {
    const headerSets: Array<Record<string, string>> = [
      { Authorization: 'Bearer static-key' },
      { 'X-API-Key': 'wrong' },
    ];
    for (const headers of headerSets) {
      for (const statusCode of [401, 403]) {
        const server: HttpServer = createHttpServer((_req, res) => {
          res.writeHead(statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as HttpAddress).port;
        const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
        const cm = createManager({
          oauthService,
          reconnectRetryEnabled: true,
          resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
        });
        const statuses: string[] = [];
        cm.onStatusChange((entry) => statuses.push(`${entry.name}:${entry.status}`));
        try {
          await cm.connectAll({
            keyed: {
              transport: 'http',
              url: `http://127.0.0.1:${port}/mcp`,
              headers,
              startupTimeoutMs: 5_000,
            },
          });
          expect(cm.get('keyed')?.status).toBe('failed');
          await sleep(250);
          expect(cm.get('keyed')?.status).toBe('failed');
          expect(statuses).toEqual(['keyed:pending', 'keyed:failed']);
        } finally {
          await cm.shutdown();
          await closeServer(server);
        }
      }
    }
  }, 15000);

  it('flips SSE servers into needs-auth when the server returns 401 and no static token is set', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'text/plain',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end('unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        legacy: {
          transport: 'sse',
          url: `http://127.0.0.1:${port}/sse`,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('legacy');
      expect(entry?.transport).toBe('sse');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login legacy');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('flips cached OAuth credentials that require reauth into needs-auth', async () => {
    const server: HttpServer = createHttpServer((req, res) => {
      if (req.url === '/token') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="mcp"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const serverUrl = `http://127.0.0.1:${port}/mcp`;
    const authServerUrl = `http://127.0.0.1:${port}`;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const provider = oauthService.getProvider('notion', serverUrl);
    await provider.saveDiscoveryState({
      authorizationServerUrl: authServerUrl,
      authorizationServerMetadata: {
        issuer: authServerUrl,
        authorization_endpoint: `${authServerUrl}/authorize`,
        token_endpoint: `${authServerUrl}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    } satisfies OAuthTokens);

    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        notion: {
          transport: 'http',
          url: serverUrl,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('notion');
      expect(entry).toMatchObject({
        status: 'needs-auth',
        error: expect.stringContaining('run /mcp-config login notion'),
      });
      expect(entry?.error).not.toContain('redirectUrl must be set');
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('marks HTTP 401 as failed when no OAuth service is configured', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401).end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const cm = createManager();
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('gated')?.status).toBe('failed');
    } finally {
      await cm.shutdown();
      await closeServer(server);
    }
  }, 15000);

  it('flips connected stdio servers to failed when the child exits unexpectedly', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        crashy: {
          transport: 'stdio',
          command: process.execPath,
          args: [crashAfterConnectFixture],
          env: { KIMI_TEST_MCP_EXIT_AFTER_MS: '500', KIMI_TEST_MCP_STDERR: 'fatal: out of memory' },
          startupTimeoutMs: 4_000,
        },
      });
      expect(cm.get('crashy')?.status).toBe('connected');

      for (let i = 0; i < 100; i++) {
        if (cm.get('crashy')?.status === 'failed') break;
        await sleep(50);
      }
      const entry = cm.get('crashy');
      expect(entry?.status).toBe('failed');
      expect(entry?.toolCount).toBe(0);
      expect(entry?.error?.toLowerCase()).toContain('closed');
      expect(entry?.error).toContain('fatal: out of memory');
      expect(seen.filter((s) => s.name === 'crashy').map((s) => s.status)).toEqual([
        'pending',
        'connected',
        'failed',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('includes captured stderr in the error when stdio connect fails before handshake', async () => {
    const cm = createManager();
    try {
      await cm.connectAll({
        nope: {
          transport: 'stdio',
          command: process.execPath,
          args: [stderrThenExitFixture],
          env: { KIMI_TEST_MCP_STDERR: 'fatal: missing API token KIMI_X' },
          startupTimeoutMs: 4_000,
        },
      });
      const entry = cm.get('nope');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('fatal: missing API token KIMI_X');
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('does not flip to failed when the manager intentionally closes the client', async () => {
    const cm = createManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(cm.get('alpha')?.status).toBe('connected');
      await cm.shutdown();
      await sleep(100);
      expect(seen.filter((s) => s.name === 'alpha').map((s) => s.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('probes healthy weak evidence silently and waits for probes during shutdown', async () => {
    const httpServer = createHttpServer(createPerSessionMcpHandler('cm-weak-ok'));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as HttpAddress).port;

    const ping = vi.spyOn(Client.prototype, 'ping');
    const cm = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
    });
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    let releaseProbe = (): void => {};
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('connected');
      const clientBefore = cm.resolved('remote')?.client;
      expect(clientBefore).toBeDefined();
      seen.length = 0;
      ping.mockClear();

      const internalClient = (cm as unknown as {
        entries: Map<string, { client?: { client: { onerror?: (e: Error) => void } } }>;
      }).entries.get('remote')?.client?.client;
      internalClient?.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));

      await sleep(300);
      expect(ping.mock.calls.length).toBeGreaterThan(0);
      expect(cm.get('remote')?.status).toBe('connected');
      expect(cm.get('remote')?.toolCount).toBe(1);
      expect(cm.resolved('remote')?.client).toBe(clientBefore);
      expect(seen).toEqual([]);

      const probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      ping.mockClear();
      ping.mockImplementation(() => probeGate.then(() => ({})));
      internalClient?.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));
      for (let i = 0; i < 100; i++) {
        if (ping.mock.calls.length > 0) break;
        await sleep(10);
      }
      expect(ping).toHaveBeenCalled();
      let shutdownSettled = false;
      const shutting = cm.shutdown().then(() => {
        shutdownSettled = true;
      });
      await sleep(50);
      expect(shutdownSettled).toBe(false);
      releaseProbe();
      await shutting;
      expect(cm.list()).toEqual([]);
    } finally {
      releaseProbe();
      ping.mockRestore();
      await cm.shutdown();
      await closeServer(httpServer);
    }
  }, 15000);

  it('reconnects automatically when weak session evidence proves the session dead', async () => {
    let healthy = true;
    const handler = createPerSessionMcpHandler('cm-weak-dead');
    const httpServer = createHttpServer((req, res) => {
      if (!healthy) {
        res.writeHead(500).end();
        return;
      }
      handler(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as HttpAddress).port;

    const cm = createManager({
      reconnectRetryEnabled: true,
      resolveDefaults: () => ({ reconnectInitialDelayMs: 50, reconnectMaxDelayMs: 100 }),
    });
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('connected');

      const internalClient = (cm as unknown as {
        entries: Map<string, { client?: { client: { onerror?: (e: Error) => void } } }>;
      }).entries.get('remote')?.client?.client;
      healthy = false;
      internalClient?.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));

      for (let i = 0; i < 100; i++) {
        if (cm.get('remote')?.status === 'failed') break;
        await sleep(25);
      }
      const entry = cm.get('remote');
      expect(entry?.status).toBe('failed');
      expect(entry?.toolCount).toBe(0);
      expect(entry?.error).toContain('Maximum reconnection attempts');
      expect(entry?.nextRetryAt).toBeDefined();

      healthy = true;
      for (let i = 0; i < 100; i++) {
        if (cm.get('remote')?.status === 'connected') break;
        await sleep(25);
      }
      const recovered = cm.get('remote');
      expect(recovered?.status).toBe('connected');
      expect(recovered?.toolCount).toBe(1);
      expect(recovered?.nextRetryAt).toBeUndefined();
      expect(cm.resolved('remote')).toBeDefined();

      const remoteStatuses = seen.filter((s) => s.name === 'remote').map((s) => s.status);
      expect(remoteStatuses).toEqual(['pending', 'connected', 'failed', 'connected']);
    } finally {
      await cm.shutdown();
      await closeServer(httpServer);
    }
  }, 15000);

  it('flips a connected server into needs-auth when a tool call fails with 401', async () => {
    const server = await startAnonymousDiscoveryHttpMcpServer();
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        hyper: { transport: 'http', url: server.url, startupTimeoutMs: 5_000 },
      });
      expect(cm.get('hyper')?.status).toBe('connected');
      const client = cm.resolved('hyper')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      const callError = await client.callTool('echo', { text: 'hi' }).then(
        () => {
          throw new Error('expected the call to fail with 401');
        },
        (error: unknown) => error,
      );

      await expect(cm.markNeedsAuth('hyper', callError)).resolves.toBe(true);
      const entry = cm.get('hyper');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login hyper');
      expect(cm.resolved('hyper')).toBeUndefined();
      expect(seen.filter((s) => s.name === 'hyper').map((s) => s.status)).toEqual([
        'pending',
        'connected',
        'needs-auth',
      ]);

      await expect(cm.markNeedsAuth('hyper', callError)).resolves.toBe(true);
      expect(seen.filter((s) => s.name === 'hyper').map((s) => s.status)).toEqual([
        'pending',
        'connected',
        'needs-auth',
      ]);
    } finally {
      await cm.shutdown();
      await server.close();
    }
  }, 15000);

  it('joins concurrent runtime 401 invalidation and makes old clients unusable immediately', async () => {
    const server = await startAnonymousDiscoveryHttpMcpServer({ tokenEndpoint: 'invalid_grant' });
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const provider = oauthService.getProvider('hyper', server.url);
    await provider.saveDiscoveryState({
      authorizationServerUrl: server.origin,
      authorizationServerMetadata: {
        issuer: server.origin,
        authorization_endpoint: `${server.origin}/authorize`,
        token_endpoint: `${server.origin}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    const revokedTokens: StoredMcpOAuthTokens = {
      access_token: 'revoked-access-token',
      refresh_token: 'revoked-refresh-token',
      token_type: 'Bearer',
      obtained_at: Date.now() - 60_000,
    };
    await provider.saveTokens(revokedTokens);
    const cm = createManager({ oauthService });
    let replacement: typeof server | undefined;
    let releaseInvalidation = (): void => {};
    try {
      expect(await oauthService.hasTokens('hyper', server.url)).toBe(true);
      await cm.connectAll({
        hyper: { transport: 'http', url: server.url, startupTimeoutMs: 5_000 },
      });
      expect(cm.get('hyper')?.status).toBe('connected');
      const client = cm.resolved('hyper')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      const callError = new StreamableHTTPError(401, 'Unauthorized');
      expect(await oauthService.hasTokens('hyper', server.url)).toBe(true);
      const invalidate = oauthService.invalidateTokensIfCurrent.bind(oauthService);
      const invalidationGate = new Promise<boolean>((resolve) => {
        releaseInvalidation = () => {
          resolve(true);
        };
      });
      const invalidation = vi
        .spyOn(oauthService, 'invalidateTokensIfCurrent')
        .mockImplementation(async (serverName, serverUrl, expected) => {
          await invalidationGate;
          return invalidate(serverName, serverUrl, expected);
        });
      const peek = vi.spyOn(oauthService, 'peekRejectedGrant');
      const first = cm.markNeedsAuth('hyper', callError, client);
      const second = cm.markNeedsAuth('hyper', callError, client);
      expect(second).toBe(first);
      let firstSettled = false;
      let secondSettled = false;
      void first.then(() => {
        firstSettled = true;
      });
      void second.then(() => {
        secondSettled = true;
      });
      for (let i = 0; i < 100; i++) {
        if (cm.get('hyper')?.status === 'needs-auth' && invalidation.mock.calls.length > 0) break;
        await sleep(10);
      }
      expect(cm.get('hyper')?.status).toBe('needs-auth');
      expect((await peek.mock.results[0]?.value)?.tokens).toBeDefined();
      expect(invalidation).toHaveBeenCalled();
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      expect(cm.resolved('hyper')).toBeUndefined();
      const late = cm.markNeedsAuth('hyper', callError, client);
      expect(late).toBe(first);
      let lateSettled = false;
      void late.then(() => {
        lateSettled = true;
      });

      replacement = await startAnonymousDiscoveryHttpMcpServer({ tokenEndpoint: 'invalid_grant' });
      const replacementProvider = oauthService.getProvider('hyper', replacement.url);
      await replacementProvider.saveTokens(revokedTokens);
      await cm.connect('hyper', { transport: 'http', url: replacement.url, startupTimeoutMs: 5000 });
      expect(cm.get('hyper')?.status).toBe('connected');
      const nextClient = cm.resolved('hyper')?.client;
      if (nextClient === undefined) throw new Error('expected a replacement client');
      const third = cm.markNeedsAuth('hyper', callError, nextClient);
      expect(third).not.toBe(first);
      let thirdSettled = false;
      void third.then(() => {
        thirdSettled = true;
      });
      for (let i = 0; i < 100; i++) {
        if (invalidation.mock.calls.length >= 2) break;
        await sleep(10);
      }
      expect(thirdSettled).toBe(false);
      const connectSpy = vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      const listSpy = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
      await cm.reconnect('hyper');
      expect(cm.get('hyper')?.status).toBe('connected');
      const finalClient = cm.resolved('hyper')?.client;
      if (finalClient === undefined) throw new Error('expected a connected client');
      const fourth = cm.markNeedsAuth('hyper', callError, finalClient);
      expect(fourth).not.toBe(third);
      const applicationError = new McpError(ErrorCode.InvalidRequest, 'application-level failure');
      const nonAuth = cm.markNeedsAuth('hyper', applicationError, finalClient);
      let fourthSettled = false;
      void fourth.then(() => {
        fourthSettled = true;
      });
      for (let i = 0; i < 100; i++) {
        if (invalidation.mock.calls.length >= 3) break;
        await sleep(10);
      }
      expect(fourthSettled).toBe(false);
      expect(
        (cm as unknown as { pendingNeedsAuthTransitions: Set<Promise<boolean>> })
          .pendingNeedsAuthTransitions.size,
      ).toBe(3);
      releaseInvalidation();
      await expect(Promise.all([first, second, late, third, fourth, nonAuth])).resolves.toEqual([
        false,
        false,
        false,
        false,
        true,
        false,
      ]);
      expect(invalidation).toHaveBeenCalledTimes(3);
      connectSpy.mockRestore();
      listSpy.mockRestore();
      invalidation.mockRestore();
      expect(await oauthService.hasTokens('hyper', replacement.url)).toBe(false);
    } finally {
      releaseInvalidation();
      vi.restoreAllMocks();
      await cm.shutdown();
      await server.close();
      await replacement?.close();
    }
  }, 15000);

  it('ignores application-level errors that merely mention unauthorized', async () => {
    const server = await startAnonymousDiscoveryHttpMcpServer();
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const cm = createManager({ oauthService });
    try {
      await cm.connectAll({
        hyper: { transport: 'http', url: server.url, startupTimeoutMs: 5_000 },
      });
      expect(cm.get('hyper')?.status).toBe('connected');
      await oauthService.getProvider('hyper', server.url).saveTokens({
        access_token: 'valid-access-token',
        token_type: 'Bearer',
        obtained_at: Date.now() - 60_000,
      } as StoredMcpOAuthTokens);
      const client = cm.resolved('hyper')?.client;
      if (client === undefined) throw new Error('expected a connected client');
      const appError = new McpError(ErrorCode.InvalidRequest, 'Unauthorized to edit this project');
      await expect(cm.markNeedsAuth('hyper', appError, client)).resolves.toBe(false);
      expect(cm.get('hyper')?.status).toBe('connected');
      expect(await oauthService.hasTokens('hyper', server.url)).toBe(true);
      expect(cm.resolved('hyper')?.client).toBe(client);
    } finally {
      await cm.shutdown();
      await server.close();
    }
  }, 15000);
});
