/**
 * `PromptService` unit tests.
 *
 * Hermetic: a fake `ICoreProcessService` returns canned session list + records
 * the `prompt` / `cancel` payloads. A stub `IEventService` collects published
 * events into an array we can inspect and drives synthesis via
 * `bus.publish(turn.*)` → PromptService's private subscriber. A stub
 * `ISessionService` exposes `onDidClose` so cleanup tests can trigger it.
 *
 * Coverage:
 *   - submit returns PromptItem with status='running' or status='queued'
 *   - submit registers an active prompt → second submit enters daemon queue
 *   - submit translates protocol content → kosong content (text + image_url)
 *   - submit on unknown sid → SessionNotFoundError
 *   - submit on a session with an active completed/aborted prompt succeeds
 *   - bus.publish of `turn.started` captures turnId (via PromptService subscriber)
 *   - bus.publish of `turn.ended` (top-level, completed) synthesizes prompt.completed
 *   - bus.publish of `turn.ended` with reason=cancelled synthesizes prompt.aborted
 *   - bus.publish of nested turn.ended ignored (non-top-level)
 *   - bus.publish on events for an unknown session is a no-op
 *   - abort() rejects PromptNotFoundError when no active prompt
 *   - abort() returns {aborted: true} + publishes prompt.aborted
 *   - second abort() → PromptAlreadyCompletedError (40903)
 *   - busy submit queues instead of throwing; list returns active + queued
 *   - steer removes queued prompts and dispatches core.rpc.steer
 *   - failed steer restores queued prompts
 *   - per-request stateless controls (model / thinking / permission_mode /
 *     plan_mode) bootstrap once, diff-dispatch on change, no-op on match,
 *     reseed after session close, agent.status.updated mirrors into shadow.
 */

import { describe, expect, it, vi } from 'vitest';

import { Emitter } from '../../src';

import type {
  CoreRPC,
  Event,
  SessionSummary,
} from '../../src';
import type { PromptSubmission, Session } from '@moonshot-ai/protocol';

import {
  type IAuthSummaryService,
  type IEventService,
  type ICoreProcessService,
  type ILogService,
  type ISessionService,
  PromptAlreadyCompletedError,
  PromptNotFoundError,
  PromptService,
  SessionNotFoundError,
} from '../../src/services';

const SID = 'sess_01PT';
const SESSION_CREATED_AT = 1_700_000_000_000;

function mkSummary(id = SID): SessionSummary {
  return {
    id,
    workDir: '/tmp/ws',
    sessionDir: `/tmp/sessions/${id}`,
    createdAt: SESSION_CREATED_AT,
    updatedAt: SESSION_CREATED_AT,
  };
}

/**
 * Default body for a submit() that exercises the per-turn override path —
 * all four runtime controls are populated, so bootstrap + diff-dispatch
 * fire. Spread overrides on top per-test as needed. Tests that want the
 * content-only path (zero bootstrap, zero setters) use `mkBodyMinimal`.
 */
function mkBody(over: Partial<PromptSubmission> = {}): PromptSubmission {
  return {
    content: [{ type: 'text', text: 'hi' }],
    model: 'kimi-code/k2',
    thinking: 'off',
    permission_mode: 'manual',
    plan_mode: false,
    ...over,
  };
}

/**
 * Minimal submit body — content only, no per-turn overrides. Triggers the
 * stateful-session path: no bootstrap RPCs, no setter dispatch, no
 * dispatch-log entries. Mirrors what the canonical web client sends after
 * setting state via `POST /sessions/{sid}/profile`.
 */
function mkBodyMinimal(over: Partial<PromptSubmission> = {}): PromptSubmission {
  return {
    content: [{ type: 'text', text: 'hi' }],
    ...over,
  };
}

interface RpcRecord {
  promptCalls: unknown[];
  steerCalls: unknown[];
  cancelCalls: unknown[];
  setModelCalls: unknown[];
  setThinkingCalls: unknown[];
  setPermissionCalls: unknown[];
  enterPlanCalls: unknown[];
  cancelPlanCalls: unknown[];
  getSwarmModeCalls: number;
  startBtwCalls: unknown[];
  enterSwarmCalls: unknown[];
  exitSwarmCalls: unknown[];
  createGoalCalls: unknown[];
  pauseGoalCalls: unknown[];
  resumeGoalCalls: unknown[];
  cancelGoalCalls: unknown[];
  getConfigCalls: number;
  getPermissionCalls: number;
  getPlanCalls: number;
}

interface BridgeStubOptions {
  /** Initial bootstrap values returned by getConfig/getPermission/getPlan. */
  config?: { modelAlias?: string; thinkingLevel?: string };
  permission?: { mode: 'manual' | 'yolo' | 'auto' };
  plan?: null | { id: string; content: string; path: string };
  sessions?: SessionSummary[];
  onPrompt?: (payload: unknown) => void | Promise<void>;
}

function makeBridge(
  opts: BridgeStubOptions = {},
): { bridge: ICoreProcessService; record: RpcRecord } {
  const record: RpcRecord = {
    promptCalls: [],
    steerCalls: [],
    cancelCalls: [],
    setModelCalls: [],
    setThinkingCalls: [],
    setPermissionCalls: [],
    enterPlanCalls: [],
    cancelPlanCalls: [],
    getSwarmModeCalls: 0,
    startBtwCalls: [],
    enterSwarmCalls: [],
    exitSwarmCalls: [],
    createGoalCalls: [],
    pauseGoalCalls: [],
    resumeGoalCalls: [],
    cancelGoalCalls: [],
    getConfigCalls: 0,
    getPermissionCalls: 0,
    getPlanCalls: 0,
  };
  const config = {
    cwd: '/tmp/ws',
    modelCapabilities: {} as unknown,
    thinkingLevel: opts.config?.thinkingLevel ?? 'off',
    systemPrompt: '',
    modelAlias: opts.config?.modelAlias ?? 'kimi-code/k2',
  };
  const permission = { mode: opts.permission?.mode ?? 'manual', rules: [] };
  const plan = opts.plan === undefined ? null : opts.plan;
  const sessions = opts.sessions ?? [mkSummary()];

  const rpc: Partial<CoreRPC> = {
    listSessions: vi.fn().mockImplementation(async () => sessions),
    resumeSession: vi.fn().mockResolvedValue(undefined as unknown as never),
    prompt: vi.fn().mockImplementation(async (payload) => {
      record.promptCalls.push(payload);
      await opts.onPrompt?.(payload);
    }),
    steer: vi.fn().mockImplementation(async (payload) => {
      record.steerCalls.push(payload);
    }),
    cancel: vi.fn().mockImplementation(async (payload) => {
      record.cancelCalls.push(payload);
    }),
    getConfig: vi.fn().mockImplementation(async () => {
      record.getConfigCalls += 1;
      return config;
    }),
    getPermission: vi.fn().mockImplementation(async () => {
      record.getPermissionCalls += 1;
      return permission;
    }),
    getPlan: vi.fn().mockImplementation(async () => {
      record.getPlanCalls += 1;
      return plan;
    }),
    setModel: vi.fn().mockImplementation(async (payload) => {
      record.setModelCalls.push(payload);
      return { model: (payload as { model: string }).model };
    }),
    setThinking: vi.fn().mockImplementation(async (payload) => {
      record.setThinkingCalls.push(payload);
    }),
    setPermission: vi.fn().mockImplementation(async (payload) => {
      record.setPermissionCalls.push(payload);
    }),
    enterPlan: vi.fn().mockImplementation(async (payload) => {
      record.enterPlanCalls.push(payload);
    }),
    cancelPlan: vi.fn().mockImplementation(async (payload) => {
      record.cancelPlanCalls.push(payload);
    }),
    getSwarmMode: vi.fn().mockImplementation(async () => {
      record.getSwarmModeCalls += 1;
      return false;
    }),
    startBtw: vi.fn().mockImplementation(async (payload) => {
      record.startBtwCalls.push(payload);
      return 'agent_btw';
    }),
    enterSwarm: vi.fn().mockImplementation(async (payload) => {
      record.enterSwarmCalls.push(payload);
    }),
    exitSwarm: vi.fn().mockImplementation(async (payload) => {
      record.exitSwarmCalls.push(payload);
    }),
    createGoal: vi.fn().mockImplementation(async (payload) => {
      record.createGoalCalls.push(payload);
      return {
        goalId: 'goal_1',
        objective: (payload as { objective: string }).objective,
        status: 'active',
      };
    }),
    pauseGoal: vi.fn().mockImplementation(async (payload) => {
      record.pauseGoalCalls.push(payload);
      return { goalId: 'goal_1', status: 'paused' };
    }),
    resumeGoal: vi.fn().mockImplementation(async (payload) => {
      record.resumeGoalCalls.push(payload);
      return { goalId: 'goal_1', status: 'active' };
    }),
    cancelGoal: vi.fn().mockImplementation(async (payload) => {
      record.cancelGoalCalls.push(payload);
      return { goalId: 'goal_1', status: 'cancelled' };
    }),
  };
  const bridge: ICoreProcessService = {
    rpc: rpc as CoreRPC,
    ready: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    _serviceBrand: undefined,
  };
  return { bridge, record };
}

function makeBus(): {
  bus: IEventService;
  events: Event[];
  triggerSubscribers: (e: Event) => void;
} {
  const events: Event[] = [];
  const emitter = new Emitter<Event>();
  const bus: IEventService = {
    publish: (e: Event) => {
      events.push(e);
      // Drive any subscribers (mirrors EventService publish → onDidPublish fire).
      emitter.fire(e);
    },
    onDidPublish: emitter.event,
    _serviceBrand: undefined,
  };
  function triggerSubscribers(e: Event): void {
    emitter.fire(e);
  }
  return { bus, events, triggerSubscribers };
}

/**
 * Stub `IAuthSummaryService` for hermetic prompt-service tests. Default
 * `ensureReady()` resolves; tests that need to exercise the readiness gate
 * can pass `{ ensureReadyError }` and assert the error surfaces.
 */
function makeAuth(opts: { ensureReadyError?: Error } = {}): IAuthSummaryService {
  return {
    get: vi.fn().mockResolvedValue({
      ready: true,
      providers_count: 1,
      default_model: 'kimi-k2',
      managed_provider: null,
    }),
    ensureReady: vi.fn().mockImplementation(async () => {
      if (opts.ensureReadyError) throw opts.ensureReadyError;
    }),
    _serviceBrand: undefined,
  };
}

/**
 * Stub `ISessionService` for hermetic prompt-service tests. Only the
 * `onDidClose` event accessor is consumed by PromptService; `triggerClose`
 * fires the close event to exercise shadow cleanup.
 */
function makeSessionService(): {
  sessionService: ISessionService;
  triggerClose: (sid: string) => void;
} {
  const closeEmitter = new Emitter<{ sessionId: string }>();
  const createEmitter = new Emitter<{ session: Session }>();
  const sessionService: ISessionService = {
    _serviceBrand: undefined,
    create: vi.fn() as unknown as ISessionService['create'],
    list: vi.fn() as unknown as ISessionService['list'],
    get: vi.fn() as unknown as ISessionService['get'],
    update: vi.fn() as unknown as ISessionService['update'],
    fork: vi.fn() as unknown as ISessionService['fork'],
    listChildren: vi.fn() as unknown as ISessionService['listChildren'],
    createChild: vi.fn() as unknown as ISessionService['createChild'],
    getStatus: vi.fn() as unknown as ISessionService['getStatus'],
    compact: vi.fn() as unknown as ISessionService['compact'],
    undo: vi.fn() as unknown as ISessionService['undo'],
    archive: vi.fn() as unknown as ISessionService['archive'],
    onDidCreate: createEmitter.event,
    onDidClose: closeEmitter.event,
  };
  return {
    sessionService,
    triggerClose: (sid: string) => closeEmitter.fire({ sessionId: sid }),
  };
}

class NoopLogService implements ILogService {
  readonly _serviceBrand: undefined;

  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogService {
    return this;
  }
}

function newSvc(
  bridge: ICoreProcessService,
  bus: IEventService,
  auth: IAuthSummaryService = makeAuth(),
  sessionService: ISessionService = makeSessionService().sessionService,
  logService: ILogService = new NoopLogService(),
): PromptService {
  return new PromptService(bridge, bus, auth, sessionService, logService);
}

describe('PromptService.submit', () => {
  it('returns ULID-shaped prompt_id + user_message_id derived from it', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    const result = await impl.submit(SID, mkBody());
    expect(result.prompt_id).toMatch(/^prompt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.user_message_id).toMatch(/^msg_sess_01PT_pending_prompt_/);
  });

  it('translates text + image content to kosong ContentParts', async () => {
    const { bridge, record } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(
      SID,
      mkBody({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', source: { kind: 'url', url: 'https://a.png' } },
        ],
      }),
    );
    expect(record.promptCalls).toHaveLength(1);
    const payload = record.promptCalls[0] as {
      sessionId: string;
      agentId: string;
      input: Array<Record<string, unknown>>;
    };
    expect(payload.sessionId).toBe(SID);
    expect(payload.agentId).toBe('main');
    expect(payload.input).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image_url', imageUrl: { url: 'https://a.png' } },
    ]);
  });

  it('translates base64 image content to a data URL image part', async () => {
    const { bridge, record } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(
      SID,
      mkBody({
        content: [
          { type: 'text', text: 'describe this' },
          {
            type: 'image',
            source: {
              kind: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
        ],
      }),
    );
    const payload = record.promptCalls[0] as {
      input: Array<Record<string, unknown>>;
    };
    expect(payload.input).toEqual([
      { type: 'text', text: 'describe this' },
      {
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,aGVsbG8=' },
      },
    ]);
  });

  it('publishes prompt.submitted when a prompt starts running', async () => {
    const { bridge } = makeBridge();
    const { bus, events } = makeBus();
    const impl = newSvc(bridge, bus);
    const body = mkBody({ content: [{ type: 'text', text: 'hello from client a' }] });

    const result = await impl.submit(SID, body);

    const submitted = events.find((event) => event.type === 'prompt.submitted') as
      | {
          type: 'prompt.submitted';
          sessionId: string;
          agentId: string;
          promptId: string;
          userMessageId: string;
          status: string;
          content: readonly PromptSubmission['content'][number][];
        }
      | undefined;
    expect(submitted).toBeDefined();
    expect(submitted?.sessionId).toBe(SID);
    expect(submitted?.agentId).toBe('main');
    expect(submitted).toMatchObject({
      promptId: result.prompt_id,
      userMessageId: result.user_message_id,
      status: 'running',
      content: body.content,
    });
  });

  it('publishes prompt.submitted before core prompt events can start the turn', async () => {
    const { bus, events } = makeBus();
    const { bridge } = makeBridge({
      onPrompt: () => {
        bus.publish({
          type: 'turn.started',
          turnId: 7,
          origin: { kind: 'user' },
          sessionId: SID,
          agentId: 'main',
        } as unknown as Event);
      },
    });
    const impl = newSvc(bridge, bus);

    const result = await impl.submit(SID, mkBodyMinimal());

    expect(events.map((event) => event.type).slice(0, 2)).toEqual([
      'prompt.submitted',
      'turn.started',
    ]);
    expect(events[0]).toMatchObject({
      type: 'prompt.submitted',
      promptId: result.prompt_id,
      status: 'running',
    });
  });

  it('queues a second prompt when a non-terminal prompt is already active', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    const first = await impl.submit(SID, mkBody({ content: [{ type: 'text', text: 'one' }] }));
    const second = await impl.submit(SID, mkBody({ content: [{ type: 'text', text: 'two' }] }));
    const listed = await impl.list(SID);

    expect(first.status).toBe('running');
    expect(second.status).toBe('queued');
    expect(listed.active?.prompt_id).toBe(first.prompt_id);
    expect(listed.queued.map((p) => p.prompt_id)).toEqual([second.prompt_id]);
  });

  it('runs an agent-scoped prompt without queueing behind the main prompt', async () => {
    const { bridge, record } = makeBridge();
    const { bus, events } = makeBus();
    const impl = newSvc(bridge, bus);

    const main = await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'main' }] }));
    const btw = await impl.submit(
      SID,
      mkBodyMinimal({
        agent_id: 'agent_btw',
        content: [{ type: 'text', text: 'side question' }],
      }),
    );
    const listed = await impl.list(SID);

    expect(main.status).toBe('running');
    expect(btw.status).toBe('running');
    expect(listed.active?.prompt_id).toBe(main.prompt_id);
    expect(listed.queued).toHaveLength(0);
    expect(record.promptCalls).toEqual([
      { sessionId: SID, agentId: 'main', input: [{ type: 'text', text: 'main' }] },
      { sessionId: SID, agentId: 'agent_btw', input: [{ type: 'text', text: 'side question' }] },
    ]);
    const submitted = events.filter((event) => event.type === 'prompt.submitted') as Array<{
      type: 'prompt.submitted';
      agentId: string;
      promptId: string;
    }>;
    expect(submitted.map((event) => [event.agentId, event.promptId])).toEqual([
      ['main', main.prompt_id],
      ['agent_btw', btw.prompt_id],
    ]);
  });

  it('publishes prompt.submitted when a prompt is queued', async () => {
    const { bridge } = makeBridge();
    const { bus, events } = makeBus();
    const impl = newSvc(bridge, bus);

    await impl.submit(SID, mkBody({ content: [{ type: 'text', text: 'one' }] }));
    const second = await impl.submit(SID, mkBody({ content: [{ type: 'text', text: 'two' }] }));

    const submitted = events.filter((event) => event.type === 'prompt.submitted') as Array<{
      type: 'prompt.submitted';
      promptId: string;
      status: string;
      content: readonly PromptSubmission['content'][number][];
    }>;
    expect(submitted.map((event) => event.promptId)).toContain(second.prompt_id);
    expect(submitted.at(-1)).toMatchObject({
      promptId: second.prompt_id,
      status: 'queued',
      content: [{ type: 'text', text: 'two' }],
    });
  });

  it('starts the next queued prompt after the active prompt completes', async () => {
    const { bridge, record } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    const first = await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'one' }] }));
    const second = await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'two' }] }));

    triggerSubscribers({
      type: 'turn.started',
      turnId: 7,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 7,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    await Promise.resolve();

    expect(record.promptCalls).toHaveLength(2);
    expect(record.promptCalls[1]).toEqual({
      sessionId: SID,
      agentId: 'main',
      input: [{ type: 'text', text: 'two' }],
    });
    const listed = await impl.list(SID);
    expect(listed.active?.prompt_id).toBe(second.prompt_id);
    expect(listed.queued).toHaveLength(0);
    expect(first.status).toBe('running');
  });

  it('throws SessionNotFoundError on unknown session id', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await expect(impl.submit('sess_missing', mkBody())).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('clears active state if bridge.prompt() rejects', async () => {
    const { bridge } = makeBridge();
    (bridge.rpc.prompt as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await expect(impl.submit(SID, mkBody())).rejects.toThrowError(/boom/);
    // A second submit must succeed (state was cleared).
    await impl.submit(SID, mkBody());
  });

  it('calls resumeSession before prompt so cross-restart sessions resolve', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody());
    const resumeMock = bridge.rpc.resumeSession as ReturnType<typeof vi.fn>;
    const promptMock = bridge.rpc.prompt as ReturnType<typeof vi.fn>;
    expect(resumeMock).toHaveBeenCalledWith({ sessionId: SID });
    const resumeOrder = resumeMock.mock.invocationCallOrder[0];
    const promptOrder = promptMock.mock.invocationCallOrder[0];
    expect(resumeOrder).toBeDefined();
    expect(promptOrder).toBeDefined();
    expect(resumeOrder!).toBeLessThan(promptOrder!);
  });
});

describe('PromptService.startBtw', () => {
  it('starts a side-channel agent through core RPC', async () => {
    const { bridge, record } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);

    await expect(impl.startBtw(SID)).resolves.toBe('agent_btw');

    expect(record.startBtwCalls).toEqual([{ sessionId: SID, agentId: 'main' }]);
  });
});

describe('PromptService lifecycle synthesis (via IEventService.onDidPublish)', () => {
  it('captures turnId on the first turn.started after submit', async () => {
    const { bridge } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody());
    triggerSubscribers({
      type: 'turn.started',
      turnId: 42,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(impl._activeForTest(SID)?.turnId).toBe(42);
  });

  it('ignores subsequent turn.started events (treated as nested turns)', async () => {
    const { bridge } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody());
    triggerSubscribers({
      type: 'turn.started',
      turnId: 42,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.started',
      turnId: 99,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(impl._activeForTest(SID)?.turnId).toBe(42);
  });

  it('synthesizes prompt.completed on top-level turn.ended (reason=completed)', async () => {
    const { bridge } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    const submit = await impl.submit(SID, mkBody());
    triggerSubscribers({
      type: 'turn.started',
      turnId: 7,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    events.length = 0;
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 7,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(events).toHaveLength(1);
    const synth = events[0] as unknown as {
      type: string;
      promptId: string;
      reason: string;
    };
    expect(synth.type).toBe('prompt.completed');
    expect(synth.promptId).toBe(submit.prompt_id);
    expect(synth.reason).toBe('completed');
    expect(impl._activeForTest(SID)).toBeUndefined();
  });

  it('fires onDidComplete listener before bus.publish', async () => {
    const { bridge } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    const submit = await impl.submit(SID, mkBody());
    triggerSubscribers({
      type: 'turn.started',
      turnId: 7,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    const handlerArgs: unknown[] = [];
    const handlerCalledBeforePublish: boolean[] = [];
    impl.onDidComplete((e) => {
      handlerArgs.push(e);
      handlerCalledBeforePublish.push(
        events.filter(
          (ev) => (ev as unknown as { type?: string }).type === 'prompt.completed',
        ).length === 0,
      );
    });
    events.length = 0;
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 7,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(handlerArgs).toHaveLength(1);
    expect((handlerArgs[0] as { promptId: string }).promptId).toBe(submit.prompt_id);
    expect(handlerCalledBeforePublish[0]).toBe(true);
  });

  it('synthesizes prompt.aborted on top-level turn.ended (reason=cancelled)', async () => {
    const { bridge } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody());
    triggerSubscribers({
      type: 'turn.started',
      turnId: 8,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    events.length = 0;
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 8,
      reason: 'cancelled',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as { type: string }).type).toBe('prompt.aborted');
  });

  it('ignores nested turn.ended (different turnId) so prompt stays active', async () => {
    const { bridge } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody());
    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    events.length = 0;
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 99,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(events).toEqual([]);
    expect(impl._activeForTest(SID)?.completed).toBe(false);
  });

  it('is a no-op for events on a session with no active prompt', async () => {
    const { bridge } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    newSvc(bridge, bus);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(events).toEqual([]);
  });
});

describe('PromptService.abort', () => {
  it('throws PromptNotFoundError when no active prompt for the session', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await expect(impl.abort(SID, 'prompt_xyz')).rejects.toBeInstanceOf(
      PromptNotFoundError,
    );
  });

  it('returns {aborted: true} and publishes prompt.aborted', async () => {
    const { bridge, record } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    const submit = await impl.submit(SID, mkBody());
    triggerSubscribers({
      type: 'turn.started',
      turnId: 5,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    events.length = 0;
    const result = await impl.abort(SID, submit.prompt_id);
    expect(result.aborted).toBe(true);
    expect(record.cancelCalls).toHaveLength(1);
    expect(record.cancelCalls[0]).toEqual({
      sessionId: SID,
      agentId: 'main',
      turnId: 5,
    });
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as { type: string }).type).toBe('prompt.aborted');
  });

  it('throws PromptAlreadyCompletedError on the second abort', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    const submit = await impl.submit(SID, mkBody());
    await impl.abort(SID, submit.prompt_id);
    await expect(impl.abort(SID, submit.prompt_id)).rejects.toBeInstanceOf(
      PromptAlreadyCompletedError,
    );
  });

  it('aborts a queued prompt without calling core.rpc.cancel', async () => {
    const { bridge, record } = makeBridge();
    const { bus, events } = makeBus();
    const impl = newSvc(bridge, bus);

    const first = await impl.submit(SID, mkBody());
    const second = await impl.submit(
      SID,
      mkBodyMinimal({ content: [{ type: 'text', text: 'queued' }] }),
    );
    expect(second.status).toBe('queued');

    events.length = 0;
    const result = await impl.abort(SID, second.prompt_id);

    expect(result.aborted).toBe(true);
    expect(record.cancelCalls).toHaveLength(0);
    const listed = await impl.list(SID);
    expect(listed.active?.prompt_id).toBe(first.prompt_id);
    expect(listed.queued).toHaveLength(0);
    expect(events).toHaveLength(1);
    const ev = events[0] as unknown as { type: string; promptId?: string };
    expect(ev.type).toBe('prompt.aborted');
    expect(ev.promptId).toBe(second.prompt_id);
  });
});

describe('PromptService.getCurrentPromptId', () => {
  it('returns the active prompt id while running', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    const submit = await impl.submit(SID, mkBody());
    expect(impl.getCurrentPromptId(SID)).toBe(submit.prompt_id);
  });

  it('returns undefined when idle', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    expect(impl.getCurrentPromptId(SID)).toBeUndefined();
  });

  it('returns undefined after the prompt completes', async () => {
    const { bridge } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    const submit = await impl.submit(SID, mkBody());
    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(impl.getCurrentPromptId(SID)).toBeUndefined();
  });
});

describe('PromptService.abortBySession', () => {
  it('delegates to abort when a daemon prompt is active', async () => {
    const { bridge, record } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    const submit = await impl.submit(SID, mkBody());
    triggerSubscribers({
      type: 'turn.started',
      turnId: 7,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    events.length = 0;

    const result = await impl.abortBySession(SID);

    expect(result.aborted).toBe(true);
    expect(record.cancelCalls).toHaveLength(1);
    expect(record.cancelCalls[0]).toEqual({
      sessionId: SID,
      agentId: 'main',
      turnId: 7,
    });
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as { type: string }).type).toBe('prompt.aborted');
  });

  it('calls core.rpc.cancel without turnId when no daemon prompt is active', async () => {
    const { bridge, record } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);

    const result = await impl.abortBySession(SID);

    expect(result.aborted).toBe(true);
    expect(record.cancelCalls).toHaveLength(1);
    expect(record.cancelCalls[0]).toEqual({
      sessionId: SID,
      agentId: 'main',
    });
  });
});

describe('PromptService queue steer', () => {
  it('steers a queued prompt into the active turn without starting a new prompt', async () => {
    const { bridge, record } = makeBridge();
    const { bus, events } = makeBus();
    const impl = newSvc(bridge, bus);
    const active = await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'active' }] }));
    const queued = await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'queued' }] }));

    const result = await impl.steer(SID, [queued.prompt_id]);

    expect(result).toEqual({ steered: true, prompt_ids: [queued.prompt_id] });
    expect(record.promptCalls).toHaveLength(1);
    expect(record.steerCalls).toEqual([
      {
        sessionId: SID,
        agentId: 'main',
        input: [{ type: 'text', text: 'queued' }],
      },
    ]);
    expect((await impl.list(SID)).queued).toHaveLength(0);
    expect(
      events.some((event) => {
        const payload = event as unknown as {
          type?: string;
          activePromptId?: string;
          promptIds?: readonly string[];
        };
        return (
          payload.type === 'prompt.steered' &&
          payload.activePromptId === active.prompt_id &&
          payload.promptIds?.[0] === queued.prompt_id
        );
      }),
    ).toBe(true);
  });

  it('joins multiple queued text prompts with blank lines when steering', async () => {
    const { bridge, record } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'active' }] }));
    const first = await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'first' }] }));
    const second = await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'second' }] }));

    await impl.steer(SID, [first.prompt_id, second.prompt_id]);

    expect(record.steerCalls).toEqual([
      {
        sessionId: SID,
        agentId: 'main',
        input: [{ type: 'text', text: 'first\n\nsecond' }],
      },
    ]);
    expect((await impl.list(SID)).queued).toHaveLength(0);
  });

  it('keeps queued prompts when core steer fails', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    vi.mocked(bridge.rpc.steer).mockRejectedValueOnce(new Error('steer failed'));
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'active' }] }));
    const queued = await impl.submit(
      SID,
      mkBodyMinimal({ content: [{ type: 'text', text: 'queued' }] }),
    );

    await expect(impl.steer(SID, [queued.prompt_id])).rejects.toThrow('steer failed');

    expect((await impl.list(SID)).queued.map((prompt) => prompt.prompt_id)).toEqual([
      queued.prompt_id,
    ]);
  });

  it('throws PromptNotFoundError when steering a prompt that is not queued', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'active' }] }));

    await expect(impl.steer(SID, ['prompt_missing'])).rejects.toBeInstanceOf(
      PromptNotFoundError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stateless per-request session controls (model / thinking / permission_mode /
// plan_mode)
// ─────────────────────────────────────────────────────────────────────────────

describe('PromptService stateless controls — bootstrap + shadow', () => {
  it('bootstraps shadow from getConfig/getPermission/getPlan on first submit', async () => {
    const { bridge, record } = makeBridge({
      config: { modelAlias: 'kimi-code/k2', thinkingLevel: 'medium' },
      permission: { mode: 'yolo' },
      plan: { id: 'plan_abc', content: '', path: '/tmp/p' },
    });
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody({ thinking: 'medium', permission_mode: 'yolo', plan_mode: true }));
    const snap = impl._agentStateForTest(SID);
    expect(snap).toEqual({
      model: 'kimi-code/k2',
      thinking: 'medium',
      permissionMode: 'yolo',
      planMode: true,
      swarmMode: false,
    });
    // Getters fired exactly once each.
    expect(record.getConfigCalls).toBe(1);
    expect(record.getPermissionCalls).toBe(1);
    expect(record.getPlanCalls).toBe(1);
    expect(record.getSwarmModeCalls).toBe(1);
    // No setters fired because body matched the bootstrap snapshot.
    expect(record.setModelCalls).toEqual([]);
    expect(record.setThinkingCalls).toEqual([]);
    expect(record.setPermissionCalls).toEqual([]);
    expect(record.enterPlanCalls).toEqual([]);
    expect(record.cancelPlanCalls).toEqual([]);
  });

  it('does not re-bootstrap on subsequent submits in the same session', async () => {
    const { bridge, record } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody());
    // Complete the first prompt so the second can start.
    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);

    await impl.submit(SID, mkBody({ content: [{ type: 'text', text: 'again' }] }));
    expect(record.getConfigCalls).toBe(1);
    expect(record.getPermissionCalls).toBe(1);
    expect(record.getPlanCalls).toBe(1);
  });

  it('re-bootstraps after the session closes', async () => {
    const { bridge, record } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const { sessionService, triggerClose } = makeSessionService();
    const impl = new PromptService(bridge, bus, makeAuth(), sessionService, new NoopLogService());
    await impl.submit(SID, mkBody());
    expect(record.getConfigCalls).toBe(1);
    // First prompt cleared on completion so the second submit isn't busy.
    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);

    triggerClose(SID);
    expect(impl._agentStateForTest(SID)).toBeUndefined();

    await impl.submit(SID, mkBody({ content: [{ type: 'text', text: 'after-close' }] }));
    expect(record.getConfigCalls).toBe(2);
    expect(record.getPermissionCalls).toBe(2);
    expect(record.getPlanCalls).toBe(2);
  });
});

describe('PromptService stateless controls — diff dispatch', () => {
  it('issues setModel only when the body model differs from the shadow', async () => {
    const { bridge, record } = makeBridge({ config: { modelAlias: 'kimi-code/k2' } });
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody({ model: 'kimi-code/k2' }));
    expect(record.setModelCalls).toEqual([]);

    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);

    await impl.submit(SID, mkBody({ model: 'kimi-code/k1' }));
    expect(record.setModelCalls).toEqual([
      { sessionId: SID, agentId: 'main', model: 'kimi-code/k1' },
    ]);
    expect(impl._agentStateForTest(SID)?.model).toBe('kimi-code/k1');
  });

  it('issues setThinking only when the body level differs from the shadow', async () => {
    const { bridge, record } = makeBridge({ config: { thinkingLevel: 'off' } });
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody({ thinking: 'off' }));
    expect(record.setThinkingCalls).toEqual([]);

    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);

    await impl.submit(SID, mkBody({ thinking: 'high' }));
    expect(record.setThinkingCalls).toEqual([
      { sessionId: SID, agentId: 'main', level: 'high' },
    ]);
    expect(impl._agentStateForTest(SID)?.thinking).toBe('high');
  });

  it('issues setPermission only when the mode differs from the shadow', async () => {
    const { bridge, record } = makeBridge({ permission: { mode: 'manual' } });
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody({ permission_mode: 'manual' }));
    expect(record.setPermissionCalls).toEqual([]);

    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);

    await impl.submit(SID, mkBody({ permission_mode: 'yolo' }));
    expect(record.setPermissionCalls).toEqual([
      { sessionId: SID, agentId: 'main', mode: 'yolo' },
    ]);
  });

  it('enters plan mode when plan_mode goes false→true', async () => {
    const { bridge, record } = makeBridge({ plan: null });
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody({ plan_mode: true }));
    expect(record.enterPlanCalls).toEqual([
      { sessionId: SID, agentId: 'main' },
    ]);
    expect(record.cancelPlanCalls).toEqual([]);
    expect(impl._agentStateForTest(SID)?.planMode).toBe(true);
  });

  it('cancels plan mode when plan_mode goes true→false', async () => {
    const { bridge, record } = makeBridge({
      plan: { id: 'plan_xyz', content: '', path: '/tmp/p' },
    });
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody({ plan_mode: false }));
    expect(record.cancelPlanCalls).toEqual([
      { sessionId: SID, agentId: 'main' },
    ]);
    expect(record.enterPlanCalls).toEqual([]);
    expect(impl._agentStateForTest(SID)?.planMode).toBe(false);
  });

  it('no-ops on repeated identical submissions (no extra setter RPCs)', async () => {
    const { bridge, record } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);

    for (let i = 0; i < 3; i++) {
      await impl.submit(
        SID,
        mkBody({ content: [{ type: 'text', text: `t${i}` }] }),
      );
      // Run the turn to completion so the next iteration's submit isn't busy.
      triggerSubscribers({
        type: 'turn.started',
        turnId: i + 1,
        origin: { kind: 'user' },
        sessionId: SID,
        agentId: 'main',
      } as unknown as Event);
      triggerSubscribers({
        type: 'turn.ended',
        turnId: i + 1,
        reason: 'completed',
        sessionId: SID,
        agentId: 'main',
      } as unknown as Event);
    }
    expect(record.setModelCalls).toEqual([]);
    expect(record.setThinkingCalls).toEqual([]);
    expect(record.setPermissionCalls).toEqual([]);
    expect(record.enterPlanCalls).toEqual([]);
    expect(record.cancelPlanCalls).toEqual([]);
  });
});

describe('PromptService stateless controls — live shadow updates', () => {
  it('mirrors agent.status.updated into the shadow', async () => {
    const { bridge } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody());
    triggerSubscribers({
      type: 'agent.status.updated',
      model: 'kimi-code/k1',
      permission: 'yolo',
      planMode: true,
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(impl._agentStateForTest(SID)).toMatchObject({
      model: 'kimi-code/k1',
      permissionMode: 'yolo',
      planMode: true,
    });
  });

  it('shadow update suppresses diff dispatch when body matches the new state', async () => {
    const { bridge, record } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody());
    // Out-of-band mutation lands on the bus.
    triggerSubscribers({
      type: 'agent.status.updated',
      permission: 'yolo',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);

    record.setPermissionCalls.length = 0;
    await impl.submit(SID, mkBody({ permission_mode: 'yolo' }));
    expect(record.setPermissionCalls).toEqual([]);
  });

  it('is a no-op on agent.status.updated for sessions without a shadow yet', async () => {
    const { bridge } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    triggerSubscribers({
      type: 'agent.status.updated',
      model: 'kimi-code/k1',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(impl._agentStateForTest(SID)).toBeUndefined();
  });
});

describe('PromptService stateless controls — dispatch log', () => {
  it('is undefined before any submit and stays empty when the body matches bootstrap', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    expect(impl._dispatchLogForTest(SID)).toBeUndefined();
    // Default body matches the default bridge bootstrap (model=k2,
    // thinking=off, permission=manual, plan=null).
    await impl.submit(SID, mkBody());
    // No setter fired -> buffer never allocated -> still undefined.
    expect(impl._dispatchLogForTest(SID)).toBeUndefined();
  });

  it('appends one entry per setter dispatched, in the order setModel/setThinking/setPermission/(enter|cancel)Plan', async () => {
    const { bridge } = makeBridge({
      config: { modelAlias: 'kimi-code/k2', thinkingLevel: 'off' },
      permission: { mode: 'manual' },
      plan: null,
    });
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(
      SID,
      mkBody({
        model: 'kimi-code/k1',
        thinking: 'high',
        permission_mode: 'yolo',
        plan_mode: true,
      }),
    );
    const log = impl._dispatchLogForTest(SID);
    expect(log).toBeDefined();
    const kinds = (log ?? []).map((e) => e.kind);
    expect(kinds).toEqual(['setModel', 'setThinking', 'setPermission', 'enterPlan']);
    expect(log?.[0]?.payload).toEqual({
      sessionId: SID,
      agentId: 'main',
      model: 'kimi-code/k1',
    });
    expect(log?.[3]?.payload).toEqual({ sessionId: SID, agentId: 'main' });
    // Every entry from a prompt-body override path is tagged source='prompt'.
    expect((log ?? []).every((e) => e.source === 'prompt')).toBe(true);
    // Each entry should be attributed to the prompt id returned by submit;
    // they all share the same id within a single submit.
    expect(new Set((log ?? []).map((e) => e.promptId)).size).toBe(1);
  });

  it('does NOT append entries when a repeat submit matches the shadow', async () => {
    const { bridge } = makeBridge({ plan: null });
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    // First submit toggles plan_mode on -> 1 entry.
    await impl.submit(SID, mkBody({ plan_mode: true }));
    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(impl._dispatchLogForTest(SID)?.length).toBe(1);
    expect(impl._dispatchLogForTest(SID)?.[0]?.kind).toBe('enterPlan');

    // Second submit with the same plan_mode -> shadow suppresses dispatch.
    // This is the property scenario 04 cannot observe over WS frames alone.
    await impl.submit(SID, mkBody({ plan_mode: true }));
    expect(impl._dispatchLogForTest(SID)?.length).toBe(1);
  });

  it('clears the buffer when the session closes (re-bootstrap on next submit)', async () => {
    const { bridge } = makeBridge({ plan: null });
    const { bus } = makeBus();
    const { sessionService, triggerClose } = makeSessionService();
    const impl = new PromptService(bridge, bus, makeAuth(), sessionService, new NoopLogService());
    await impl.submit(SID, mkBody({ plan_mode: true }));
    expect(impl._dispatchLogForTest(SID)?.length).toBe(1);
    triggerClose(SID);
    expect(impl._dispatchLogForTest(SID)).toBeUndefined();
  });

  it('bootstraps swarmMode from getSwarmMode', async () => {
    const { bridge, record } = makeBridge({
      config: { modelAlias: 'kimi-code/k2', thinkingLevel: 'off' },
      permission: { mode: 'manual' },
      plan: null,
    });
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody({ model: 'kimi-code/k1' }));
    expect(record.getSwarmModeCalls).toBe(1);
  });

  it('dispatches enterSwarm/exitSwarm and records them in the log', async () => {
    const { bridge, record } = makeBridge({
      config: { modelAlias: 'kimi-code/k2', thinkingLevel: 'off' },
      permission: { mode: 'manual' },
      plan: null,
    });
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);

    await impl.submit(SID, mkBody({ swarm_mode: true }));
    expect(record.enterSwarmCalls.length).toBe(1);
    expect(record.enterSwarmCalls[0]).toEqual({
      sessionId: SID,
      agentId: 'main',
      trigger: 'manual',
    });
    let log = impl._dispatchLogForTest(SID);
    expect(log?.some((e) => e.kind === 'enterSwarm')).toBe(true);

    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);

    await impl.submit(SID, mkBody({ swarm_mode: false }));
    expect(record.exitSwarmCalls.length).toBe(1);
    expect(record.exitSwarmCalls[0]).toEqual({ sessionId: SID, agentId: 'main' });
    log = impl._dispatchLogForTest(SID);
    expect(log?.some((e) => e.kind === 'exitSwarm')).toBe(true);
  });

  it('does not re-dispatch swarm_mode when it matches the shadow', async () => {
    const { bridge, record } = makeBridge({
      config: { modelAlias: 'kimi-code/k2', thinkingLevel: 'off' },
      permission: { mode: 'manual' },
      plan: null,
    });
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody({ swarm_mode: true }));
    expect(record.enterSwarmCalls.length).toBe(1);

    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);

    await impl.submit(SID, mkBody({ swarm_mode: true }));
    expect(record.enterSwarmCalls.length).toBe(1);
  });

  it('dispatches createGoal and records it in the log', async () => {
    const { bridge, record } = makeBridge({
      config: { modelAlias: 'kimi-code/k2', thinkingLevel: 'off' },
      permission: { mode: 'manual' },
      plan: null,
    });
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBody({ goal_objective: 'Refactor the auth module' }));
    expect(record.createGoalCalls.length).toBe(1);
    expect(record.createGoalCalls[0]).toEqual({
      sessionId: SID,
      agentId: 'main',
      objective: 'Refactor the auth module',
      replace: false,
    });
    const log = impl._dispatchLogForTest(SID);
    expect(log?.some((e) => e.kind === 'createGoal')).toBe(true);
  });

  it('dispatches goal control actions and records them in the log', async () => {
    const { bridge, record } = makeBridge({
      config: { modelAlias: 'kimi-code/k2', thinkingLevel: 'off' },
      permission: { mode: 'manual' },
      plan: null,
    });
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.applyAgentState(SID, { goal_control: 'pause' }, 'meta');
    expect(record.pauseGoalCalls.length).toBe(1);
    await impl.applyAgentState(SID, { goal_control: 'resume' }, 'meta');
    expect(record.resumeGoalCalls.length).toBe(1);
    await impl.applyAgentState(SID, { goal_control: 'cancel' }, 'meta');
    expect(record.cancelGoalCalls.length).toBe(1);
    const log = impl._dispatchLogForTest(SID);
    expect(log?.filter((e) => e.kind === 'pauseGoal').length).toBe(1);
    expect(log?.filter((e) => e.kind === 'resumeGoal').length).toBe(1);
    expect(log?.filter((e) => e.kind === 'cancelGoal').length).toBe(1);
  });
});

describe('PromptService stateful session — content-only path', () => {
  it('issues zero bootstrap RPCs and zero setters when the body carries no controls', async () => {
    const { bridge, record } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.submit(SID, mkBodyMinimal());
    // Bootstrap getters never ran (no body control to diff against).
    expect(record.getConfigCalls).toBe(0);
    expect(record.getPermissionCalls).toBe(0);
    expect(record.getPlanCalls).toBe(0);
    expect(record.getSwarmModeCalls).toBe(0);
    // No setters fired either.
    expect(record.setModelCalls).toEqual([]);
    expect(record.setThinkingCalls).toEqual([]);
    expect(record.setPermissionCalls).toEqual([]);
    expect(record.enterPlanCalls).toEqual([]);
    expect(record.cancelPlanCalls).toEqual([]);
    // Shadow stays absent — there's nothing to remember.
    expect(impl._agentStateForTest(SID)).toBeUndefined();
    // Dispatch log untouched.
    expect(impl._dispatchLogForTest(SID)).toBeUndefined();
    // The prompt itself fires through to bridge.prompt.
    expect(record.promptCalls).toHaveLength(1);
  });

  it('reuses the shadow established by a prior submit for subsequent content-only submits', async () => {
    const { bridge, record } = makeBridge({ config: { modelAlias: 'kimi-code/k2' } });
    const { bus, triggerSubscribers } = makeBus();
    const impl = newSvc(bridge, bus);
    // First submit carries an override → bootstrap + dispatch.
    await impl.submit(SID, mkBody({ model: 'kimi-code/k9' }));
    expect(record.setModelCalls).toHaveLength(1);
    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    record.setModelCalls.length = 0;
    // Second submit content-only — uses the shadow, no setter re-fires.
    await impl.submit(SID, mkBodyMinimal({ content: [{ type: 'text', text: 'follow-up' }] }));
    expect(record.setModelCalls).toEqual([]);
    expect(impl._agentStateForTest(SID)?.model).toBe('kimi-code/k9');
  });
});

describe('PromptService.applyAgentState (POST /sessions/{sid}/profile path)', () => {
  it('throws SessionNotFoundError on unknown sid', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await expect(
      impl.applyAgentState('sess_missing', { model: 'kimi-code/k1' }, 'meta'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('is a no-op when the patch carries no fields (no bootstrap, no setter)', async () => {
    const { bridge, record } = makeBridge();
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.applyAgentState(SID, {}, 'meta');
    expect(record.getConfigCalls).toBe(0);
    expect(record.setModelCalls).toEqual([]);
    expect(impl._agentStateForTest(SID)).toBeUndefined();
  });

  it('dispatches setThinking and records source="meta" when patch differs from shadow', async () => {
    const { bridge, record } = makeBridge({ config: { thinkingLevel: 'off' } });
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.applyAgentState(SID, { thinking: 'high' }, 'meta');
    expect(record.setThinkingCalls).toEqual([
      { sessionId: SID, agentId: 'main', level: 'high' },
    ]);
    expect(impl._agentStateForTest(SID)?.thinking).toBe('high');
    const log = impl._dispatchLogForTest(SID);
    expect(log).toHaveLength(1);
    expect(log?.[0]?.source).toBe('meta');
    // No prompt minted → entry's promptId is the empty string.
    expect(log?.[0]?.promptId).toBe('');
  });

  it('subsequent content-only submit observes the shadow set via /profile and dispatches nothing', async () => {
    const { bridge, record } = makeBridge({
      config: { thinkingLevel: 'off' },
      permission: { mode: 'manual' },
    });
    const { bus } = makeBus();
    const impl = newSvc(bridge, bus);
    await impl.applyAgentState(
      SID,
      { thinking: 'high', permission_mode: 'yolo' },
      'meta',
    );
    record.setThinkingCalls.length = 0;
    record.setPermissionCalls.length = 0;
    await impl.submit(SID, mkBodyMinimal());
    expect(record.setThinkingCalls).toEqual([]);
    expect(record.setPermissionCalls).toEqual([]);
    expect(impl._agentStateForTest(SID)).toMatchObject({
      thinking: 'high',
      permissionMode: 'yolo',
    });
  });
});
