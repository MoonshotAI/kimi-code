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
import {
  ErrorCodes,
  KimiError,
  type Event,
  type KimiHarness,
  type Session,
} from '@moonshot-ai/kimi-code-sdk';

import { turnStopReasonToAcpStopReason } from '../src/events-map';
import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in error-mapping test');
  }
  // Notifications are best-effort; let them no-op so the agent side
  // doesn't backpressure on a missing handler.
  async sessionUpdate(_n: SessionNotification): Promise<void> {}
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in error-mapping test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in error-mapping test');
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

interface ScriptedSession {
  session: Session;
  unsubscribeCount: () => number;
}

/**
 * Build a fake `Session` whose `prompt()` either rejects with a
 * caller-supplied error OR fans out a pre-recorded event sequence
 * through any subscribed listener — covering the two distinct error
 * paths that {@link AcpSession.prompt} routes through `mapPromptError`:
 * a synchronous rejection from `session.prompt(...)` (which carries
 * auth-coded failures under the engine contract) and a streamed
 * `session.turn.ended` `stop_reason`.
 */
function makeScriptedSession(
  sessionId: string,
  opts: { script?: readonly Event[]; rejectWith?: Error },
): ScriptedSession {
  const listeners = new Set<(event: Event) => void>();
  let unsubCount = 0;
  const session = {
    id: sessionId,
    prompt: async (_input: unknown) => {
      if (opts.rejectWith) throw opts.rejectWith;
      if (opts.script) {
        for (const ev of opts.script) {
          for (const fn of listeners) fn(ev);
        }
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

function makeHarnessWithSession(session: Session): KimiHarness {
  return {
    auth: { status: async () => AUTHED_STATUS },
    createSession: async () => session,
  } as unknown as KimiHarness;
}

describe('AcpServer error mapping', () => {
  it('resolves with end_turn when session.turn.ended carries a non-terminal stop_reason (MaxTokens)', async () => {
    // MaxTokens / Paused have no ACP `StopReason` variant — the adapter
    // resolves `end_turn` so the client stays unblocked (ACP spec
    // discourages signaling errors through `stopReason`).
    const sessionId = 'sess-max-tokens';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, {
      script: [
        {
          type: 'session.turn.ended',
          sessionId,
          agentId: 'main',
          turn_id: 1,
          stop_reason: 'MaxTokens',
          steps: 1,
        } as Event,
      ],
    });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarnessWithSession(session), c), agentStream);
    const client = new ClientSideConnection(() => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const response = await client.prompt({ sessionId, prompt: [textBlock('hi')] });
    expect(response.stopReason).toBe('end_turn');
    expect(unsubscribeCount()).toBe(1);
  });

  it('maps a synchronous session.prompt rejection carrying an auth code to authRequired (-32000)', async () => {
    const sessionId = 'sess-prompt-rejects-auth';
    const { session } = makeScriptedSession(sessionId, {
      rejectWith: new KimiError(ErrorCodes.PROVIDER_AUTH_ERROR, 'Provider 401'),
    });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarnessWithSession(session), c), agentStream);
    const client = new ClientSideConnection(() => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await expect(
      client.prompt({ sessionId, prompt: [textBlock('hi')] }),
    ).rejects.toMatchObject({ code: -32000 });
  });

  it('maps a generic session.prompt rejection to internalError (-32603) without leaking the stack', async () => {
    const sessionId = 'sess-generic-error';
    const stackTip = 'super-secret-stack-frame-do-not-leak';
    const generic = new Error('boom internal');
    generic.stack = `Error: boom internal\n    at ${stackTip} (secret.ts:1:1)`;
    const { session } = makeScriptedSession(sessionId, { rejectWith: generic });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarnessWithSession(session), c), agentStream);
    const client = new ClientSideConnection(() => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    let captured: unknown;
    try {
      await client.prompt({ sessionId, prompt: [textBlock('hi')] });
    } catch (err) {
      captured = err;
    }
    expect(captured).toMatchObject({ code: -32603 });
    // Privacy guarantee: the JSON-RPC error response carries only the
    // `code` (and optionally a structured `data`); neither the
    // original stack nor the raw message crosses the wire. We assert
    // negatively rather than on the canonical message because the
    // ACP SDK strips the message from the deserialized client-side
    // error and only retains the code.
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(stackTip);
    expect(serialized).not.toContain('boom internal');
  });

  it('maps an Aborted stop_reason to ACP stopReason cancelled', async () => {
    const sessionId = 'sess-cancel-regression';
    const { session } = makeScriptedSession(sessionId, {
      script: [
        {
          type: 'session.turn.ended',
          sessionId,
          agentId: 'main',
          turn_id: 1,
          stop_reason: 'Aborted',
          steps: 1,
        } as Event,
      ],
    });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarnessWithSession(session), c), agentStream);
    const client = new ClientSideConnection(() => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const response = await client.prompt({ sessionId, prompt: [textBlock('hi')] });
    expect(response.stopReason).toBe('cancelled');
  });

  it('maps engine stop_reasons to ACP stopReason', () => {
    // ACP has a native `refusal` stop reason that matches the engine's
    // `Filtered` (provider safety block); mapping it to anything else
    // (e.g. end_turn) would let the client mistake the block for a
    // clean turn.
    expect(turnStopReasonToAcpStopReason('EndTurn')).toBe('end_turn');
    expect(turnStopReasonToAcpStopReason('MaxTokens')).toBe('end_turn');
    expect(turnStopReasonToAcpStopReason('Paused')).toBe('end_turn');
    expect(turnStopReasonToAcpStopReason('Aborted')).toBe('cancelled');
    expect(turnStopReasonToAcpStopReason('Filtered')).toBe('refusal');
  });

  it('resolves with refusal when session.turn.ended carries stop_reason Filtered', async () => {
    const sessionId = 'sess-filtered';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, {
      script: [
        {
          type: 'session.turn.ended',
          sessionId,
          agentId: 'main',
          turn_id: 1,
          stop_reason: 'Filtered',
          steps: 1,
        } as Event,
      ],
    });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarnessWithSession(session), c), agentStream);
    const client = new ClientSideConnection(() => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const response = await client.prompt({ sessionId, prompt: [textBlock('hi')] });
    expect(response.stopReason).toBe('refusal');
    expect(unsubscribeCount()).toBe(1);
  });
});
