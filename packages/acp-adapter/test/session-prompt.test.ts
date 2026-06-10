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
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class CollectingClient implements Client {
  readonly updates: SessionNotification[] = [];

  /**
   * Updates produced AFTER `session/new` returns. Phase 9.3 makes
   * `newSession` emit exactly one `available_commands_update` on
   * creation; tests in this file pre-date that emission and assert
   * only on prompt-driven updates, so we filter that variant out.
   */
  get promptUpdates(): readonly SessionNotification[] {
    return this.updates.filter(
      (n) =>
        (n.update as { sessionUpdate?: string }).sessionUpdate !==
        'available_commands_update',
    );
  }

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('CollectingClient.requestPermission should not be called in prompt test');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('CollectingClient.writeTextFile should not be called in prompt test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CollectingClient.readTextFile should not be called in prompt test');
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
 * Construct a fake Session whose `prompt()` synchronously emits a
 * pre-recorded sequence of `Event`s through any subscribed listener.
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
      // Emit asynchronously so the caller has time to set `settled`
      // before the first event lands (matches real RPC ordering).
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

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

describe('AcpServer session/prompt', () => {
  it('streams two AssistantDelta events as agent_message_chunk updates and resolves with end_turn', async () => {
    const sessionId = 'sess-A';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, [
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'hel' } as Event,
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'lo' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const response = await client.prompt({
      sessionId,
      prompt: [textBlock('hi')],
    });

    expect(response.stopReason).toBe('end_turn');

    // Give the agent side a tick to flush queued sessionUpdate writes
    // through the ndjson stream.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(collecting.promptUpdates).toHaveLength(2);
    for (const note of collecting.promptUpdates) {
      expect(note.sessionId).toBe(sessionId);
    }
    const first = collecting.promptUpdates[0]?.update;
    const second = collecting.promptUpdates[1]?.update;
    expect(first).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hel' },
    });
    expect(second).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'lo' },
    });

    // Listener must be unsubscribed exactly once after turn.ended fires.
    expect(unsubscribeCount()).toBe(1);
  });

  it('resolves with cancelled stopReason when turn.ended reason is cancelled', async () => {
    const sessionId = 'sess-B';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, [
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'partial' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'cancelled' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const response = await client.prompt({
      sessionId,
      prompt: [textBlock('do something long')],
    });

    expect(response.stopReason).toBe('cancelled');
    expect(unsubscribeCount()).toBe(1);
  });

  it('rejects prompt with invalid_params when sessionId is unknown', async () => {
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => {
        throw new Error('createSession should not be called for unknown-id test');
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await expect(
      client.prompt({ sessionId: 'sess-does-not-exist', prompt: [textBlock('hi')] }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('rejects prompt (and unsubscribes) when underlying session.prompt rejects', async () => {
    const sessionId = 'sess-C';
    const listeners = new Set<(event: Event) => void>();
    let unsubCount = 0;
    const session = {
      id: sessionId,
      prompt: async (_input: unknown) => {
        throw new Error('boom from session.prompt');
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

    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    await expect(
      client.prompt({ sessionId, prompt: [textBlock('hi')] }),
    ).rejects.toBeDefined();
    expect(unsubCount).toBe(1);
  });

  it('rejects prompt when the SDK emits a turn.agent_busy error event', async () => {
    const sessionId = 'sess-busy';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, [
      {
        type: 'error',
        sessionId,
        agentId: 'main',
        code: 'turn.agent_busy',
        message: 'Cannot launch a new turn while another turn (ID 0) is active',
        details: { turnId: 0 },
        retryable: true,
      } as unknown as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    await expect(
      client.prompt({ sessionId, prompt: [textBlock('hi')] }),
    ).rejects.toMatchObject({ code: -32600 });
    expect(unsubscribeCount()).toBe(1);
  });

  it('does not reject an already-started prompt when a later prompt gets busy', async () => {
    const sessionId = 'sess-busy-active';
    const listeners = new Set<(event: Event) => void>();
    let unsubCount = 0;
    let promptCall = 0;
    let firstError: unknown;
    let resolveFirstTurn: (() => void) | undefined;
    const firstTurn = new Promise<void>((resolve) => {
      resolveFirstTurn = () => {
        resolve();
      };
    });
    void firstTurn.then(() => {
      for (const fn of listeners) {
        fn({ type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event);
      }
    });
    const session = {
      id: sessionId,
      prompt: async (_input: unknown) => {
        promptCall += 1;
        await Promise.resolve();
        if (promptCall === 1) {
          for (const fn of listeners) {
            fn({
              type: 'turn.started',
              sessionId,
              agentId: 'main',
              turnId: 1,
              origin: { kind: 'user' },
            } as unknown as Event);
          }
          await firstTurn;
          return;
        }
        for (const fn of listeners) {
          fn({
            type: 'error',
            sessionId,
            agentId: 'main',
            code: 'turn.agent_busy',
            message: 'Cannot launch a new turn while another turn (ID 1) is active',
            details: { turnId: 1 },
            retryable: true,
          } as unknown as Event);
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
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const firstPrompt = client
      .prompt({ sessionId, prompt: [textBlock('active')] })
      .then(
        (response) => response,
        (error) => {
          firstError = error;
          throw error;
        },
      );
    await Promise.resolve();

    await expect(
      client.prompt({ sessionId, prompt: [textBlock('busy')] }),
    ).rejects.toMatchObject({ code: -32600 });
    expect(firstError).toBeUndefined();

    resolveFirstTurn?.();
    await expect(firstPrompt).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(unsubCount).toBe(2);
  });

  it('ignores a subagent turn.ended and resolves on the main agent turn.ended', async () => {
    const sessionId = 'sess-subagent';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, [
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'a' } as Event,
      { type: 'assistant.delta', sessionId, agentId: 'sub-1', turnId: 99, delta: 'leak' } as Event,
      { type: 'thinking.delta', sessionId, agentId: 'sub-1', turnId: 99, delta: 'leak' } as Event,
      {
        type: 'tool.call.started',
        sessionId,
        agentId: 'sub-1',
        turnId: 99,
        toolCallId: 'sub-tool',
        name: 'Shell',
        args: { command: 'echo leak' },
      } as Event,
      {
        type: 'tool.result',
        sessionId,
        agentId: 'sub-1',
        turnId: 99,
        toolCallId: 'sub-tool',
        output: 'leak',
      } as Event,
      // A subagent finishes its own turn while the main turn is still
      // running. Pre-fix this would resolve the parent prompt with
      // `end_turn` and leak the listener; post-fix it must be ignored.
      {
        type: 'turn.ended',
        sessionId,
        agentId: 'sub-1',
        turnId: 99,
        reason: 'completed',
      } as Event,
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'b' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const response = await client.prompt({
      sessionId,
      prompt: [textBlock('hi')],
    });

    expect(response.stopReason).toBe('end_turn');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collecting.promptUpdates).toHaveLength(2);
    expect(unsubscribeCount()).toBe(1);
  });
});
