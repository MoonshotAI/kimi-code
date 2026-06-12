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

  /** Updates excluding the `available_commands_update` emitted by session/new. */
  get promptUpdates(): readonly SessionNotification[] {
    return this.updates.filter(
      (n) =>
        (n.update as { sessionUpdate?: string }).sessionUpdate !==
        'available_commands_update',
    );
  }

  get chunkTexts(): readonly string[] {
    return this.promptUpdates
      .map((n) => n.update as { sessionUpdate?: string; content?: { text?: string } })
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => u.content?.text ?? '');
  }

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('CollectingClient.requestPermission should not be called in steer test');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('CollectingClient.writeTextFile should not be called in steer test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CollectingClient.readTextFile should not be called in steer test');
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

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

function makeHarness(session: Session): KimiHarness {
  return {
    auth: { status: async () => AUTHED_STATUS },
    createSession: async () => session,
  } as unknown as KimiHarness;
}

/**
 * A steer-capable Session stub modelling an agent-initiated turn
 * (e.g. a background-task notification turn) that is already active:
 * `prompt()` answers with `turn.agent_busy`, and `steer()` emits the
 * remainder of the active turn followed by `turn.ended`.
 */
function makeBusyThenSteerSession(sessionId: string): {
  session: Session;
  steerCalls: unknown[];
  emit: (event: Event) => void;
  unsubscribeCount: () => number;
} {
  const listeners = new Set<(event: Event) => void>();
  let unsubCount = 0;
  const steerCalls: unknown[] = [];
  const emit = (event: Event): void => {
    for (const fn of listeners) fn(event);
  };
  const session = {
    id: sessionId,
    prompt: async (_input: unknown) => {
      emit({
        type: 'error',
        sessionId,
        agentId: 'main',
        code: 'turn.agent_busy',
        message: 'Cannot launch a new turn while another turn (ID 16) is active',
        details: { turnId: 16 },
        retryable: true,
      } as unknown as Event);
    },
    steer: async (input: unknown) => {
      steerCalls.push(input);
      emit({ type: 'assistant.delta', sessionId, agentId: 'main', turnId: 16, delta: 'merged ' } as Event);
      emit({ type: 'assistant.delta', sessionId, agentId: 'main', turnId: 16, delta: 'reply' } as Event);
      emit({ type: 'turn.ended', sessionId, agentId: 'main', turnId: 16, reason: 'completed' } as Event);
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
  return { session, steerCalls, emit, unsubscribeCount: () => unsubCount };
}

describe('AcpSession steer support', () => {
  it('steers a prompt into an active agent-initiated turn and resolves on its turn.ended', async () => {
    const sessionId = 'sess-steer';
    const { session, steerCalls, unsubscribeCount } = makeBusyThenSteerSession(sessionId);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarness(session), c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const response = await client.prompt({ sessionId, prompt: [textBlock('hi there')] });

    expect(response.stopReason).toBe('end_turn');
    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0]).toMatchObject([{ type: 'text', text: 'hi there' }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    // The active turn's output after the steer streams back as the
    // response to this prompt — exactly once.
    expect(collecting.chunkTexts).toEqual(['merged ', 'reply']);
    expect(unsubscribeCount()).toBe(1);
  });

  it('rejects the prompt when the steer fallback itself rejects', async () => {
    const sessionId = 'sess-steer-fail';
    const listeners = new Set<(event: Event) => void>();
    const session = {
      id: sessionId,
      prompt: async (_input: unknown) => {
        for (const fn of listeners) {
          fn({
            type: 'error',
            sessionId,
            agentId: 'main',
            code: 'turn.agent_busy',
            message: 'Cannot launch a new turn while another turn (ID 3) is active',
            details: { turnId: 3 },
            retryable: true,
          } as unknown as Event);
        }
      },
      steer: async (_input: unknown) => {
        throw new Error('steer transport down');
      },
      cancel: async () => undefined,
      onEvent: (fn: (event: Event) => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    } as unknown as Session;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarness(session), c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    await expect(
      client.prompt({ sessionId, prompt: [textBlock('hi')] }),
    ).rejects.toBeDefined();
  });

  it('merges a second prompt into the first turn without duplicating chunks', async () => {
    const sessionId = 'sess-steer-overlap';
    const listeners = new Set<(event: Event) => void>();
    let unsubCount = 0;
    let promptCall = 0;
    const emit = (event: Event): void => {
      for (const fn of listeners) fn(event);
    };
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const session = {
      id: sessionId,
      prompt: async (_input: unknown) => {
        promptCall += 1;
        if (promptCall === 1) {
          emit({
            type: 'turn.started',
            sessionId,
            agentId: 'main',
            turnId: 1,
            origin: { kind: 'user' },
          } as unknown as Event);
          emit({ type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'a' } as Event);
          await firstTurnGate;
          return;
        }
        emit({
          type: 'error',
          sessionId,
          agentId: 'main',
          code: 'turn.agent_busy',
          message: 'Cannot launch a new turn while another turn (ID 1) is active',
          details: { turnId: 1 },
          retryable: true,
        } as unknown as Event);
      },
      steer: async (_input: unknown) => {
        // The steered message is consumed by turn 1, which continues
        // and then ends once.
        emit({ type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'b' } as Event);
        emit({ type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event);
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

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarness(session), c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const firstPrompt = client.prompt({ sessionId, prompt: [textBlock('first')] });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const secondPrompt = client.prompt({ sessionId, prompt: [textBlock('second')] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFirstTurn?.();

    await expect(firstPrompt).resolves.toMatchObject({ stopReason: 'end_turn' });
    await expect(secondPrompt).resolves.toMatchObject({ stopReason: 'end_turn' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    // Both subscriptions observed every delta; only the oldest one
    // forwards, so each chunk reaches the client exactly once.
    expect(collecting.chunkTexts).toEqual(['a', 'b']);
    expect(unsubCount).toBe(2);
  });
});

describe('AcpSession skill activation queueing', () => {
  /**
   * Fake Session modelling: an agent-initiated turn (ID 16) is active,
   * so the FIRST `activateSkill` gets `turn.agent_busy`; the test then
   * ends the foreign turn via `emit`, and the SECOND (re-issued)
   * `activateSkill` runs its own turn (ID 17). `listSkills` seeds the
   * server's skillCommandMap so `/skill:foo` routes to activateSkill.
   */
  function makeBusySkillSession(sessionId: string): {
    session: Session;
    activateCalls: Array<{ name: string; args?: string | undefined }>;
    emit: (event: Event) => void;
  } {
    const listeners = new Set<(event: Event) => void>();
    const activateCalls: Array<{ name: string; args?: string | undefined }> = [];
    const emit = (event: Event): void => {
      for (const fn of listeners) fn(event);
    };
    const session = {
      id: sessionId,
      prompt: async (_input: unknown) => undefined,
      activateSkill: async (name: string, args?: string | undefined) => {
        activateCalls.push({ name, args });
        if (activateCalls.length === 1) {
          emit({
            type: 'error',
            sessionId,
            agentId: 'main',
            code: 'turn.agent_busy',
            message: 'Cannot launch a new turn while another turn (ID 16) is active',
            details: { turnId: 16 },
            retryable: true,
          } as unknown as Event);
          return;
        }
        emit({
          type: 'turn.started',
          sessionId,
          agentId: 'main',
          turnId: 17,
          origin: { kind: 'user' },
        } as unknown as Event);
        emit({ type: 'assistant.delta', sessionId, agentId: 'main', turnId: 17, delta: 'skill output' } as Event);
        emit({ type: 'turn.ended', sessionId, agentId: 'main', turnId: 17, reason: 'completed' } as Event);
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
    return { session, activateCalls, emit };
  }

  /**
   * Mirror the CLI's `slashCommands` resolver wiring so the per-session
   * `skillCommandMap` is seeded before the prompt fires (same pattern
   * as session-slash.test.ts).
   */
  function makeSkillServer(
    session: Session,
    agentStream: ReturnType<typeof ndJsonStream>,
  ): void {
    new AgentSideConnection(
      (c) =>
        new AcpServer(makeHarness(session), c, {
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
  }

  /** Wait until the server's available_commands_update seeded the skill map. */
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
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('available_commands_update never arrived');
  }

  it('queues a skill activation behind the active turn and re-issues it on idle', async () => {
    const sessionId = 'sess-skill-queue';
    const { session, activateCalls, emit } = makeBusySkillSession(sessionId);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    makeSkillServer(session, agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await waitForAvailableCommands(collecting);

    const promptPromise = client.prompt({ sessionId, prompt: [textBlock('/skill:foo bar')] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(activateCalls).toHaveLength(1);

    // The foreign turn streams a bit more and then finishes — the
    // queued activation must launch right after.
    emit({ type: 'assistant.delta', sessionId, agentId: 'main', turnId: 16, delta: 'bg tail' } as Event);
    emit({ type: 'turn.ended', sessionId, agentId: 'main', turnId: 16, reason: 'completed' } as Event);

    await expect(promptPromise).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(activateCalls).toHaveLength(2);
    expect(activateCalls[1]).toMatchObject({ name: 'foo', args: 'bar' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    // While queued, the pending subscription forwards the foreign
    // turn's tail; the skill turn's output follows — each exactly once.
    expect(collecting.chunkTexts).toEqual(['bg tail', 'skill output']);
  });

  it('settles a queued skill activation as cancelled when the active turn is cancelled', async () => {
    const sessionId = 'sess-skill-queue-cancel';
    const { session, activateCalls, emit } = makeBusySkillSession(sessionId);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    makeSkillServer(session, agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await waitForAvailableCommands(collecting);

    const promptPromise = client.prompt({ sessionId, prompt: [textBlock('/skill:foo')] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(activateCalls).toHaveLength(1);

    emit({ type: 'turn.ended', sessionId, agentId: 'main', turnId: 16, reason: 'cancelled' } as Event);

    await expect(promptPromise).resolves.toMatchObject({ stopReason: 'cancelled' });
    // The queued activation is dropped, not re-issued.
    expect(activateCalls).toHaveLength(1);
  });
});

describe('AcpSession agent-initiated turn forwarding', () => {
  it('forwards output of a background-notification turn when no prompt is in flight', async () => {
    const sessionId = 'sess-bg-turn';
    const listeners = new Set<(event: Event) => void>();
    const emit = (event: Event): void => {
      for (const fn of listeners) fn(event);
    };
    const session = {
      id: sessionId,
      prompt: async (_input: unknown) => undefined,
      cancel: async () => undefined,
      onEvent: (fn: (event: Event) => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    } as unknown as Session;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarness(session), c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    // A background-task notification steers the idle agent, which
    // launches a turn with no originating session/prompt.
    emit({
      type: 'turn.started',
      sessionId,
      agentId: 'main',
      turnId: 16,
      origin: { kind: 'background_task', taskId: 't1', status: 'completed', notificationId: 'task:t1:completed' },
    } as unknown as Event);
    emit({ type: 'assistant.delta', sessionId, agentId: 'main', turnId: 16, delta: 'task t1 ' } as Event);
    emit({ type: 'assistant.delta', sessionId, agentId: 'main', turnId: 16, delta: 'finished' } as Event);
    emit({ type: 'turn.ended', sessionId, agentId: 'main', turnId: 16, reason: 'completed' } as Event);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collecting.chunkTexts).toEqual(['task t1 ', 'finished']);
  });

  it('ignores subagent events while forwarding an agent-initiated turn', async () => {
    const sessionId = 'sess-bg-sub';
    const listeners = new Set<(event: Event) => void>();
    const emit = (event: Event): void => {
      for (const fn of listeners) fn(event);
    };
    const session = {
      id: sessionId,
      prompt: async (_input: unknown) => undefined,
      cancel: async () => undefined,
      onEvent: (fn: (event: Event) => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    } as unknown as Session;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(makeHarness(session), c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    emit({ type: 'assistant.delta', sessionId, agentId: 'main', turnId: 7, delta: 'main' } as Event);
    emit({ type: 'assistant.delta', sessionId, agentId: 'sub-1', turnId: 99, delta: 'leak' } as Event);
    emit({ type: 'turn.ended', sessionId, agentId: 'sub-1', turnId: 99, reason: 'completed' } as Event);
    emit({ type: 'turn.ended', sessionId, agentId: 'main', turnId: 7, reason: 'completed' } as Event);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collecting.chunkTexts).toEqual(['main']);
  });
});
