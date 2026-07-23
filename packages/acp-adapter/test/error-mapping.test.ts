/**
 * Scenario: ACP session/prompt terminal failure mapping.
 * Responsibilities: map terminal outcomes and expose only safe JSON-RPC error data.
 * Wiring: real ACP connections over in-memory NDJSON; scripted SDK Session boundary.
 * Run: pnpm exec vitest run packages/acp-adapter/test/error-mapping.test.ts
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
 * Build the SDK boundary used by the wire-level tests. Its prompt either
 * rejects or emits a caller-supplied event sequence to active subscribers.
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

function connectToSession(
  session: Session,
): readonly [AgentSideConnection, ClientSideConnection] {
  const { agentStream, clientStream } = makeInMemoryStreamPair();
  const agent = new AgentSideConnection(
    (connection) => new AcpServer(makeHarnessWithSession(session), connection),
    agentStream,
  );
  const client = new ClientSideConnection(() => new StubClient(), clientStream);
  return [agent, client];
}

function makeFailedSession(
  sessionId: string,
  error?: KimiErrorPayload,
): ScriptedSession {
  return makeScriptedSession(sessionId, {
    script: [
      {
        type: 'turn.ended',
        sessionId,
        agentId: 'main',
        turnId: 1,
        reason: 'failed',
        error,
      } as Event,
    ],
  });
}

async function capturePromptError(
  client: ClientSideConnection,
  sessionId: string,
  text = 'hi',
): Promise<unknown> {
  try {
    await client.prompt({ sessionId, prompt: [textBlock(text)] });
  } catch (error) {
    return error;
  }
  throw new Error('Expected session/prompt to reject');
}

function exposedError(error: unknown): string | undefined {
  return error instanceof Error
    ? JSON.stringify({
        message: error.message,
        data: (error as Error & { data?: unknown }).data,
      })
    : JSON.stringify(error);
}

describe('ACP prompt failure mapping (terminal outcomes and safe error data)', () => {
  it.each([
    [ErrorCodes.AUTH_LOGIN_REQUIRED, 'Login required'],
    [ErrorCodes.PROVIDER_AUTH_ERROR, 'Provider returned 401'],
  ] as const)('rejects with authRequired when a failed event carries %s', async (code, message) => {
    const sessionId = `sess-${code}`;
    const { session } = makeFailedSession(sessionId, {
      code,
      message,
      retryable: false,
    });

    const [, client] = connectToSession(session);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await expect(
      client.prompt({ sessionId, prompt: [textBlock('hi')] }),
    ).rejects.toMatchObject({ code: -32000, data: undefined });
  });

  it('rejects with safe machine-readable data when a turn has a known non-auth failure', async () => {
    const sessionId = 'sess-context-overflow';
    const errorPayload: KimiErrorPayload = {
      code: ErrorCodes.CONTEXT_OVERFLOW,
      message: 'Context window exceeded',
      retryable: true,
    };
    const { session } = makeFailedSession(sessionId, errorPayload);

    const [, client] = connectToSession(session);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const caught = await capturePromptError(client, sessionId);

    expect(caught).toMatchObject({ code: -32603 });
    expect((caught as { data?: unknown }).data).toEqual({
      code: ErrorCodes.CONTEXT_OVERFLOW,
      retryable: true,
    });
  });

  it('settles a new prompt after the previous prompt ends with a failure', async () => {
    const sessionId = 'sess-consecutive-failures';
    const { session } = makeFailedSession(sessionId, {
      code: ErrorCodes.CONTEXT_OVERFLOW,
      message: 'Context window exceeded',
      retryable: true,
    });

    const [, client] = connectToSession(session);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await capturePromptError(client, sessionId);
    await expect(capturePromptError(client, sessionId, 'try again')).resolves.toMatchObject({
      code: -32603,
    });
  });

  it('unsubscribes from SDK events when a failed turn settles', async () => {
    const sessionId = 'sess-failure-cleanup';
    const { session, unsubscribeCount } = makeFailedSession(sessionId, {
      code: ErrorCodes.CONTEXT_OVERFLOW,
      message: 'Context window exceeded',
      retryable: true,
    });

    const [, client] = connectToSession(session);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await capturePromptError(client, sessionId);

    expect(unsubscribeCount()).toBe(1);
  });

  it('rejects a failed turn without inventing data when the SDK payload is missing', async () => {
    const sessionId = 'sess-failed-without-payload';
    const { session } = makeFailedSession(sessionId);

    const [, client] = connectToSession(session);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await expect(capturePromptError(client, sessionId)).resolves.toMatchObject({
      code: -32603,
      data: undefined,
    });
  });

  it('omits error data when a failed event carries an unrecognized code', async () => {
    const sessionId = 'sess-unknown-error-code';
    const privateMessage = 'unknown-error-message-must-not-cross-the-wire';
    const { session } = makeScriptedSession(sessionId, {
      script: [
        {
          type: 'turn.ended',
          sessionId,
          agentId: 'main',
          turnId: 1,
          reason: 'failed',
          error: {
            code: 'validation.failed',
            message: privateMessage,
            retryable: false,
          },
        } as Event,
      ],
    });

    const [, client] = connectToSession(session);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const caught = await capturePromptError(client, sessionId);

    expect(caught).toMatchObject({ code: -32603, data: undefined });
    const exposed = exposedError(caught);
    expect(exposed).not.toContain(privateMessage);
    expect(exposed).not.toContain('validation.failed');
  });

  it.each(['failed event', 'prompt rejection'] as const)(
    'omits private Kimi error codes and messages when delivered as a %s',
    async (delivery) => {
      const sessionId = `sess-private-kimi-error-${delivery.replace(' ', '-')}`;
      const privateMessage = 'private-kimi-error-message-must-not-cross-the-wire';
      const { session } =
        delivery === 'failed event'
          ? makeFailedSession(sessionId, {
              code: ErrorCodes.SESSION_INIT_FAILED,
              message: privateMessage,
              retryable: false,
            })
          : makeScriptedSession(sessionId, {
              rejectWith: new KimiError(ErrorCodes.SESSION_INIT_FAILED, privateMessage),
            });

      const [, client] = connectToSession(session);

      await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
      const caught = await capturePromptError(client, sessionId);

      expect(caught).toMatchObject({ code: -32603, data: undefined });
      const exposed = exposedError(caught);
      expect(exposed).not.toContain(ErrorCodes.SESSION_INIT_FAILED);
      expect(exposed).not.toContain(privateMessage);
    },
  );

  it.each(['failed event', 'prompt rejection'] as const)(
    'exposes the same canonical safe data when a provider failure arrives as a %s',
    async (delivery) => {
      const sessionId = `sess-provider-api-error-${delivery.replace(' ', '-')}`;
      const privateMessage = 'provider-response-body-must-not-cross-the-wire';
      const privateRequestId = 'request-id-must-not-cross-the-wire';
      const details = {
        statusCode: 403,
        requestId: privateRequestId,
        providerBody: { account: 'private-account-data' },
      };
      const { session } =
        delivery === 'failed event'
          ? makeFailedSession(sessionId, {
              code: ErrorCodes.PROVIDER_API_ERROR,
              message: privateMessage,
              name: 'PrivateProviderErrorName',
              details,
              retryable: true,
            })
          : makeScriptedSession(sessionId, {
              rejectWith: new KimiError(ErrorCodes.PROVIDER_API_ERROR, privateMessage, { details }),
            });

      const [, client] = connectToSession(session);

      await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
      const caught = await capturePromptError(client, sessionId);

      expect(caught).toMatchObject({ code: -32603 });
      expect((caught as { data?: unknown }).data).toEqual({
        code: ErrorCodes.PROVIDER_API_ERROR,
        retryable: false,
        statusCode: 403,
      });
      const exposed = exposedError(caught);
      expect(exposed).not.toContain(privateMessage);
      expect(exposed).not.toContain(privateRequestId);
      expect(exposed).not.toContain('PrivateProviderErrorName');
      expect(exposed).not.toContain('private-account-data');
    },
  );

  it.each([99, 600, 403.5, '403', Number.NaN])(
    'omits statusCode when provider status %j is not a valid HTTP status',
    async (statusCode) => {
      const sessionId = 'sess-invalid-provider-status';
      const { session } = makeFailedSession(sessionId, {
        code: ErrorCodes.PROVIDER_API_ERROR,
        message: 'Provider request failed',
        details: { statusCode },
        retryable: false,
      });

      const [, client] = connectToSession(session);

      await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
      const caught = await capturePromptError(client, sessionId);

      expect(caught).toMatchObject({ code: -32603 });
      expect((caught as { data?: unknown }).data).toEqual({
        code: ErrorCodes.PROVIDER_API_ERROR,
        retryable: false,
      });
    },
  );

  it('rejects with authRequired when session.prompt rejects with an auth code', async () => {
    const sessionId = 'sess-prompt-rejects-auth';
    const { session } = makeScriptedSession(sessionId, {
      rejectWith: new KimiError(ErrorCodes.PROVIDER_AUTH_ERROR, 'Provider 401'),
    });

    const [, client] = connectToSession(session);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await expect(
      client.prompt({ sessionId, prompt: [textBlock('hi')] }),
    ).rejects.toMatchObject({ code: -32000, data: undefined });
  });

  it('rejects without internal details when session.prompt throws a generic error', async () => {
    const sessionId = 'sess-generic-error';
    const stackTip = 'super-secret-stack-frame-do-not-leak';
    const generic = new Error('boom internal');
    generic.stack = `Error: boom internal\n    at ${stackTip} (secret.ts:1:1)`;
    const { session } = makeScriptedSession(sessionId, { rejectWith: generic });

    const [, client] = connectToSession(session);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const captured = await capturePromptError(client, sessionId);
    expect(captured).toMatchObject({
      code: -32603,
      data: undefined,
      message: 'Internal error: session prompt failed',
    });
    // Error.message is non-enumerable, so JSON.stringify(error) alone would
    // miss a leak. Reconstruct the observable wire fields explicitly.
    const exposed = exposedError(captured);
    expect(exposed).not.toContain(stackTip);
    expect(exposed).not.toContain('boom internal');
  });

  it('returns cancelled when the turn ends after cancellation', async () => {
    const sessionId = 'sess-cancel-regression';
    const { session } = makeScriptedSession(sessionId, {
      script: [
        { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'cancelled' } as Event,
      ],
    });

    const [, client] = connectToSession(session);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const response = await client.prompt({ sessionId, prompt: [textBlock('hi')] });
    expect(response.stopReason).toBe('cancelled');
  });

  it('returns refusal when a prompt hook blocks the turn', async () => {
    const sessionId = 'sess-blocked';
    const { session } = makeScriptedSession(sessionId, {
      script: [
        {
          type: 'turn.ended',
          sessionId,
          agentId: 'main',
          turnId: 1,
          reason: 'blocked',
        } as Event,
      ],
    });

    const [, client] = connectToSession(session);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const response = await client.prompt({ sessionId, prompt: [textBlock('hi')] });

    expect(response.stopReason).toBe('refusal');
  });

  it.each(['failed event', 'prompt rejection'] as const)(
    'returns refusal when provider filtering arrives as a %s',
    async (delivery) => {
      const sessionId = `sess-filtered-${delivery.replace(' ', '-')}`;
      const message = 'Provider safety policy blocked the response.';
      const { session } =
        delivery === 'failed event'
          ? makeFailedSession(sessionId, {
              code: ErrorCodes.PROVIDER_FILTERED,
              message,
              name: 'ProviderFilteredError',
              retryable: false,
            })
          : makeScriptedSession(sessionId, {
              rejectWith: new KimiError(ErrorCodes.PROVIDER_FILTERED, message),
            });

      const [, client] = connectToSession(session);

      await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
      const response = await client.prompt({ sessionId, prompt: [textBlock('hi')] });
      expect(response.stopReason).toBe('refusal');
    },
  );
});
