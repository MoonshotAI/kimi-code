import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Event, SessionStatus } from '@moonshot-ai/protocol';
import {
  type CoreRPC,
  Emitter,
  IInstantiationService,
  type SessionSummary,
} from '../../../src';
import { TestInstantiationService } from '#/_base/di/test';
import { IApprovalService } from '#/approval';
import type { IEventService } from '#/event';
import {
  type ICoreRuntime,
  IPromptService,
  IQuestionService,
} from '../../../src/services';
import type { AgentStateSnapshot } from '../../../src/services/prompt/prompt';
import { SessionRuntimeService } from '../../../src/services/session/sessionRuntimeService';
import { SessionNotFoundError } from '../../../src/services/session/session';

const WORKDIR_A = '/repos/alpha';

interface FakeState {
  sessions: SessionSummary[];
}

function freshState(): FakeState {
  return { sessions: [] };
}

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    workDir: WORKDIR_A,
    sessionDir: `/sessions/${overrides.id}`,
    createdAt: overrides.updatedAt ?? 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeFakeBridge(state: FakeState): ICoreRuntime & { getCoreApi(): CoreRPC } {
  const rpc: Partial<CoreRPC> = {
    listSessions: vi
      .fn()
      .mockImplementation(async (): Promise<readonly SessionSummary[]> => state.sessions),
    getConfig: vi.fn().mockResolvedValue({
      cwd: WORKDIR_A,
      modelAlias: 'kimi-k2',
      thinkingLevel: 'medium',
      modelCapabilities: { max_context_tokens: 1000 },
      systemPrompt: '',
    }),
    getContext: vi.fn().mockResolvedValue({ history: [], tokenCount: 250 }),
    getPermission: vi.fn().mockResolvedValue({ mode: 'default', rules: [] }),
    getPlan: vi.fn().mockResolvedValue(null),
  };
  // `getCoreApi()` mirrors `rpc` on purpose: in production both expose the
  // identical CoreAPI method set — `getCoreApi()` is the in-process
  // (zero-serialization) path, `rpc` is the serializing proxy. Sharing one
  // stub keeps the `bridge.rpc.*` call-recording assertions valid without
  // duplicating the mock.
  return {
    rpc: rpc as CoreRPC,
    getCoreApi: () => rpc as CoreRPC,
    ready: async () => undefined,
    dispose: () => undefined,
    _serviceBrand: undefined,
  };
}

function makeEventServiceStub(): {
  eventService: IEventService;
  published: unknown[];
} {
  const published: unknown[] = [];
  const emitter = new Emitter<never>();
  return {
    published,
    eventService: {
      _serviceBrand: undefined,
      publish: vi.fn((event: unknown) => {
        published.push(event);
        emitter.fire(event as never);
      }) as IEventService['publish'],
      onDidPublish: emitter.event as unknown as IEventService['onDidPublish'],
    },
  };
}

function makePromptServiceStub(): {
  promptService: IPromptService;
  activePromptIds: Map<string, string | undefined>;
  snapshots: Map<string, AgentStateSnapshot>;
} {
  const activePromptIds = new Map<string, string | undefined>();
  const snapshots = new Map<string, AgentStateSnapshot>();
  const emitter = new Emitter<never>();
  const promptService: IPromptService = {
    _serviceBrand: undefined,
    list: vi.fn() as unknown as IPromptService['list'],
    submit: vi.fn() as unknown as IPromptService['submit'],
    startBtw: vi.fn() as unknown as IPromptService['startBtw'],
    steer: vi.fn() as unknown as IPromptService['steer'],
    abort: vi.fn() as unknown as IPromptService['abort'],
    abortBySession: vi.fn() as unknown as IPromptService['abortBySession'],
    getCurrentPromptId: vi.fn().mockImplementation((sid: string) =>
      activePromptIds.get(sid),
    ) as unknown as IPromptService['getCurrentPromptId'],
    applyAgentState: vi.fn() as unknown as IPromptService['applyAgentState'],
    onDidComplete: emitter.event as unknown as IPromptService['onDidComplete'],
    onDidAbort: emitter.event as unknown as IPromptService['onDidAbort'],
    getAgentStateSnapshot: vi.fn().mockImplementation((sid: string) =>
      snapshots.get(sid),
    ) as unknown as IPromptService['getAgentStateSnapshot'],
  };
  return { promptService, activePromptIds, snapshots };
}

function makeApprovalServiceStub(): {
  approvalService: IApprovalService;
  pending: Map<string, unknown[]>;
} {
  const pending = new Map<string, unknown[]>();
  const approvalService: IApprovalService = {
    _serviceBrand: undefined,
    request: vi.fn() as unknown as IApprovalService['request'],
    resolve: vi.fn() as unknown as IApprovalService['resolve'],
    listPending: vi.fn().mockImplementation((sessionId: string) => {
      return (pending.get(sessionId) ?? []) as unknown as ReturnType<
        IApprovalService['listPending']
      >;
    }),
  } as unknown as IApprovalService;
  return { approvalService, pending };
}

function makeQuestionServiceStub(): {
  questionService: IQuestionService;
  pending: Map<string, unknown[]>;
} {
  const pending = new Map<string, unknown[]>();
  const questionService: IQuestionService = {
    _serviceBrand: undefined,
    request: vi.fn() as unknown as IQuestionService['request'],
    resolve: vi.fn() as unknown as IQuestionService['resolve'],
    dismiss: vi.fn() as unknown as IQuestionService['dismiss'],
    listPending: vi.fn().mockImplementation((sessionId: string) => {
      return (pending.get(sessionId) ?? []) as unknown as ReturnType<
        IQuestionService['listPending']
      >;
    }),
  } as unknown as IQuestionService;
  return { questionService, pending };
}

const SESSION_STATUSES: readonly SessionStatus[] = [
  'idle',
  'running',
  'awaiting_approval',
  'awaiting_question',
  'aborted',
];

let state: FakeState;
let bridge: ICoreRuntime;
let svc: SessionRuntimeService;
let promptStub: ReturnType<typeof makePromptServiceStub>;
let approvalStub: ReturnType<typeof makeApprovalServiceStub>;
let questionStub: ReturnType<typeof makeQuestionServiceStub>;
let eventBus: ReturnType<typeof makeEventServiceStub>;
let instantiation: TestInstantiationService;

beforeEach(() => {
  state = freshState();
  bridge = makeFakeBridge(state);
  promptStub = makePromptServiceStub();
  approvalStub = makeApprovalServiceStub();
  questionStub = makeQuestionServiceStub();
  eventBus = makeEventServiceStub();
  instantiation = new TestInstantiationService(undefined, true);
  instantiation.stub(IInstantiationService, instantiation);
  instantiation.stub(IPromptService, promptStub.promptService);
  instantiation.stub(IApprovalService, approvalStub.approvalService);
  instantiation.stub(IQuestionService, questionStub.questionService);
  svc = new SessionRuntimeService(
    bridge,
    eventBus.eventService,
    instantiation,
    approvalStub.approvalService,
    questionStub.questionService,
  );
});

afterEach(() => {
  svc.dispose();
  instantiation.dispose();
});

describe('SessionRuntimeService.getStatus', () => {
  it('returns idle for a cold (archived) session with no live state', async () => {
    state.sessions.push(makeSummary({ id: 'cold', archived: true }));

    const status = await svc.getStatus('cold');

    expect(status.status).toBe('idle');
    expect(status.context_tokens).toBe(250);
    expect(status.max_context_tokens).toBe(1000);
    expect(status.context_usage).toBeCloseTo(0.25);
    expect(status.model).toBe('kimi-k2');
    expect(status.thinking_level).toBe('medium');
    expect(status.permission).toBe('default');
    expect(status.plan_mode).toBe(false);
    expect(status.swarm_mode).toBe(false);
  });

  it('returns running for a live session with an active prompt', async () => {
    state.sessions.push(makeSummary({ id: 'live' }));
    promptStub.activePromptIds.set('live', 'prompt-1');
    promptStub.snapshots.set('live', { swarmMode: true, model: 'kimi-k2' });

    const status = await svc.getStatus('live');

    expect(status.status).toBe('running');
    expect(status.swarm_mode).toBe(true);
  });

  it('returns a clear SessionStatus enum (never undefined) for a cold session', async () => {
    state.sessions.push(makeSummary({ id: 's' }));

    const status = await svc.getStatus('s');

    expect(SESSION_STATUSES).toContain(status.status);
    expect(status.status).toBe('idle');
  });

  it('throws SessionNotFoundError for an unknown session', async () => {
    await expect(svc.getStatus('missing')).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('SessionRuntimeService.getLiveState', () => {
  it('returns the cold indicator for an unknown session', async () => {
    expect(await svc.getLiveState('unknown')).toEqual({ live: false });
  });

  it('returns a live descriptor when an agent is loaded', async () => {
    promptStub.snapshots.set('s', { model: 'kimi-k2', swarmMode: true });

    const live = await svc.getLiveState('s');

    expect(live).toEqual({
      live: true,
      agentState: { model: 'kimi-k2', swarmMode: true },
    });
  });
});

describe('SessionRuntimeService.onDidChangeStatus', () => {
  it('fires when an IEventService event changes the status', async () => {
    const listener = vi.fn();
    svc.onDidChangeStatus(listener);

    eventBus.eventService.publish({ type: 'turn.started', sessionId: 's' } as unknown as Event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's',
        status: 'running',
        previousStatus: 'idle',
      }),
    );
  });

  it('does NOT fire when the status is unchanged', () => {
    const listener = vi.fn();
    svc.onDidChangeStatus(listener);

    eventBus.eventService.publish({ type: 'prompt.completed', sessionId: 's' } as unknown as Event);

    expect(listener).not.toHaveBeenCalled();
  });

  it('republishes event.session.status_changed with the same payload', () => {
    svc.onDidChangeStatus(vi.fn());

    eventBus.eventService.publish({ type: 'turn.started', sessionId: 's' } as unknown as Event);

    const statusChanged = eventBus.published.find(
      (e) => (e as { type?: string }).type === 'event.session.status_changed',
    );
    expect(statusChanged).toMatchObject({
      type: 'event.session.status_changed',
      sessionId: 's',
      status: 'running',
      previous_status: 'idle',
    });
  });
});
