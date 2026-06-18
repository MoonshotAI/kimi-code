import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentContextData,
  type CoreRPC,
  type ContextMessage,
  type CreateSessionPayload,
  Emitter,
  type ForkSessionPayload,
  IInstantiationService,
  type RenameSessionPayload,
  type ResumeSessionResult,
  type SessionMeta,
  type SessionSummary,
  type UpdateSessionMetadataPayload,
} from '../../src';
import { TestInstantiationService } from '../../src/di/test';
import { emptySessionUsage, type Event, type Session } from '@moonshot-ai/protocol';

import {
  IApprovalService,
  type IAuthSummaryService,
  type ICoreProcessService,
  type IEventService,
  IPromptService,
  IQuestionService,
  type ISessionService,
  PromptService,
  SessionNotFoundError,
  SessionUndoUnavailableError,
  SessionService,
  toProtocolSession,
} from '../../src/services';

type WithSessionId<T> = T & { readonly sessionId: string };

interface FakeBridgeState {
  sessions: SessionSummary[];
  createPayloads: CreateSessionPayload[];
  metas: Map<string, SessionMeta>;
  archivedIds: string[];
  closedIds: string[];
  renamedTitles: Map<string, string>;
  metadataPatches: Map<string, UpdateSessionMetadataPayload['metadata']>;
  forkPayloads: Array<WithSessionId<Omit<ForkSessionPayload, 'sessionId'>>>;
  compactions: Array<{ sessionId: string; agentId: string; instruction?: string }>;
  undoPayloads: Array<{ sessionId: string; agentId: string; count: number }>;
  resumedIds: string[];
  contexts: Map<string, AgentContextData>;
  postUndoContexts: Map<string, AgentContextData>;
}

function makeFakeBridge(state: FakeBridgeState): ICoreProcessService {
  const rpc: Partial<CoreRPC> = {
    createSession: vi
      .fn()
      .mockImplementation(async (payload: CreateSessionPayload): Promise<SessionSummary> => {
        state.createPayloads.push(payload);
        const id = payload.id ?? `sess_${state.sessions.length + 1}`;
        const created: SessionSummary = {
          id,
          workDir: payload.workDir,
          sessionDir: `/tmp/sessions/${id}`,
          createdAt: 1_000_000 + state.sessions.length * 1_000,
          updatedAt: 1_000_000 + state.sessions.length * 1_000,
          metadata: payload.metadata,
          title: undefined,
        };
        state.sessions.push(created);
        return created;
      }),
    listSessions: vi
      .fn()
      .mockImplementation(
        async (
          input?: { workDir?: string },
        ): Promise<readonly SessionSummary[]> => {
          if (input?.workDir !== undefined) {
            return state.sessions.filter((s) => s.workDir === input.workDir);
          }
          return state.sessions;
        },
      ),
    forkSession: vi
      .fn()
      .mockImplementation(async (payload: ForkSessionPayload): Promise<ResumeSessionResult> => {
        const source = state.sessions.find((s) => s.id === payload.sessionId);
        if (source === undefined) {
          throw new Error(`missing source ${payload.sessionId}`);
        }
        state.forkPayloads.push({
          sessionId: payload.sessionId,
          id: payload.id,
          title: payload.title,
          metadata: payload.metadata,
        });
        const id = payload.id ?? `sess_fork_${state.sessions.length + 1}`;
        const created: SessionSummary = {
          id,
          workDir: source.workDir,
          sessionDir: `/tmp/sessions/${id}`,
          createdAt: 2_000_000 + state.sessions.length * 1_000,
          updatedAt: 2_000_000 + state.sessions.length * 1_000,
          metadata: {
            ...source.metadata,
            ...payload.metadata,
          },
          title: payload.title,
        };
        state.sessions.push(created);
        const sourceMeta = state.metas.get(source.id);
        const sessionMetadata: SessionMeta = {
          title: payload.title ?? `Fork: ${source.title ?? source.id}`,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          isCustomTitle: payload.title !== undefined,
          agents: {},
          custom: {
            ...sourceMeta?.custom,
            ...payload.metadata,
          },
          forkedFrom: source.id,
        };
        state.metas.set(id, sessionMetadata);
        return {
          ...created,
          sessionMetadata,
          agents: {},
        };
      }),
    archiveSession: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      state.archivedIds.push(sessionId);
    }),
    renameSession: vi
      .fn()
      .mockImplementation(async (payload: WithSessionId<RenameSessionPayload>) => {
        state.renamedTitles.set(payload.sessionId, payload.title);
        const existing = state.metas.get(payload.sessionId);
        if (existing !== undefined) {
          state.metas.set(payload.sessionId, { ...existing, title: payload.title });
        } else {
          state.metas.set(payload.sessionId, {
            title: payload.title,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            isCustomTitle: true,
            agents: {},
            custom: {},
          });
        }
      }),
    updateSessionMetadata: vi
      .fn()
      .mockImplementation(
        async (payload: WithSessionId<UpdateSessionMetadataPayload>) => {
          state.metadataPatches.set(payload.sessionId, payload.metadata);
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
    beginCompaction: vi
      .fn()
      .mockImplementation(async (payload: { sessionId: string; agentId: string; instruction?: string }) => {
        state.compactions.push(payload);
      }),
    resumeSession: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      state.resumedIds.push(sessionId);
      const found = state.sessions.find((session) => session.id === sessionId);
      if (found === undefined) throw new Error(`missing session ${sessionId}`);
      return found as ResumeSessionResult;
    }),
    undoHistory: vi
      .fn()
      .mockImplementation(async (payload: { sessionId: string; agentId: string; count: number }) => {
        state.undoPayloads.push(payload);
        const next = state.postUndoContexts.get(payload.sessionId);
        if (next !== undefined) {
          state.contexts.set(payload.sessionId, next);
        }
      }),
    getContext: vi
      .fn()
      .mockImplementation(async ({ sessionId }: { sessionId: string }): Promise<AgentContextData> => {
        return state.contexts.get(sessionId) ?? { history: [], tokenCount: 0 };
      }),
    getConfig: vi.fn().mockResolvedValue({
      modelAlias: 'kimi-k2',
      thinkingLevel: 'auto',
      modelCapabilities: { max_context_tokens: 100 },
    }),
    getPermission: vi.fn().mockResolvedValue({ mode: 'manual' }),
    getPlan: vi.fn().mockResolvedValue(null),
  };
  return {
    rpc: rpc as CoreRPC,
    ready: async () => undefined,
    dispose: () => undefined,
    _serviceBrand: undefined,
  };
}

function freshState(): FakeBridgeState {
  return {
    sessions: [],
    createPayloads: [],
    metas: new Map(),
    archivedIds: [],
    closedIds: [],
    renamedTitles: new Map(),
    metadataPatches: new Map(),
    forkPayloads: [],
    compactions: [],
    undoPayloads: [],
    resumedIds: [],
    contexts: new Map(),
    postUndoContexts: new Map(),
  };
}

function textMessage(
  role: ContextMessage['role'],
  text: string,
  origin?: ContextMessage['origin'],
): ContextMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin,
  };
}

let state: FakeBridgeState;
let svc: SessionService;
let promptStub: ReturnType<typeof makePromptServiceStub>;
let approvalStub: ReturnType<typeof makeApprovalServiceStub>;
let questionStub: ReturnType<typeof makeQuestionServiceStub>;
let eventBus: ReturnType<typeof makeEventServiceStub>;
let instantiation: TestInstantiationService;

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
  calls: Array<{ sid: string; patch: Record<string, unknown>; source: string; promptId: string | undefined }>;
  activePromptIds: Map<string, string | undefined>;
} {
  const calls: Array<{ sid: string; patch: Record<string, unknown>; source: string; promptId: string | undefined }> = [];
  const activePromptIds = new Map<string, string | undefined>();
  const applyAgentState = vi
    .fn()
    .mockImplementation(async (sid: string, patch: Record<string, unknown>, source: string, promptId?: string) => {
      calls.push({ sid, patch, source, promptId });
    });
  const emitter = new Emitter<never>();
  const promptService: IPromptService = {
    _serviceBrand: undefined,
    list: vi.fn() as unknown as IPromptService['list'],
    submit: vi.fn() as unknown as IPromptService['submit'],
    startBtw: vi.fn().mockResolvedValue('btw_test') as unknown as IPromptService['startBtw'],
    steer: vi.fn() as unknown as IPromptService['steer'],
    abort: vi.fn() as unknown as IPromptService['abort'],
    abortBySession: vi.fn() as unknown as IPromptService['abortBySession'],
    getCurrentPromptId: vi.fn().mockImplementation((sid: string) => activePromptIds.get(sid)) as unknown as IPromptService['getCurrentPromptId'],
    applyAgentState,
    onDidComplete: emitter.event as unknown as IPromptService['onDidComplete'],
    onDidAbort: emitter.event as unknown as IPromptService['onDidAbort'],
    getAgentStateSnapshot: vi.fn().mockReturnValue(undefined) as unknown as IPromptService['getAgentStateSnapshot'],
  };
  return { promptService, calls, activePromptIds };
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
      return (pending.get(sessionId) ?? []) as unknown as ReturnType<IApprovalService['listPending']>;
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
      return (pending.get(sessionId) ?? []) as unknown as ReturnType<IQuestionService['listPending']>;
    }),
  } as unknown as IQuestionService;
  return { questionService, pending };
}

function makeTestInstantiation(stubs: {
  promptService: IPromptService;
  approvalService: IApprovalService;
  questionService: IQuestionService;
}): TestInstantiationService {
  const ix = new TestInstantiationService(undefined, true);
  ix.stub(IInstantiationService, ix);
  ix.stub(IPromptService, stubs.promptService);
  ix.stub(IApprovalService, stubs.approvalService);
  ix.stub(IQuestionService, stubs.questionService);
  return ix;
}

beforeEach(() => {
  state = freshState();
  promptStub = makePromptServiceStub();
  approvalStub = makeApprovalServiceStub();
  questionStub = makeQuestionServiceStub();
  eventBus = makeEventServiceStub();
  instantiation = makeTestInstantiation({
    promptService: promptStub.promptService,
    approvalService: approvalStub.approvalService,
    questionService: questionStub.questionService,
  });
  svc = new SessionService(
    makeFakeBridge(state),
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

describe('toProtocolSession adapter', () => {
  it('converts camelCase + number timestamps to snake_case + ISO Z', () => {
    const summary: SessionSummary = {
      id: 'sess_01',
      title: 'Hello',
      workDir: '/tmp/wd',
      sessionDir: '/tmp/sd',
      createdAt: 1_000_000_000_000,
      updatedAt: 1_000_000_001_000,
    };
    const proto = toProtocolSession(summary);
    expect(proto.id).toBe('sess_01');
    expect(proto.title).toBe('Hello');
    expect(proto.metadata.cwd).toBe('/tmp/wd');
    expect(proto.created_at).toBe(new Date(1_000_000_000_000).toISOString());
    expect(proto.updated_at).toBe(new Date(1_000_000_001_000).toISOString());
    expect(proto.created_at.endsWith('Z')).toBe(true);
  });

  it('fills documented defaults when CoreAPI does not surface a field', () => {
    const summary: SessionSummary = {
      id: 'sess_02',
      workDir: '/tmp/wd2',
      sessionDir: '/tmp/sd2',
      createdAt: 0,
      updatedAt: 0,
    };
    const proto = toProtocolSession(summary);
    expect(proto.status).toBe('idle');
    expect(proto.usage).toEqual(emptySessionUsage());
    expect(proto.permission_rules).toEqual([]);
    expect(proto.message_count).toBe(0);
    expect(proto.last_seq).toBe(0);
    expect(proto.agent_config.model).toBe('');
    expect(proto.title).toBe('');
  });

  it('enriches title + cwd from SessionMeta when available', () => {
    const summary: SessionSummary = {
      id: 'sess_03',
      workDir: '/tmp/orig',
      sessionDir: '/tmp/sd3',
      createdAt: 0,
      updatedAt: 0,
    };
    const meta: SessionMeta = {
      title: 'Renamed via meta',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCustomTitle: true,
      agents: {},
      custom: { cwd: '/tmp/cwd-from-meta', other_key: 'x' },
    };
    const proto = toProtocolSession(summary, meta);
    expect(proto.title).toBe('Renamed via meta');
    expect(proto.metadata.cwd).toBe('/tmp/cwd-from-meta');
    expect(proto.metadata['other_key']).toBe('x');
  });

  it('preserves custom metadata from the summary when SessionMeta is unavailable', () => {
    const summary: SessionSummary = {
      id: 'sess_summary_meta',
      workDir: '/tmp/orig',
      sessionDir: '/tmp/sd-summary-meta',
      createdAt: 0,
      updatedAt: 0,
      metadata: {
        cwd: '/tmp/from-summary',
        parent_session_id: 'sess_parent',
        child_session_kind: 'child',
        topic: 'btw',
      },
    };
    const proto = toProtocolSession(summary);
    expect(proto.metadata).toMatchObject({
      cwd: '/tmp/from-summary',
      parent_session_id: 'sess_parent',
      child_session_kind: 'child',
      topic: 'btw',
    });
  });

  it('strips the internal "goal" metadata key', () => {
    const summary: SessionSummary = {
      id: 'sess_04',
      workDir: '/tmp/wd',
      sessionDir: '/tmp/sd',
      createdAt: 0,
      updatedAt: 0,
    };
    const meta: SessionMeta = {
      title: 't',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCustomTitle: false,
      agents: {},
      custom: { goal: { secret: 'state' }, keep: 'me' },
    };
    const proto = toProtocolSession(summary, meta);
    expect(proto.metadata['goal']).toBeUndefined();
    expect(proto.metadata['keep']).toBe('me');
  });

  it('derives workspace_id from summary.workDir via encodeWorkDirKey', async () => {
    const { encodeWorkDirKey } = await import('../../src/session/store');
    const summary: SessionSummary = {
      id: 'sess_ws',
      workDir: '/tmp/wd-ws',
      sessionDir: '/tmp/sd-ws',
      createdAt: 0,
      updatedAt: 0,
    };
    const proto = toProtocolSession(summary);
    expect(proto.workspace_id).toBe(encodeWorkDirKey('/tmp/wd-ws'));
    expect(proto.workspace_id).toMatch(/^wd_[A-Za-z0-9._-]+_[0-9a-f]{12}$/);
  });
});

describe('SessionService.create', () => {
  it('calls bridge.rpc.createSession with workDir = metadata.cwd and returns a protocol Session', async () => {
    const session = await svc.create({
      metadata: { cwd: '/tmp/foo' },
      title: 'My session',
    });
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]!.workDir).toBe('/tmp/foo');
    expect(session.metadata.cwd).toBe('/tmp/foo');
    expect(session.title).toBe('My session');
    expect(session.created_at.endsWith('Z')).toBe(true);
  });

  it('passes model through to the agent_config when supplied', async () => {
    await svc.create({
      metadata: { cwd: '/tmp/x' },
      agent_config: { model: 'moonshot-v1-128k' },
    });
    expect(state.sessions[0]!.metadata?.['cwd']).toBe('/tmp/x');
  });

  it('passes client telemetry metadata through to core createSession', async () => {
    await svc.create(
      { metadata: { cwd: '/tmp/web' } },
      {
        client: {
          id: 'web_test_client',
          name: 'kimi-code-web',
          version: '0.1.1',
          uiMode: 'web',
        },
      },
    );

    expect(state.createPayloads[0]!.client).toEqual({
      id: 'web_test_client',
      name: 'kimi-code-web',
      version: '0.1.1',
      uiMode: 'web',
    });
  });

  it('rejects when metadata.cwd is absent (daemon route must pre-resolve workspace_id → cwd)', async () => {
    await expect(svc.create({} as unknown as Parameters<typeof svc.create>[0])).rejects.toThrow(
      /metadata\.cwd is required/,
    );
  });
});

describe('SessionService.list', () => {
  beforeEach(async () => {
    await svc.create({ metadata: { cwd: '/tmp/a' } });
    await svc.create({ metadata: { cwd: '/tmp/b' } });
    await svc.create({ metadata: { cwd: '/tmp/c' } });
  });

  it('returns descending-by-updatedAt order with default page size', async () => {
    const page = await svc.list({});
    expect(page.items).toHaveLength(3);
    expect(page.items[0]!.metadata.cwd).toBe('/tmp/c');
    expect(page.items[2]!.metadata.cwd).toBe('/tmp/a');
    expect(page.has_more).toBe(false);
  });

  it('honors page_size and surfaces has_more', async () => {
    const page = await svc.list({ page_size: 2 });
    expect(page.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/c', '/tmp/b']);
    expect(page.has_more).toBe(true);
  });

  it('before_id returns less-recent sessions only', async () => {
    const all = await svc.list({});
    const pivotId = all.items[0]!.id;
    const olderPage = await svc.list({ before_id: pivotId });
    expect(olderPage.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/b', '/tmp/a']);
  });

  it('after_id returns more-recent sessions only', async () => {
    const all = await svc.list({});
    const pivotId = all.items[2]!.id;
    const newerPage = await svc.list({ after_id: pivotId });
    expect(newerPage.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/c', '/tmp/b']);
  });

  it('status filter applies post-hydration', async () => {
    const empty = await svc.list({ status: 'running' });
    expect(empty.items).toEqual([]);
    const idle = await svc.list({ status: 'idle' });
    expect(idle.items.length).toBe(3);
  });

  it('forwards workDir to the underlying core.rpc.listSessions for the workspace fast path', async () => {
    const page = await svc.list({ workDir: '/tmp/b' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.metadata.cwd).toBe('/tmp/b');
    const calls = (state as unknown as { sessions: SessionSummary[] }).sessions;
    void calls;
  });

  it('returns an empty page when workDir matches no sessions', async () => {
    const page = await svc.list({ workDir: '/tmp/nonexistent' });
    expect(page.items).toEqual([]);
    expect(page.has_more).toBe(false);
  });
});

describe('SessionService.get', () => {
  it('returns the matching session', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/x' } });
    const found = await svc.get(created.id);
    expect(found.id).toBe(created.id);
    expect(found.metadata.cwd).toBe('/tmp/x');
  });

  it('throws SessionNotFoundError for an unknown id', async () => {
    await expect(svc.get('does-not-exist')).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(svc.get('does-not-exist')).rejects.toThrow(/does not exist/);
  });
});

describe('SessionService.update', () => {
  let created: Session;

  beforeEach(async () => {
    created = await svc.create({ metadata: { cwd: '/tmp/u' } });
  });

  it('rejects updates to missing sessions with SessionNotFoundError', async () => {
    await expect(svc.update('does-not-exist', { title: 'x' })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('routes title through bridge.rpc.renameSession', async () => {
    await svc.update(created.id, { title: 'Renamed' });
    expect(state.renamedTitles.get(created.id)).toBe('Renamed');
    expect(state.metadataPatches.has(created.id)).toBe(false);
  });

  it('routes metadata patch through bridge.rpc.updateSessionMetadata (into .custom)', async () => {
    await svc.update(created.id, { metadata: { custom_field: 'x' } });
    const patch = state.metadataPatches.get(created.id);
    expect(patch).toEqual({ custom: { custom_field: 'x' } });
  });

  it('handles both title + metadata in a single update', async () => {
    await svc.update(created.id, { title: 'New', metadata: { tag: 'a' } });
    expect(state.renamedTitles.get(created.id)).toBe('New');
    expect(state.metadataPatches.get(created.id)).toEqual({ custom: { tag: 'a' } });
  });

  it('is a no-op when update body is empty', async () => {
    await svc.update(created.id, {});
    expect(state.renamedTitles.size).toBe(0);
    expect(state.metadataPatches.size).toBe(0);
    expect(promptStub.calls).toEqual([]);
  });

  it('forwards agent_config.model through IPromptService.applyAgentState (source="meta")', async () => {
    await svc.update(created.id, { agent_config: { model: 'kimi-code/k9' } });
    expect(promptStub.calls).toEqual([
      { sid: created.id, patch: { model: 'kimi-code/k9' }, source: 'meta', promptId: undefined },
    ]);
  });

  it('ignores agent_config.model when empty string (legacy quirk preserved)', async () => {
    await svc.update(created.id, { agent_config: { model: '' } });
    expect(promptStub.calls).toEqual([]);
  });

  it('forwards thinking + permission_mode + plan_mode through applyAgentState in one call', async () => {
    await svc.update(created.id, {
      agent_config: {
        thinking: 'high',
        permission_mode: 'yolo',
        plan_mode: true,
      },
    });
    expect(promptStub.calls).toEqual([
      {
        sid: created.id,
        patch: { thinking: 'high', permission_mode: 'yolo', plan_mode: true },
        source: 'meta',
        promptId: undefined,
      },
    ]);
  });

  it('combines model + runtime controls into a single applyAgentState call', async () => {
    await svc.update(created.id, {
      agent_config: { model: 'kimi-code/k9', plan_mode: false },
    });
    expect(promptStub.calls).toHaveLength(1);
    expect(promptStub.calls[0]?.patch).toEqual({ model: 'kimi-code/k9', plan_mode: false });
    expect(promptStub.calls[0]?.source).toBe('meta');
  });

  it('does not call applyAgentState when agent_config carries no runtime fields', async () => {
    await svc.update(created.id, { agent_config: {} });
    expect(promptStub.calls).toEqual([]);
  });

  it('returns the post-update Session shape', async () => {
    const after = await svc.update(created.id, { title: 'Renamed' });
    expect(after.id).toBe(created.id);
    expect(after.metadata.cwd).toBe('/tmp/u');
  });
});

describe('SessionService.fork', () => {
  it('forks through core.rpc.forkSession with TUI-compatible default title', async () => {
    const source = await svc.create({
      metadata: { cwd: '/tmp/fork', source: true },
      title: 'Source title',
    });

    const fork = await svc.fork(source.id, { metadata: { child: true } });

    expect(state.forkPayloads).toEqual([
      {
        sessionId: source.id,
        id: undefined,
        title: 'Fork: Source title',
        metadata: { child: true },
      },
    ]);
    expect(fork.id).toMatch(/^sess_fork_/);
    expect(fork.title).toBe('Fork: Source title');
    expect(fork.metadata).toMatchObject({
      cwd: '/tmp/fork',
      child: true,
    });
  });

  it('passes an explicit title through to core.rpc.forkSession', async () => {
    const source = await svc.create({ metadata: { cwd: '/tmp/fork-explicit' } });

    const fork = await svc.fork(source.id, {
      title: 'Custom fork',
      metadata: { origin: 'web' },
    });

    expect(state.forkPayloads[0]).toEqual({
      sessionId: source.id,
      id: undefined,
      title: 'Custom fork',
      metadata: { origin: 'web' },
    });
    expect(fork.id).toMatch(/^sess_fork_/);
    expect(fork.title).toBe('Custom fork');
  });

  it('throws SessionNotFoundError when the source session is missing', async () => {
    await expect(svc.fork('missing', {})).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(state.forkPayloads).toEqual([]);
  });
});

describe('SessionService children', () => {
  it('creates a child session through forkSession with child metadata', async () => {
    const source = await svc.create({
      metadata: { cwd: '/tmp/child', source: true },
      title: 'Parent title',
    });

    const child = await svc.createChild(source.id, {
      metadata: {
        parent_session_id: 'spoofed-parent',
        child_session_kind: 'spoofed-kind',
        topic: 'btw',
      },
    });

    expect(state.forkPayloads).toEqual([
      {
        sessionId: source.id,
        id: undefined,
        title: 'Child: Parent title',
        metadata: {
          parent_session_id: source.id,
          child_session_kind: 'child',
          topic: 'btw',
        },
      },
    ]);
    expect(child.id).toMatch(/^sess_fork_/);
    expect(child.title).toBe('Child: Parent title');
    expect(child.metadata).toMatchObject({
      cwd: '/tmp/child',
      parent_session_id: source.id,
      child_session_kind: 'child',
      topic: 'btw',
    });
  });

  it('lists only direct children for a parent session', async () => {
    const parent = await svc.create({
      metadata: { cwd: '/tmp/children' },
      title: 'Parent',
    });
    const child = await svc.createChild(parent.id, { title: 'Child one' });
    await svc.fork(parent.id, { metadata: { forked: true } });
    const grandchild = await svc.createChild(child.id, { title: 'Grandchild' });

    const page = await svc.listChildren(parent.id, {});

    expect(page.has_more).toBe(false);
    expect(page.items.map((item) => item.id)).toEqual([child.id]);
    expect(page.items.map((item) => item.id)).not.toContain(grandchild.id);
  });

  it('lists children from persisted summary metadata when SessionMeta is unavailable', async () => {
    const parent = await svc.create({
      metadata: { cwd: '/tmp/persisted-child' },
      title: 'Parent',
    });
    const child = await svc.createChild(parent.id, { title: 'Child one' });
    state.metas.delete(child.id);

    const page = await svc.listChildren(parent.id, {});

    expect(page.items.map((item) => item.id)).toEqual([child.id]);
    expect(page.items[0]!.metadata).toMatchObject({
      cwd: '/tmp/persisted-child',
      parent_session_id: parent.id,
      child_session_kind: 'child',
    });
  });

  it('throws SessionNotFoundError when listing children for a missing parent', async () => {
    await expect(svc.listChildren('missing', {})).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('SessionService.archive', () => {
  it('calls bridge.rpc.archiveSession and returns { archived: true }', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/d' } });
    const result = await svc.archive(created.id);
    expect(result).toEqual({ archived: true });
    expect(state.archivedIds).toEqual([created.id]);
  });

  it('throws SessionNotFoundError on a missing id', async () => {
    await expect(svc.archive('does-not-exist')).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('SessionService.compact', () => {
  it('calls bridge.rpc.beginCompaction with the main agent and a trimmed instruction', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/compact' } });
    const result = await svc.compact(created.id, { instruction: '  focus on decisions  ' });
    expect(result).toEqual({});
    expect(state.compactions).toEqual([
      { sessionId: created.id, agentId: 'main', instruction: 'focus on decisions' },
    ]);
  });

  it('omits instruction when it is blank after trimming', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/compact-blank' } });
    await svc.compact(created.id, { instruction: '    ' });
    expect(state.compactions).toEqual([
      { sessionId: created.id, agentId: 'main', instruction: undefined },
    ]);
  });

  it('throws SessionNotFoundError on a missing id', async () => {
    await expect(svc.compact('does-not-exist', {})).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(state.compactions).toEqual([]);
  });
});

describe('SessionService.undo', () => {
  it('undoes through core and returns refreshed messages plus status', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/undo' } });
    state.contexts.set(created.id, {
      history: [
        textMessage('user', 'first prompt'),
        textMessage('assistant', 'first answer'),
        textMessage('user', 'second prompt'),
        textMessage('assistant', 'second answer'),
      ],
      tokenCount: 40,
    });
    state.postUndoContexts.set(created.id, {
      history: [
        textMessage('user', 'first prompt'),
        textMessage('assistant', 'first answer'),
      ],
      tokenCount: 20,
    });

    const result = await svc.undo(created.id, { count: 1, page_size: 10 });

    expect(state.resumedIds).toEqual([created.id]);
    expect(state.undoPayloads).toEqual([
      { sessionId: created.id, agentId: 'main', count: 1 },
    ]);
    expect(result.messages.has_more).toBe(false);
    expect(result.messages.items.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'first answer' },
      { type: 'text', text: 'first prompt' },
    ]);
    expect(result.status).toMatchObject({
      status: 'idle',
      model: 'kimi-k2',
      thinking_level: 'auto',
      permission: 'manual',
      plan_mode: false,
      context_tokens: 20,
      max_context_tokens: 100,
      context_usage: 0.2,
    });
  });

  it('does not call core undo when the requested count crosses a compaction boundary', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/undo-boundary' } });
    state.contexts.set(created.id, {
      history: [
        textMessage('assistant', 'summary', { kind: 'compaction_summary' }),
        textMessage('user', 'recent prompt'),
        textMessage('assistant', 'recent answer'),
      ],
      tokenCount: 20,
    });

    await expect(svc.undo(created.id, { count: 2 })).rejects.toBeInstanceOf(
      SessionUndoUnavailableError,
    );
    expect(state.undoPayloads).toEqual([]);
    expect(state.contexts.get(created.id)?.history.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'summary' },
      { type: 'text', text: 'recent prompt' },
      { type: 'text', text: 'recent answer' },
    ]);
  });

  it('throws SessionNotFoundError on a missing id', async () => {
    await expect(svc.undo('does-not-exist', { count: 1 })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    expect(state.undoPayloads).toEqual([]);
  });
});

describe('SessionService per-domain event listeners (Phase C)', () => {
  it('onDidCreate fires after bridge.rpc.createSession resolves', async () => {
    const events: unknown[] = [];
    svc.onDidCreate((e) => { events.push(e); });
    const session = await svc.create({ metadata: { cwd: '/tmp/evt' } });
    expect(events).toHaveLength(1);
    expect((events[0] as { session: { id: string } }).session.id).toBe(session.id);
  });

  it('publishes session.created after creating a session', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/evt-bus' } });
    expect(eventBus.events).toContainEqual({
      type: 'event.session.created',
      sessionId: session.id,
      agentId: 'main',
      session,
    });
  });

  it('onDidCreate detach stops future events', async () => {
    const events: unknown[] = [];
    const sub = svc.onDidCreate((e) => { events.push(e); });
    sub.dispose();
    await svc.create({ metadata: { cwd: '/tmp/evt2' } });
    expect(events).toHaveLength(0);
  });

  it('onDidClose fires after bridge.rpc.archiveSession resolves', async () => {
    const closedIds: string[] = [];
    svc.onDidClose((e) => { closedIds.push(e.sessionId); });
    const session = await svc.create({ metadata: { cwd: '/tmp/evt3' } });
    await svc.archive(session.id);
    expect(closedIds).toEqual([session.id]);
  });

  it('onDidClose detach stops future events', async () => {
    const closedIds: string[] = [];
    const sub = svc.onDidClose((e) => { closedIds.push(e.sessionId); });
    sub.dispose();
    const session = await svc.create({ metadata: { cwd: '/tmp/evt4' } });
    await svc.archive(session.id);
    expect(closedIds).toHaveLength(0);
  });
});

describe('SessionService status lifecycle', () => {
  it('getStatus returns live status', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/status' } });
    const status = await svc.getStatus(session.id);
    expect(status.status).toBe('idle');
  });

  it('patches created session status to idle', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/status2' } });
    expect(session.status).toBe('idle');
  });

  it('turn.started moves status to running and emits status_changed', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/running' } });
    eventBus.eventService.publish({
      type: 'turn.started',
      sessionId: session.id,
    } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('running');
    expect(eventBus.events).toContainEqual(expect.objectContaining({
      type: 'event.session.status_changed',
      sessionId: session.id,
      previous_status: 'idle',
      status: 'running',
    }));
  });

  it('turn.ended with success moves status back to idle', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/ended' } });
    eventBus.eventService.publish({ type: 'turn.started', sessionId: session.id } as unknown as Event);
    eventBus.eventService.publish({ type: 'turn.ended', sessionId: session.id, reason: 'success' } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('idle');
  });

  it('turn.ended with failed moves status to aborted', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/aborted' } });
    eventBus.eventService.publish({ type: 'turn.started', sessionId: session.id } as unknown as Event);
    eventBus.eventService.publish({ type: 'turn.ended', sessionId: session.id, reason: 'failed' } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('aborted');
  });

  it('prompt.submitted moves status to running when a current prompt exists', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/prompt' } });
    promptStub.activePromptIds.set(session.id, 'p1');
    eventBus.eventService.publish({ type: 'prompt.submitted', sessionId: session.id } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('running');
  });

  it('pending approval yields awaiting_approval', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/approval' } });
    approvalStub.pending.set(session.id, [{ id: 'a1' }]);
    eventBus.eventService.publish({ type: 'event.approval.requested', sessionId: session.id } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('awaiting_approval');
  });

  it('pending question yields awaiting_question', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/question' } });
    questionStub.pending.set(session.id, [{ id: 'q1' }]);
    eventBus.eventService.publish({ type: 'event.question.requested', sessionId: session.id } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('awaiting_question');
  });

  it('approval takes precedence over active prompt', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/priority' } });
    promptStub.activePromptIds.set(session.id, 'p1');
    approvalStub.pending.set(session.id, [{ id: 'a1' }]);
    eventBus.eventService.publish({ type: 'prompt.submitted', sessionId: session.id } as unknown as Event);
    expect((await svc.get(session.id)).status).toBe('awaiting_approval');
  });

  it('does not emit status_changed when status is unchanged', async () => {
    const session = await svc.create({ metadata: { cwd: '/tmp/nochange' } });
    const statusChangedCount = (e: unknown) =>
      (e as { type?: string }).type === 'event.session.status_changed';
    const before = eventBus.events.filter(statusChangedCount).length;
    eventBus.eventService.publish({ type: 'prompt.completed', sessionId: session.id } as unknown as Event);
    expect(eventBus.events.filter(statusChangedCount).length).toBe(before);
  });
});
