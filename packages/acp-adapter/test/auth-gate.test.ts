import { describe, expect, it } from 'vitest';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type NewSessionRequest,
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
import { AUTHED_STATUS, UNAUTHED_STATUS } from './_helpers/harness-stubs';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in auth-gate test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in auth-gate test');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in auth-gate test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in auth-gate test');
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

function makeHarnessWithToken(hasToken: boolean): KimiHarness {
  return {
    auth: {
      status: async () => (hasToken ? AUTHED_STATUS : UNAUTHED_STATUS),
    },
  } as unknown as KimiHarness;
}

describe('AcpServer auth gate', () => {
  it('rejects session/new with auth_required (-32000) when no token', async () => {
    const harness = makeHarnessWithToken(false);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const request: NewSessionRequest = {
      cwd: '/tmp/x',
      mcpServers: [],
    };

    await expect(client.newSession(request)).rejects.toMatchObject({
      code: -32000,
    });
  });

  it('does not call createSession when the auth gate fails', async () => {
    let createCalled = false;
    const harness = {
      auth: {
        status: async () => UNAUTHED_STATUS,
      },
      createSession: async (_opts: unknown) => {
        createCalled = true;
        return { id: 'should-not-be-reached' };
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(
      client.newSession({ cwd: '/tmp/x', mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32000 });
    expect(createCalled).toBe(false);
  });
});

describe('AcpServer.authenticate', () => {
  it('rejects unknown methodId with invalidParams (-32602)', async () => {
    const harness = makeHarnessWithToken(true);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.authenticate({ methodId: 'unknown' })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('returns void on valid token', async () => {
    const harness = makeHarnessWithToken(true);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const result = await client.authenticate({ methodId: 'login' });
    // ACP allows `AuthenticateResponse | void`; either `null`/`undefined`
    // or an empty body `{}` is considered a successful ack.
    expect(result ?? {}).toEqual({});
  });

  it('throws authRequired (-32000) when harness has no token', async () => {
    const harness = makeHarnessWithToken(false);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.authenticate({ methodId: 'login' })).rejects.toMatchObject({
      code: -32000,
    });
  });
});
