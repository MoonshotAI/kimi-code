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
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('requestPermission should not be called');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('writeTextFile should not be called');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('readTextFile should not be called');
  }
}

function makeInMemoryStreamPair(): {
  agentStream: ReturnType<typeof ndJsonStream>;
  clientStream: ReturnType<typeof ndJsonStream>;
} {
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  return {
    agentStream: ndJsonStream(a2c.writable, c2a.readable),
    clientStream: ndJsonStream(c2a.writable, a2c.readable),
  };
}

/**
 * Fake `Session` that records every call to `prompt` / `activateSkill`
 * and emits a pre-recorded event sequence to any subscribed listener
 * after a microtask (matches real RPC ordering: the kick returns
 * before the first event lands).
 *
 * `listSkills` returns a single Prompt skill so the AcpServer's
 * `available_commands_update` resolver also populates the per-session
 * `skillCommandMap` that {@link AcpSession.prompt} consults.
 */
function makeFakeSession(
  sessionId: string,
  script: readonly Event[],
): {
  session: Session;
  calls: {
    prompt: number;
    activate: Array<{ name: string; args?: string | undefined }>;
  };
} {
  const listeners = new Set<(event: Event) => void>();
  const calls = {
    prompt: 0,
    activate: [] as Array<{ name: string; args?: string | undefined }>,
  };
  const emit = async (): Promise<void> => {
    await Promise.resolve();
    for (const ev of script) {
      for (const fn of listeners) fn(ev);
    }
  };
  const session = {
    id: sessionId,
    prompt: async (_input: unknown) => {
      calls.prompt += 1;
      await emit();
    },
    activateSkill: async (name: string, args?: string | undefined) => {
      calls.activate.push({ name, args });
      await emit();
    },
    cancel: async () => undefined,
    onEvent: (fn: (event: Event) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    listSkills: async () => [
      {
        name: 'foo',
        description: 'foo skill',
        path: '/tmp/foo.md',
        source: 'user' as const,
        type: 'prompt',
      },
    ],
  } as unknown as Session;
  return { session, calls };
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

function endedTurn(sessionId: string): Event {
  return { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event;
}

/**
 * Wait for the client to receive an `available_commands_update` push.
 * The server schedules it via `setTimeout(0)` after `session/new`
 * resolves, so we need a microtask boundary before sending a prompt
 * that relies on the per-session `skillCommandMap` being seeded.
 */
async function waitForAvailableCommands(
  collecting: CollectingClient,
  timeoutMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      collecting.updates.some(
        (n) =>
          (n.update as { sessionUpdate?: string }).sessionUpdate ===
          'available_commands_update',
      )
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('available_commands_update never arrived');
}

describe('AcpSession slash routing', () => {
  it('routes `/skill:foo bar` to Session.activateSkill (not Session.prompt)', async () => {
    const sessionId = 'sess-slash-A';
    const { session, calls } = makeFakeSession(sessionId, [endedTurn(sessionId)]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    // The CLI wires `slashCommands` to a resolver that returns both the
    // palette and `skillCommandMap`; mirror that here so the per-
    // session skill map is seeded before the prompt fires.
    new AgentSideConnection(
      (c) =>
        new AcpServer(harness, c, {
          slashCommands: async (s) => {
            const skills = await s.listSkills();
            const map = new Map<string, string>();
            const commands = skills.map((sk) => {
              const name = `skill:${sk.name}`;
              map.set(name, sk.name);
              return { name, description: sk.description };
            });
            return { commands, skillCommandMap: map };
          },
        }),
      agentStream,
    );
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await waitForAvailableCommands(collecting);

    const response = await client.prompt({
      sessionId,
      prompt: [textBlock('/skill:foo bar baz')],
    });

    expect(response.stopReason).toBe('end_turn');
    expect(calls.prompt).toBe(0);
    expect(calls.activate).toEqual([{ name: 'foo', args: 'bar baz' }]);
  });

  it('passes empty-string args as undefined to activateSkill', async () => {
    const sessionId = 'sess-slash-B';
    const { session, calls } = makeFakeSession(sessionId, [endedTurn(sessionId)]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection(
      (c) =>
        new AcpServer(harness, c, {
          slashCommands: async (s) => {
            const skills = await s.listSkills();
            const map = new Map<string, string>();
            const commands = skills.map((sk) => {
              const name = `skill:${sk.name}`;
              map.set(name, sk.name);
              return { name, description: sk.description };
            });
            return { commands, skillCommandMap: map };
          },
        }),
      agentStream,
    );
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await waitForAvailableCommands(collecting);

    await client.prompt({ sessionId, prompt: [textBlock('/skill:foo')] });

    expect(calls.prompt).toBe(0);
    expect(calls.activate).toEqual([{ name: 'foo', args: undefined }]);
  });

  it('intercepts unknown slash commands locally and lets non-slash text flow to Session.prompt', async () => {
    const sessionId = 'sess-slash-C';
    const { session, calls } = makeFakeSession(sessionId, [
      endedTurn(sessionId),
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection(
      (c) =>
        new AcpServer(harness, c, {
          slashCommands: async (s) => {
            const skills = await s.listSkills();
            const map = new Map<string, string>();
            const commands = skills.map((sk) => {
              const name = `skill:${sk.name}`;
              map.set(name, sk.name);
              return { name, description: sk.description };
            });
            return { commands, skillCommandMap: map };
          },
        }),
      agentStream,
    );
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await waitForAvailableCommands(collecting);

    // Unknown slash (`/clear` is a TUI builtin not advertised by ACP):
    // the adapter must NOT forward it to the model. It produces a local
    // "unknown command" reply and returns `end_turn` without invoking
    // Session.prompt.
    await client.prompt({ sessionId, prompt: [textBlock('/clear')] });
    // Plain text: trivially passes through.
    await client.prompt({ sessionId, prompt: [textBlock('hello world')] });

    expect(calls.prompt).toBe(1);
    expect(calls.activate).toEqual([]);
  });

  it('intercepts a `/skill:foo` form locally when no skillCommandMap has been seeded', async () => {
    // No `slashCommands` option at all → the adapter's internal map
    // stays empty, so `/skill:foo` resolves to no skill. Per the new
    // ACP-owned routing contract, the adapter must still NOT forward
    // the slash form to the model — it surfaces a local "unknown
    // command" reply and skips Session.prompt.
    const sessionId = 'sess-slash-D';
    const { session, calls } = makeFakeSession(sessionId, [endedTurn(sessionId)]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    // Wait for the (empty) available_commands_update to settle so the
    // map seeder has fired its no-op pass.
    await waitForAvailableCommands(collecting);

    await client.prompt({
      sessionId,
      prompt: [textBlock('/skill:foo bar')],
    });

    expect(calls.prompt).toBe(0);
    expect(calls.activate).toEqual([]);
  });

  it('routes built-in `/help` locally and surfaces the advertised palette', async () => {
    const sessionId = 'sess-slash-help';
    const { session, calls } = makeFakeSession(sessionId, [endedTurn(sessionId)]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await waitForAvailableCommands(collecting);

    await client.prompt({ sessionId, prompt: [textBlock('/help')] });

    expect(calls.prompt).toBe(0);
    expect(calls.activate).toEqual([]);
    const helpReply = collecting.updates.find(
      (n) =>
        (n.update as { sessionUpdate?: string }).sessionUpdate === 'agent_message_chunk',
    );
    expect(helpReply).toBeDefined();
    const text =
      (helpReply!.update as { content?: { text?: string } }).content?.text ?? '';
    expect(text).toContain('Available ACP commands:');
    expect(text).toContain('/compact');
    expect(text).toContain('/help');
  });

  it('routes built-in `/status` locally and renders SDK status fields', async () => {
    const sessionId = 'sess-slash-status';
    const { session, calls } = makeFakeSession(sessionId, [endedTurn(sessionId)]);
    // Bolt a minimal getStatus onto the fake session — the adapter only
    // reads from it; we don't need the rest of the SDK surface here.
    (session as unknown as { getStatus: () => Promise<unknown> }).getStatus = async () => ({
      model: 'mock-model',
      thinkingEffort: 'low',
      permission: 'ask',
      planMode: false,
      contextTokens: 1234,
      maxContextTokens: 200_000,
      contextUsage: 0.00617,
    });
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await waitForAvailableCommands(collecting);

    await client.prompt({ sessionId, prompt: [textBlock('/status')] });

    expect(calls.prompt).toBe(0);
    expect(calls.activate).toEqual([]);
    const reply = collecting.updates.find(
      (n) =>
        (n.update as { sessionUpdate?: string }).sessionUpdate === 'agent_message_chunk',
    );
    const text = (reply!.update as { content?: { text?: string } }).content?.text ?? '';
    expect(text).toContain('Session status:');
    expect(text).toContain('Model: mock-model');
    expect(text).toContain('Context: 1,234 / 200,000 (0.6%)');
  });
});
