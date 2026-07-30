/**
 * Scenario: ACP slash-command routing and concurrent skill activations.
 * Responsibilities: route known skill commands locally and correlate each ACP request to its turn.
 * Wiring: real ACP NDJSON connections; only the node SDK Session boundary is scripted.
 * Run: pnpm --filter @moonshot-ai/acp-adapter exec vitest run test/session-slash.test.ts
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
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class CollectingClient implements Client {
  readonly updates: SessionNotification[] = [];
  private readonly updateWaiters = new Set<{
    readonly predicate: (notification: SessionNotification) => boolean;
    readonly resolve: (notification: SessionNotification) => void;
  }>();

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('requestPermission should not be called');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
    for (const waiter of this.updateWaiters) {
      if (!waiter.predicate(n)) continue;
      this.updateWaiters.delete(waiter);
      waiter.resolve(n);
    }
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('writeTextFile should not be called');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('readTextFile should not be called');
  }

  waitForUpdate(
    predicate: (notification: SessionNotification) => boolean,
  ): Promise<SessionNotification> {
    const existing = this.updates.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.updateWaiters.add({ predicate, resolve });
    });
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
  const emit = async (
    origin:
      | { readonly kind: 'user'; readonly promptId?: string }
      | {
          readonly kind: 'skill_activation';
          readonly activationId?: string;
          readonly skillName: string;
          readonly trigger: 'user-slash';
        },
  ): Promise<void> => {
    await Promise.resolve();
    const firstTurnEvent = script.find(
      (event): event is Event & { turnId: number } =>
        'turnId' in event && typeof event.turnId === 'number',
    );
    if (firstTurnEvent !== undefined) {
      for (const fn of listeners) {
        fn({
          type: 'turn.started',
          sessionId,
          agentId: 'main',
          turnId: firstTurnEvent.turnId,
          origin,
        } as Event);
      }
    }
    for (const ev of script) {
      for (const fn of listeners) fn(ev);
    }
  };
  const session = {
    id: sessionId,
    prompt: async (
      _input: unknown,
      options?: { readonly promptId?: string },
    ) => {
      calls.prompt += 1;
      await emit({ kind: 'user', promptId: options?.promptId });
    },
    activateSkill: async (
      name: string,
      args?: string | undefined,
      options?: { readonly activationId?: string },
    ) => {
      calls.activate.push({ name, args });
      await emit({
        kind: 'skill_activation',
        activationId: options?.activationId,
        skillName: name,
        trigger: 'user-slash',
      });
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

async function waitForAvailableCommands(
  collecting: CollectingClient,
): Promise<void> {
  await collecting.waitForUpdate(
    (notification) =>
      (notification.update as { sessionUpdate?: string }).sessionUpdate ===
      'available_commands_update',
  );
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

  it('keeps concurrent activations of the same skill bound to their correlation ids', async () => {
    const sessionId = 'sess-slash-same-skill-concurrent';
    const listeners = new Set<(event: Event) => void>();
    const activationCalls: Array<{
      readonly args?: string;
      readonly activationId?: string;
    }> = [];
    let signalFirstActivation!: () => void;
    let signalSecondActivation!: () => void;
    const firstActivation = new Promise<void>((resolve) => {
      signalFirstActivation = resolve;
    });
    const secondActivation = new Promise<void>((resolve) => {
      signalSecondActivation = resolve;
    });
    const emit = (event: Event): void => {
      for (const listener of listeners) listener(event);
    };
    const session = {
      id: sessionId,
      prompt: async () => {
        throw new Error('plain prompt should not run for a known skill command');
      },
      activateSkill: async (
        _name: string,
        args?: string,
        options?: { readonly activationId?: string },
      ) => {
        activationCalls.push({ args, activationId: options?.activationId });
        if (activationCalls.length === 1) signalFirstActivation();
        if (activationCalls.length === 2) signalSecondActivation();
      },
      cancel: async () => undefined,
      onEvent: (listener: (event: Event) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
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
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection(
      (connection) =>
        new AcpServer(harness, connection, {
          slashCommands: async (sdkSession) => {
            const skills = await sdkSession.listSkills();
            return {
              commands: skills.map((skill) => ({
                name: `skill:${skill.name}`,
                description: skill.description,
              })),
              skillCommandMap: new Map([['skill:foo', 'foo']]),
            };
          },
        }),
      agentStream,
    );
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await waitForAvailableCommands(collecting);
    const firstPrompt = client.prompt({
      sessionId,
      prompt: [textBlock('/skill:foo first')],
    });
    const secondPrompt = client.prompt({
      sessionId,
      prompt: [textBlock('/skill:foo second')],
    });

    await firstActivation;
    expect(activationCalls).toHaveLength(1);
    const firstActivationId = activationCalls[0]?.activationId;
    expect(firstActivationId).toEqual(expect.any(String));

    emit({
      type: 'turn.started',
      sessionId,
      agentId: 'main',
      turnId: 50,
      origin: {
        kind: 'skill_activation',
        activationId: 'external-same-skill',
        skillName: 'foo',
        skillArgs: 'first',
        trigger: 'user-slash',
      },
    } as Event);
    emit({
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId: 50,
      reason: 'cancelled',
    } as Event);
    emit({
      type: 'turn.started',
      sessionId,
      agentId: 'main',
      turnId: 51,
      origin: {
        kind: 'skill_activation',
        activationId: firstActivationId,
        skillName: 'foo',
        skillArgs: 'first',
        trigger: 'user-slash',
      },
    } as Event);
    emit({
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId: 51,
      reason: 'completed',
    } as Event);

    await secondActivation;
    expect(activationCalls).toHaveLength(2);
    const secondActivationId = activationCalls[1]?.activationId;
    expect(secondActivationId).toEqual(expect.any(String));
    expect(secondActivationId).not.toBe(firstActivationId);
    emit({
      type: 'turn.started',
      sessionId,
      agentId: 'main',
      turnId: 52,
      origin: {
        kind: 'skill_activation',
        activationId: secondActivationId,
        skillName: 'foo',
        skillArgs: 'second',
        trigger: 'user-slash',
      },
    } as Event);
    emit({
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId: 52,
      reason: 'cancelled',
    } as Event);

    await expect(firstPrompt).resolves.toEqual({ stopReason: 'end_turn' });
    await expect(secondPrompt).resolves.toEqual({ stopReason: 'cancelled' });
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
