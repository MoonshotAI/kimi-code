import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentSideConnection,
  ClientSideConnection,
  McpServer,
  NewSessionRequest,
} from '@agentclientprotocol/sdk';
import {
  AgentSideConnection as AgentSideConnectionImpl,
  ClientSideConnection as ClientSideConnectionImpl,
  ndJsonStream,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';
import { log } from '@moonshot-ai/kimi-code-sdk';
import type { McpServerConfig } from '@moonshot-ai/agent-core';

import { acpMcpServersToConfigs } from '../src/mcp';
import { AcpServer } from '../src/server';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    /* drop available_commands_update / etc. — not asserted in this test */
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called');
  }
}

function makeInMemoryStreamPair(): {
  agentStream: ReturnType<typeof ndJsonStream>;
  clientStream: ReturnType<typeof ndJsonStream>;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
  return { agentStream, clientStream };
}

interface CapturedCall {
  options: { workDir: string; mcpServers?: Record<string, McpServerConfig> };
}

function makeHarness(
  sessionId: string,
  captured: CapturedCall[],
): {
  harness: KimiHarness;
} {
  const fakeSession = {
    id: sessionId,
    prompt: async () => undefined,
    cancel: async () => undefined,
    onEvent: () => () => undefined,
  } as unknown as Session;
  const harness = {
    auth: {
      status: async () => ({ providers: [{ providerName: 'kimi', hasToken: true }] }),
    },
    createSession: async (options: CapturedCall['options']) => {
      captured.push({ options });
      return fakeSession;
    },
  } as unknown as KimiHarness;
  return { harness };
}

const httpServer = (
  name: string,
  url: string,
  headers: ReadonlyArray<{ name: string; value: string }>,
): McpServer =>
  // ACP `McpServer` union with `type: 'http'` is `McpServerHttp &
  // { type: 'http' }`. The literal object satisfies the runtime
  // shape; the cast bypasses TS's reluctance to widen the readonly
  // header array into the union member.
  ({
    type: 'http',
    name,
    url,
    headers,
  }) as unknown as McpServer;

const stdioServer = (
  name: string,
  command: string,
  args: ReadonlyArray<string>,
  env: ReadonlyArray<{ name: string; value: string }>,
): McpServer =>
  // The ACP `McpServer` union has stdio as the bare branch with no
  // `type` discriminator (schema 0.23). The cast lets the test
  // assemble the literal as the runtime sees it.
  ({
    name,
    command,
    args,
    env,
  }) as unknown as McpServer;

const sseServer = (
  name: string,
  url: string,
  headers: ReadonlyArray<{ name: string; value: string }>,
): McpServer =>
  ({
    type: 'sse',
    name,
    url,
    headers,
  }) as unknown as McpServer;

const acpServer = (name: string, id: string): McpServer =>
  ({
    type: 'acp',
    name,
    id,
  }) as unknown as McpServer;

describe('acpMcpServersToConfigs', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns an empty record for undefined input', () => {
    expect(acpMcpServersToConfigs(undefined)).toEqual({});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns an empty record for an empty list', () => {
    expect(acpMcpServersToConfigs([])).toEqual({});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('converts an HTTP server with headers to a Record keyed by name', () => {
    const out = acpMcpServersToConfigs([
      httpServer('docs', 'https://mcp.example.com', [
        { name: 'X-Token', value: 'abc' },
        { name: 'Accept', value: 'application/json' },
      ]),
    ]);
    expect(out).toEqual({
      docs: {
        transport: 'http',
        url: 'https://mcp.example.com',
        headers: { 'X-Token': 'abc', Accept: 'application/json' },
      },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('converts a stdio server with args + env to a Record keyed by name', () => {
    const out = acpMcpServersToConfigs([
      stdioServer(
        'fs',
        '/usr/local/bin/mcp-fs',
        ['--root', '/tmp'],
        [
          { name: 'NODE_ENV', value: 'production' },
          { name: 'DEBUG', value: '1' },
        ],
      ),
    ]);
    expect(out).toEqual({
      fs: {
        transport: 'stdio',
        command: '/usr/local/bin/mcp-fs',
        args: ['--root', '/tmp'],
        env: { NODE_ENV: 'production', DEBUG: '1' },
      },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warn-drops sse servers (PLAN D3 — sse capability is false)', () => {
    const out = acpMcpServersToConfigs([
      sseServer('events', 'https://stream.example.com', [{ name: 'X-K', value: 'V' }]),
    ]);
    expect(out).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'acp: dropping unsupported MCP server transport',
      expect.objectContaining({ name: 'events', type: 'sse' }),
    );
  });

  it('warn-drops acp servers (experimental, not supported)', () => {
    const out = acpMcpServersToConfigs([acpServer('inner', 'opaque-id')]);
    expect(out).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'acp: dropping unsupported MCP server transport',
      expect.objectContaining({ name: 'inner', type: 'acp' }),
    );
  });

  it('mixes supported + unsupported transports and warn-drops only the unsupported ones', () => {
    const out = acpMcpServersToConfigs([
      httpServer('docs', 'https://h', [{ name: 'X', value: 'v' }]),
      sseServer('events', 'https://s', [{ name: 'X', value: 'v' }]),
      stdioServer('fs', '/bin/fs', [], []),
    ]);
    expect(Object.keys(out)).toEqual(['docs', 'fs']);
    expect(out['docs']).toMatchObject({ transport: 'http' });
    expect(out['fs']).toMatchObject({ transport: 'stdio' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AcpServer session/new MCP forwarding', () => {
  it('forwards converted mcpServers to harness.createSession', async () => {
    const captured: CapturedCall[] = [];
    const { harness } = makeHarness('sess-mcp-1', captured);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    let server: AcpServer | undefined;
    const _agentConn: AgentSideConnection = new AgentSideConnectionImpl((c) => {
      server = new AcpServer(harness, c);
      return server;
    }, agentStream);
    const client: ClientSideConnection = new ClientSideConnectionImpl(
      (_a) => new StubClient(),
      clientStream,
    );

    const request: NewSessionRequest = {
      cwd: '/tmp/work',
      mcpServers: [
        httpServer('docs', 'https://mcp.example.com', [{ name: 'Auth', value: 'tok' }]),
        sseServer('events', 'https://s', [{ name: 'X', value: 'v' }]),
      ],
    };

    const response = await client.newSession(request);
    expect(response.sessionId).toBe('sess-mcp-1');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.options.workDir).toBe('/tmp/work');
    expect(captured[0]?.options.mcpServers).toEqual({
      docs: {
        transport: 'http',
        url: 'https://mcp.example.com',
        headers: { Auth: 'tok' },
      },
    });
    void _agentConn;
  });
});
