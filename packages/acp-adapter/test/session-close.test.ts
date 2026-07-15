import { describe, expect, it } from 'vitest';

import {
  AgentSideConnection,
  ClientSideConnection,
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
import { type KimiHarness, type Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in session/close test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in session/close test');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in session/close test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in session/close test');
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

describe('AcpServer session/close', () => {
  it('closes a known session and removes it from the server map', async () => {
    let closeCalls = 0;
    let cancelCalls = 0;
    const fakeSession = {
      id: 'sess-close-known',
      prompt: async () => undefined,
      cancel: async () => {
        cancelCalls += 1;
      },
      close: async () => {
        closeCalls += 1;
      },
      onEvent: () => () => undefined,
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => fakeSession,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    const serverRef = { current: undefined as AcpServer | undefined };
    new AgentSideConnection(
      (c) => {
        const server = new AcpServer(harness, c);
        serverRef.current = server;
        return server;
      },
      agentStream,
    );
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    expect(serverRef.current?.getSession('sess-close-known')).toBeDefined();

    await client.closeSession({ sessionId: 'sess-close-known' });

    expect(cancelCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(serverRef.current?.getSession('sess-close-known')).toBeUndefined();
  });

  it('throws invalid_params when sessionId is unknown', async () => {
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => {
        throw new Error('createSession should not be called when no session is created');
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.closeSession({ sessionId: 'sess-unknown' })).rejects.toThrow(
      /Unknown sessionId/,
    );
  });
});
