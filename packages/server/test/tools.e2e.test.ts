/**
 * Tools + MCP end-to-end tests (W9.1 / Chain 7 / P1.7).
 *
 * Coverage:
 *   - GET  /api/v1/tools                              → envelope shape + tools[]
 *   - GET  /api/v1/mcp/servers                        → envelope shape + servers[]
 *   - POST /api/v1/mcp/servers/{id}:restart           → {restarting:true} on a real
 *                                                   server / 40408 on unknown
 *   - POST /api/v1/mcp/servers/foo:bogus              → 40001 unsupported action
 *
 * **Bootstrap strategy**: spawn the real server and create one session so the
 * agent-core `getTools` / `listMcpServers` can dispatch (those calls live on
 * the SessionAPI). The HOME dir is a fresh tmpdir so plugin discovery is
 * sandboxed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import {
  listMcpServersResponseSchema,
  listToolsResponseSchema,
} from '@moonshot-ai/protocol';
import { IMcpService, McpServerNotFoundError } from '@moonshot-ai/agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer, type ServerStartOptions } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-tools-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-tools-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(
  serviceOverrides?: ServerStartOptions['serviceOverrides'],
): Promise<RunningServer> {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    serviceOverrides,
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: join(tmpDir, 'workspace') } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

function createMcpServiceOverride(
  overrides: Partial<IMcpService> = {},
): IMcpService {
  return {
    _serviceBrand: undefined,
    list: async () => [],
    restart: async () => ({ restarting: true }),
    ...overrides,
  };
}

describe('GET /api/v1/tools', () => {
  it('returns an envelope with {tools: ToolDescriptor[]} (empty list pre-session)', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/tools' });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    // Before any session exists, the global list is empty by design.
    const parsed = listToolsResponseSchema.parse(env.data);
    expect(parsed.tools).toEqual([]);
  });

  it('returns a populated list after a session exists (response data round-trips through schema)', async () => {
    const r = await bootDaemon();
    await createSession(r);
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/tools' });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    const parsed = listToolsResponseSchema.parse(env.data);
    // We don't assert a specific count (depends on plugin discovery in the
    // sandboxed home dir), only that the envelope shape is valid and every
    // descriptor parses.
    expect(Array.isArray(parsed.tools)).toBe(true);
  });

  it('accepts session_id query and returns the same shape', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/tools?session_id=${sid}`,
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    expect(listToolsResponseSchema.safeParse(env.data).success).toBe(true);
  });

  it('rejects empty session_id with 40001', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/tools?session_id=',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });
});

describe('GET /api/v1/mcp/servers', () => {
  it('returns an envelope with {servers: McpServer[]} from the MCP service', async () => {
    const r = await bootDaemon([
      [
        IMcpService,
        createMcpServiceOverride({
          list: async () => [
            {
              id: 'lark',
              name: 'lark',
              status: 'connected',
              transport: 'stdio',
              tool_count: 2,
            },
          ],
        }),
      ],
    ]);
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/mcp/servers' });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    const parsed = listMcpServersResponseSchema.parse(env.data);
    expect(parsed.servers).toEqual([
      {
        id: 'lark',
        name: 'lark',
        status: 'connected',
        transport: 'stdio',
        tool_count: 2,
      },
    ]);
  });

  it('returns 200 with empty list even before any session is created', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/mcp/servers' });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    const parsed = listMcpServersResponseSchema.parse(env.data);
    expect(parsed.servers).toEqual([]);
  });
});

describe('POST /api/v1/mcp/servers/{id}:restart', () => {
  it('returns 40408 mcp.server_not_found for an unknown server id', async () => {
    const r = await bootDaemon([
      [
        IMcpService,
        createMcpServiceOverride({
          restart: async (serverId) => {
            throw new McpServerNotFoundError(serverId);
          },
        }),
      ],
    ]);
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/mcp/servers/does-not-exist:restart',
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40408);
    expect(env.msg).toMatch(/does not exist/);
  });

  it('returns 40408 even before any session is created (registrar unreachable)', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/mcp/servers/x:restart',
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40408);
  });

  it('rejects unsupported action with 40001', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/mcp/servers/foo:bogus',
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(env.msg).toMatch(/unsupported action/);
  });

  it('rejects bare {id} (no action) with 40001 — :restart is the only allowed action', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/mcp/servers/foo',
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });
});
