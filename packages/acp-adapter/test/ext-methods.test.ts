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
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS, makeModelsMap } from './_helpers/harness-stubs';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in ext-methods test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in ext-methods test');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in ext-methods test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in ext-methods test');
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

function makeMinimalHarness(): KimiHarness {
  // ext_method does not touch the harness; the auth/session surface
  // is irrelevant for these tests so the stub keeps the harness flat.
  return {} as unknown as KimiHarness;
}

describe('AcpServer ext method surface', () => {
  it('unit-level extMethod throws RequestError.methodNotFound with the method name', async () => {
    const server = new AcpServer(makeMinimalHarness());
    await expect(server.extMethod('myorg.foo', {})).rejects.toMatchObject({
      // JSON-RPC method-not-found code per ACP SDK RequestError.methodNotFound.
      code: -32601,
      // RequestError stamps the requested method name into the message
      // so clients can distinguish "ext/foo" from "ext/bar".
      message: expect.stringContaining('myorg.foo'),
    });
  });

  it('unit-level extNotification throws RequestError.methodNotFound with the method name', async () => {
    const server = new AcpServer(makeMinimalHarness());
    await expect(server.extNotification('myorg.bar', {})).rejects.toMatchObject({
      code: -32601,
      message: expect.stringContaining('myorg.bar'),
    });
  });

  it('over-the-wire extMethod surfaces -32601 to a remote ACP client', async () => {
    const harness = makeMinimalHarness();
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.extMethod('myorg.unsupported', {})).rejects.toMatchObject({
      code: -32601,
    });
  });
});

describe('AcpServer kimi/session/* extension methods', () => {
  interface ForkHarness {
    harness: KimiHarness;
    forkCalls: Array<{ id: string; title?: string }>;
    closeCalls: string[];
    archiveCalls: string[];
    forkSessionId: string;
  }

  function makeSessionStub(id: string): Session {
    return {
      id,
      prompt: async () => undefined,
      cancel: async () => undefined,
      onEvent: () => () => undefined,
      listSkills: async () => [],
    } as unknown as Session;
  }

  function makeForkHarness(sourceSessionId: string): ForkHarness {
    const forkCalls: Array<{ id: string; title?: string }> = [];
    const closeCalls: string[] = [];
    const archiveCalls: string[] = [];
    const forkSessionId = 'sess-fork-1';
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async (options: { id?: string }) =>
        makeSessionStub(options.id ?? sourceSessionId),
      getConfig: async () => ({
        providers: {},
        defaultModel: 'kimi-coder',
        models: makeModelsMap([{ id: 'kimi-coder', name: 'Kimi Coder' }]),
      }),
      forkSession: async (input: { id: string; title?: string }) => {
        forkCalls.push(input);
        return makeSessionStub(forkSessionId);
      },
      closeSession: async (id: string) => {
        closeCalls.push(id);
      },
      archiveSession: async (id: string) => {
        archiveCalls.push(id);
      },
    } as unknown as KimiHarness;
    return { harness, forkCalls, closeCalls, archiveCalls, forkSessionId };
  }

  it('kimi/session/fork forks via the harness and registers a promptable ACP session', async () => {
    const { harness, forkCalls, forkSessionId } = makeForkHarness('sess-src');
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    let server: AcpServer | undefined;
    new AgentSideConnection((c) => {
      server = new AcpServer(harness, c);
      return server;
    }, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    const result = await client.extMethod('kimi/session/fork', { sessionId });

    expect(result).toEqual({ sessionId: forkSessionId });
    expect(forkCalls).toEqual([{ id: sessionId, title: `Fork of ${sessionId}` }]);
    // The fork is registered as a first-class ACP session.
    expect(server?.getSession(forkSessionId)?.id).toBe(forkSessionId);
  });

  it('kimi/session/fork rejects an unknown sessionId with invalidParams', async () => {
    const { harness } = makeForkHarness('sess-src');
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(
      client.extMethod('kimi/session/fork', { sessionId: 'nope' }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(client.extMethod('kimi/session/fork', {})).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('kimi/session/close drops the session; archive:true archives the directory', async () => {
    const { harness, closeCalls, archiveCalls, forkSessionId } = makeForkHarness('sess-src');
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    let server: AcpServer | undefined;
    new AgentSideConnection((c) => {
      server = new AcpServer(harness, c);
      return server;
    }, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    await client.extMethod('kimi/session/fork', { sessionId });

    await client.extMethod('kimi/session/close', { sessionId: forkSessionId, archive: true });
    expect(archiveCalls).toEqual([forkSessionId]);
    expect(closeCalls).toEqual([]);
    expect(server?.getSession(forkSessionId)).toBeUndefined();

    await client.extMethod('kimi/session/close', { sessionId });
    expect(closeCalls).toEqual([sessionId]);
    expect(server?.getSession(sessionId)).toBeUndefined();
  });
});
