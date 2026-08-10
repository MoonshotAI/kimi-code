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
import type { KimiConfig, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS, UNAUTHED_STATUS } from './_helpers/harness-stubs';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in auth-gate test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in auth-gate test');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in auth-gate test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in auth-gate test');
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

function startAcpServer(
  harness: KimiHarness,
  agentStream: ReturnType<typeof ndJsonStream>,
): AgentSideConnection {
  return new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
}

function makeHarnessWithToken(hasToken: boolean): KimiHarness {
  return {
    auth: {
      status: async () => (hasToken ? AUTHED_STATUS : UNAUTHED_STATUS),
    },
  } as unknown as KimiHarness;
}

function configuredModelConfig(provider: KimiConfig['providers'][string]): KimiConfig {
  return {
    providers: { local: provider },
    defaultModel: 'local/gpt',
    models: {
      'local/gpt': {
        provider: 'local',
        model: 'gpt-4o',
        maxContextSize: 128000,
      },
    },
  };
}

function makeHarnessWithConfig(config: KimiConfig, hasToken = false): {
  harness: KimiHarness;
  createCalls: Array<{ id?: string; workDir: string }>;
} {
  const createCalls: Array<{ id?: string; workDir: string }> = [];
  const harness = {
    auth: {
      status: async () => (hasToken ? AUTHED_STATUS : UNAUTHED_STATUS),
    },
    getConfig: async () => config,
    createSession: async (options: { id?: string; workDir: string }) => {
      createCalls.push(options);
      return {
        id: options.id ?? 'session-fallback',
        prompt: async () => undefined,
        cancel: async () => undefined,
        onEvent: () => () => undefined,
      } as unknown as Session;
    },
  } as unknown as KimiHarness;
  return { harness, createCalls };
}

describe('AcpServer auth gate', () => {
  it('rejects session/new with auth_required (-32000) when no token', async () => {
    const harness = makeHarnessWithToken(false);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const request: NewSessionRequest = {
      cwd: '/tmp/x',
      mcpServers: [],
    };

    await expect(client.newSession(request)).rejects.toMatchObject({
      code: -32000,
    });
  });

  it('does not call createSession when the auth gate fails', async () => {
    let createCalled = false;
    const harness = {
      auth: {
        status: async () => UNAUTHED_STATUS,
      },
      createSession: async (_opts: unknown) => {
        createCalled = true;
        return { id: 'should-not-be-reached' };
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(
      client.newSession({ cwd: '/tmp/x', mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32000 });
    expect(createCalled).toBe(false);
  });

  it('accepts a configured default model with an api_key provider', async () => {
    const { harness, createCalls } = makeHarnessWithConfig(
      configuredModelConfig({ type: 'openai', apiKey: 'sk-test' }),
    );

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const response = await client.newSession({ cwd: '/tmp/configured', mcpServers: [] });

    expect(response.sessionId).toBeTruthy();
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.workDir).toBe('/tmp/configured');
  });

  it('accepts provider env-table credentials without an OAuth token', async () => {
    const { harness, createCalls } = makeHarnessWithConfig(
      configuredModelConfig({ type: 'openai', env: { OPENAI_API_KEY: 'sk-env' } }),
    );

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.newSession({ cwd: '/tmp/env', mcpServers: [] })).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(createCalls).toHaveLength(1);
  });

  it('rejects config credentials when no default model resolves to them', async () => {
    const { harness, createCalls } = makeHarnessWithConfig({
      providers: { local: { type: 'openai', apiKey: 'sk-test' } },
      models: {},
    });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.newSession({ cwd: '/tmp/no-model', mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
    });
    expect(createCalls).toHaveLength(0);
  });

  it('does not trim the configured default model before resolving it', async () => {
    const { harness, createCalls } = makeHarnessWithConfig({
      providers: { local: { type: 'openai', apiKey: 'sk-test' } },
      defaultModel: ' local/gpt ',
      models: {
        'local/gpt': {
          provider: 'local',
          model: 'gpt-4o',
          maxContextSize: 128000,
        },
      },
    });

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.newSession({ cwd: '/tmp/spaced-model', mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
    });
    expect(createCalls).toHaveLength(0);
  });

  it('rejects mixed api_key and OAuth provider config without a token', async () => {
    const { harness, createCalls } = makeHarnessWithConfig(
      configuredModelConfig({
        type: 'kimi',
        apiKey: 'sk-test',
        oauth: { storage: 'file', key: 'kimi' },
      }),
    );

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.newSession({ cwd: '/tmp/mixed-auth', mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
    });
    expect(createCalls).toHaveLength(0);
  });

  it('rejects Vertex AI service-account config without a resolvable location', async () => {
    const { harness, createCalls } = makeHarnessWithConfig(
      configuredModelConfig({
        type: 'vertexai',
        baseUrl: 'https://example.test/v1',
        env: { GOOGLE_CLOUD_PROJECT: 'project' },
      }),
    );

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.newSession({ cwd: '/tmp/vertexai', mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
    });
    expect(createCalls).toHaveLength(0);
  });

  it('keeps the OAuth token short-circuit even when config loading fails', async () => {
    const createCalls: Array<{ id?: string; workDir: string }> = [];
    const harness = {
      auth: {
        status: async () => AUTHED_STATUS,
      },
      getConfig: async () => {
        throw new Error('config unavailable');
      },
      createSession: async (options: { id?: string; workDir: string }) => {
        createCalls.push(options);
        return {
          id: options.id ?? 'session-fallback',
          prompt: async () => undefined,
          cancel: async () => undefined,
          onEvent: () => () => undefined,
        } as unknown as Session;
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.newSession({ cwd: '/tmp/token', mcpServers: [] })).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(createCalls).toHaveLength(1);
  });
});

describe('AcpServer.authenticate', () => {
  it('rejects unknown methodId with invalidParams (-32602)', async () => {
    const harness = makeHarnessWithToken(true);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.authenticate({ methodId: 'unknown' })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('returns void on valid token', async () => {
    const harness = makeHarnessWithToken(true);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const result = await client.authenticate({ methodId: 'login' });
    // ACP allows `AuthenticateResponse | void`; either `null`/`undefined`
    // or an empty body `{}` is considered a successful ack.
    expect(result ?? {}).toEqual({});
  });

  it('throws authRequired (-32000) when harness has no token', async () => {
    const harness = makeHarnessWithToken(false);
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.authenticate({ methodId: 'login' })).rejects.toMatchObject({
      code: -32000,
    });
  });

  it('returns void when config credentials are already usable', async () => {
    const { harness } = makeHarnessWithConfig(
      configuredModelConfig({ type: 'kimi', apiKey: 'sk-kimi' }),
    );
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    startAcpServer(harness, agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    const result = await client.authenticate({ methodId: 'login' });
    expect(result ?? {}).toEqual({});
  });
});
