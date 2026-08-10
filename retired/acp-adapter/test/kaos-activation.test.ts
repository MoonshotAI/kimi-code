/**
 * Tests that {@link AcpServer.newSession} / `setupSessionFromExisting`
 * passes an {@link AcpKaos} to {@link KimiHarness.createSession} /
 * `resumeSession` when, and only when, the client advertises
 * `fs.readTextFile` or `fs.writeTextFile`.
 *
 * Boundary-injection model: the kaos is captured by the kernel
 * `SessionImpl` ctor at session-creation time so every tool downstream
 * sees the same reference — no AsyncLocalStorage, no per-prompt
 * wrapping. The right surface to assert is therefore the
 * `harness.createSession({ kaos })` boundary, not in-flight tool calls.
 */

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
import type { Kaos } from '@moonshot-ai/kaos';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { AcpKaos } from '../src/kaos-acp';
import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in kaos-activation test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    // no-op — the server may push available_commands_update etc.
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return {};
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return { content: 'STUB' };
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

interface CapturedCreate {
  options: { id?: string; workDir: string; kaos?: Kaos; persistenceKaos?: Kaos };
}

function makeHarness(captured: CapturedCreate[]): KimiHarness {
  const fakeSession = (id: string): Session =>
    ({
      id,
      prompt: async () => undefined,
      cancel: async () => undefined,
      onEvent: () => () => undefined,
    }) as unknown as Session;
  return {
    auth: { status: async () => AUTHED_STATUS },
    createSession: async (options: { id?: string; workDir: string; kaos?: Kaos; persistenceKaos?: Kaos }) => {
      captured.push({ options });
      return fakeSession(options.id ?? 'fallback');
    },
    getConfig: async () => ({ providers: {}, models: {} }),
  } as unknown as KimiHarness;
}

describe('AcpServer FS-capability activation (boundary injection)', () => {
  it('passes an AcpKaos to createSession when the client advertises fs.readTextFile', async () => {
    const captured: CapturedCreate[] = [];
    const harness = makeHarness(captured);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
    });
    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.options.kaos).toBeInstanceOf(AcpKaos);
    expect(captured[0]?.options.kaos?.name).toBe('acp(local)');
    expect(captured[0]?.options.persistenceKaos).toBeDefined();
    expect(captured[0]?.options.persistenceKaos).not.toBe(captured[0]?.options.kaos);
  });

  it('passes an AcpKaos when only fs.writeTextFile is advertised', async () => {
    const captured: CapturedCreate[] = [];
    const harness = makeHarness(captured);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: true } },
    });
    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.options.kaos).toBeInstanceOf(AcpKaos);
    expect(captured[0]?.options.persistenceKaos).toBeDefined();
    expect(captured[0]?.options.persistenceKaos).not.toBe(captured[0]?.options.kaos);
  });

  it('passes persistenceKaos only when tool AcpKaos is active and omits both when no FS capability', async () => {
    const captured: CapturedCreate[] = [];
    const harness = makeHarness(captured);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.options.kaos).toBeUndefined();
    expect(captured[0]?.options.persistenceKaos).toBeUndefined();
  });

  it('omits kaos when the FS capability flags are both false', async () => {
    const captured: CapturedCreate[] = [];
    const harness = makeHarness(captured);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.options.kaos).toBeUndefined();
    expect(captured[0]?.options.persistenceKaos).toBeUndefined();
  });

  it('threads the per-session id into the AcpKaos so reverse-RPC calls route to the right session', async () => {
    const captured: CapturedCreate[] = [];
    const harness = makeHarness(captured);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    let observedSessionId: string | undefined;
    class CapturingClient extends StubClient {
      override async readTextFile(p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        observedSessionId = p.sessionId;
        return { content: 'STUB' };
      }
    }

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new CapturingClient(), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true } },
    });
    const response = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    const kaos = captured[0]?.options.kaos;
    expect(kaos).toBeInstanceOf(AcpKaos);
    // Drive a reverse-RPC read through the AcpKaos and verify the
    // sessionId on the wire matches the one returned by newSession.
    await kaos!.readText('/abs/file.ts');
    expect(observedSessionId).toBe(response.sessionId);
  });
});
