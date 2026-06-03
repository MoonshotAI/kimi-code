import { describe, expect, it } from 'vitest';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type NewSessionRequest,
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
    throw new Error('StubClient.requestPermission should not be called in session-new test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in session-new test');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in session-new test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in session-new test');
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

interface CapturedCall {
  options: { workDir: string };
}

function makeHarness(sessionId: string, captured: CapturedCall[]): {
  harness: KimiHarness;
  fakeSession: Session;
} {
  const fakeSession = {
    id: sessionId,
    prompt: async () => undefined,
    cancel: async () => undefined,
    onEvent: () => () => undefined,
  } as unknown as Session;
  const harness = {
    auth: { status: async () => AUTHED_STATUS },
    createSession: async (options: { workDir: string }) => {
      captured.push({ options });
      return fakeSession;
    },
    // Phase 14: server.newSession reads these to assemble configOptions.
    getConfig: async () => ({
      providers: {},
      defaultModel: 'kimi-coder',
      models: makeModelsMap([
        { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: true },
        { id: 'kimi-plain', name: 'Kimi Plain', thinkingSupported: false },
      ]),
    }),
  } as unknown as KimiHarness;
  return { harness, fakeSession };
}

describe('AcpServer session/new', () => {
  it('calls harness.createSession with workDir from ACP cwd and returns the new sessionId', async () => {
    const captured: CapturedCall[] = [];
    const { harness } = makeHarness('sess-42', captured);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    let server: AcpServer | undefined;
    new AgentSideConnection((c) => {
      server = new AcpServer(harness, c);
      return server;
    }, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const request: NewSessionRequest = {
      cwd: '/tmp/work',
      mcpServers: [],
    };

    const response = await client.newSession(request);

    expect(response.sessionId).toBe('sess-42');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.options).toEqual({ workDir: '/tmp/work', mcpServers: {} });

    // The wrapper is stashed in the map under the same id we returned to
    // the client (so Phase 3.3/3.4 can look it up by sessionId).
    expect(server?.getSession('sess-42')?.id).toBe('sess-42');
  });

  it('returns a distinct sessionId per call (one createSession per request)', async () => {
    const captured: CapturedCall[] = [];
    let counter = 0;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async (options: { workDir: string }) => {
        counter += 1;
        const id = `sess-${counter}`;
        captured.push({ options });
        return {
          id,
          prompt: async () => undefined,
          cancel: async () => undefined,
          onEvent: () => () => undefined,
        } as unknown as Session;
      },
      // Phase 14: server.newSession reads these to assemble configOptions.
      getConfig: async () => ({ providers: {}, models: {} }),
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const first = await client.newSession({ cwd: '/tmp/a', mcpServers: [] });
    const second = await client.newSession({ cwd: '/tmp/b', mcpServers: [] });

    expect(first.sessionId).toBe('sess-1');
    expect(second.sessionId).toBe('sess-2');
    expect(captured).toHaveLength(2);
    expect(captured[0]?.options).toEqual({ workDir: '/tmp/a', mcpServers: {} });
    expect(captured[1]?.options).toEqual({ workDir: '/tmp/b', mcpServers: {} });
  });

  it('advertises configOptions (PLAN D11 + Phase 15 thinking toggle) — model + thinking + mode under the unified SessionConfigOption surface', async () => {
    const captured: CapturedCall[] = [];
    const { harness } = makeHarness('sess-modes', captured);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    // Phase 14 (PLAN D11) replaces Phase 12's dedicated `modes:` field
    // with the spec's generic `configOptions:` surface — model + mode
    // are now sibling SessionConfigOption entries on the same dropdown
    // channel. Positive proof the legacy field is gone:
    expect(response.modes).toBeUndefined();

    expect(response.configOptions).toBeDefined();
    // Default model is `kimi-coder` (thinkingSupported), so the toggle is
    // visible between model and mode → 3 options total.
    expect(response.configOptions).toHaveLength(3);
    const [modelOpt, thinkingOpt, modeOpt] = response.configOptions!;
    expect(modelOpt!.id).toBe('model');
    expect(thinkingOpt!.id).toBe('thinking');
    expect(modeOpt!.id).toBe('mode');

    // Thinking picker — Phase 16 reshaped this to a 2-entry select
    // (`off` / `on`) so Zed renders it; the underlying axis is still
    // binary. `thought_level` category, currentValue='off' (no
    // defaultThinking set on the harness fixture).
    if (thinkingOpt!.type !== 'select') {
      throw new Error('thinking option must be a select');
    }
    expect(thinkingOpt!.category).toBe('thought_level');
    expect(thinkingOpt!.currentValue).toBe('off');

    // Mode picker — locked taxonomy (PLAN D9). Same order assertions
    // the Phase 12 test made, just rephrased against the new shape.
    if (modeOpt!.type !== 'select') {
      throw new Error('mode option must be a select');
    }
    expect(modeOpt!.currentValue).toBe('default');
    expect(modeOpt!.options).toHaveLength(4);
    const modeIds = modeOpt!.options.map((o) => 'value' in o ? o.value : '');
    expect(modeIds).toEqual(['default', 'plan', 'auto', 'yolo']);
    for (const entry of modeOpt!.options) {
      if ('value' in entry) {
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(typeof entry.description).toBe('string');
        expect((entry.description ?? '').length).toBeGreaterThan(0);
      }
    }

    // Model picker — Phase 15 removed `,thinking` variant rows: each
    // catalog entry surfaces exactly one option. Fixture has 2 entries.
    if (modelOpt!.type !== 'select') {
      throw new Error('model option must be a select');
    }
    expect(modelOpt!.currentValue).toBe('kimi-coder');
    expect(modelOpt!.options).toHaveLength(2);
    const modelValues = modelOpt!.options.map((o) => 'value' in o ? o.value : '');
    expect(modelValues).toEqual(['kimi-coder', 'kimi-plain']);
  });
});
