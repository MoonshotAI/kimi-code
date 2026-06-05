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
import { KimiError, ErrorCodes, type Event, type KimiHarness, type Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS, UNAUTHED_STATUS, makeModelsMap } from './_helpers/harness-stubs';

/**
 * Tests for the ACP `session/resume` handler (gap-4.3). Mirrors the
 * shape of `session-load.test.ts` because the two handlers share
 * `setupSessionFromExisting`; the assertions below pin the
 * `resumeSession`-specific contract:
 *
 *  - auth gate parity with newSession / loadSession,
 *  - configOptions reflects the resumed model + thinking projection,
 *  - NO history replay (the ONE difference vs loadSession),
 *  - SDK `session.not_found` maps to ACP invalid_params,
 *  - AcpSession is registered so subsequent calls can locate it.
 */

class CapturingClient implements Client {
  readonly updates: SessionNotification[] = [];

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('CapturingClient.requestPermission should not be called in session-resume test');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('CapturingClient.writeTextFile should not be called in session-resume test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CapturingClient.readTextFile should not be called in session-resume test');
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
 * Build a fake {@link Session} whose `getResumeState` reports the given
 * main-agent config so the server's resume-state projection (modelAlias
 * → currentModelId, thinkingLevel → currentThinkingEnabled) gets a
 * deterministic input. History is empty because `resumeSession` does
 * not replay anyway — the field is kept for API parity with the
 * matching session-load helper.
 */
function makeSessionWithMainConfig(
  sessionId: string,
  mainConfig?: { modelAlias?: string; thinkingLevel?: string },
): Session {
  return {
    id: sessionId,
    cancel: async () => undefined,
    prompt: async () => undefined,
    onEvent: (_fn: (event: Event) => void) => () => undefined,
    setApprovalHandler: () => undefined,
    getResumeState: () =>
      mainConfig
        ? {
            agents: {
              main: {
                config: mainConfig,
                context: { history: [], tokenCount: 0 },
              },
            },
          }
        : {
            agents: {
              main: {
                context: { history: [], tokenCount: 0 },
              },
            },
          },
  } as unknown as Session;
}

function makeHarness(opts: {
  hasUsableToken?: boolean;
  session?: Session;
  resumeError?: Error;
}): KimiHarness {
  const authed = opts.hasUsableToken ?? true;
  return {
    auth: {
      status: async () => (authed ? AUTHED_STATUS : UNAUTHED_STATUS),
    },
    resumeSession: async (_input: { id: string }) => {
      if (opts.resumeError) throw opts.resumeError;
      if (!opts.session) throw new Error('test harness has no session configured');
      return opts.session;
    },
    // Phase 14: server.resumeSession (via setupSessionFromExisting) reads
    // these to assemble configOptions. `kimi-coder` opts in to thinking
    // via `capabilities: ['thinking']`; `kimi-plain` stays off.
    getConfig: async () => ({
      providers: {},
      defaultModel: 'kimi-coder',
      models: makeModelsMap([
        { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: true },
        { id: 'kimi-plain', name: 'Kimi Plain', thinkingSupported: false },
      ]),
    }),
  } as unknown as KimiHarness;
}

describe('AcpServer.resumeSession', () => {
  it('auth gate rejects with authRequired (-32000) when no token', async () => {
    const harness = makeHarness({ hasUsableToken: false });
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const clientConn = new ClientSideConnection((_a) => new CapturingClient(), clientStream);

    await expect(
      clientConn.resumeSession({ sessionId: 'sess-x', cwd: '/tmp/x', mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32000 });
  });

  it('returns configOptions matching the resumed session model + mode + thinking', async () => {
    const sessionId = 'sess-resume-model';
    // Resume state reports kimi-plain (thinking unsupported) so we can
    // assert the projection picks the alias from main-agent config and
    // that thinking flips to `on` because `thinkingLevel='high'` is
    // non-`off` per the server's boolean projection. The mode currentValue
    // is always `default` because mode is session-scoped (PLAN D9).
    //
    // We use kimi-coder so the thinking option is rendered (kimi-plain
    // would suppress it via `thinkingSupported: false`).
    const session = makeSessionWithMainConfig(sessionId, {
      modelAlias: 'kimi-coder',
      thinkingLevel: 'high',
    });
    const harness = makeHarness({ hasUsableToken: true, session });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const clientConn = new ClientSideConnection((_a) => new CapturingClient(), clientStream);

    const response = await clientConn.resumeSession({
      sessionId,
      cwd: '/tmp/x',
      mcpServers: [],
    });

    expect(response.configOptions).toBeDefined();
    expect(response.configOptions).toHaveLength(3);

    const modelOpt = response.configOptions!.find((o) => o.id === 'model');
    const thinkingOpt = response.configOptions!.find((o) => o.id === 'thinking');
    const modeOpt = response.configOptions!.find((o) => o.id === 'mode');
    expect(modelOpt).toBeDefined();
    expect(thinkingOpt).toBeDefined();
    expect(modeOpt).toBeDefined();

    if (modelOpt!.type !== 'select') throw new Error('model option must be a select');
    expect(modelOpt!.currentValue).toBe('kimi-coder');

    if (thinkingOpt!.type !== 'select') throw new Error('thinking option must be a select');
    // `thinkingLevel='high'` → boolean projection picks the `on` slot.
    expect(thinkingOpt!.currentValue).toBe('on');

    if (modeOpt!.type !== 'select') throw new Error('mode option must be a select');
    // Mode is session-scoped and not persisted → resumed sessions
    // start at `default`.
    expect(modeOpt!.currentValue).toBe('default');
  });

  it('does NOT emit replay session/update notifications (only the available_commands_update)', async () => {
    const sessionId = 'sess-no-replay';
    // Use a session that WOULD replay 2 turns if loadSession had been
    // called — pass a populated history (the server ignores it for
    // resume because `replayHistory()` is not invoked).
    const session = {
      id: sessionId,
      cancel: async () => undefined,
      prompt: async () => undefined,
      onEvent: (_fn: (event: Event) => void) => () => undefined,
      setApprovalHandler: () => undefined,
      getResumeState: () => ({
        agents: {
          main: {
            context: {
              history: [
                { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
                { role: 'assistant', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
              ],
              tokenCount: 0,
            },
          },
        },
      }),
    } as unknown as Session;
    const harness = makeHarness({ hasUsableToken: true, session });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new CapturingClient();
    const clientConn = new ClientSideConnection((_a) => client, clientStream);

    await clientConn.resumeSession({ sessionId, cwd: '/tmp/x', mcpServers: [] });

    // Exactly ONE notification: the available_commands_update. Compare
    // to session-load.test.ts which sees 1 update per history turn
    // PLUS the available_commands_update.
    expect(client.updates).toHaveLength(1);
    expect((client.updates[0]!.update as { sessionUpdate?: string }).sessionUpdate).toBe(
      'available_commands_update',
    );
  });

  it('maps SDK session.not_found error to invalidParams (-32602)', async () => {
    const harness = makeHarness({
      hasUsableToken: true,
      resumeError: new KimiError(ErrorCodes.SESSION_NOT_FOUND, 'Session "ghost" was not found'),
    });
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const clientConn = new ClientSideConnection((_a) => new CapturingClient(), clientStream);

    await expect(
      clientConn.resumeSession({ sessionId: 'ghost', cwd: '/tmp/x', mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('registers the AcpSession under its id so subsequent calls can locate it', async () => {
    const sessionId = 'sess-resume-registered';
    const session = makeSessionWithMainConfig(sessionId);
    const harness = makeHarness({ hasUsableToken: true, session });
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    let server: AcpServer | undefined;
    new AgentSideConnection((c) => {
      server = new AcpServer(harness, c);
      return server;
    }, agentStream);
    const clientConn = new ClientSideConnection((_a) => new CapturingClient(), clientStream);

    await clientConn.resumeSession({ sessionId, cwd: '/tmp/x', mcpServers: [] });

    expect(server?.getSession(sessionId)?.id).toBe(sessionId);
  });
});
