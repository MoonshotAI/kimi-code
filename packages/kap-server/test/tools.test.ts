/**
 * `/api/v1` tools + MCP routes — engine-projected port (Rust mode).
 *
 * Covers the wire contract of the endpoints:
 *   - GET  /api/v1/tools                              → envelope shape + tools[]
 *   - GET  /api/v1/mcp/servers                        → envelope shape + servers[]
 *
 * Engine mode: both endpoints fall back to the most-recent engine session and
 * project the engine's native toolset / MCP servers onto the protocol wire
 * shapes (no session live → empty list). `POST /mcp/servers/{id}:restart` was
 * retired with the v2 engine; the surviving restart cases cover only the wire
 * error paths.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listMcpServersResponseSchema,
  listToolsResponseSchema,
} from '../src/protocol/rest-tool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface ToolWire {
  name: string;
  description: string;
  input_schema: unknown;
  source: string;
  mcp_server_id?: string;
  active?: boolean;
}

describe('server-v2 /api/v1 tools + mcp', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-tools-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body ?? {}),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  describe('GET /api/v1/tools', () => {
    it('returns an empty list before any session exists', async () => {
      const { status, body } = await getJson<{ tools: ToolWire[] }>('/api/v1/tools');
      expect(status).toBe(200);
      expect(body.code).toBe(0);
      expect(listToolsResponseSchema.parse(body.data).tools).toEqual([]);
    });

    it('returns builtin tools after the session creates its main agent', async () => {
      await createSession();
      const { body } = await getJson<{ tools: ToolWire[] }>('/api/v1/tools');
      expect(body.code).toBe(0);
      expect(listToolsResponseSchema.parse(body.data).tools.length).toBeGreaterThan(0);
    });

    it('accepts an explicit session_id query', async () => {
      const sid = await createSession();
      const { body } = await getJson<{ tools: ToolWire[] }>(
        `/api/v1/tools?session_id=${sid}`,
      );
      expect(body.code).toBe(0);
      expect(listToolsResponseSchema.safeParse(body.data).success).toBe(true);
    });

    it('rejects an empty session_id with 40001', async () => {
      const { body } = await getJson<null>('/api/v1/tools?session_id=');
      expect(body.code).toBe(40001);
    });
  });

  describe('GET /api/v1/mcp/servers', () => {
    it('returns an empty list before any session exists', async () => {
      const { status, body } = await getJson<{ servers: unknown[] }>('/api/v1/mcp/servers');
      expect(status).toBe(200);
      expect(body.code).toBe(0);
      expect(listMcpServersResponseSchema.parse(body.data).servers).toEqual([]);
    });

    it('returns an empty list when the session has no main agent yet', async () => {
      await createSession();
      const { body } = await getJson<{ servers: unknown[] }>('/api/v1/mcp/servers');
      expect(body.code).toBe(0);
      expect(listMcpServersResponseSchema.parse(body.data).servers).toEqual([]);
    });

    it('returns a parseable servers list once the main agent exists', async () => {
      await createSession();
      const { body } = await getJson<{ servers: unknown[] }>('/api/v1/mcp/servers');
      expect(body.code).toBe(0);
      // No MCP servers configured in the sandboxed home → empty, but the route
      // must still resolve the session and answer a valid shape.
      expect(listMcpServersResponseSchema.parse(body.data).servers).toEqual([]);
    });
  });
});
