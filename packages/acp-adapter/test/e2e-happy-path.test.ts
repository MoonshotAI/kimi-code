/**
 * End-to-end "happy path" exercise:
 *
 *   initialize → session/new → session/prompt → end_turn
 *
 * The test wires an `AgentSideConnection` and a `ClientSideConnection`
 * over an in-memory NDJSON pipe (matching `test/e2e-fs.test.ts`'s
 * Phase 6 pattern), drives the full ACP handshake from the client
 * side, and asserts:
 *
 *  1. `initialize` returns the documented capability matrix
 *     (PLAN D4: image=true, audio=false, embeddedContext=true,
 *      mcp.http=true, mcp.sse=true, loadSession=true,
 *      sessionCapabilities.list={}).
 *  2. `session/new` returns a non-empty sessionId.
 *  3. `session/prompt` streams at least one `agent_message_chunk`
 *     update and resolves with `stopReason: 'end_turn'`.
 *  4. `session/cancel` mid-stream resolves the prompt with
 *     `stopReason: 'cancelled'` and does not throw.
 *  5. A main-agent turn started by the runtime while no ACP prompt is
 *     in flight still streams its `session/update` notifications.
 *
 * The `promptUpdates` getter filters out the `available_commands_update`
 * one-shot that `newSession` emits (Phase 9), matching the pattern
 * established in `test/session-prompt.test.ts:24-37`.
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
  ApprovalRequest,
  ApprovalResponse,
  Event,
  KimiHarness,
  QuestionAnswers,
  QuestionHandler,
  QuestionRequest,
  QuestionResult,
  Session,
} from '@moonshot-ai/kimi-code-sdk';

import { AcpServer, runAcpServerWithStream } from '../src/server';
import { AUTHED_STATUS, makeModelsMap } from './_helpers/harness-stubs';

class CollectingClient implements Client {
  readonly updates: SessionNotification[] = [];
  private readonly updateWaiters = new Set<{
    readonly predicate: (notification: SessionNotification) => boolean;
    readonly resolve: (notification: SessionNotification) => void;
  }>();

  /**
   * Filters out the `available_commands_update` one-shot that
   * `session/new` emits (Phase 9), so prompt-update assertions only
   * see chunks produced by the actual turn.
   */
  get promptUpdates(): readonly SessionNotification[] {
    return this.updates.filter(
      (n) =>
        (n.update as { sessionUpdate?: string }).sessionUpdate !==
        'available_commands_update',
    );
  }

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('CollectingClient.requestPermission should not be called in happy-path test');
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
    throw new Error('CollectingClient.writeTextFile should not be called in happy-path test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CollectingClient.readTextFile should not be called in happy-path test');
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

class InteractionClient extends CollectingClient {
  readonly permissionRequests: RequestPermissionRequest[] = [];

  override async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(request);
    const option = request.options[0];
    if (option === undefined) {
      return { outcome: { outcome: 'cancelled' } };
    }
    return {
      outcome: { outcome: 'selected', optionId: option.optionId },
    };
  }
}

function makeInMemoryStreamPair(): {
  agentStream: ReturnType<typeof ndJsonStream>;
  clientStream: ReturnType<typeof ndJsonStream>;
  closeAgentInput: () => Promise<void>;
  closeClientInput: () => Promise<void>;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
  return {
    agentStream,
    clientStream,
    closeAgentInput: () => clientToAgent.writable.close(),
    closeClientInput: () => agentToClient.writable.close(),
  };
}

/**
 * Build a scripted Session whose `prompt()` synchronously emits a
 * pre-recorded sequence of `Event`s through any subscribed listener.
 * `onEvent` tracks listener registrations so the test can assert the
 * prompt-completion listener unsubscribes after `turn.ended`; the
 * session-lifetime projection listener intentionally remains registered.
 */
function makeScriptedSession(
  sessionId: string,
  script: readonly Event[],
): {
  session: Session;
  emit: (event: Event) => void;
  listenerCount: () => number;
  promptCalled: Promise<void>;
  unsubscribeCount: () => number;
} {
  const listeners = new Set<(event: Event) => void>();
  let unsubCount = 0;
  let signalPromptCalled!: () => void;
  const promptCalled = new Promise<void>((resolve) => {
    signalPromptCalled = resolve;
  });
  let promptId: string | undefined;
  const emit = (event: Event): void => {
    const correlatedEvent =
      event.type === 'turn.started' &&
      event.origin.kind === 'user' &&
      event.origin.promptId === undefined
        ? ({
            ...event,
            origin: { ...event.origin, promptId },
          } as Event)
        : event;
    for (const listener of listeners) listener(correlatedEvent);
  };
  const session = {
    id: sessionId,
    prompt: async (
      _input: unknown,
      options?: { readonly promptId?: string },
    ) => {
      promptId = options?.promptId;
      signalPromptCalled();
      if (!script.some((event) => event.type === 'turn.started')) {
        const firstTurnEvent = script.find(
          (event): event is Event & { turnId: number } =>
            'turnId' in event && typeof event.turnId === 'number',
        );
        if (firstTurnEvent !== undefined) {
          emit({
            type: 'turn.started',
            sessionId,
            agentId: 'main',
            turnId: firstTurnEvent.turnId,
            origin: { kind: 'user', promptId },
          } as Event);
        }
      }
      for (const ev of script) {
        emit(ev);
      }
    },
    cancel: async () => undefined,
    getContext: async () => ({ history: [], tokenCount: 0 }),
    onEvent: (fn: (event: Event) => void) => {
      listeners.add(fn);
      return () => {
        unsubCount += 1;
        listeners.delete(fn);
      };
    },
  } as unknown as Session;
  return {
    session,
    emit,
    listenerCount: () => listeners.size,
    promptCalled,
    unsubscribeCount: () => unsubCount,
  };
}

function makeHarness(session: Session): KimiHarness {
  return {
    auth: { status: async () => AUTHED_STATUS },
    createSession: async () => session,
    resumeSession: async () => session,
    // Phase 14: server.newSession reads these for configOptions.
    getConfig: async () => ({
      providers: {},
      defaultModel: 'kimi-coder',
      models: makeModelsMap([{ id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: false }]),
    }),
  } as unknown as KimiHarness;
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

describe('AcpServer end-to-end happy path', () => {
  it('initialize advertises the documented capability matrix (PLAN D4)', async () => {
    // No session-side work here — just exercise the `initialize`
    // handshake to lock the capability surface. `createSession` would
    // throw if it were ever called.
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => {
        throw new Error('createSession should not be called from initialize-only test');
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    const response = await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    });

    // ACP `protocolVersion` is the integer the server agreed on; we
    // just assert it is a number — Phase 1 already pins the exact
    // negotiated value in version.test.ts.
    expect(typeof response.protocolVersion).toBe('number');

    expect(response.agentCapabilities).toMatchObject({
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: true,
      },
      mcpCapabilities: {
        http: true,
        sse: true,
      },
      sessionCapabilities: {
        list: {},
        resume: {},
      },
    });

    // Phase 10 does not supply agentInfo; authMethods advertises terminal-auth.
    expect(response.agentInfo).toBeUndefined();
    expect(response.authMethods).toHaveLength(1);
    expect(response.authMethods?.[0]).toMatchObject({
      id: 'login',
      type: 'terminal',
      args: ['--login'],
    });
  });

  it('drives the full happy path: initialize → newSession → prompt(end_turn)', async () => {
    const sessionId = 'sess-e2e-happy';
    const { session, unsubscribeCount } = makeScriptedSession(sessionId, [
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'echo ' } as Event,
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'hi' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event,
    ]);
    const harness = makeHarness(session);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    // 1. initialize
    const init = await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    expect(init.agentCapabilities?.mcpCapabilities?.http).toBe(true);

    // 2. session/new
    const newRes = await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    expect(newRes.sessionId).toBe(sessionId);
    expect(typeof newRes.sessionId).toBe('string');
    expect(newRes.sessionId.length).toBeGreaterThan(0);
    // Phase 14 (PLAN D11) configOptions advertisement — replaces
    // Phase 12.1's dedicated `modes:` field on NewSessionResponse with
    // the spec's generic `configOptions:` surface. The dedicated field
    // must be gone, and the mode picker still reports `currentValue:
    // 'default'` (Phase 12.1 default mode).
    expect(newRes.modes).toBeUndefined();
    expect(
      newRes.configOptions?.find((o) => o.id === 'mode')?.currentValue,
    ).toBe('default');
    expect(newRes.configOptions?.length).toBe(2);

    // 3. session/prompt
    const promptRes = await client.prompt({
      sessionId,
      prompt: [textBlock('echo hi')],
    });
    expect(promptRes.stopReason).toBe('end_turn');

    await collecting.waitForUpdate(
      (notification) =>
        notification.update.sessionUpdate === 'agent_message_chunk' &&
        notification.update.content.type === 'text' &&
        notification.update.content.text.length > 0,
    );

    const promptOnlyUpdates = collecting.promptUpdates;
    expect(promptOnlyUpdates.length).toBeGreaterThanOrEqual(1);

    // At least one chunk must be non-empty text on this session id.
    const firstChunk = promptOnlyUpdates[0]?.update as {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
    };
    expect(firstChunk.sessionUpdate).toBe('agent_message_chunk');
    expect(firstChunk.content?.type).toBe('text');
    expect(firstChunk.content?.text).toBeTruthy();
    for (const note of promptOnlyUpdates) {
      expect(note.sessionId).toBe(sessionId);
    }

    // Listener was unsubscribed when turn.ended landed.
    expect(unsubscribeCount()).toBe(1);
  });

  it('streams display-safe task and cron triggers with their autonomous replies', async () => {
    const sessionId = 'sess-e2e-agent-initiated';
    const origin = {
      kind: 'background_task',
      taskId: 'task-example',
      status: 'completed',
      notificationId: 'task:task-example:completed',
    } as const;
    const privateStopReason = 'sensitive task stop detail';
    const { session, emit } = makeScriptedSession(sessionId, []);
    const harness = makeHarness(session);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    const agentConnection = new AgentSideConnection(
      (connection) => new AcpServer(harness, connection),
      agentStream,
    );
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    emit({
      type: 'background.task.terminated',
      sessionId,
      agentId: 'main',
      info: {
        kind: 'agent',
        taskId: 'task-example',
        agentId: 'agent-example',
        description: '   ',
        status: 'completed',
        detached: true,
        startedAt: 1,
        endedAt: 2,
        stopReason: privateStopReason,
      },
    } as Event);
    emit({
      type: 'turn.started',
      sessionId,
      agentId: 'main',
      turnId: 2,
      origin,
    } as Event);
    emit({
      type: 'turn.step.started',
      sessionId,
      agentId: 'main',
      turnId: 2,
      step: 1,
    } as Event);
    emit({
      type: 'assistant.delta',
      sessionId,
      agentId: 'main',
      turnId: 2,
      delta: 'Background work finished.',
    } as Event);
    emit({
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId: 2,
      reason: 'completed',
    } as Event);
    emit({
      type: 'turn.started',
      sessionId,
      agentId: 'main',
      turnId: 3,
      origin: {
        kind: 'cron_job',
        jobId: 'cron-example',
        cron: '0 9 * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
      },
    } as Event);
    // v2 publishes cron.fired immediately after the injected step is assigned,
    // so turn.started may precede the display event. It still arrives before
    // the model's streaming output and must become the user-side chunk.
    emit({
      type: 'cron.fired',
      sessionId,
      agentId: 'main',
      origin: {
        kind: 'cron_job',
        jobId: 'cron-example',
        cron: '0 9 * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
      },
      prompt: 'Review the scheduled report.',
    } as Event);
    emit({
      type: 'assistant.delta',
      sessionId,
      agentId: 'main',
      turnId: 3,
      delta: 'Scheduled review finished.',
    } as Event);
    emit({
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId: 3,
      reason: 'completed',
    } as Event);

    const barrier = collecting.waitForUpdate(
      (notification) =>
        (notification.update._meta as { barrier?: string } | null | undefined)?.barrier ===
        'after-autonomous-turn',
    );
    await agentConnection.sessionUpdate({
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
        _meta: { barrier: 'after-autonomous-turn' },
      },
      sessionId,
    });
    await barrier;

    // ACP projects only the display-safe task lifecycle summary. Internal
    // task identifiers and stop details must not cross the wire.
    expect(collecting.promptUpdates).toEqual([
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Background agent task completed.' },
        }),
      }),
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Background work finished.' },
        }),
      }),
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Review the scheduled report.' },
        }),
      }),
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Scheduled review finished.' },
        }),
      }),
    ]);
    const wire = JSON.stringify(collecting.updates);
    expect(wire).not.toContain(privateStopReason);
    expect(wire).not.toContain('task-example');
    expect(wire).not.toContain('agent-example');
  });

  it('attaches a new-session bridge only after asynchronous configuration finishes', async () => {
    const sessionId = 'sess-e2e-agent-initiated-setup';
    const { session, emit, listenerCount } = makeScriptedSession(sessionId, []);
    let signalConfigStarted!: () => void;
    const configStarted = new Promise<void>((resolve) => {
      signalConfigStarted = resolve;
    });
    let releaseConfig!: () => void;
    const configGate = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
      getConfig: async () => {
        signalConfigStarted();
        await configGate;
        return {
          providers: {},
          defaultModel: 'kimi-coder',
          models: makeModelsMap([
            { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: false },
          ]),
        };
      },
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection(
      (connection) => new AcpServer(harness, connection),
      agentStream,
    );
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    const newSession = client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    await configStarted;
    expect(listenerCount()).toBe(0);

    emit({
      type: 'turn.started',
      sessionId,
      agentId: 'main',
      turnId: 4,
      origin: {
        kind: 'background_task',
        taskId: 'task-during-setup',
        status: 'completed',
        notificationId: 'task:task-during-setup:completed',
      },
    } as Event);
    emit({
      type: 'assistant.delta',
      sessionId,
      agentId: 'main',
      turnId: 4,
      delta: 'Must not precede the session response.',
    } as Event);
    emit({
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId: 4,
      reason: 'completed',
    } as Event);

    releaseConfig();
    await newSession;
    expect(listenerCount()).toBe(1);
    expect(collecting.promptUpdates).toEqual([]);

    const postResponseUpdate = collecting.waitForUpdate(
      (notification) =>
        (notification.update as {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
        }).sessionUpdate === 'agent_message_chunk' &&
        (notification.update as { content?: { text?: string } }).content?.text ===
          'Visible after the session response.',
    );
    emit({
      type: 'turn.started',
      sessionId,
      agentId: 'main',
      turnId: 5,
      origin: {
        kind: 'background_task',
        taskId: 'task-after-setup',
        status: 'completed',
        notificationId: 'task:task-after-setup:completed',
      },
    } as Event);
    emit({
      type: 'assistant.delta',
      sessionId,
      agentId: 'main',
      turnId: 5,
      delta: 'Visible after the session response.',
    } as Event);
    emit({
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId: 5,
      reason: 'completed',
    } as Event);
    await postResponseUpdate;

    expect(collecting.promptUpdates).toEqual([
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Visible after the session response.' },
        }),
      }),
    ]);
  });

  it("waits for a queued prompt's turn when an autonomous turn is already active", async () => {
    const sessionId = 'sess-e2e-agent-initiated-queue';
    const { session, emit } = makeScriptedSession(sessionId, [
      {
        type: 'turn.ended',
        sessionId,
        agentId: 'main',
        turnId: 5,
        reason: 'cancelled',
      } as Event,
      {
        type: 'turn.started',
        sessionId,
        agentId: 'main',
        turnId: 6,
        origin: { kind: 'user' },
      } as Event,
      {
        type: 'turn.ended',
        sessionId,
        agentId: 'main',
        turnId: 6,
        reason: 'completed',
      } as Event,
    ]);
    const harness = makeHarness(session);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    const agentConnection = new AgentSideConnection(
      (connection) => new AcpServer(harness, connection),
      agentStream,
    );
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    emit({
      type: 'turn.started',
      sessionId,
      agentId: 'main',
      turnId: 5,
      origin: {
        kind: 'background_task',
        taskId: 'task-before-prompt',
        status: 'completed',
        notificationId: 'task:task-before-prompt:completed',
      },
    } as Event);

    await expect(
      client.prompt({ sessionId, prompt: [textBlock('queued prompt')] }),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(agentConnection.signal.aborted).toBe(false);
  });

  it('does not complete an attached prompt from an autonomous turn that started before attach', async () => {
    const sessionId = 'sess-e2e-agent-initiated-attach-mid-turn';
    const { session } = makeScriptedSession(sessionId, [
      {
        type: 'turn.ended',
        sessionId,
        agentId: 'main',
        turnId: 20,
        reason: 'cancelled',
      } as Event,
      {
        type: 'turn.started',
        sessionId,
        agentId: 'main',
        turnId: 21,
        origin: { kind: 'user' },
      } as Event,
      {
        type: 'turn.ended',
        sessionId,
        agentId: 'main',
        turnId: 21,
        reason: 'completed',
      } as Event,
    ]);
    const harness = makeHarness(session);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((connection) => new AcpServer(harness, connection), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    // Turn 20 began before the adapter attached, so the bridge has no
    // `turn.started` fact for it. Its terminal event must still remain
    // unowned rather than completing the newly submitted ACP prompt.
    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    await expect(
      client.prompt({ sessionId, prompt: [textBlock('owned prompt')] }),
    ).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('does not claim an autonomous turn that starts while the prompt is being enqueued', async () => {
    const sessionId = 'sess-e2e-agent-initiated-enqueue-race';
    const { session } = makeScriptedSession(sessionId, [
      {
        type: 'turn.started',
        sessionId,
        agentId: 'main',
        turnId: 30,
        origin: {
          kind: 'background_task',
          taskId: 'task-during-enqueue',
          status: 'completed',
          notificationId: 'task:task-during-enqueue:completed',
        },
      } as Event,
      {
        type: 'turn.ended',
        sessionId,
        agentId: 'main',
        turnId: 30,
        reason: 'cancelled',
      } as Event,
      {
        type: 'turn.started',
        sessionId,
        agentId: 'main',
        turnId: 31,
        origin: { kind: 'user' },
      } as Event,
      {
        type: 'turn.ended',
        sessionId,
        agentId: 'main',
        turnId: 31,
        reason: 'completed',
      } as Event,
    ]);
    const harness = makeHarness(session);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((connection) => new AcpServer(harness, connection), agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    await expect(
      client.prompt({ sessionId, prompt: [textBlock('queued behind runtime work')] }),
    ).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it.each(['resume', 'load'] as const)(
    'preserves prompt ownership and tool projection across same-session %s',
    async (reattachMode) => {
      const sessionId = `sess-e2e-mid-tool-${reattachMode}`;
      const turnId = 40;
      const toolCallId = 'tool-mid-reattach';
      const {
        session,
        emit,
        promptCalled,
      } = makeScriptedSession(sessionId, []);
      const harness = makeHarness(session);

      const { agentStream, clientStream } = makeInMemoryStreamPair();
      const agentConnection = new AgentSideConnection(
        (connection) => new AcpServer(harness, connection),
        agentStream,
      );
      const collecting = new CollectingClient();
      const client = new ClientSideConnection(() => collecting, clientStream);

      await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
      const promptOutcome = client
        .prompt({ sessionId, prompt: [textBlock('continue through reattach')] })
        .then(
          (response) => ({ ok: true as const, response }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await promptCalled;

      emit({
        type: 'turn.started',
        sessionId,
        agentId: 'main',
        turnId,
        origin: { kind: 'user' },
      } as Event);
      emit({
        type: 'tool.call.delta',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        name: 'Read',
        argumentsPart: '{"path":',
      } as Event);
      await collecting.waitForUpdate(
        (notification) =>
          (notification.update as { sessionUpdate?: string; toolCallId?: string })
            .sessionUpdate === 'tool_call' &&
          (notification.update as { toolCallId?: string }).toolCallId ===
            `${turnId}:${toolCallId}`,
      );

      if (reattachMode === 'resume') {
        await client.resumeSession({ sessionId, cwd: '/tmp/work', mcpServers: [] });
      } else {
        await client.loadSession({ sessionId, cwd: '/tmp/work', mcpServers: [] });
      }
      emit({
        type: 'tool.call.started',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        name: 'Read',
        args: { path: '/tmp/example.txt' },
        description: 'Reading example file',
      } as Event);
      emit({
        type: 'turn.ended',
        sessionId,
        agentId: 'main',
        turnId,
        reason: 'completed',
      } as Event);

      const barrier = collecting.waitForUpdate(
        (notification) =>
          (notification.update._meta as { barrier?: string } | null | undefined)?.barrier ===
          `after-mid-tool-${reattachMode}`,
      );
      await agentConnection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [],
          _meta: { barrier: `after-mid-tool-${reattachMode}` },
        },
      });
      await barrier;

      expect(await promptOutcome).toEqual({
        ok: true,
        response: { stopReason: 'end_turn' },
      });
      expect(
        collecting.promptUpdates
          .filter(
            (notification) =>
              (notification.update as { toolCallId?: string }).toolCallId ===
              `${turnId}:${toolCallId}`,
          )
          .map(
            (notification) =>
              (notification.update as { sessionUpdate?: string }).sessionUpdate,
          ),
      ).toEqual(['tool_call', 'tool_call_update']);
    },
  );

  it('preserves live event order while a cold session resume is materializing', async () => {
    const sessionId = 'sess-e2e-cold-resume-events';
    const { session, listenerCount } = makeScriptedSession(sessionId, []);
    const rawListeners = new Set<(event: Event) => void>();
    let rawUnsubscribeCount = 0;
    const preReturnEvents = [
      {
        type: 'cron.fired',
        sessionId,
        agentId: 'main',
        origin: {
          kind: 'cron_job',
          jobId: 'cron-example',
          cron: '0 9 * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
        prompt: 'Review the scheduled report.',
      },
      {
        type: 'turn.started',
        sessionId,
        agentId: 'main',
        turnId: 7,
        origin: {
          kind: 'cron_job',
          jobId: 'cron-example',
          cron: '0 9 * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
      },
      {
        type: 'assistant.delta',
        sessionId,
        agentId: 'main',
        turnId: 7,
        delta: 'Scheduled review finished.',
      },
      {
        type: 'turn.ended',
        sessionId,
        agentId: 'main',
        turnId: 7,
        reason: 'completed',
      },
    ] as const satisfies readonly Event[];
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      onSessionEvent: (
        subscribedSessionId: string,
        listener: (event: Event) => void,
      ) => {
        expect(subscribedSessionId).toBe(sessionId);
        rawListeners.add(listener);
        return () => {
          if (!rawListeners.delete(listener)) return;
          rawUnsubscribeCount += 1;
        };
      },
      resumeSession: async () => {
        for (const event of preReturnEvents) {
          for (const listener of rawListeners) listener(event);
        }
        return session;
      },
      getConfig: async () => ({
        providers: {},
        defaultModel: 'kimi-coder',
        models: makeModelsMap([
          { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: false },
        ]),
      }),
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    const agentConnection = new AgentSideConnection(
      (connection) => new AcpServer(harness, connection),
      agentStream,
    );
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.resumeSession({ sessionId, cwd: '/tmp/work', mcpServers: [] });
    const barrier = collecting.waitForUpdate(
      (notification) =>
        (notification.update._meta as { barrier?: string } | null | undefined)?.barrier ===
        'after-cold-resume-events',
    );
    await agentConnection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
        _meta: { barrier: 'after-cold-resume-events' },
      },
    });
    await barrier;

    expect(
      collecting.promptUpdates.map((notification) => notification.update),
    ).toEqual([
      expect.objectContaining({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Review the scheduled report.' },
      }),
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Scheduled review finished.' },
      }),
    ]);
    expect(rawListeners.size).toBe(0);
    expect(rawUnsubscribeCount).toBe(1);
    expect(listenerCount()).toBe(1);
  });

  it('holds cold-resume interactions until AcpSession can bridge them', async () => {
    const sessionId = 'sess-e2e-cold-resume-interactions';
    const { session } = makeScriptedSession(sessionId, []);
    let approvalHandler: ApprovalHandler | undefined;
    let questionHandler: QuestionHandler | undefined;
    const registerApproval = (handler: ApprovalHandler): (() => void) => {
      approvalHandler = handler;
      return () => {
        if (approvalHandler === handler) approvalHandler = undefined;
      };
    };
    const registerQuestion = (handler: QuestionHandler): (() => void) => {
      questionHandler = handler;
      return () => {
        if (questionHandler === handler) questionHandler = undefined;
      };
    };
    Object.assign(session, {
      registerApprovalHandler: registerApproval,
      registerQuestionHandler: registerQuestion,
    });

    let signalInteractionsStarted!: () => void;
    const interactionsStarted = new Promise<void>((resolve) => {
      signalInteractionsStarted = resolve;
    });
    let releaseResumeSummary!: () => void;
    const resumeSummaryGate = new Promise<void>((resolve) => {
      releaseResumeSummary = resolve;
    });
    let approvalOutcome: Promise<ApprovalResponse> | undefined;
    let questionOutcome: Promise<QuestionResult> | undefined;
    const approvalRequest: ApprovalRequest = {
      toolCallId: 'tool-resume',
      toolName: 'Bash',
      action: 'run command',
      display: { kind: 'command', command: 'echo ready' },
    };
    const questionRequest: QuestionRequest = {
      toolCallId: 'question-resume',
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    };
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      registerSessionApprovalHandler: (
        _subscribedSessionId: string,
        handler: ApprovalHandler,
      ) => registerApproval(handler),
      registerSessionQuestionHandler: (
        _subscribedSessionId: string,
        handler: QuestionHandler,
      ) => registerQuestion(handler),
      resumeSession: async () => {
        if (approvalHandler === undefined || questionHandler === undefined) {
          throw new Error('resume interactions were not registered before materialization');
        }
        approvalOutcome = Promise.resolve(approvalHandler(approvalRequest));
        questionOutcome = Promise.resolve(questionHandler(questionRequest));
        signalInteractionsStarted();
        await resumeSummaryGate;
        return session;
      },
      getConfig: async () => ({
        providers: {},
        defaultModel: 'kimi-coder',
        models: makeModelsMap([
          { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: false },
        ]),
      }),
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection(
      (connection) => new AcpServer(harness, connection),
      agentStream,
    );
    const collecting = new InteractionClient();
    const client = new ClientSideConnection(() => collecting, clientStream);
    let resumeSettled = false;
    const resume = client
      .resumeSession({ sessionId, cwd: '/tmp/work', mcpServers: [] })
      .finally(() => {
        resumeSettled = true;
      });

    await interactionsStarted;
    expect(resumeSettled).toBe(false);
    expect(collecting.permissionRequests).toEqual([]);

    releaseResumeSummary();
    await resume;
    await expect(approvalOutcome).resolves.toMatchObject({ decision: 'approved' });
    await expect(questionOutcome).resolves.toEqual({
      'Continue?': 'Yes',
    } satisfies QuestionAnswers);
    expect(collecting.permissionRequests).toHaveLength(2);

    // Temporary registration cleanup is ownership-aware: it must not remove
    // the permanent handler AcpSession installed during the handoff.
    if (approvalHandler === undefined) {
      throw new Error('AcpSession approval handler was cleared during handoff');
    }
    if (questionHandler === undefined) {
      throw new Error('AcpSession question handler was cleared during handoff');
    }
    await expect(approvalHandler(approvalRequest)).resolves.toMatchObject({
      decision: 'approved',
    });
    await expect(questionHandler(questionRequest)).resolves.toEqual({
      'Continue?': 'Yes',
    } satisfies QuestionAnswers);
    expect(collecting.permissionRequests).toHaveLength(4);
  });

  it('rejects non-canonical resume ids before changing interaction ownership', async () => {
    const sessionId = 'sess-e2e-canonical-resume';
    const { session } = makeScriptedSession(sessionId, []);
    let approvalHandler: ApprovalHandler | undefined;
    let questionHandler: QuestionHandler | undefined;
    const registerApproval = (handler: ApprovalHandler): (() => void) => {
      approvalHandler = handler;
      return () => {
        if (approvalHandler === handler) approvalHandler = undefined;
      };
    };
    const registerQuestion = (handler: QuestionHandler): (() => void) => {
      questionHandler = handler;
      return () => {
        if (questionHandler === handler) questionHandler = undefined;
      };
    };
    Object.assign(session, {
      registerApprovalHandler: registerApproval,
      registerQuestionHandler: registerQuestion,
    });
    const temporaryRegistrations: string[] = [];
    const resumedIds: string[] = [];
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      registerSessionApprovalHandler: (
        subscribedSessionId: string,
        handler: ApprovalHandler,
      ) => {
        temporaryRegistrations.push(`approval:${subscribedSessionId}`);
        return registerApproval(handler);
      },
      registerSessionQuestionHandler: (
        subscribedSessionId: string,
        handler: QuestionHandler,
      ) => {
        temporaryRegistrations.push(`question:${subscribedSessionId}`);
        return registerQuestion(handler);
      },
      resumeSession: async (input: { id: string }) => {
        resumedIds.push(input.id);
        return session;
      },
      getConfig: async () => ({
        providers: {},
        defaultModel: 'kimi-coder',
        models: makeModelsMap([
          { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: false },
        ]),
      }),
    } as unknown as KimiHarness;
    const server = new AcpServer(
      harness,
      { sessionUpdate: async () => undefined } as unknown as AgentSideConnection,
    );

    await server.resumeSession({ sessionId, cwd: '/tmp/work', mcpServers: [] });
    const permanentApproval = approvalHandler;
    const permanentQuestion = questionHandler;
    expect(permanentApproval).toBeDefined();
    expect(permanentQuestion).toBeDefined();

    await expect(
      server.resumeSession({
        sessionId: `  ${sessionId}  `,
        cwd: '/tmp/work',
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      server.resumeSession({ sessionId: '   ', cwd: '/tmp/work', mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32602 });

    expect(resumedIds).toEqual([sessionId]);
    expect(temporaryRegistrations).toEqual([
      `approval:${sessionId}`,
      `question:${sessionId}`,
    ]);
    expect(approvalHandler).toBe(permanentApproval);
    expect(questionHandler).toBe(permanentQuestion);
    server.dispose();
  });

  it('does not replay the raw resume buffer when replacing an attached Session', async () => {
    const sessionId = 'sess-e2e-replacement-resume-events';
    const {
      session: originalSession,
      emit: emitOriginal,
      listenerCount: originalListenerCount,
      unsubscribeCount: originalUnsubscribeCount,
    } = makeScriptedSession(sessionId, []);
    const {
      session: replacementSession,
      listenerCount: replacementListenerCount,
    } = makeScriptedSession(sessionId, []);
    const rawListeners = new Set<(event: Event) => void>();
    const event = {
      type: 'assistant.delta',
      sessionId,
      agentId: 'main',
      turnId: 9,
      delta: 'Observed once during replacement.',
    } as const satisfies Event;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => originalSession,
      onSessionEvent: (
        _subscribedSessionId: string,
        listener: (event: Event) => void,
      ) => {
        rawListeners.add(listener);
        return () => {
          rawListeners.delete(listener);
        };
      },
      resumeSession: async () => {
        // Real SDK Session listeners and harness-level listeners subscribe to
        // the same RPC event multicast. Model both deliveries explicitly.
        emitOriginal(event);
        for (const listener of rawListeners) listener(event);
        return replacementSession;
      },
      getConfig: async () => ({
        providers: {},
        defaultModel: 'kimi-coder',
        models: makeModelsMap([
          { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: false },
        ]),
      }),
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    const agentConnection = new AgentSideConnection(
      (connection) => new AcpServer(harness, connection),
      agentStream,
    );
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    await client.resumeSession({ sessionId, cwd: '/tmp/work', mcpServers: [] });
    const barrier = collecting.waitForUpdate(
      (notification) =>
        (notification.update._meta as { barrier?: string } | null | undefined)?.barrier ===
        'after-replacement-resume-events',
    );
    await agentConnection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
        _meta: { barrier: 'after-replacement-resume-events' },
      },
    });
    await barrier;

    expect(
      collecting.promptUpdates.filter(
        (notification) =>
          (notification.update as { sessionUpdate?: string }).sessionUpdate ===
          'agent_message_chunk',
      ),
    ).toEqual([
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          content: { type: 'text', text: 'Observed once during replacement.' },
        }),
      }),
    ]);
    expect(rawListeners.size).toBe(0);
    expect(originalListenerCount()).toBe(0);
    expect(originalUnsubscribeCount()).toBe(1);
    expect(replacementListenerCount()).toBe(1);
  });

  it('serializes concurrent same-session resume setup through configuration', async () => {
    const sessionId = 'sess-e2e-concurrent-resume';
    const { session } = makeScriptedSession(sessionId, []);
    const rawListeners = new Set<(event: Event) => void>();
    const updates: SessionNotification[] = [];
    let activeSession: Session | undefined;
    let configCalls = 0;
    let signalConfigStarted!: () => void;
    const configStarted = new Promise<void>((resolve) => {
      signalConfigStarted = resolve;
    });
    let releaseFirstConfig!: () => void;
    const firstConfigGate = new Promise<void>((resolve) => {
      releaseFirstConfig = resolve;
    });
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      onSessionEvent: (
        _subscribedSessionId: string,
        listener: (event: Event) => void,
      ) => {
        rawListeners.add(listener);
        return () => {
          rawListeners.delete(listener);
        };
      },
      resumeSession: async () => {
        if (activeSession !== undefined) return activeSession;
        activeSession = session;
        const event = {
          type: 'assistant.delta',
          sessionId,
          agentId: 'main',
          turnId: 10,
          delta: 'Concurrent resume output.',
        } as const satisfies Event;
        for (const listener of rawListeners) listener(event);
        return session;
      },
      getConfig: async () => {
        configCalls += 1;
        if (configCalls === 1) {
          signalConfigStarted();
          await firstConfigGate;
        }
        return {
          providers: {},
          defaultModel: 'kimi-coder',
          models: makeModelsMap([
            { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: false },
          ]),
        };
      },
    } as unknown as KimiHarness;
    const server = new AcpServer(
      harness,
      {
        sessionUpdate: async (notification: SessionNotification) => {
          updates.push(notification);
        },
      } as unknown as AgentSideConnection,
    );

    const first = server.resumeSession({
      sessionId,
      cwd: '/tmp/work',
      mcpServers: [],
    });
    await configStarted;
    const second = server.resumeSession({
      sessionId,
      cwd: '/tmp/work',
      mcpServers: [],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The second request has been dispatched, but must not enter any setup
    // collaborator while the first request owns this session's critical
    // section.
    expect(configCalls).toBe(1);

    releaseFirstConfig();
    await Promise.all([first, second]);

    expect(
      updates.filter(
        (notification) =>
          (notification.update as { sessionUpdate?: string }).sessionUpdate ===
          'agent_message_chunk',
      ),
    ).toEqual([
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          content: { type: 'text', text: 'Concurrent resume output.' },
        }),
      }),
    ]);
    expect(rawListeners.size).toBe(0);
  });

  it.each(['new', 'resume'] as const)(
    'does not attach a session event bridge when the server is disposed during %s setup',
    async (mode) => {
      const sessionId = `sess-e2e-dispose-during-${mode}`;
      const { session, listenerCount } = makeScriptedSession(sessionId, []);
      let signalSetupStarted: (() => void) | undefined;
      const setupStarted = new Promise<void>((resolve) => {
        signalSetupStarted = resolve;
      });
      let releaseSetup: (() => void) | undefined;
      const setupGate = new Promise<void>((resolve) => {
        releaseSetup = resolve;
      });
      const rawListeners = new Set<(event: Event) => void>();
      const delayedSession = async (): Promise<Session> => {
        signalSetupStarted?.();
        await setupGate;
        return session;
      };
      const harness = {
        auth: { status: async () => AUTHED_STATUS },
        createSession: delayedSession,
        resumeSession: delayedSession,
        onSessionEvent: (_sessionId: string, listener: (event: Event) => void) => {
          rawListeners.add(listener);
          return () => {
            rawListeners.delete(listener);
          };
        },
        getConfig: async () => ({
          providers: {},
          defaultModel: 'kimi-coder',
          models: makeModelsMap([
            { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: false },
          ]),
        }),
      } as unknown as KimiHarness;
      const connection = {
        sessionUpdate: async () => undefined,
      } as unknown as AgentSideConnection;
      const server = new AcpServer(harness, connection);
      const setup =
        mode === 'new'
          ? server.newSession({ cwd: '/tmp/work', mcpServers: [] })
          : server.resumeSession({ sessionId, cwd: '/tmp/work', mcpServers: [] });
      const outcome = setup.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      await setupStarted;
      expect(rawListeners.size).toBe(mode === 'resume' ? 1 : 0);
      server.dispose();
      expect(rawListeners.size).toBe(0);
      releaseSetup?.();

      await expect(outcome).resolves.toMatchObject({
        ok: false,
        error: { code: -32603 },
      });
      expect(listenerCount()).toBe(0);
    },
  );

  it('releases the temporary event bridge when a cold resume fails', async () => {
    const sessionId = 'sess-e2e-cold-resume-failure';
    const rawListeners = new Set<(event: Event) => void>();
    let rawUnsubscribeCount = 0;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      onSessionEvent: (
        _subscribedSessionId: string,
        listener: (event: Event) => void,
      ) => {
        rawListeners.add(listener);
        return () => {
          if (!rawListeners.delete(listener)) return;
          rawUnsubscribeCount += 1;
        };
      },
      resumeSession: async () => {
        throw new Error('resume unavailable');
      },
    } as unknown as KimiHarness;
    const server = new AcpServer(
      harness,
      { sessionUpdate: async () => undefined } as unknown as AgentSideConnection,
    );

    await expect(
      server.resumeSession({ sessionId, cwd: '/tmp/work', mcpServers: [] }),
    ).rejects.toThrow('resume unavailable');

    expect(rawListeners.size).toBe(0);
    expect(rawUnsubscribeCount).toBe(1);
    expect(server.getSession(sessionId)).toBeUndefined();
  });

  it('rolls back interaction handlers when cold-resume event registration fails', async () => {
    const sessionId = 'sess-e2e-cold-resume-registration-failure';
    let currentApproval: ApprovalHandler | undefined;
    let currentQuestion: QuestionHandler | undefined;
    let capturedApproval: ApprovalHandler | undefined;
    let capturedQuestion: QuestionHandler | undefined;
    let approvalReleaseCount = 0;
    let questionReleaseCount = 0;
    let resumeCallCount = 0;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      registerSessionApprovalHandler: (
        _subscribedSessionId: string,
        handler: ApprovalHandler,
      ) => {
        currentApproval = handler;
        capturedApproval = handler;
        return () => {
          if (currentApproval !== handler) return;
          currentApproval = undefined;
          approvalReleaseCount += 1;
        };
      },
      registerSessionQuestionHandler: (
        _subscribedSessionId: string,
        handler: QuestionHandler,
      ) => {
        currentQuestion = handler;
        capturedQuestion = handler;
        return () => {
          if (currentQuestion !== handler) return;
          currentQuestion = undefined;
          questionReleaseCount += 1;
        };
      },
      onSessionEvent: () => {
        throw new Error('event registration unavailable');
      },
      resumeSession: async () => {
        resumeCallCount += 1;
        throw new Error('resume should not run');
      },
    } as unknown as KimiHarness;
    const server = new AcpServer(
      harness,
      { sessionUpdate: async () => undefined } as unknown as AgentSideConnection,
    );

    await expect(
      server.resumeSession({ sessionId, cwd: '/tmp/work', mcpServers: [] }),
    ).rejects.toThrow('event registration unavailable');

    expect(resumeCallCount).toBe(0);
    expect(currentApproval).toBeUndefined();
    expect(currentQuestion).toBeUndefined();
    expect(approvalReleaseCount).toBe(1);
    expect(questionReleaseCount).toBe(1);
    if (capturedApproval === undefined || capturedQuestion === undefined) {
      throw new Error('temporary interaction handlers were not registered');
    }
    await expect(
      capturedApproval({
        toolCallId: 'tool-registration-failure',
        toolName: 'Bash',
        action: 'run command',
        display: { kind: 'command', command: 'echo ready' },
      }),
    ).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'ACP session setup did not complete.',
    } satisfies ApprovalResponse);
    await expect(
      capturedQuestion({
        toolCallId: 'question-registration-failure',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      }),
    ).resolves.toBeNull();
  });

  it('removes a newly attached resume bridge when configuration setup fails', async () => {
    const sessionId = 'sess-e2e-resume-config-failure';
    const {
      session,
      listenerCount,
      unsubscribeCount,
    } = makeScriptedSession(sessionId, []);
    const models = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('catalog unavailable');
        },
      },
    );
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      resumeSession: async () => session,
      getConfig: async () => ({
        providers: {},
        defaultModel: 'kimi-coder',
        models,
      }),
    } as unknown as KimiHarness;
    const connection = {
      sessionUpdate: async () => undefined,
    } as unknown as AgentSideConnection;
    const server = new AcpServer(harness, connection);

    await expect(
      server.resumeSession({ sessionId, cwd: '/tmp/work', mcpServers: [] }),
    ).rejects.toThrow('catalog unavailable');

    expect(server.getSession(sessionId)).toBeUndefined();
    expect(listenerCount()).toBe(0);
    expect(unsubscribeCount()).toBe(1);
  });

  it('releases the session event bridge when the ACP transport closes', async () => {
    const sessionId = 'sess-e2e-agent-initiated-close';
    const { session, listenerCount, unsubscribeCount } = makeScriptedSession(sessionId, []);
    const harness = makeHarness(session);

    const {
      agentStream,
      clientStream,
      closeAgentInput,
      closeClientInput,
    } = makeInMemoryStreamPair();
    const run = runAcpServerWithStream(harness, agentStream);
    const client = new ClientSideConnection(() => new CollectingClient(), clientStream);

    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });
    expect(listenerCount()).toBe(1);

    await closeAgentInput();
    await run;

    expect(listenerCount()).toBe(0);
    expect(unsubscribeCount()).toBe(1);

    await closeClientInput();
    await client.closed;
  });

  it('cancel mid-stream resolves with stopReason cancelled', async () => {
    const sessionId = 'sess-e2e-cancel';
    // Scripted session that emits one delta, then a cancelled
    // turn.ended. The ACP `cancel` notification flows through the
    // adapter; we assert the prompt resolves with `cancelled` and
    // does not throw.
    const { session } = makeScriptedSession(sessionId, [
      { type: 'assistant.delta', sessionId, agentId: 'main', turnId: 1, delta: 'partial' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'cancelled' } as Event,
    ]);
    const harness = makeHarness(session);

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    await client.newSession({ cwd: '/tmp/work', mcpServers: [] });

    // Fire-and-forget the cancel notification before awaiting prompt.
    // The scripted session emits turn.ended(cancelled) regardless;
    // this verifies the cancel notification does not throw when the
    // session is known (sessionId resolves to the registered
    // AcpSession in `AcpServer.cancel`).
    const promptPromise = client.prompt({
      sessionId,
      prompt: [textBlock('long task')],
    });
    await client.cancel({ sessionId });
    const promptRes = await promptPromise;
    expect(promptRes.stopReason).toBe('cancelled');
  });
});
