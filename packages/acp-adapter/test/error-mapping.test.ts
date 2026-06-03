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
  type KimiErrorPayload,
  type KimiHarness,
  type Session,
} from '@moonshot-ai/kimi-code-sdk';

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
 * paths that {@link AcpSession.prompt} routes through
 * `mapPromptError` / `authRequiredFromPayload`.
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
  it('maps a turn.ended failed event with auth.login_required to authRequired (-32000)', async () => {
    const sessionId = 'sess-auth-payload';
    const errorPayload: KimiErrorPayload = {
      code: ErrorCodes.AUTH_LOGIN_REQUIRED,
      message: 'Login required',
      retryable: false,
    };
    const { session } = makeScriptedSession(sessionId, {
      script: [
        {
          type: 'turn.ended',
          sessionId,
          agentId: 'main',
          turnId: 1,
          reason: 'failed',
          error: errorPayload,
        } as Event,
      ],
    });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarnessWithSession(session), c), agentStream);
    const client = new ClientSideConnection(() => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await expect(
      client.prompt({ sessionId, prompt: [textBlock('hi')] }),
    ).rejects.toMatchObject({ code: -32000 });
  });

  it('maps a turn.ended failed event with provider.auth_error to authRequired (-32000)', async () => {
    const sessionId = 'sess-provider-auth';
    const errorPayload: KimiErrorPayload = {
      code: ErrorCodes.PROVIDER_AUTH_ERROR,
      message: 'Provider returned 401',
      retryable: false,
    };
    const { session } = makeScriptedSession(sessionId, {
      script: [
        {
          type: 'turn.ended',
          sessionId,
          agentId: 'main',
          turnId: 1,
          reason: 'failed',
          error: errorPayload,
        } as Event,
      ],
    });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarnessWithSession(session), c), agentStream);
    const client = new ClientSideConnection(() => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await expect(
      client.prompt({ sessionId, prompt: [textBlock('hi')] }),
    ).rejects.toMatchObject({ code: -32000 });
  });

  it('resolves with end_turn when turn.ended fails with a non-auth code (log-only path)', async () => {
    // Non-auth failures stay on the existing log-and-resolve path so
    // the client is unblocked. The error appears in the agent log;
    // `stopReason` does not signal it (ACP spec discourages errors-via-stopReason).
    const sessionId = 'sess-context-overflow';
    const errorPayload: KimiErrorPayload = {
      code: ErrorCodes.CONTEXT_OVERFLOW,
      message: 'Context window exceeded',
      retryable: true,
    };
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, {
      script: [
        {
          type: 'turn.ended',
          sessionId,
          agentId: 'main',
          turnId: 1,
          reason: 'failed',
          error: errorPayload,
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

  it('still maps reason: cancelled to stop_reason: cancelled (Phase 3/4 regression guard)', async () => {
    const sessionId = 'sess-cancel-regression';
    const { session } = makeScriptedSession(sessionId, {
      script: [
        { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'cancelled' } as Event,
      ],
    });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarnessWithSession(session), c), agentStream);
    const client = new ClientSideConnection(() => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const response = await client.prompt({ sessionId, prompt: [textBlock('hi')] });
    expect(response.stopReason).toBe('cancelled');
  });
});
