/**
 * `/api/v1` tools + MCP routes — server-v2 port of `packages/server/test/tools.e2e.test.ts`.
 *
 * Covers the wire contract of the three endpoints:
 *   - GET  /api/v1/tools                              → envelope shape + tools[]
 *   - GET  /api/v1/mcp/servers                        → envelope shape + servers[]
 *   - POST /api/v1/mcp/servers/{id}:restart           → {restarting:true} / 40408
 *   - POST /api/v1/mcp/servers/foo:bogus              → 40001 unsupported action
 *
 * Unlike v1 (which sources these from a global singleton), server-v2 resolves
 * `IToolRegistry` / `IMcpService` from the most-recent session's `main` agent.
 * The empty-list / 40408 fallbacks for "no session yet" and "no main agent yet"
 * (gap G10) are exercised explicitly.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IAgentToolRegistryService,
  ISessionLifecycleService,
  IModelCatalog,
  type ExecutableTool,
} from '@moonshot-ai/agent-core-v2';
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
}

describe('server-v2 /api/v1 tools + mcp', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-tools-'));
    const modelCatalog: IModelCatalog = {
      _serviceBrand: undefined,
      get: () => {
        throw new Error('modelCatalog.get not exercised in this test');
      },
      getRequester: () => {
        throw new Error('modelCatalog.getRequester not exercised in this test');
      },
      inspect: () => {
        throw new Error('modelCatalog.inspect not exercised in this test');
      },
      ping: () => {
        throw new Error('modelCatalog.ping not exercised in this test');
      },
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('modelCatalog.getProvider not exercised in this test');
      },
      setDefaultModel: async () => {
        throw new Error('modelCatalog.setDefaultModel not exercised in this test');
      },
    };
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IModelCatalog, modelCatalog]],
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

  // The main agent scope is not created automatically on session creation
  // (server-v2 gap G10); create it here so IToolRegistry / IMcpService resolve.
  async function ensureMainAgent(sessionId: string) {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    let agent = session.accessor.get(IAgentLifecycleService).get('main');
    agent ??= await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    return agent;
  }

  function makeTool(name: string, parameters?: Record<string, unknown>): ExecutableTool {
    return {
      name,
      description: `tool ${name}`,
      parameters,
      resolveExecution: () => ({
        approvalRule: 'always-allow',
        execute: async () => ({ output: '' }),
      }),
    } as ExecutableTool;
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

    it('projects registered tools with source mapping and mcp server id', async () => {
      const id = await createSession();
      const agent = await ensureMainAgent(id);
      const registry = agent.accessor.get(IAgentToolRegistryService);
      const schema = { type: 'object', properties: { msg: { type: 'string' } } };
      registry.register(makeTool('Echo', schema), { source: 'builtin' });
      registry.register(makeTool('MySkill'), { source: 'user' });
      registry.register(makeTool('mcp__myserver__search'), { source: 'mcp' });

      const { body } = await getJson<{ tools: ToolWire[] }>('/api/v1/tools');
      expect(body.code).toBe(0);
      const tools = listToolsResponseSchema.parse(body.data).tools;

      const echo = tools.find((t) => t.name === 'Echo');
      // v1 parity: `input_schema` is always null on the wire, even though v2's
      // registry carries the real JSON schema (`parameters`).
      expect(echo).toMatchObject({ source: 'builtin', input_schema: null });
      expect(echo?.mcp_server_id).toBeUndefined();

      const skill = tools.find((t) => t.name === 'MySkill');
      // v2 `user` source maps to the wire `skill` name.
      expect(skill).toMatchObject({ source: 'skill' });

      const mcp = tools.find((t) => t.name === 'mcp__myserver__search');
      // Qualified name `mcp__<server>__<tool>` yields the server id.
      expect(mcp).toMatchObject({ source: 'mcp', mcp_server_id: 'myserver' });
    });

    it('accepts an explicit session_id query', async () => {
      const sid = await createSession();
      await ensureMainAgent(sid);
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
      const id = await createSession();
      await ensureMainAgent(id);
      const { body } = await getJson<{ servers: unknown[] }>('/api/v1/mcp/servers');
      expect(body.code).toBe(0);
      // No MCP servers configured in the sandboxed home → empty, but the route
      // must still resolve IMcpService successfully and answer a valid shape.
      expect(listMcpServersResponseSchema.parse(body.data).servers).toEqual([]);
    });
  });

  describe('POST /api/v1/mcp/servers/{id}:restart', () => {
    it('returns 40408 for an unknown server id', async () => {
      const id = await createSession();
      await ensureMainAgent(id);
      const { body } = await postJson<null>('/api/v1/mcp/servers/does-not-exist:restart');
      expect(body.code).toBe(40408);
      expect(body.msg).toMatch(/does not exist/);
    });

    it('returns 40408 even before any session is created', async () => {
      const { body } = await postJson<null>('/api/v1/mcp/servers/x:restart');
      expect(body.code).toBe(40408);
    });

    it('rejects an unsupported action with 40001', async () => {
      await createSession();
      const { body } = await postJson<null>('/api/v1/mcp/servers/foo:bogus');
      expect(body.code).toBe(40001);
      expect(body.msg).toMatch(/unsupported action/);
    });

    it('rejects a bare {id} (no action) with 40001', async () => {
      await createSession();
      const { body } = await postJson<null>('/api/v1/mcp/servers/foo');
      expect(body.code).toBe(40001);
    });
  });
});
