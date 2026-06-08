import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { log, type KimiHarness, type Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in cancel test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in cancel test');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in cancel test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in cancel test');
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

describe('AcpServer cancel', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('forwards session/cancel to the underlying Session.cancel() for a known sessionId', async () => {
    let cancelCalls = 0;
    const fakeSession = {
      id: 'sess-known',
      prompt: async () => undefined,
      cancel: async () => {
        cancelCalls += 1;
      },
      onEvent: () => () => undefined,
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => fakeSession,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    // session/cancel is a notification — `client.cancel` is fire-and-forget.
    await client.cancel({ sessionId: 'sess-known' });

    // Give the agent side a tick to process the notification.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cancelCalls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not throw and logs a warning when sessionId is unknown', async () => {
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => {
        throw new Error('createSession should not be called when no session is created');
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    // Notification: no response, no throw.
    await client.cancel({ sessionId: 'sess-unknown' });

    // Give the agent side a tick to process the notification.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('cancel for unknown sessionId'),
      expect.objectContaining({ sessionId: 'sess-unknown' }),
    );
  });

  it('swallows and warns when Session.cancel() throws (notifications must not error)', async () => {
    const fakeSession = {
      id: 'sess-erroring',
      prompt: async () => undefined,
      cancel: async () => {
        throw new Error('boom inside cancel');
      },
      onEvent: () => () => undefined,
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => fakeSession,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await client.cancel({ sessionId: 'sess-erroring' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('error while cancelling'),
      expect.objectContaining({ sessionId: 'sess-erroring' }),
    );
  });
});
