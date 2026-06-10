import { describe, expect, it } from 'vitest';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type InitializeRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { TERMINAL_AUTH_METHOD } from '../src';

/** Minimal Client that throws on every callback so tests fail loudly. */
class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in Phase 2');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in Phase 2');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in Phase 2');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in Phase 2');
  }
}

/**
 * Build a bidirectional in-memory ndJSON pair:
 *  - agentSide reads `clientToAgent` and writes to `agentToClient`
 *  - clientSide reads `agentToClient` and writes to `clientToAgent`
 */
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

describe('AcpServer + AgentSideConnection', () => {
  it('responds to initialize with negotiated v1 capabilities', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    // Agent side
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    // Client side
    const client = new ClientSideConnection((_agent) => new StubClient(), clientStream);

    const request: InitializeRequest = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    };

    const response = await client.initialize(request);

    expect(response.protocolVersion).toBe(1);
    expect(response.authMethods).toEqual([TERMINAL_AUTH_METHOD]);
    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(response.agentCapabilities?.promptCapabilities?.audio).toBe(false);
    expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
    expect(response.agentCapabilities?.mcpCapabilities?.http).toBe(true);
    expect(response.agentCapabilities?.mcpCapabilities?.sse).toBe(false);
    expect(response.agentCapabilities?.sessionCapabilities?.list).toEqual({});
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
  });

  it('initialize advertises terminal-auth with id, type, args, name', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    expect(response.authMethods).toHaveLength(1);
    const method = response.authMethods?.[0];
    expect(method).toMatchObject({
      id: 'login',
      type: 'terminal',
      name: expect.any(String),
      args: ['--login'],
    });
  });

  it('honors version negotiation: client v99 still negotiates to v1', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 99 });
    expect(response.protocolVersion).toBe(1);
  });

  it('initialize returns the supplied agentInfo', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    const agentInfo = { name: 'Kimi Code CLI', version: '9.9.9-test' };
    new AgentSideConnection(
      (c) => new AcpServer(harness, c, { agentInfo }),
      agentStream,
    );
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 1 });
    expect(response.agentInfo).toEqual(agentInfo);
  });

  it('initialize omits agentInfo when not supplied', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 1 });
    expect(response.agentInfo).toBeUndefined();
  });

  it('initialize forwards terminalAuthEnv into authMethods[0].env', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    const terminalAuthEnv = { KIMI_CODE_HOME: '/tmp/kimi-debug' };
    new AgentSideConnection(
      (c) => new AcpServer(harness, c, { terminalAuthEnv }),
      agentStream,
    );
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 1 });
    expect(response.authMethods).toHaveLength(1);
    const method = response.authMethods?.[0] as { env?: Record<string, string> };
    expect(method.env).toEqual({ KIMI_CODE_HOME: '/tmp/kimi-debug' });
  });

  it('initialize emits legacy _meta["terminal-auth"] when terminalAuthLegacyCommand is set', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection(
      (c) =>
        new AcpServer(harness, c, {
          terminalAuthLegacyCommand: '/abs/path/to/kimi',
          terminalAuthEnv: { KIMI_CODE_HOME: '/tmp/kimi-debug' },
        }),
      agentStream,
    );
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 1 });
    const method = response.authMethods?.[0] as {
      args?: string[];
      env?: Record<string, string>;
      _meta?: { 'terminal-auth'?: Record<string, unknown> };
    };
    // First-class path still uses '--login' for the appended-args form.
    expect(method.args).toEqual(['--login']);
    // Legacy _meta fallback uses absolute command + 'login' subcommand.
    expect(method._meta?.['terminal-auth']).toEqual({
      type: 'terminal',
      label: 'Login with Kimi account',
      command: '/abs/path/to/kimi',
      args: ['login'],
      env: { KIMI_CODE_HOME: '/tmp/kimi-debug' },
    });
  });

  it('initialize omits _meta["terminal-auth"] when terminalAuthLegacyCommand is unset', async () => {
    const harness = {} as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.initialize({ protocolVersion: 1 });
    const method = response.authMethods?.[0] as {
      _meta?: { 'terminal-auth'?: unknown } | null;
    };
    expect(method._meta?.['terminal-auth']).toBeUndefined();
  });
});
