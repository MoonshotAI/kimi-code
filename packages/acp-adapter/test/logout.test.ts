import { describe, expect, it, vi } from 'vitest';

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
import { type KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in logout test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in logout test');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in logout test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in logout test');
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

describe('AcpServer logout', () => {
  it('forwards logout to harness.auth.logout', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const harness = {
      auth: {
        status: async () => AUTHED_STATUS,
        logout,
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.logout({});

    expect(logout).toHaveBeenCalledTimes(1);
  });
});
