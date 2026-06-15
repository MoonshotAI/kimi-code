/**
 * End-to-end "happy path" exercise:
 *
 *   initialize → session/new → session/prompt → end_turn
 *
 * The test wires an `AgentSideConnection` and a `ClientSideConnection`
 * over an in-memory NDJSON pipe (matching `test/e2e-fs.test.ts`'s
 * Phase 6 pattern), drives the full ACP handshake from the client
 * side, and asserts:
 *
 *  1. `initialize` returns the documented capability matrix
 *     (PLAN D4: image=true, audio=false, embeddedContext=true,
 *      mcp.http=true, mcp.sse=true, loadSession=true,
 *      sessionCapabilities.list={}).
 *  2. `session/new` returns a non-empty sessionId.
 *  3. `session/prompt` streams at least one `agent_message_chunk`
 *     update and resolves with `stopReason: 'end_turn'`.
 *  4. `session/cancel` mid-stream resolves the prompt with
 *     `stopReason: 'cancelled'` and does not throw.
 *
 * The `promptUpdates` getter filters out the `available_commands_update`
 * one-shot that `newSession` emits (Phase 9), matching the pattern
 * established in `test/session-prompt.test.ts:24-37`.
 */

import { describe, expect, it } from 'vitest';

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
import type { Event, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS, makeModelsMap } from './_helpers/harness-stubs';

class CollectingClient implements Client {
  readonly updates: SessionNotification[] = [];

  /**
   * Filters out the `available_commands_update` one-shot that
   * `session/new` emits (Phase 9), so prompt-update assertions only
   * see chunks produced by the actual turn.
   */
  get promptUpdates(): readonly SessionNotification[] {
    return this.updates.filter(
      (n) =>
        (n.update as { sessionUpdate?: string }).sessionUpdate !==
        'available_commands_update',
    );
  }

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('CollectingClient.requestPermission should not be called in happy-path test');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('CollectingClient.writeTextFile should not be called in happy-path test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CollectingClient.readTextFile should not be called in happy-path test');
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

/**
 * Build a scripted Session whose `prompt()` synchronously emits a
 * pre-recorded sequence of `Event`s through any subscribed listener.
 * `onEvent` tracks listener registrations so the test can assert
 * the AcpSession unsubscribes after `turn.ended`.
 */
function makeScriptedSession(
  sessionId: string,
  script: readonly Event[],
): {
  session: Session;
  unsubscribeCount: () => number;
} {
  const listeners = new Set<(event: Event) => void>();
  let unsubCount = 0;
  const session = {
    id: sessionId,
    prompt: async (_input: unknown) => {
      for (const ev of script) {
        for (const fn of listeners) fn(ev);
      }
    },
    cancel: async () => undefined,
    onEvent: (fn: (event: Event) => void) => {
      listeners.add(fn);
      return () => {
        unsubCount += 1;
        listeners.delete(fn);
      };
    },
  } as unknown as Session;
  return { session, unsubscribeCount: () => unsubCount };
}

function makeHarness(session: Session): KimiHarness {
  return {
    auth: { status: async () => AUTHED_STATUS },
    createSession: async () => session,
    // Phase 14: server.newSession reads these for configOptions.
    getConfig: async () => ({
      providers: {},
      defaultModel: 'kimi-coder',
      models: makeModelsMap([{ id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: false }]),
    }),
  } as unknown as KimiHarness;
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

describe('AcpServer end-to-end happy path', () => {
  it('initialize advertises the documented capability matrix (PLAN D4)', async () => {
    // No session-side work here — just exercise the `initialize`
    // handshake to lock the capability surface. `createSession` would
    // throw if it were ever called.
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => {
        throw new Error('createSession should not be called from initialize-only test');
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    const response = await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    });

    // ACP `protocolVersion` is the integer the server agreed on; we
    // just assert it is a number — Phase 1 already pins the exact
    // negotiated value in version.test.ts.
    expect(typeof response.protocolVersion).toBe('number');

    expect(response.agentCapabilities).toMatchObject({
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: true,
      },
      mcpCapabilities: {
        http: true,
        sse: true,
      },
      sessionCapabilities: {
        list: {},
        resume: {},
      },
    });

    // Phase 10 does not supply agentInfo; authMethods advertises terminal-auth.
    expect(response.agentInfo).toBeUndefined();
    expect(response.authMethods).toHaveLength(1);
    expect(response.authMethods?.[0]).toMatchObject({
      id: 'login',
      type: 'terminal',
      args: ['--login'],
    });
  });

  it('drives the full happy path: initialize → newSession → prompt(end_turn)', async () => {
    const sessionId = 'sess-e2e-happy';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, [
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'echo ' } as Event,
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'hi' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event,
    ]);
    const harness = makeHarness(session);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    // 1. initialize
    const init = await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    expect(init.agentCapabilities?.mcpCapabilities?.http).toBe(true);

    // 2. session/new
    const newRes = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    expect(newRes.sessionId).toBe(sessionId);
    expect(typeof newRes.sessionId).toBe('string');
    expect(newRes.sessionId.length).toBeGreaterThan(0);
    // Phase 14 (PLAN D11) configOptions advertisement — replaces
    // Phase 12.1's dedicated `modes:` field on NewSessionResponse with
    // the spec's generic `configOptions:` surface. The dedicated field
    // must be gone, and the mode picker still reports `currentValue:
    // 'default'` (Phase 12.1 default mode).
    expect(newRes.modes).toBeUndefined();
    expect(
      newRes.configOptions?.find((o) => o.id === 'mode')?.currentValue,
    ).toBe('default');
    expect(newRes.configOptions?.length).toBe(2);

    // 3. session/prompt
    const promptRes = await client.prompt({
      sessionId,
      prompt: [textBlock('echo hi')],
    });
    expect(promptRes.stopReason).toBe('end_turn');

    // Give the agent side a tick to flush queued sessionUpdate writes
    // through the ndjson stream (matching session-prompt.test.ts:128).
    await new Promise((resolve) => setTimeout(resolve, 20));

    const promptOnlyUpdates = collecting.promptUpdates;
    expect(promptOnlyUpdates.length).toBeGreaterThanOrEqual(1);

    // At least one chunk must be non-empty text on this session id.
    const firstChunk = promptOnlyUpdates[0]?.update as {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
    };
    expect(firstChunk.sessionUpdate).toBe('agent_message_chunk');
    expect(firstChunk.content?.type).toBe('text');
    expect(firstChunk.content?.text).toBeTruthy();
    for (const note of promptOnlyUpdates) {
      expect(note.sessionId).toBe(sessionId);
    }

    // Listener was unsubscribed when turn.ended landed.
    expect(unsubscribeCount()).toBe(1);
  });

  it('cancel mid-stream resolves with stopReason cancelled', async () => {
    const sessionId = 'sess-e2e-cancel';
    // Scripted session that emits one delta, then a cancelled
    // turn.ended. The ACP `cancel` notification flows through the
    // adapter; we assert the prompt resolves with `cancelled` and
    // does not throw.
    const { session } = makeScriptedSession(sessionId, [
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'partial' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'cancelled' } as Event,
    ]);
    const harness = makeHarness(session);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    // Fire-and-forget the cancel notification before awaiting prompt.
    // The scripted session emits turn.ended(cancelled) regardless;
    // this verifies the cancel notification does not throw when the
    // session is known (sessionId resolves to the registered
    // AcpSession in `AcpServer.cancel`).
    const promptPromise = client.prompt({
      sessionId,
      prompt: [textBlock('long task')],
    });
    await client.cancel({ sessionId });
    const promptRes = await promptPromise;
    expect(promptRes.stopReason).toBe('cancelled');
  });
});
