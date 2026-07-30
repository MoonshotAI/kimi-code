/**
 * Scenario: ACP prompt admission, turn correlation, terminal mapping, and cleanup.
 * Responsibilities: one request owns only its correlated main-agent turn or no-turn completion.
 * Wiring: scripted SDK Session events through AcpSession/AcpServer and in-memory ACP NDJSON.
 * Run: pnpm --filter @moonshot-ai/acp-adapter exec vitest run test/session-prompt.test.ts
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
import type {
  ApprovalHandler,
  Event,
  KimiHarness,
  QuestionHandler,
  Session,
} from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AcpSession } from '../src/session';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class CollectingClient implements Client {
  readonly updates: SessionNotification[] = [];
  private readonly promptUpdateWaiters = new Set<{
    readonly count: number;
    readonly resolve: () => void;
  }>();

  /**
   * Updates produced AFTER `session/new` returns. Phase 9.3 makes
   * `newSession` emit exactly one `available_commands_update` on
   * creation; tests in this file pre-date that emission and assert
   * only on prompt-driven updates, so we filter that variant out.
   */
  get promptUpdates(): readonly SessionNotification[] {
    return this.updates.filter(
      (n) =>
        (n.update as { sessionUpdate?: string }).sessionUpdate !==
        'available_commands_update',
    );
  }

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('CollectingClient.requestPermission should not be called in prompt test');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
    const promptUpdateCount = this.promptUpdates.length;
    for (const waiter of this.promptUpdateWaiters) {
      if (promptUpdateCount < waiter.count) continue;
      this.promptUpdateWaiters.delete(waiter);
      waiter.resolve();
    }
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('CollectingClient.writeTextFile should not be called in prompt test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CollectingClient.readTextFile should not be called in prompt test');
  }

  waitForPromptUpdates(count: number): Promise<void> {
    if (this.promptUpdates.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.promptUpdateWaiters.add({ count, resolve });
    });
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
 * Construct a fake Session whose `prompt()` synchronously emits a
 * pre-recorded sequence of `Event`s through any subscribed listener.
 */
function makeScriptedSession(
  sessionId: string,
  script: readonly Event[],
): {
  session: Session;
  unsubscribeCount: () => number;
} {
  const listeners = new Set<(event: Event) => void>();
  let unsubCount = 0;
  const emit = (event: Event, promptId: string | undefined): void => {
    const correlatedEvent =
      event.type === 'turn.started' &&
      event.origin.kind === 'user' &&
      event.origin.promptId === undefined
        ? ({ ...event, origin: { ...event.origin, promptId } } as Event)
        : event;
    for (const fn of listeners) fn(correlatedEvent);
  };
  const session = {
    id: sessionId,
    prompt: async (
      _input: unknown,
      options?: { readonly promptId?: string },
    ) => {
      // Emit asynchronously so the caller has time to set `settled`
      // before the first event lands (matches real RPC ordering).
      if (!script.some((event) => event.type === 'turn.started')) {
        const firstTurnEvent = script.find(
          (event): event is Event & { turnId: number } =>
            'turnId' in event && typeof event.turnId === 'number',
        );
        if (firstTurnEvent !== undefined) {
          emit(
            {
              type: 'turn.started',
              sessionId,
              agentId: 'main',
              turnId: firstTurnEvent.turnId,
              origin: { kind: 'user', promptId: options?.promptId },
            } as Event,
            options?.promptId,
          );
        }
      }
      for (const ev of script) {
        emit(ev, options?.promptId);
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

function makeControlledAdmissionSession(
  sessionId: string,
  onPrompt: (
    promptId: string,
    call: number,
    emit: (event: Event) => void,
  ) => Promise<void> | void,
): {
  readonly session: Session;
  readonly listeners: ReadonlySet<(event: Event) => void>;
  emit(event: Event): void;
} {
  const listeners = new Set<(event: Event) => void>();
  let promptCalls = 0;
  const emit = (event: Event): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    session: {
      id: sessionId,
      prompt: async (
        _input: unknown,
        options?: { readonly promptId?: string },
      ) => {
        const promptId = options?.promptId;
        if (promptId === undefined) throw new Error('ACP did not correlate the SDK prompt');
        promptCalls += 1;
        await onPrompt(promptId, promptCalls, emit);
      },
      cancel: async () => undefined,
      onEvent: (listener: (event: Event) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as Session,
    listeners,
    emit,
  };
}

function promptCompletedEvent(
  sessionId: string,
  promptId: string,
  reason: 'completed' | 'failed' | 'blocked',
): Event {
  return {
    type: 'prompt.completed',
    sessionId,
    agentId: 'main',
    promptId,
    finishedAt: '2026-01-01T00:00:00.000Z',
    reason,
  } as Event;
}

function directAcpSession(session: Session): AcpSession {
  return new AcpSession(
    { sessionUpdate: async () => undefined } as unknown as AgentSideConnection,
    session,
  );
}

describe('AcpServer session/prompt', () => {
  it('streams two AssistantDelta events as agent_message_chunk updates and resolves with end_turn', async () => {
    const sessionId = 'sess-A';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, [
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'hel' } as Event,
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'lo' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const updatesReceived = collecting.waitForPromptUpdates(2);
    const response = await client.prompt({
      sessionId,
      prompt: [textBlock('hi')],
    });

    expect(response.stopReason).toBe('end_turn');
    await updatesReceived;

    expect(collecting.promptUpdates).toHaveLength(2);
    for (const note of collecting.promptUpdates) {
      expect(note.sessionId).toBe(sessionId);
    }
    const first = collecting.promptUpdates[0]?.update;
    const second = collecting.promptUpdates[1]?.update;
    expect(first).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hel' },
    });
    expect(second).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'lo' },
    });

    // Listener must be unsubscribed exactly once after turn.ended fires.
    expect(unsubscribeCount()).toBe(1);
  });

  it('resolves with cancelled stopReason when turn.ended reason is cancelled', async () => {
    const sessionId = 'sess-B';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, [
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'partial' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'cancelled' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const response = await client.prompt({
      sessionId,
      prompt: [textBlock('do something long')],
    });

    expect(response.stopReason).toBe('cancelled');
    expect(unsubscribeCount()).toBe(1);
  });

  it('rejects prompt with invalid_params when sessionId is unknown', async () => {
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => {
        throw new Error('createSession should not be called for unknown-id test');
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await expect(
      client.prompt({ sessionId: 'sess-does-not-exist', prompt: [textBlock('hi')] }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('rejects prompt (and unsubscribes) when underlying session.prompt rejects', async () => {
    const sessionId = 'sess-C';
    const listeners = new Set<(event: Event) => void>();
    let unsubCount = 0;
    const session = {
      id: sessionId,
      prompt: async (_input: unknown) => {
        throw new Error('boom from session.prompt');
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

    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    await expect(
      client.prompt({ sessionId, prompt: [textBlock('hi')] }),
    ).rejects.toBeDefined();
    expect(unsubCount).toBe(1);
  });

  it('rejects prompt when the SDK emits a turn.agent_busy error event', async () => {
    const sessionId = 'sess-busy';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, [
      {
        type: 'error',
        sessionId,
        agentId: 'main',
        code: 'turn.agent_busy',
        message: 'Cannot launch a new turn while another turn (ID 0) is active',
        details: { turnId: 0 },
        retryable: true,
      } as unknown as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    await expect(
      client.prompt({ sessionId, prompt: [textBlock('hi')] }),
    ).rejects.toMatchObject({ code: -32600 });
    expect(unsubscribeCount()).toBe(1);
  });

  it('does not reject an already-started prompt when a later prompt gets busy', async () => {
    const sessionId = 'sess-busy-active';
    const listeners = new Set<(event: Event) => void>();
    let unsubCount = 0;
    let promptCall = 0;
    let firstError: unknown;
    let resolveFirstTurn: (() => void) | undefined;
    const firstTurn = new Promise<void>((resolve) => {
      resolveFirstTurn = () => {
        resolve();
      };
    });
    void firstTurn.then(() => {
      for (const fn of listeners) {
        fn({ type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event);
      }
    });
    const session = {
      id: sessionId,
      prompt: async (
        _input: unknown,
        options?: { readonly promptId?: string },
      ) => {
        promptCall += 1;
        await Promise.resolve();
        if (promptCall === 1) {
          for (const fn of listeners) {
            fn({
              type: 'turn.started',
              sessionId,
              agentId: 'main',
              turnId: 1,
              origin: { kind: 'user', promptId: options?.promptId },
            } as unknown as Event);
          }
          await firstTurn;
          return;
        }
        for (const fn of listeners) {
          fn({
            type: 'error',
            sessionId,
            agentId: 'main',
            code: 'turn.agent_busy',
            message: 'Cannot launch a new turn while another turn (ID 1) is active',
            details: { turnId: 1 },
            retryable: true,
          } as unknown as Event);
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
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const firstPrompt = client
      .prompt({ sessionId, prompt: [textBlock('active')] })
      .then(
        (response) => response,
        (error) => {
          firstError = error;
          throw error;
        },
      );
    await Promise.resolve();

    await expect(
      client.prompt({ sessionId, prompt: [textBlock('busy')] }),
    ).rejects.toMatchObject({ code: -32600 });
    expect(firstError).toBeUndefined();

    resolveFirstTurn?.();
    await expect(firstPrompt).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(unsubCount).toBe(2);
  });

  it('ignores a subagent turn.ended and resolves on the main agent turn.ended', async () => {
    const sessionId = 'sess-subagent';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, [
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'a' } as Event,
      { type: 'assistant.delta', sessionId, agentId: 'sub-1', turnId: 99, delta: 'leak' } as Event,
      { type: 'thinking.delta', sessionId, agentId: 'sub-1', turnId: 99, delta: 'leak' } as Event,
      {
        type: 'tool.call.started',
        sessionId,
        agentId: 'sub-1',
        turnId: 99,
        toolCallId: 'sub-tool',
        name: 'Shell',
        args: { command: 'echo leak' },
      } as Event,
      {
        type: 'tool.result',
        sessionId,
        agentId: 'sub-1',
        turnId: 99,
        toolCallId: 'sub-tool',
        output: 'leak',
      } as Event,
      // A subagent finishes its own turn while the main turn is still
      // running. Pre-fix this would resolve the parent prompt with
      // `end_turn` and leak the listener; post-fix it must be ignored.
      {
        type: 'turn.ended',
        sessionId,
        agentId: 'sub-1',
        turnId: 99,
        reason: 'completed',
      } as Event,
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'b' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const updatesReceived = collecting.waitForPromptUpdates(2);
    const response = await client.prompt({
      sessionId,
      prompt: [textBlock('hi')],
    });

    expect(response.stopReason).toBe('end_turn');
    await updatesReceived;
    expect(collecting.promptUpdates).toHaveLength(2);
    expect(unsubscribeCount()).toBe(1);
  });

  it('dispose rejects active and queued prompt admissions and releases their listeners', async () => {
    const sessionId = 'sess-dispose-prompts';
    const listeners = new Set<(event: Event) => void>();
    let promptCallCount = 0;
    let resolveFirstPromptCalled: (() => void) | undefined;
    const firstPromptCalled = new Promise<void>((resolve) => {
      resolveFirstPromptCalled = resolve;
    });
    const session = {
      id: sessionId,
      prompt: () => {
        promptCallCount += 1;
        resolveFirstPromptCalled?.();
        return new Promise<void>(() => undefined);
      },
      cancel: async () => undefined,
      onEvent: (listener: (event: Event) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as Session;
    const connection = {
      sessionUpdate: async () => undefined,
    } as unknown as AgentSideConnection;
    const acpSession = new AcpSession(connection, session);

    const firstResult = acpSession
      .prompt([textBlock('first')])
      .then(
        (response) => response,
        (error: unknown) => error,
      );
    const secondResult = acpSession
      .prompt([textBlock('second')])
      .then(
        (response) => response,
        (error: unknown) => error,
      );

    await firstPromptCalled;
    expect(promptCallCount).toBe(1);

    acpSession.dispose();

    await expect(firstResult).resolves.toMatchObject({ code: -32603 });
    await expect(secondResult).resolves.toMatchObject({ code: -32603 });
    expect(listeners.size).toBe(0);
  });

  it('dispose is idempotent for the session-lifetime event subscription', () => {
    const listeners = new Set<(event: Event) => void>();
    let unsubscribeCount = 0;
    const session = {
      id: 'sess-dispose-idempotent',
      cancel: async () => undefined,
      onEvent: (listener: (event: Event) => void) => {
        listeners.add(listener);
        return () => {
          unsubscribeCount += 1;
          listeners.delete(listener);
        };
      },
    } as unknown as Session;
    const acpSession = directAcpSession(session);

    acpSession.dispose();
    acpSession.dispose();

    expect(unsubscribeCount).toBe(1);
    expect(listeners.size).toBe(0);
  });

  it('releases owned interaction handlers when event registration fails', () => {
    let approvalHandler: ApprovalHandler | undefined;
    let questionHandler: QuestionHandler | undefined;
    let approvalReleases = 0;
    let questionReleases = 0;
    const session = {
      id: 'sess-construction-cleanup',
      registerApprovalHandler: (handler: ApprovalHandler) => {
        approvalHandler = handler;
        return () => {
          approvalReleases += 1;
          if (approvalHandler === handler) approvalHandler = undefined;
        };
      },
      registerQuestionHandler: (handler: QuestionHandler) => {
        questionHandler = handler;
        return () => {
          questionReleases += 1;
          if (questionHandler === handler) questionHandler = undefined;
        };
      },
      onEvent: () => {
        throw new Error('event registration failed');
      },
    } as unknown as Session;

    expect(
      () => new AcpSession({} as AgentSideConnection, session),
    ).toThrow('event registration failed');

    expect(approvalHandler).toBeUndefined();
    expect(questionHandler).toBeUndefined();
    expect(approvalReleases).toBe(1);
    expect(questionReleases).toBe(1);
  });

  it('rejects prompts after dispose without calling the SDK session', async () => {
    let promptCallCount = 0;
    const session = {
      id: 'sess-prompt-after-dispose',
      prompt: () => {
        promptCallCount += 1;
        return Promise.resolve();
      },
      cancel: async () => undefined,
      onEvent: () => () => undefined,
    } as unknown as Session;
    const acpSession = directAcpSession(session);
    acpSession.dispose();

    await expect(acpSession.prompt([textBlock('after dispose')])).rejects.toMatchObject({
      code: -32603,
    });
    await expect(acpSession.prompt([textBlock('/help')])).rejects.toMatchObject({
      code: -32603,
    });
    expect(promptCallCount).toBe(0);
  });

  it.each([
    { reason: 'blocked' as const, wrongReason: 'failed' as const, stopReason: 'refusal' as const },
    { reason: 'failed' as const, wrongReason: 'blocked' as const, stopReason: 'end_turn' as const },
  ])(
    'settles a correlated no-turn $reason completion and ignores another prompt id',
    async ({ reason, wrongReason, stopReason }) => {
      const sessionId = `sess-no-turn-${reason}`;
      const controlled = makeControlledAdmissionSession(
        sessionId,
        (promptId, _call, emit) => {
          emit(promptCompletedEvent(sessionId, 'different-prompt', wrongReason));
          emit(promptCompletedEvent(sessionId, promptId, reason));
        },
      );
      const acpSession = directAcpSession(controlled.session);

      await expect(acpSession.prompt([textBlock('hello')])).resolves.toEqual({ stopReason });
      expect(controlled.listeners.size).toBe(1);
      acpSession.dispose();
      expect(controlled.listeners.size).toBe(0);
    },
  );

  it('ignores prompt.completed after the correlated turn has started', async () => {
    const sessionId = 'sess-completion-after-turn';
    const controlled = makeControlledAdmissionSession(
      sessionId,
      (promptId, _call, emit) => {
        emit({
          type: 'turn.started',
          sessionId,
          agentId: 'main',
          turnId: 7,
          origin: { kind: 'user', promptId },
        } as Event);
        emit(promptCompletedEvent(sessionId, promptId, 'blocked'));
        emit({
          type: 'turn.ended',
          sessionId,
          agentId: 'main',
          turnId: 7,
          reason: 'completed',
        } as Event);
      },
    );
    const acpSession = directAcpSession(controlled.session);

    await expect(acpSession.prompt([textBlock('hello')])).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(controlled.listeners.size).toBe(1);
    acpSession.dispose();
  });

  it('waits for turn.ended when the launch promise rejects after the correlated turn starts', async () => {
    const sessionId = 'sess-kick-rejects-after-start';
    const listeners = new Set<(event: Event) => void>();
    const emit = (event: Event): void => {
      for (const listener of listeners) listener(event);
    };
    let rejectKick: ((error: Error) => void) | undefined;
    const kickResult = new Promise<void>((_resolve, reject) => {
      rejectKick = reject;
    });
    let resolveTurnStarted: (() => void) | undefined;
    const turnStarted = new Promise<void>((resolve) => {
      resolveTurnStarted = resolve;
    });
    const session = {
      id: sessionId,
      prompt: (
        _input: unknown,
        options?: { readonly promptId?: string },
      ) => {
        const promptId = options?.promptId;
        if (promptId === undefined) throw new Error('ACP did not correlate the SDK prompt');
        emit({
          type: 'turn.started',
          sessionId,
          agentId: 'main',
          turnId: 8,
          origin: { kind: 'user', promptId },
        } as Event);
        resolveTurnStarted?.();
        return kickResult;
      },
      cancel: async () => undefined,
      onEvent: (listener: (event: Event) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as Session;
    const acpSession = directAcpSession(session);
    const outcome = acpSession.prompt([textBlock('hello')]).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );

    await turnStarted;
    rejectKick?.(new Error('metadata update failed after launch'));
    await Promise.resolve();
    emit({
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId: 8,
      reason: 'completed',
    } as Event);

    await expect(outcome).resolves.toEqual({
      response: { stopReason: 'end_turn' },
    });
    acpSession.dispose();
  });

  it('settles once when duplicate no-turn completions race a rejected kick', async () => {
    const sessionId = 'sess-completion-kick-race';
    const controlled = makeControlledAdmissionSession(
      sessionId,
      async (promptId, _call, emit) => {
        emit(promptCompletedEvent(sessionId, promptId, 'blocked'));
        emit(promptCompletedEvent(sessionId, promptId, 'failed'));
        throw new Error('late kick rejection');
      },
    );
    const acpSession = directAcpSession(controlled.session);

    await expect(acpSession.prompt([textBlock('hello')])).resolves.toEqual({
      stopReason: 'refusal',
    });
    await Promise.resolve();
    expect(controlled.listeners.size).toBe(1);
    acpSession.dispose();
  });

  it('advances a queued prompt after a no-turn completion releases admission', async () => {
    const sessionId = 'sess-no-turn-queue';
    let resolveFirstKicked: ((promptId: string) => void) | undefined;
    const firstKicked = new Promise<string>((resolve) => {
      resolveFirstKicked = resolve;
    });
    let resolveSecondKicked: (() => void) | undefined;
    const secondKicked = new Promise<void>((resolve) => {
      resolveSecondKicked = resolve;
    });
    const controlled = makeControlledAdmissionSession(
      sessionId,
      (promptId, call, emit) => {
        if (call === 1) {
          resolveFirstKicked?.(promptId);
          return new Promise<void>(() => undefined);
        }
        emit(promptCompletedEvent(sessionId, promptId, 'failed'));
        resolveSecondKicked?.();
      },
    );
    const acpSession = directAcpSession(controlled.session);

    const first = acpSession.prompt([textBlock('first')]);
    const second = acpSession.prompt([textBlock('second')]);
    const firstPromptId = await firstKicked;
    controlled.emit(promptCompletedEvent(sessionId, firstPromptId, 'blocked'));

    await expect(first).resolves.toEqual({ stopReason: 'refusal' });
    await secondKicked;
    await expect(second).resolves.toEqual({ stopReason: 'end_turn' });
    expect(controlled.listeners.size).toBe(1);
    acpSession.dispose();
  });
});
