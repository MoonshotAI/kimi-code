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
import type { Event, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpKaos } from '../src/kaos-acp';
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
  interface ForkCall {
    id: string;
    forkId?: string;
    title?: string;
    kaos?: unknown;
    persistenceKaos?: unknown;
  }

  interface ForkHarness {
    harness: KimiHarness;
    forkCalls: ForkCall[];
    closeCalls: string[];
    archiveCalls: string[];
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
    const forkCalls: ForkCall[] = [];
    const closeCalls: string[] = [];
    const archiveCalls: string[] = [];
    // Fallback id for callers that do not pre-mint a forkId; the adapter
    // always does, so the stub mirrors the kernel by preferring input.forkId.
    const fallbackForkId = 'sess-fork-1';
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async (options: { id?: string }) =>
        makeSessionStub(options.id ?? sourceSessionId),
      getConfig: async () => ({
        providers: {},
        defaultModel: 'kimi-coder',
        models: makeModelsMap([{ id: 'kimi-coder', name: 'Kimi Coder' }]),
      }),
      forkSession: async (input: ForkCall) => {
        forkCalls.push(input);
        return makeSessionStub(input.forkId ?? fallbackForkId);
      },
      closeSession: async (id: string) => {
        closeCalls.push(id);
      },
      archiveSession: async (id: string) => {
        archiveCalls.push(id);
      },
    } as unknown as KimiHarness;
    return { harness, forkCalls, closeCalls, archiveCalls };
  }

  it('kimi/session/fork forks via the harness and registers a promptable ACP session', async () => {
    const { harness, forkCalls } = makeForkHarness('sess-src');
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    let server: AcpServer | undefined;
    new AgentSideConnection((c) => {
      server = new AcpServer(harness, c);
      return server;
    }, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    const result = await client.extMethod('kimi/session/fork', { sessionId });

    const forkCall = forkCalls[0];
    expect(result).toEqual({ sessionId: forkCall?.forkId });
    expect(forkCall).toMatchObject({ id: sessionId, title: `Fork of ${sessionId}` });
    expect(forkCall?.forkId).toEqual(expect.any(String));
    // Without an `initialize` fs capability the fork must NOT get a kaos
    // pair — the kernel falls back to its process-wide LocalKaos.
    expect(forkCall?.kaos).toBeUndefined();
    expect(forkCall?.persistenceKaos).toBeUndefined();
    // The fork is registered as a first-class ACP session.
    expect(server?.getSession(forkCall!.forkId!)?.id).toBe(forkCall!.forkId!);
  });

  it('kimi/session/fork threads an AcpKaos pair when the client advertises fs capabilities', async () => {
    const { harness, forkCalls } = makeForkHarness('sess-src');
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    await client.extMethod('kimi/session/fork', { sessionId });

    const forkCall = forkCalls[0];
    expect(forkCall?.kaos).toBeInstanceOf(AcpKaos);
    expect(forkCall?.persistenceKaos).toBeDefined();
    expect(forkCall?.persistenceKaos).not.toBe(forkCall?.kaos);
    expect(forkCall?.forkId).toEqual(expect.any(String));
  });

  it('kimi/session/fork omits the kaos pair when the client has no fs capability', async () => {
    const { harness, forkCalls } = makeForkHarness('sess-src');
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    await client.extMethod('kimi/session/fork', { sessionId });

    expect(forkCalls[0]?.kaos).toBeUndefined();
    expect(forkCalls[0]?.persistenceKaos).toBeUndefined();
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
    const { harness, closeCalls, archiveCalls } = makeForkHarness('sess-src');
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    let server: AcpServer | undefined;
    new AgentSideConnection((c) => {
      server = new AcpServer(harness, c);
      return server;
    }, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    const forkResult = (await client.extMethod('kimi/session/fork', { sessionId })) as {
      sessionId: string;
    };
    const forkId = forkResult.sessionId;

    await client.extMethod('kimi/session/close', { sessionId: forkId, archive: true });
    expect(archiveCalls).toEqual([forkId]);
    expect(closeCalls).toEqual([]);
    expect(server?.getSession(forkId)).toBeUndefined();

    await client.extMethod('kimi/session/close', { sessionId });
    expect(closeCalls).toEqual([sessionId]);
    expect(server?.getSession(sessionId)).toBeUndefined();
  });
});

describe('AcpServer kimi/session/steer', () => {
  interface SteerHarness {
    harness: KimiHarness;
    steerCalls: unknown[][];
  }

  /**
   * Stub harness whose session can hold a turn open: `prompt()` emits
   * `turn.started` and never `turn.ended`, so the adapter's
   * `currentTurnId` stays set (the same busy-turn setup as the `/undo`
   * test in session-slash.test.ts).
   */
  function makeSteerHarness(opts?: { steerError?: Error }): SteerHarness {
    const steerCalls: unknown[][] = [];
    const listeners = new Set<(event: Event) => void>();
    const sessionId = 'sess-steer-src';
    const session = {
      id: sessionId,
      prompt: async () => {
        await Promise.resolve();
        for (const fn of listeners) {
          fn({ type: 'turn.started', sessionId, agentId: 'main', turnId: 1 } as Event);
        }
      },
      steer: async (parts: readonly unknown[]) => {
        if (opts?.steerError !== undefined) throw opts.steerError;
        steerCalls.push([...parts]);
      },
      cancel: async () => undefined,
      onEvent: (fn: (event: Event) => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      listSkills: async () => [],
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
      getConfig: async () => ({
        providers: {},
        defaultModel: 'kimi-coder',
        models: makeModelsMap([{ id: 'kimi-coder', name: 'Kimi Coder' }]),
      }),
    } as unknown as KimiHarness;
    return { harness, steerCalls };
  }

  function wireUp(harness: KimiHarness): ClientSideConnection {
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    return new ClientSideConnection((_a) => new StubClient(), clientStream);
  }

  it('steers a pending user message into the active turn', async () => {
    const { harness, steerCalls } = makeSteerHarness();
    const client = wireUp(harness);

    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    // Fire-and-forget: the stub turn never ends, so this prompt stays in
    // flight and the adapter keeps `currentTurnId` set.
    void client.prompt({ sessionId, prompt: [{ type: 'text', text: 'run something long' }] });
    // Let the turn.started event reach the adapter before steering.
    await new Promise((r) => setTimeout(r, 20));

    const result = await client.extMethod('kimi/session/steer', {
      sessionId,
      prompt: [{ type: 'text', text: 'keep going' }],
    });

    expect(result).toEqual({ steered: true });
    expect(steerCalls).toEqual([[{ type: 'text', text: 'keep going' }]]);
  });

  it('resolves to no_active_turn instead of erroring when no turn is running', async () => {
    const { harness, steerCalls } = makeSteerHarness();
    const client = wireUp(harness);

    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    const result = await client.extMethod('kimi/session/steer', {
      sessionId,
      prompt: [{ type: 'text', text: 'keep going' }],
    });

    expect(result).toEqual({ steered: false, reason: 'no_active_turn' });
    expect(steerCalls).toEqual([]);
  });

  it('maps a prompt.not_found steer rejection to no_active_turn', async () => {
    const steerError = Object.assign(new Error('no active prompt to steer into'), {
      code: 'prompt.not_found',
    });
    const { harness, steerCalls } = makeSteerHarness({ steerError });
    const client = wireUp(harness);

    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    void client.prompt({ sessionId, prompt: [{ type: 'text', text: 'run something long' }] });
    await new Promise((r) => setTimeout(r, 20));

    const result = await client.extMethod('kimi/session/steer', {
      sessionId,
      prompt: [{ type: 'text', text: 'keep going' }],
    });

    expect(result).toEqual({ steered: false, reason: 'no_active_turn' });
    expect(steerCalls).toEqual([]);
  });

  it('rejects unknown sessions and missing/empty prompts with invalidParams', async () => {
    const { harness } = makeSteerHarness();
    const client = wireUp(harness);

    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    await expect(
      client.extMethod('kimi/session/steer', {
        sessionId: 'nope',
        prompt: [{ type: 'text', text: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(client.extMethod('kimi/session/steer', { sessionId })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      client.extMethod('kimi/session/steer', { sessionId, prompt: [] }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('rejects malformed prompt blocks with invalidParams', async () => {
    const { harness } = makeSteerHarness();
    const client = wireUp(harness);

    const { sessionId } = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    // null element.
    await expect(
      client.extMethod('kimi/session/steer', { sessionId, prompt: [null] }),
    ).rejects.toMatchObject({ code: -32602 });
    // text block without text.
    await expect(
      client.extMethod('kimi/session/steer', { sessionId, prompt: [{ type: 'text' }] }),
    ).rejects.toMatchObject({ code: -32602 });
    // primitive element.
    await expect(
      client.extMethod('kimi/session/steer', { sessionId, prompt: ['text'] }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
