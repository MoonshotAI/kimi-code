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
import { Jimp } from 'jimp';

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

  it('returns cancelled without launching when cancel arrives during image compression', async () => {
    let promptCalls = 0;
    const fakeSession = {
      id: 'sess-cancel-compress',
      prompt: async () => {
        promptCalls += 1;
        return undefined;
      },
      cancel: async () => undefined,
      onEvent: () => () => undefined,
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => fakeSession,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const { sessionId } = await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    // A solid 2600×2600 image is small in bytes but slow enough to compress
    // that the cancel below reliably lands mid-compression, before any turn.
    const data = Buffer.from(
      await new Jimp({ width: 2600, height: 2600, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');

    const promptP = client.prompt({
      sessionId,
      prompt: [{ type: 'image', data, mimeType: 'image/png' }],
    });
    await client.cancel({ sessionId });
    const res = await promptP;

    expect(res.stopReason).toBe('cancelled');
    expect(promptCalls).toBe(0); // the turn was never launched
  });

  it('cancels every prompt compressing concurrently, not just the most recent', async () => {
    let promptCalls = 0;
    const fakeSession = {
      id: 'sess-cancel-concurrent',
      prompt: async () => {
        promptCalls += 1;
        return undefined;
      },
      cancel: async () => undefined,
      onEvent: () => () => undefined,
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => fakeSession,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const { sessionId } = await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const data = Buffer.from(
      await new Jimp({ width: 2600, height: 2600, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');
    const imageBlock = { type: 'image' as const, data, mimeType: 'image/png' };

    // Two prompts compressing at once; a single cancel must cover both.
    const p1 = client.prompt({ sessionId, prompt: [imageBlock] });
    const p2 = client.prompt({ sessionId, prompt: [imageBlock] });
    await client.cancel({ sessionId });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.stopReason).toBe('cancelled');
    expect(r2.stopReason).toBe('cancelled');
    expect(promptCalls).toBe(0);
  });
});
