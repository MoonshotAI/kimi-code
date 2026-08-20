import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Error2,
  ErrorCodes,
  IMcpManagementService,
  type GlobalMcpServerConfig,
  type McpManagedServer,
  type McpServerInspection,
  type McpServerLocator,
  type McpServerTestTarget,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface EnvelopeWire<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: { path: string; message: string }[];
}

const STDIO_A: GlobalMcpServerConfig = {
  name: 'a',
  transport: 'stdio',
  command: 'run-a',
  args: ['--verbose'],
  env: { TOKEN: 'secret' },
};

interface McpStub {
  readonly service: IMcpManagementService;
  readonly calls: string[];
  readonly state: {
    lastUpdate?: GlobalMcpServerConfig;
    lastTestTarget?: McpServerTestTarget;
    lastResetLocator?: McpServerLocator;
    lastInspectCwd?: string;
    lastBeginCwd?: string;
    lastResetCwd?: string;
    verifySeen?: boolean;
    mutationCwds: Array<string | undefined>;
  };
}

function makeMcpStub(): McpStub {
  const servers = new Map<string, GlobalMcpServerConfig>();
  const calls: string[] = [];
  const state: McpStub['state'] = { mutationCwds: [] };
  const list = (): McpManagedServer[] =>
    [...servers.values()].map((server) => {
      const { name, ...config } = server;
      return {
        name,
        config,
        source: 'global',
        origin: '/home/user/.kimi-code/mcp.json',
        mutable: true,
      };
    });
  const service: IMcpManagementService = {
    _serviceBrand: undefined,
    listServers: async () => {
      calls.push('listServers');
      return list();
    },
    getServer: async (name) => {
      calls.push(`getServer:${name}`);
      const server = servers.get(name);
      if (server === undefined) {
        throw new Error2(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" was not found`);
      }
      return list().find((entry) => entry.name === name)!;
    },
    addServer: async (server, query) => {
      calls.push(`addServer:${server.name}`);
      state.mutationCwds.push(query?.cwd);
      servers.set(server.name, server);
      return list();
    },
    updateServer: async (server, query) => {
      calls.push(`updateServer:${server.name}`);
      state.mutationCwds.push(query?.cwd);
      state.lastUpdate = server;
      if (!servers.has(server.name)) {
        throw new Error2(
          ErrorCodes.MCP_SERVER_NOT_FOUND,
          `MCP server "${server.name}" was not found`,
        );
      }
      servers.set(server.name, server);
      return list();
    },
    removeServer: async (name, query) => {
      calls.push(`removeServer:${name}`);
      state.mutationCwds.push(query?.cwd);
      servers.delete(name);
      return list();
    },
    testServer: async (target) => {
      calls.push('testServer');
      state.lastTestTarget = target;
      if (target.name === undefined && target.server === undefined) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          'Pass an MCP server name or an inline server config',
        );
      }
      return { success: true, output: 'probe ok' };
    },
    listAuthStatuses: async (query) => {
      calls.push('listAuthStatuses');
      state.verifySeen = query?.verify;
      return [...servers.keys()].map((name) => ({
        name,
        authStatus: 'not-applicable' as const,
      }));
    },
    inspectServers: async (targets, query) => {
      calls.push('inspectServers');
      state.lastInspectCwd = query?.cwd;
      const selected = [...servers.values()].filter(
        (server) =>
          targets === undefined ||
          targets.some((target) => target.source === 'global' && target.name === server.name),
      );
      return selected.map((server): McpServerInspection => {
        const { name, ...config } = server;
        return {
          serverId: `global:${name}`,
          locator: { source: 'global', name },
          runtimeName: name,
          origin: 'global',
          config,
          enabled: true,
          editable: true,
          authStatus: 'not-applicable',
          checkedAt: 1000,
        };
      });
    },
    resolveServerByName: async (name) => ({ source: 'global', name }),
    beginServerAuth: async (_locator, query) => {
      state.lastBeginCwd = query?.cwd;
      return {
        status: 'authorization-required',
        flowId: 'flow-1',
        authorizationUrl: 'https://example.com/oauth/authorize?client=x',
      };
    },
    completeServerAuth: async (handle) => {
      if (handle.flowId !== 'flow-1') {
        throw new Error2(ErrorCodes.REQUEST_INVALID, `Unknown MCP OAuth flow: ${handle.flowId}`);
      }
    },
    cancelServerAuth: async () => {},
    resetServerAuth: async (locator, query) => {
      state.lastResetLocator = locator;
      state.lastResetCwd = query?.cwd;
    },
  };
  return { service, calls, state };
}

describe('server /api/v2/mcp', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function boot(stub: McpStub): Promise<void> {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-mcp-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IMcpManagementService, stub.service]],
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: EnvelopeWire<T> }> {
    const res = await authedFetch(server as RunningServer, base, path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as EnvelopeWire<T> };
  }

  describe('routes', () => {
    it('round-trips a server through add/get/update/remove', async () => {
      const stub = makeMcpStub();
      await boot(stub);

      const added = await call<McpManagedServer[]>(
        'POST',
        '/api/v2/mcp/servers?cwd=%2Fworkspace%2Fproject',
        STDIO_A,
      );
      expect(added.status).toBe(200);
      expect(added.body.code).toBe(0);
      expect(added.body.data).toEqual([
        {
          name: 'a',
          config: {
            transport: 'stdio',
            command: 'run-a',
            args: ['--verbose'],
            env: { TOKEN: 'secret' },
          },
          source: 'global',
          origin: '/home/user/.kimi-code/mcp.json',
          mutable: true,
        },
      ]);

      const got = await call<McpManagedServer>('GET', '/api/v2/mcp/servers/a');
      expect(got.body.code).toBe(0);
      expect(got.body.data).toMatchObject({ name: 'a', config: { command: 'run-a' } });

      const updated = await call<McpManagedServer[]>(
        'PUT',
        '/api/v2/mcp/servers/a?cwd=%2Fworkspace%2Fproject',
        {
          transport: 'stdio',
          command: 'run-b',
        },
      );
      expect(updated.body.code).toBe(0);
      expect(updated.body.data).toHaveLength(1);
      expect(stub.state.lastUpdate).toEqual({ transport: 'stdio', command: 'run-b', name: 'a' });

      const removed = await call<McpManagedServer[]>(
        'DELETE',
        '/api/v2/mcp/servers/a?cwd=%2Fworkspace%2Fproject',
      );
      expect(removed.body.code).toBe(0);
      expect(removed.body.data).toEqual([]);
      expect(stub.calls).toContain('removeServer:a');
      expect(stub.state.mutationCwds).toEqual([
        '/workspace/project',
        '/workspace/project',
        '/workspace/project',
      ]);
    });

    it('maps an unknown server name to 40408', async () => {
      const stub = makeMcpStub();
      await boot(stub);
      const got = await call('GET', '/api/v2/mcp/servers/nope');
      expect(got.status).toBe(200);
      expect(got.body.code).toBe(40408);
      expect(got.body.data).toBeNull();
      expect(got.body.msg).toContain('nope');

      const updated = await call('PUT', '/api/v2/mcp/servers/nope', {
        transport: 'stdio',
        command: 'run-x',
      });
      expect(updated.body.code).toBe(40408);
    });

    it('rejects malformed bodies with 40001 + details from the zod preHandler', async () => {
      const stub = makeMcpStub();
      await boot(stub);

      const badAdd = await call('POST', '/api/v2/mcp/servers', { name: 'a', command: 'run-a' });
      expect(badAdd.body.code).toBe(40001);
      expect(Array.isArray(badAdd.body.details)).toBe(true);

      const badBegin = await call('POST', '/api/v2/mcp/auth:begin', { source: 'global' });
      expect(badBegin.body.code).toBe(40001);

      expect(stub.calls).toEqual([]);
    });

    it('maps the engine request.invalid rejection to 40001', async () => {
      const stub = makeMcpStub();
      await boot(stub);
      const res = await call('POST', '/api/v2/mcp/servers:test', {});
      expect(res.body.code).toBe(40001);
      expect(res.body.data).toBeNull();
      expect(stub.calls).toEqual(['testServer']);
    });

    it('maps the engine config.invalid rejection to 40001', async () => {
      const stub = makeMcpStub();
      stub.service.addServer = async () => {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          'Invalid JSON in /home/user/.kimi-code/mcp.json: Unexpected token',
        );
      };
      await boot(stub);

      const res = await call('POST', '/api/v2/mcp/servers', STDIO_A);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(40001);
      expect(res.body.data).toBeNull();
    });

    it('maps the engine mcp.oauth_failed rejection to 40929', async () => {
      const stub = makeMcpStub();
      stub.service.completeServerAuth = async () => {
        throw new Error2(
          ErrorCodes.MCP_OAUTH_FAILED,
          'OAuth flow for "a" failed: OAuth callback timed out',
        );
      };
      await boot(stub);

      const res = await call('POST', '/api/v2/mcp/auth:complete', { flowId: 'flow-1' });
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(40929);
      expect(res.body.data).toBeNull();
    });

    it('maps a delete rejected with mcp.server_not_found to 40408', async () => {
      const stub = makeMcpStub();
      stub.service.removeServer = async (name) => {
        throw new Error2(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" was not found`);
      };
      await boot(stub);

      const res = await call('DELETE', '/api/v2/mcp/servers/nope');
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(40408);
      expect(res.body.data).toBeNull();
      expect(res.body.msg).toContain('nope');
    });

    it('tests an inline server config without saving it', async () => {
      const stub = makeMcpStub();
      await boot(stub);
      const inline = { name: 'inline', transport: 'http', url: 'https://example.com/mcp' };
      const res = await call('POST', '/api/v2/mcp/servers:test', { server: inline });
      expect(res.body).toMatchObject({ code: 0, data: { success: true, output: 'probe ok' } });
      expect(stub.state.lastTestTarget).toEqual({ server: inline });
    });

    it('inspects the catalog narrowed by locator targets', async () => {
      const stub = makeMcpStub();
      await boot(stub);
      await call('POST', '/api/v2/mcp/servers', STDIO_A);

      const res = await call<McpServerInspection[]>('POST', '/api/v2/mcp/servers:inspect', {
        targets: [{ source: 'global', name: 'a' }],
      });
      expect(res.body.code).toBe(0);
      expect(res.body.data).toEqual([
        {
          serverId: 'global:a',
          locator: { source: 'global', name: 'a' },
          runtimeName: 'a',
          origin: 'global',
          config: {
            transport: 'stdio',
            command: 'run-a',
            args: ['--verbose'],
            env: { TOKEN: 'secret' },
          },
          enabled: true,
          editable: true,
          authStatus: 'not-applicable',
          checkedAt: 1000,
        },
      ]);
    });

    it('forwards cwd through locator-addressed inspection and OAuth operations', async () => {
      const stub = makeMcpStub();
      await boot(stub);

      await call('POST', '/api/v2/mcp/servers:inspect', {
        targets: [],
        cwd: '/workspace/project',
      });
      await call('POST', '/api/v2/mcp/auth:begin?cwd=%2Fworkspace%2Fproject', {
        source: 'global',
        name: 'a',
      });
      await call('POST', '/api/v2/mcp/auth:reset?cwd=%2Fworkspace%2Fproject', {
        source: 'global',
        name: 'a',
      });

      expect(stub.state).toMatchObject({
        lastInspectCwd: '/workspace/project',
        lastBeginCwd: '/workspace/project',
        lastResetCwd: '/workspace/project',
      });
    });

    it('maps ?verify= onto the boolean auth-status query flag', async () => {
      const stub = makeMcpStub();
      await boot(stub);
      await call('POST', '/api/v2/mcp/servers', STDIO_A);

      const verified = await call('GET', '/api/v2/mcp/auth-statuses?verify=true');
      expect(verified.body).toMatchObject({
        code: 0,
        data: [{ name: 'a', authStatus: 'not-applicable' }],
      });
      expect(stub.state.verifySeen).toBe(true);

      const offline = await call('GET', '/api/v2/mcp/auth-statuses');
      expect(offline.body.code).toBe(0);
      expect(stub.state.verifySeen).toBeUndefined();

      const bogus = await call('GET', '/api/v2/mcp/auth-statuses?verify=yes');
      expect(bogus.body.code).toBe(40001);
    });

    it('drives the locator-addressed OAuth flow operations', async () => {
      const stub = makeMcpStub();
      await boot(stub);

      const begin = await call('POST', '/api/v2/mcp/auth:begin', { source: 'global', name: 'a' });
      expect(begin.body).toMatchObject({
        code: 0,
        data: {
          status: 'authorization-required',
          flowId: 'flow-1',
          authorizationUrl: 'https://example.com/oauth/authorize?client=x',
        },
      });

      const complete = await call('POST', '/api/v2/mcp/auth:complete', { flowId: 'flow-1' });
      expect(complete.body).toMatchObject({ code: 0, data: null });

      const unknownFlow = await call('POST', '/api/v2/mcp/auth:complete', { flowId: 'nope' });
      expect(unknownFlow.body.code).toBe(40001);

      const cancel = await call('POST', '/api/v2/mcp/auth:cancel', { flowId: 'flow-1' });
      expect(cancel.body).toMatchObject({ code: 0, data: null });

      const reset = await call('POST', '/api/v2/mcp/auth:reset', {
        source: 'plugin',
        pluginId: 'p',
        serverName: 's',
      });
      expect(reset.body).toMatchObject({ code: 0, data: null });
      expect(stub.state.lastResetLocator).toEqual({ source: 'plugin', pluginId: 'p', serverName: 's' });
    });

    it('rejects an overflowing auth:complete timeoutMs with 40001', async () => {
      const stub = makeMcpStub();
      await boot(stub);

      const res = await call('POST', '/api/v2/mcp/auth:complete', {
        flowId: 'flow-1',
        timeoutMs: 2 ** 31,
      });

      expect(res.body.code).toBe(40001);
      expect(stub.calls).toEqual([]);
    });

    it('aborts the engine wait when the client disconnects mid-complete', async () => {
      const stub = makeMcpStub();
      let seenSignal: AbortSignal | undefined;
      let reached = false;
      stub.service.completeServerAuth = async (_handle, options) => {
        seenSignal = options?.signal;
        reached = true;
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      await boot(stub);

      const controller = new AbortController();
      const pending = authedFetch(server as RunningServer, base, '/api/v2/mcp/auth:complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flowId: 'flow-1' }),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(reached).toBe(true));

      controller.abort();

      await expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true));
    });
  });
});
