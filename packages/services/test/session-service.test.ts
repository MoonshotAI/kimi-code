/**
 * `SessionService` (Chain 2 / P1.2) unit tests.
 *
 * Hermetic: we mock `ICoreProcessService` with an in-memory `rpc` proxy whose
 * methods return controllable promises. No KimiCore, no agent-core RPC pair
 * — the adapter is exercised against a fake bridge.
 *
 * Test cases cover:
 *   - create → toProtocolSession (camelCase ↔ snake_case + number → ISO)
 *   - list pagination (default/before_id/after_id/page_size; has_more)
 *   - get + SessionNotFoundError → 40401 mapping at the daemon layer
 *   - update (title-only / metadata-only / both / empty)
 *   - delete returning {deleted: true}
 *   - toProtocolSession field defaults for fields agent-core doesn't surface
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CoreRPC,
  type CreateSessionPayload,
  Emitter,
  type ForkSessionPayload,
  type IInstantiationService,
  type RenameSessionPayload,
  type ResumeSessionResult,
  type ServiceIdentifier,
  type ServicesAccessor,
  type SessionMeta,
  type SessionSummary,
  type UpdateSessionMetadataPayload,
} from '@moonshot-ai/agent-core';
import { emptySessionUsage, type Session } from '@moonshot-ai/protocol';

import {
  type IAuthSummaryService,
  type ICoreProcessService,
  type IEventService,
  IPromptService,
  type ISessionService,
  PromptService,
  SessionNotFoundError,
  SessionService,
  toProtocolSession,
} from '../src';

type WithSessionId<T> = T & { readonly sessionId: string };

interface FakeBridgeState {
  sessions: SessionSummary[];
  metas: Map<string, SessionMeta>;
  closedIds: string[];
  renamedTitles: Map<string, string>;
  metadataPatches: Map<string, UpdateSessionMetadataPayload['metadata']>;
  forkPayloads: Array<WithSessionId<Omit<ForkSessionPayload, 'sessionId'>>>;
  compactions: Array<{ sessionId: string; agentId: string; instruction?: string }>;
}

/**
 * Build a tiny fake `ICoreProcessService` whose `rpc` proxy implements just the
 * five session methods the impl uses. Each method delegates to an in-memory
 * state object the test owns.
 */
function makeFakeBridge(state: FakeBridgeState): ICoreProcessService {
  const rpc: Partial<CoreRPC> = {
    createSession: vi
      .fn()
      .mockImplementation(async (payload: CreateSessionPayload): Promise<SessionSummary> => {
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
    closeSession: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      state.closedIds.push(sessionId);
    }),
    renameSession: vi
      .fn()
      .mockImplementation(async (payload: WithSessionId<RenameSessionPayload>) => {
        state.renamedTitles.set(payload.sessionId, payload.title);
        // Reflect into the metadata map so subsequent `getSessionMetadata`
        // returns the updated title (mirrors real KimiCore behavior).
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
    metas: new Map(),
    closedIds: [],
    renamedTitles: new Map(),
    metadataPatches: new Map(),
    forkPayloads: [],
    compactions: [],
  };
}

let state: FakeBridgeState;
let svc: SessionService;
let promptStub: ReturnType<typeof makePromptServiceStub>;

/**
 * Stub `IPromptService` for hermetic SessionService tests. Records every
 * `applyAgentState(sid, patch, source)` call so tests can assert that
 * `SessionService.update` forwards `agent_config` runtime fields through
 * the shared shadow-aware helper rather than dispatching `core.rpc.*`
 * directly. The other `IPromptService` methods aren't reachable from
 * SessionService and are stubbed to throw on access.
 */
function makePromptServiceStub(): {
  promptService: IPromptService;
  calls: Array<{ sid: string; patch: Record<string, unknown>; source: string; promptId: string | undefined }>;
} {
  const calls: Array<{ sid: string; patch: Record<string, unknown>; source: string; promptId: string | undefined }> = [];
  const applyAgentState = vi
    .fn()
    .mockImplementation(async (sid: string, patch: Record<string, unknown>, source: string, promptId?: string) => {
      calls.push({ sid, patch, source, promptId });
    });
  const emitter = new Emitter<never>();
  const promptService: IPromptService = {
    _serviceBrand: undefined,
    submit: vi.fn() as unknown as IPromptService['submit'],
    abort: vi.fn() as unknown as IPromptService['abort'],
    applyAgentState,
    onDidComplete: emitter.event as unknown as IPromptService['onDidComplete'],
    onDidAbort: emitter.event as unknown as IPromptService['onDidAbort'],
  };
  return { promptService, calls };
}

/**
 * Fake `IInstantiationService` that only resolves the one service
 * `SessionService.update` reaches for (`IPromptService`). Other lookups
 * throw — they would indicate an unintended dependency creeping in.
 */
function makeFakeInstantiation(stubs: {
  promptService: IPromptService;
}): IInstantiationService {
  const accessor: ServicesAccessor = {
    get: <T,>(id: ServiceIdentifier<T>): T => {
      if ((id as unknown) === (IPromptService as unknown)) {
        return stubs.promptService as unknown as T;
      }
      throw new Error(`unexpected service lookup: ${String((id as unknown as { toString(): string }).toString())}`);
    },
  };
  return {
    _serviceBrand: undefined,
    invokeFunction: <R,>(fn: (a: ServicesAccessor) => R): R => fn(accessor),
    createInstance: (() => {
      throw new Error('createInstance not supported in this test stub');
    }) as IInstantiationService['createInstance'],
    createChild: () => {
      throw new Error('createChild not supported in this test stub');
    },
  } as unknown as IInstantiationService;
}

beforeEach(() => {
  state = freshState();
  promptStub = makePromptServiceStub();
  svc = new SessionService(
    makeFakeBridge(state),
    makeFakeInstantiation({ promptService: promptStub.promptService }),
  );
});

afterEach(() => {
  svc.dispose();
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
    const { encodeWorkDirKey } = await import('@moonshot-ai/agent-core/session/store');
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
    // title is echoed back even when CoreAPI doesn't reflect it (gap doc).
    expect(session.title).toBe('My session');
    expect(session.created_at.endsWith('Z')).toBe(true);
  });

  it('passes model through to the agent_config when supplied', async () => {
    await svc.create({
      metadata: { cwd: '/tmp/x' },
      agent_config: { model: 'moonshot-v1-128k' },
    });
    const created = state.sessions[0]!;
    expect((state.sessions as SessionSummary[])[0]!.metadata?.['cwd']).toBe('/tmp/x');
    void created;
  });

  it('rejects when metadata.cwd is absent (daemon route must pre-resolve workspace_id → cwd)', async () => {
    await expect(svc.create({} as unknown as Parameters<typeof svc.create>[0])).rejects.toThrow(
      /metadata\.cwd is required/,
    );
  });
});

describe('SessionService.list', () => {
  beforeEach(async () => {
    // Seed 3 sessions in increasing createdAt order.
    await svc.create({ metadata: { cwd: '/tmp/a' } });
    await svc.create({ metadata: { cwd: '/tmp/b' } });
    await svc.create({ metadata: { cwd: '/tmp/c' } });
  });

  it('returns descending-by-createdAt order with default page size', async () => {
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

  it('before_id returns older sessions only', async () => {
    const all = await svc.list({});
    const pivotId = all.items[0]!.id; // newest
    const olderPage = await svc.list({ before_id: pivotId });
    expect(olderPage.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/b', '/tmp/a']);
  });

  it('after_id returns newer sessions only', async () => {
    const all = await svc.list({});
    const pivotId = all.items[2]!.id; // oldest
    const newerPage = await svc.list({ after_id: pivotId });
    expect(newerPage.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/c', '/tmp/b']);
  });

  it('status filter applies post-hydration', async () => {
    // Today everything maps to 'idle'; non-matching filter returns []
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
    // Title is reflected via the next get (impl re-fetches metadata).
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

describe('SessionService.delete', () => {
  it('calls bridge.rpc.closeSession and returns { deleted: true }', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/d' } });
    const result = await svc.delete(created.id);
    expect(result).toEqual({ deleted: true });
    expect(state.closedIds).toEqual([created.id]);
  });

  it('throws SessionNotFoundError on a missing id', async () => {
    await expect(svc.delete('does-not-exist')).rejects.toBeInstanceOf(SessionNotFoundError);
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

describe('SessionService per-domain event listeners (Phase C)', () => {
  it('onDidCreate fires after bridge.rpc.createSession resolves', async () => {
    const events: unknown[] = [];
    svc.onDidCreate((e) => { events.push(e); });
    const session = await svc.create({ metadata: { cwd: '/tmp/evt' } });
    expect(events).toHaveLength(1);
    expect((events[0] as { session: { id: string } }).session.id).toBe(session.id);
  });

  it('onDidCreate detach stops future events', async () => {
    const events: unknown[] = [];
    const sub = svc.onDidCreate((e) => { events.push(e); });
    sub.dispose();
    await svc.create({ metadata: { cwd: '/tmp/evt2' } });
    expect(events).toHaveLength(0);
  });

  it('onDidClose fires after bridge.rpc.closeSession resolves', async () => {
    const closedIds: string[] = [];
    svc.onDidClose((e) => { closedIds.push(e.sessionId); });
    const session = await svc.create({ metadata: { cwd: '/tmp/evt3' } });
    await svc.delete(session.id);
    expect(closedIds).toEqual([session.id]);
  });

  it('onDidClose detach stops future events', async () => {
    const closedIds: string[] = [];
    const sub = svc.onDidClose((e) => { closedIds.push(e.sessionId); });
    sub.dispose();
    const session = await svc.create({ metadata: { cwd: '/tmp/evt4' } });
    await svc.delete(session.id);
    expect(closedIds).toHaveLength(0);
  });
});
