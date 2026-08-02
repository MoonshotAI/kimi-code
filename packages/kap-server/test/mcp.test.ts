import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';
import { ErrorCode } from '../src/protocol/error-codes';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

interface WireMcpServerConfig {
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  executor?: 'local' | 'kaos';
  url?: string;
  headers?: Record<string, string>;
  bearer_token_env_var?: string;
  enabled?: boolean;
  startup_timeout_ms?: number;
  tool_timeout_ms?: number;
  enabled_tools?: string[];
  disabled_tools?: string[];
}

type WireListResponse = { servers: Record<string, WireMcpServerConfig> };

describe('server-v2 /api/v1/mcp/config/servers', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-mcp-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
  });

  async function boot(): Promise<void> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function listServers(): Promise<Envelope<WireListResponse>> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/mcp/config/servers');
    expect(res.status).toBe(200);
    return (await res.json()) as Envelope<WireListResponse>;
  }

  async function upsertServer(
    name: string,
    config: WireMcpServerConfig,
  ): Promise<Envelope<WireListResponse>> {
    const res = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/mcp/config/servers/${name}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Envelope<WireListResponse>;
  }

  async function deleteServer(name: string): Promise<Envelope<unknown>> {
    const res = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/mcp/config/servers/${name}`,
      {
        method: 'DELETE',
      },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Envelope<unknown>;
  }

  async function readMcpJson(): Promise<{ mcpServers: Record<string, unknown> } | null> {
    try {
      const text = await readFile(join(home as string, 'mcp.json'), 'utf-8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  it('GET returns empty servers map when no mcp.json exists', async () => {
    await boot();
    const body = await listServers();
    expect(body.code).toBe(0);
    expect(body.data.servers).toEqual({});
  });

  it('POST stdio server (with explicit transport) upserts and persists in camelCase', async () => {
    await boot();
    const body = await upsertServer('my-stdio', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { FOO: 'bar' },
      startup_timeout_ms: 5000,
    });
    expect(body.code).toBe(0);
    expect(body.data.servers['my-stdio']!).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { FOO: 'bar' },
      startup_timeout_ms: 5000,
    });

    const onDisk = await readMcpJson();
    expect(onDisk).not.toBeNull();
    expect(onDisk?.mcpServers['my-stdio']).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      startupTimeoutMs: 5000,
    });
    // snake_case wire keys must NOT appear on disk
    expect(onDisk?.mcpServers['my-stdio']).not.toHaveProperty('startup_timeout_ms');
  });

  it('POST stdio server (no transport) preprocesses to stdio via command', async () => {
    await boot();
    const body = await upsertServer('implicit-stdio', {
      command: 'uvx',
      args: ['mcp-server-git'],
    });
    expect(body.code).toBe(0);
    expect(body.data.servers['implicit-stdio']!).toMatchObject({
      transport: 'stdio',
      command: 'uvx',
    });
  });

  it('POST http server (no transport, with url) preprocesses to http', async () => {
    await boot();
    const body = await upsertServer('remote', {
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      bearer_token_env_var: 'MCP_TOKEN',
    });
    expect(body.code).toBe(0);
    expect(body.data.servers['remote']!).toMatchObject({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      bearer_token_env_var: 'MCP_TOKEN',
    });

    const onDisk = await readMcpJson();
    expect(onDisk?.mcpServers['remote']).toMatchObject({
      transport: 'http',
      bearerTokenEnvVar: 'MCP_TOKEN',
    });
  });

  it('POST same name twice upserts (overwrites previous entry)', async () => {
    await boot();
    await upsertServer('replace', { transport: 'stdio', command: 'first' });
    const body = await upsertServer('replace', { transport: 'stdio', command: 'second' });
    expect(body.code).toBe(0);
    expect(body.data.servers['replace']?.command).toBe('second');
    expect(Object.keys(body.data.servers)).toEqual(['replace']);
  });

  it('GET reflects writes from a fresh request', async () => {
    await boot();
    await upsertServer('one', { transport: 'stdio', command: 'a' });
    await upsertServer('two', { transport: 'http', url: 'https://b.local/mcp' });
    const body = await listServers();
    expect(body.code).toBe(0);
    expect(Object.keys(body.data.servers).sort()).toEqual(['one', 'two']);
  });

  it('DELETE removes the entry', async () => {
    await boot();
    await upsertServer('doomed', { transport: 'stdio', command: 'rm' });
    const del = await deleteServer('doomed');
    expect(del.code).toBe(0);
    const after = await listServers();
    expect(after.data.servers).toEqual({});
  });

  it('DELETE a missing name returns MCP_SERVER_NOT_FOUND (40408)', async () => {
    await boot();
    const del = await deleteServer('nope');
    expect(del.code).toBe(ErrorCode.MCP_SERVER_NOT_FOUND);
  });

  it('POST with an invalid name returns VALIDATION_FAILED (40001)', async () => {
    await boot();
    // Direct fetch: the URL-encoded path `..` would be rejected by the
    // fastify param regex first; instead use a name containing `/` which
    // also fails the param schema but does not break path routing.
    const res = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/mcp/config/servers/bad%20name`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transport: 'stdio', command: 'x' }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('POST with an invalid body returns VALIDATION_FAILED (40001)', async () => {
    await boot();
    const res = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/mcp/config/servers/badbody`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // stdio requires a non-empty command; missing command must fail
        body: JSON.stringify({ transport: 'stdio' }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('POST http with an invalid url returns VALIDATION_FAILED (40001)', async () => {
    await boot();
    const res = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/mcp/config/servers/badurl`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transport: 'http', url: 'not-a-url' }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});
