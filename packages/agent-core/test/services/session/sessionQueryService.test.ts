import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Event } from '@moonshot-ai/protocol';
import {
  type CoreRPC,
  Emitter,
  IInstantiationService,
  type ResumeSessionResult,
  type SessionMeta,
  type SessionSummary,
} from '../../../src';
import { TestInstantiationService } from '#/_base/di/test';
import {
  IApprovalService,
  type ICoreRuntime,
  type IEventService,
  IPromptService,
  IQuestionService,
} from '../../../src/services';
import { SessionQueryService } from '../../../src/services/session/sessionQueryService';
import {
  SessionNotFoundError,
  type SessionQueryScope,
} from '../../../src/services/session/session';
import { encodeWorkDirKey } from '../../../src/session/store';

const WORKDIR_A = '/repos/alpha';
const WORKDIR_B = '/repos/beta';
const WORKSPACE_A = encodeWorkDirKey(WORKDIR_A);
const WORKSPACE_B = encodeWorkDirKey(WORKDIR_B);

interface FakeState {
  sessions: SessionSummary[];
  metas: Map<string, SessionMeta>;
  resumedIds: string[];
}

function freshState(): FakeState {
  return {
    sessions: [],
    metas: new Map(),
    resumedIds: [],
  };
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
      .mockImplementation(
        async (input?: {
          workDir?: string;
          includeArchive?: boolean;
        }): Promise<readonly SessionSummary[]> => {
          if (input?.workDir !== undefined) {
            return state.sessions.filter((s) => s.workDir === input.workDir);
          }
          return state.sessions;
        },
      ),
    getSessionMetadata: vi
      .fn()
      .mockImplementation(async ({ sessionId }: { sessionId: string }): Promise<SessionMeta> => {
        const found = state.metas.get(sessionId);
        if (found === undefined) {
          throw new Error(`no metadata for ${sessionId}`);
        }
        return found;
      }),
    resumeSession: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      state.resumedIds.push(sessionId);
      const found = state.sessions.find((s) => s.id === sessionId);
      if (found === undefined) throw new Error(`missing session ${sessionId}`);
      return found as unknown as ResumeSessionResult;
    }),
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
  events: unknown[];
} {
  const events: unknown[] = [];
  const emitter = new Emitter<never>();
  return {
    events,
    eventService: {
      _serviceBrand: undefined,
      publish: vi.fn((event: unknown) => {
        events.push(event);
        emitter.fire(event as never);
      }) as IEventService['publish'],
      onDidPublish: emitter.event as unknown as IEventService['onDidPublish'],
    },
  };
}

function makePromptServiceStub(): {
  promptService: IPromptService;
  activePromptIds: Map<string, string | undefined>;
} {
  const activePromptIds = new Map<string, string | undefined>();
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
    getAgentStateSnapshot: vi
      .fn()
      .mockReturnValue(undefined) as unknown as IPromptService['getAgentStateSnapshot'],
  };
  return { promptService, activePromptIds };
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

let state: FakeState;
let bridge: ICoreRuntime;
let svc: SessionQueryService;
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
  svc = new SessionQueryService(
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

function ids(page: { items: readonly { id: string }[] }): string[] {
  return page.items.map((s) => s.id);
}

describe('SessionQueryService.list', () => {
  it('returns descending-by-updatedAt order with default page size', async () => {
    state.sessions.push(
      makeSummary({ id: 'old', updatedAt: 1 }),
      makeSummary({ id: 'new', updatedAt: 3 }),
      makeSummary({ id: 'mid', updatedAt: 2 }),
    );

    const page = await svc.list({});

    expect(ids(page)).toEqual(['new', 'mid', 'old']);
    expect(page.has_more).toBe(false);
  });

  it('honors page_size and surfaces has_more', async () => {
    state.sessions.push(
      makeSummary({ id: 'a', updatedAt: 3 }),
      makeSummary({ id: 'b', updatedAt: 2 }),
      makeSummary({ id: 'c', updatedAt: 1 }),
    );

    const page = await svc.list({ page_size: 2 });

    expect(ids(page)).toEqual(['a', 'b']);
    expect(page.has_more).toBe(true);
  });

  it('before_id returns less-recent sessions only', async () => {
    state.sessions.push(
      makeSummary({ id: 'a', updatedAt: 3 }),
      makeSummary({ id: 'b', updatedAt: 2 }),
      makeSummary({ id: 'c', updatedAt: 1 }),
    );

    const older = await svc.list({ before_id: 'a' });

    expect(ids(older)).toEqual(['b', 'c']);
  });

  it('after_id returns more-recent sessions only', async () => {
    state.sessions.push(
      makeSummary({ id: 'a', updatedAt: 3 }),
      makeSummary({ id: 'b', updatedAt: 2 }),
      makeSummary({ id: 'c', updatedAt: 1 }),
    );

    const newer = await svc.list({ after_id: 'c' });

    expect(ids(newer)).toEqual(['a', 'b']);
  });

  it('status filter applies post-hydration', async () => {
    state.sessions.push(
      makeSummary({ id: 'a', updatedAt: 2 }),
      makeSummary({ id: 'b', updatedAt: 1 }),
    );

    const running = await svc.list({ status: 'running' });
    const idle = await svc.list({ status: 'idle' });

    expect(running.items).toEqual([]);
    expect(idle.items).toHaveLength(2);
  });

  it('does not resume an agent during a plain list (cold path only)', async () => {
    state.sessions.push(
      makeSummary({ id: 'a', updatedAt: 2 }),
      makeSummary({ id: 'b', updatedAt: 1 }),
    );

    await svc.list({});

    // The query service never touches the runtime session aggregate, so
    // getReadyAgent is unreachable by construction; the warm-path resume
    // primitive must not be invoked either.
    expect(bridge.rpc.resumeSession).not.toHaveBeenCalled();
    expect(state.resumedIds).toEqual([]);
    // Cold reads still happen: the index is seeded from listSessions and each
    // row is hydrated via getSessionMetadata.
    expect(bridge.rpc.listSessions).toHaveBeenCalled();
    expect(bridge.rpc.getSessionMetadata).toHaveBeenCalled();
  });
});

describe('SessionQueryService.count', () => {
  it('counts visible (non-archived) sessions in global scope by default', async () => {
    state.sessions.push(
      makeSummary({ id: 'live-1' }),
      makeSummary({ id: 'live-2' }),
      makeSummary({ id: 'archived', archived: true }),
    );

    expect(await svc.count()).toBe(2);
    expect(await svc.count({ kind: 'global' })).toBe(2);
  });

  it('counts within a workspace scope', async () => {
    state.sessions.push(
      makeSummary({ id: 'a1', workDir: WORKDIR_A }),
      makeSummary({ id: 'a2', workDir: WORKDIR_A }),
      makeSummary({ id: 'b1', workDir: WORKDIR_B }),
    );

    const scopeA: SessionQueryScope = { kind: 'workspace', workspaceId: WORKSPACE_A };
    expect(await svc.count(scopeA)).toBe(2);
  });
});

describe('SessionQueryService.listChildren', () => {
  it('filters to direct children of the parent', async () => {
    state.sessions.push(
      makeSummary({ id: 'parent', updatedAt: 10 }),
      makeSummary({
        id: 'child-1',
        updatedAt: 9,
        metadata: { parent_session_id: 'parent', child_session_kind: 'child' },
      }),
      makeSummary({
        id: 'child-2',
        updatedAt: 8,
        metadata: { parent_session_id: 'parent', child_session_kind: 'child' },
      }),
      makeSummary({
        id: 'other',
        updatedAt: 7,
        metadata: { parent_session_id: 'someone-else', child_session_kind: 'child' },
      }),
      makeSummary({ id: 'no-meta', updatedAt: 6 }),
    );

    const page = await svc.listChildren('parent', {});

    expect(ids(page).sort()).toEqual(['child-1', 'child-2']);
  });

  it('throws SessionNotFoundError for a missing parent', async () => {
    await expect(svc.listChildren('missing', {})).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('SessionQueryService archive visibility', () => {
  it('exclude (default) hides archived; include surfaces them', async () => {
    state.sessions.push(
      makeSummary({ id: 'live', updatedAt: 2 }),
      makeSummary({ id: 'archived', updatedAt: 1, archived: true }),
    );

    const excluded = await svc.listGlobal({});
    const included = await svc.listGlobal({ includeArchive: true });

    expect(ids(excluded)).toEqual(['live']);
    expect(ids(included).sort()).toEqual(['archived', 'live']);
  });
});

describe('SessionQueryService.listByWorkspace', () => {
  it('filters by workspace derived from workDir', async () => {
    state.sessions.push(
      makeSummary({ id: 'a1', workDir: WORKDIR_A, updatedAt: 3 }),
      makeSummary({ id: 'a2', workDir: WORKDIR_A, updatedAt: 2 }),
      makeSummary({ id: 'b1', workDir: WORKDIR_B, updatedAt: 1 }),
    );

    const page = await svc.listByWorkspace(WORKSPACE_B, {});

    expect(ids(page)).toEqual(['b1']);
  });
});

describe('SessionQueryService.search', () => {
  it('matches by title (case-insensitive) within the implied scope', async () => {
    state.sessions.push(
      makeSummary({ id: 'a', title: 'Fix login bug', updatedAt: 3 }),
      makeSummary({ id: 'b', title: 'Refactor auth', updatedAt: 2 }),
      makeSummary({ id: 'c', title: 'fix signup flow', updatedAt: 1 }),
    );

    const page = await svc.search({ q: 'fix' });

    expect(ids(page).sort()).toEqual(['a', 'c']);
  });
});

describe('SessionQueryService live status', () => {
  it('reflects turn.started as running via the shared status derivation', async () => {
    state.sessions.push(makeSummary({ id: 's', updatedAt: 1 }));

    eventBus.eventService.publish({ type: 'turn.started', sessionId: 's' } as unknown as Event);

    const page = await svc.list({});
    expect(page.items[0]?.status).toBe('running');
  });
});
