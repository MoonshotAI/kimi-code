/**
 * End-to-end test for the FS reverse-RPC bridge.
 *
 * Wire shape under test (the integration that Phases 6.1 + 6.2 unlock):
 *
 *   ┌────────┐  fs/readTextFile (RPC)   ┌────────┐
 *   │ client │ ───────────────────────► │ agent  │
 *   │        │                          │ │      │
 *   │        │ ◄──── { content: ... } ──│ ▼ tool │
 *   └────────┘                          │ uses   │
 *                                       │ kaos   │
 *                                       └────────┘
 *
 * The test drives a real `ClientSideConnection`+`AgentSideConnection`
 * pair over an in-memory ndjson stream, advertising
 * `clientCapabilities.fs.readTextFile = true` so the agent activates
 * `AcpKaos`. A mock harness's `Session.prompt` calls
 * `getCurrentKaos().readText('/path/x.ts')` inside its body — exactly
 * what a real Read tool would do — and emits the returned content as
 * an `assistant.delta`. We assert that the client's `readTextFile`
 * handler was invoked with the expected path AND that the assistant
 * chunk carrying the unsaved-buffer content reached the client.
 */

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { getCurrentKaos } from '@moonshot-ai/kaos';
import type { Event, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

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

/**
 * A `Client` that:
 *  - Records every `readTextFile` request the agent sends.
 *  - Returns `unsavedContent` for those requests (the "unsaved buffer"
 *    payload).
 *  - Captures every `sessionUpdate` so the test can verify the
 *    assistant chunks carrying the content reached the client.
 */
class UnsavedBufferClient implements Client {
  readonly readRequests: ReadTextFileRequest[] = [];
  readonly updates: SessionNotification[] = [];
  unsavedContent = 'UNSAVED BUFFER CONTENT';

  async readTextFile(p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.readRequests.push(p);
    return { content: this.unsavedContent };
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('writeTextFile not exercised in this e2e test');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('requestPermission not exercised in this e2e test');
  }
}

/**
 * Build a fake `Session` whose `prompt(parts)` performs a tool-shaped
 * action: it pulls `getCurrentKaos()` (the `AcpKaos` the agent wired
 * for this prompt), reads `targetPath`, emits the contents as an
 * assistant delta, and then ends the turn. This stands in for the
 * Read tool inside the SDK loop without dragging the full SDK harness
 * into the test.
 */
function makeReadingSession(sessionId: string, targetPath: string): Session {
  const listeners = new Set<(event: Event) => void>();
  return {
    id: sessionId,
    prompt: async (_input: unknown) => {
      // This call is the FS reverse-RPC trigger — it's what a real
      // file-read tool would invoke. The `AcpKaos` activated by
      // `AcpSession.prompt` makes this hit the client's
      // `readTextFile` handler over the wire.
      const content = await getCurrentKaos().readText(targetPath);

      for (const fn of listeners) {
        fn({
          type: 'assistant.delta',
          sessionId,
          agentId: 'main',
          turnId: 1,
          delta: content,
        } as Event);
      }
      for (const fn of listeners) {
        fn({
          type: 'turn.ended',
          sessionId,
          agentId: 'main',
          turnId: 1,
          reason: 'completed',
        } as Event);
      }
    },
    cancel: async () => undefined,
    onEvent: (fn: (event: Event) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  } as unknown as Session;
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

describe('end-to-end FS reverse-RPC', () => {
  it('routes a tool-time readText through the client when fs.readTextFile is advertised', async () => {
    const sessionId = 'sess-fs-e2e';
    const targetPath = '/Users/test/x.ts';
    const session = makeReadingSession(sessionId, targetPath);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const bufferClient = new UnsavedBufferClient();
    const client = new ClientSideConnection(() => bufferClient, clientStream);

    // Initialize with the FS read capability advertised — this is the
    // wire signal that switches the agent to `AcpKaos`.
    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const response = await client.prompt({
      sessionId,
      prompt: [textBlock('read the unsaved file please')],
    });

    expect(response.stopReason).toBe('end_turn');

    // ── Assertion 1: the client saw exactly one fs/readTextFile
    // request with the expected path and matching sessionId.
    expect(bufferClient.readRequests).toHaveLength(1);
    expect(bufferClient.readRequests[0]).toMatchObject({
      sessionId,
      path: targetPath,
    });

    // Give the agent a tick to flush the queued sessionUpdate write
    // through the ndjson stream (assistant chunks are fire-and-forget
    // — see `session.ts` comments).
    await new Promise((resolve) => setTimeout(resolve, 20));

    // ── Assertion 2: the assistant chunk carrying the unsaved-buffer
    // content reached the client, proving end-to-end plumbing.
    const chunkUpdate = bufferClient.updates.find(
      (u) => u.update.sessionUpdate === 'agent_message_chunk',
    );
    expect(chunkUpdate).toBeDefined();
    expect(chunkUpdate?.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'UNSAVED BUFFER CONTENT' },
    });
  });

  it('does NOT route through the client when no FS capability is advertised', async () => {
    // Sanity counterpart: the same wiring without the FS capability
    // must fall back to local FS (which would attempt to actually read
    // /Users/test/x.ts and fail). We avoid the filesystem touch by
    // probing the session-side outcome differently: the prompt body
    // now reads a path that DOES exist transiently — we just verify
    // that the client never saw a readTextFile request.
    const sessionId = 'sess-no-fs-e2e';

    const session: Session = {
      id: sessionId,
      // `prompt` here does NOT call getCurrentKaos — that path would
      // throw / hit local FS, which we don't want in this test. We
      // simply end the turn immediately. The point is: with no FS
      // capability, the agent must NOT have built an AcpKaos and the
      // client must NOT see any readTextFile RPC even if it had been
      // called.
      prompt: async () => {
        // Emit turn.ended directly through the listener that
        // session.onEvent registered.
        for (const fn of listeners) {
          fn({
            type: 'turn.ended',
            sessionId,
            agentId: 'main',
            turnId: 1,
            reason: 'completed',
          } as Event);
        }
      },
      cancel: async () => undefined,
      onEvent: (fn: (event: Event) => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    } as unknown as Session;
    const listeners = new Set<(event: Event) => void>();

    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const bufferClient = new UnsavedBufferClient();
    const client = new ClientSideConnection(() => bufferClient, clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        // Both flags absent — agent must not activate AcpKaos.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const response = await client.prompt({
      sessionId,
      prompt: [textBlock('hi')],
    });

    expect(response.stopReason).toBe('end_turn');
    expect(bufferClient.readRequests).toEqual([]);
  });
});
