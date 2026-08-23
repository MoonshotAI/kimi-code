import { describe, expect, it, vi } from 'vitest';

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
import { Jimp } from 'jimp';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in ext-methods test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    // Steering / session-new may emit available_commands_update; ignore.
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in ext-methods test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in ext-methods test');
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

function makeMinimalHarness(): KimiHarness {
  // ext_method does not touch the harness; the auth/session surface
  // is irrelevant for these tests so the stub keeps the harness flat.
  return {} as unknown as KimiHarness;
}

const STEER_METHOD = '_session/steering';
const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

describe('AcpServer ext method surface', () => {
  it('unit-level extMethod throws RequestError.methodNotFound with the method name', async () => {
    const server = new AcpServer(makeMinimalHarness());
    await expect(server.extMethod('myorg.foo', {})).rejects.toMatchObject({
      // JSON-RPC method-not-found code per ACP SDK RequestError.methodNotFound.
      code: -32601,
      // RequestError stamps the requested method name into the message
      // so clients can distinguish "ext/foo" from "ext/bar".
      message: expect.stringContaining('myorg.foo'),
    });
  });

  it('unit-level extNotification throws RequestError.methodNotFound with the method name', async () => {
    const server = new AcpServer(makeMinimalHarness());
    await expect(server.extNotification('myorg.bar', {})).rejects.toMatchObject({
      code: -32601,
      message: expect.stringContaining('myorg.bar'),
    });
  });

  it('over-the-wire extMethod surfaces -32601 to a remote ACP client', async () => {
    const harness = makeMinimalHarness();
    const { agentStream, clientStream } = makeInMemoryStreamPair();

    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(client.extMethod('myorg.unsupported', {})).rejects.toMatchObject({
      code: -32601,
    });
  });

  it('over-the-wire _session/steering rejects when the session is idle', async () => {
    const sessionId = 'sess-steer-idle';
    const session = {
      id: sessionId,
      prompt: async () => undefined,
      steer: async () => {
        throw new Error('steer should not be called when idle');
      },
      cancel: async () => undefined,
      onEvent: () => () => undefined,
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    await expect(
      client.extMethod(STEER_METHOD, {
        sessionId,
        prompt: [textBlock('follow up')],
      }),
    ).rejects.toMatchObject({
      // invalidRequest — host should resubmit via session/prompt.
      code: -32600,
      message: expect.stringContaining('session/prompt'),
    });
  });

  it('over-the-wire _session/steering injects into a running turn', async () => {
    const sessionId = 'sess-steer-busy';
    const steered: unknown[] = [];
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let signalPromptStarted: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      signalPromptStarted = resolve;
    });
    const listeners = new Set<(event: Event) => void>();
    const session = {
      id: sessionId,
      prompt: async () => {
        for (const fn of listeners) {
          fn({
            type: 'turn.started',
            sessionId,
            agentId: 'main',
            turnId: 1,
          } as Event);
          fn({
            type: 'turn.ended',
            sessionId,
            agentId: 'subagent-1',
            turnId: 1,
            reason: 'completed',
          } as Event);
        }
        signalPromptStarted?.();
        // Hold the ACP prompt open until the test releases it, so
        // `_session/steering` sees an active turn.
        await turnGate;
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
      steer: async (input: unknown) => {
        steered.push(input);
      },
      cancel: async () => undefined,
      onEvent: (fn: (event: Event) => void) => {
        listeners.add(fn);
        return () => {
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
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const promptPromise = client.prompt({
      sessionId,
      prompt: [textBlock('start')],
    });
    await promptStarted;

    const steerResult = await client.extMethod(STEER_METHOD, {
      sessionId,
      prompt: [textBlock('also do this')],
    });
    expect(steerResult).toEqual({ outcome: 'injected' });
    expect(steered).toEqual([[{ type: 'text', text: 'also do this' }]]);

    const oversizedPng = Buffer.from(
      await new Jimp({ width: 3600, height: 1800, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');
    await client.extMethod(STEER_METHOD, {
      sessionId,
      prompt: [{ type: 'image', data: oversizedPng, mimeType: 'image/png' }],
    });
    expect(steered[1]).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('Image compressed') }),
      expect.objectContaining({ type: 'image_url' }),
    ]);

    const endingSteer = client.extMethod(STEER_METHOD, {
      sessionId,
      prompt: [{ type: 'image', data: oversizedPng, mimeType: 'image/png' }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseTurn?.();
    await expect(promptPromise).resolves.toMatchObject({ stopReason: 'end_turn' });
    await expect(endingSteer).rejects.toMatchObject({ code: -32600 });
  });

  it('rejects steering before the underlying turn.started event', async () => {
    const sessionId = 'sess-steer-not-started';
    let signalPromptEntered: (() => void) | undefined;
    const promptEntered = new Promise<void>((resolve) => {
      signalPromptEntered = resolve;
    });
    let releasePrompt: (() => void) | undefined;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const listeners = new Set<(event: Event) => void>();
    const steer = vi.fn();
    const session = {
      id: sessionId,
      prompt: async () => {
        signalPromptEntered?.();
        await promptGate;
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
      steer,
      cancel: async () => undefined,
      onEvent: (fn: (event: Event) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);
    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const promptPromise = client.prompt({ sessionId, prompt: [textBlock('start')] });
    await promptEntered;
    await expect(
      client.extMethod(STEER_METHOD, { sessionId, prompt: [textBlock('too early')] }),
    ).rejects.toMatchObject({ code: -32600 });
    expect(steer).not.toHaveBeenCalled();

    releasePrompt?.();
    await promptPromise;
  });

  it('rejects malformed steering content blocks as invalid params', async () => {
    const sessionId = 'sess-steer-invalid-blocks';
    const session = { id: sessionId } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);
    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    for (const prompt of [
      [null],
      [{ type: 'text' }],
      [{ type: 'resource', resource: { uri: 'x', text: 1, blob: 'valid' } }],
    ]) {
      await expect(client.extMethod(STEER_METHOD, { sessionId, prompt })).rejects.toMatchObject({
        code: -32602,
      });
    }
  });

  it('over-the-wire _session/steering rejects unknown sessionId', async () => {
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => {
        throw new Error('createSession should not be called');
      },
    } as unknown as KimiHarness;
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await expect(
      client.extMethod(STEER_METHOD, {
        sessionId: 'missing',
        prompt: [textBlock('x')],
      }),
    ).rejects.toMatchObject({
      code: -32602, // invalidParams
    });
  });
});
