import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

import type { AppApprovalRequest, AppQuestionRequest, AppSession } from '@moonshot-ai/app-core/api';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { approvalsStore } from '../src/stores/approvals';
import { hostsStore } from '../src/stores/hosts';
import { pinnedOrderStore } from '../src/stores/pinnedOrder';
import { promptStore } from '../src/stores/prompt';
import { sessionRuntimeStore } from '../src/stores/sessionRuntime';
import { formatTime, sessionViewsStore } from '../src/stores/sessionViews';
import { sessionsStore } from '../src/stores/sessions';
import { workspacesStore } from '../src/stores/workspaces';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2026-01-03T00:00:00.000Z';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalCostUsd: 0,
  contextTokens: 0,
  contextLimit: 0,
  turnCount: 0,
};

function sessionRow(
  id: string,
  opts: {
    workspaceId?: string;
    cwd?: string;
    updatedAt?: string;
    archived?: boolean;
    parentSessionId?: string;
    mainTurnActive?: boolean;
    pendingInteraction?: AppSession['pendingInteraction'];
    lastTurnReason?: AppSession['lastTurnReason'];
    lastPrompt?: string;
  } = {},
): AppSession {
  return {
    id,
    title: id,
    createdAt: T1,
    updatedAt: opts.updatedAt ?? T1,
    busy: false,
    mainTurnActive: opts.mainTurnActive ?? false,
    pendingInteraction: opts.pendingInteraction ?? 'none',
    archived: opts.archived ?? false,
    cwd: opts.cwd ?? '/repo/a',
    model: 'model-1',
    usage: { ...usage },
    messageCount: 0,
    workspaceId: opts.workspaceId ?? 'ws-a',
    ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
    ...(opts.lastTurnReason !== undefined ? { lastTurnReason: opts.lastTurnReason } : {}),
    ...(opts.lastPrompt !== undefined ? { lastPrompt: opts.lastPrompt } : {}),
  };
}

function seedWorkspaces(): void {
  workspacesStore().workspaces = [
    { id: 'ws-a', root: '/repo/a', name: 'Alpha', sessionCount: 0 },
    { id: 'ws-b', root: '/repo/b', name: 'Beta', sessionCount: 0, hostId: 'devbox' },
  ];
}

function resetStores(): void {
  const ws = workspacesStore();
  ws.workspaces = [];
  ws.storedActiveWorkspaceId = null;
  ws.fsHome = null;
  ws.recentRoots = [];
  ws.hiddenWorkspaceIds = [];
  ws.workspaceOrder = [];
  ws.pinnedWorkspaceIds = [];
  ws.workspaceSortMode = 'manual';
  ws.workspaceRecencyFloor = {};
  ws.sessionsHasMoreByWorkspace = {};
  ws.sessionsLoadingMoreByWorkspace = {};
  ws.sessionsCursorByWorkspace = {};
  ws.sessionsInitialCountByWorkspace = {};
  const sessions = sessionsStore();
  sessions.setSessions([]);
  sessions.setActiveSessionId(undefined);
  sessions.unpinSessions([...sessions.pinnedSessionIds]);
  pinnedOrderStore().pinnedOrder = [];
  approvalsStore().approvalsBySession = {};
  approvalsStore().questionsBySession = {};
  promptStore().inFlightBySession = {};
  const runtime = sessionRuntimeStore();
  runtime.runtimes.clear();
  const views = sessionViewsStore();
  views.reloadUnread();
  views.setFlatSessionsFrontier(null);
  views.sessionTimeClock = 0;
  hostsStore().byId = {};
  hostsStore().loaded = false;
}

beforeEach(() => {
  memStorage.clear();
  resetStores();
});

afterEach(() => {
  sessionViewsStore().stopSessionTimeClock();
  vi.useRealTimers();
});

describe('isMainTurnActive', () => {
  it('is false when nothing is in flight', () => {
    sessionsStore().setSessions([sessionRow('s1')]);
    expect(sessionViewsStore().isMainTurnActive('s1', false)).toBe(false);
  });

  it('is true when a prompt is in flight for the session', () => {
    promptStore().setInFlight('s1', true);
    expect(sessionViewsStore().isMainTurnActive('s1', false)).toBe(true);
  });

  it('falls back to the listed flag and then to the pool row', () => {
    sessionsStore().setSessions([sessionRow('s1', { mainTurnActive: true })]);
    expect(sessionViewsStore().isMainTurnActive('s1', true)).toBe(true);
    expect(sessionViewsStore().isMainTurnActive('s1')).toBe(true);
    expect(sessionViewsStore().isMainTurnActive('unknown')).toBe(false);
  });
});

describe('sessionsForView', () => {
  it('maps pooled sessions of visible workspaces and drops children and hidden workspaces', () => {
    seedWorkspaces();
    workspacesStore().hiddenWorkspaceIds = ['ws-hidden'];
    sessionsStore().setSessions([
      sessionRow('s1', { updatedAt: T1 }),
      sessionRow('s2', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T2 }),
      sessionRow('s3', { parentSessionId: 's1', updatedAt: T3 }),
      sessionRow('s4', { workspaceId: 'ws-hidden', cwd: '/repo/hidden' }),
    ]);

    const rows = sessionViewsStore().sessionsForView;

    expect(rows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(rows[0]).toMatchObject({
      id: 's1',
      workspaceId: 'ws-a',
      workspaceName: 'Alpha',
      busy: false,
      pendingInteraction: 'none',
      time: formatTime(T1),
    });
    expect(rows[1]).toMatchObject({ id: 's2', workspaceId: 'ws-b', workspaceName: 'Beta' });
  });

  it('tags worktree sessions with the environment they actually use', () => {
    seedWorkspaces();
    const setup = (status: 'running' | 'ready' | 'local') => ({
      status,
      purpose: 'create' as const,
      request: { sourceBranch: 'main' },
      steps: [],
      commandsRan: 0,
      startedAt: T1,
      script: 'none' as const,
    });
    sessionsStore().setSessions([
      sessionRow('local', { updatedAt: T1 }),
      { ...sessionRow('creating', { updatedAt: T1 }), worktree: { setup: setup('running') } },
      { ...sessionRow('ready', { updatedAt: T1 }), worktree: { path: '/wt/a', setup: setup('ready') } },
      { ...sessionRow('gone', { updatedAt: T1 }), worktree: { path: '/wt/b', missing: true, setup: setup('ready') } },
      { ...sessionRow('fallback', { updatedAt: T1 }), worktree: { setup: setup('local') } },
    ]);

    const tags = Object.fromEntries(sessionViewsStore().sessionsForView.map((row) => [row.id, row.environment]));

    expect(tags).toEqual({
      local: undefined,
      creating: 'settingUp',
      ready: 'worktree',
      gone: 'invalid',
      fallback: undefined,
    });
  });
});

describe('workspaceGroups / mobileWorkspaceGroups', () => {
  it('groups non-archived sessions by workspace with pagination fields and pinned counts', () => {
    seedWorkspaces();
    sessionsStore().setSessions([
      sessionRow('s-a-old', { updatedAt: T1 }),
      sessionRow('s-a-new', { updatedAt: T3 }),
      sessionRow('s-b', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T2 }),
      sessionRow('s-archived', { archived: true }),
      sessionRow('s-child', { parentSessionId: 's-a-old' }),
    ]);
    sessionsStore().pinSession('s-b');
    const ws = workspacesStore();
    ws.sessionsHasMoreByWorkspace = { 'ws-a': true };
    ws.sessionsLoadingMoreByWorkspace = { 'ws-b': true };
    ws.sessionsInitialCountByWorkspace = { 'ws-a': 7 };

    const groups = sessionViewsStore().workspaceGroups;
    const groupA = groups.find((g) => g.workspace.id === 'ws-a');
    const groupB = groups.find((g) => g.workspace.id === 'ws-b');

    expect(groupA?.sessions.map((s) => s.id)).toEqual(['s-a-new', 's-a-old']);
    expect(groupA).toMatchObject({
      pinnedCount: 0,
      hasMore: true,
      loadingMore: false,
      initialCount: 7,
    });
    expect(groupB?.sessions).toEqual([]);
    expect(groupB).toMatchObject({
      pinnedCount: 1,
      hasMore: false,
      loadingMore: true,
      initialCount: 5,
    });
  });

  it('projects pinned workspaces separately without changing the complete, mobile or flat projections', () => {
    seedWorkspaces();
    sessionsStore().setSessions([
      sessionRow('s-a', { updatedAt: T1 }),
      sessionRow('s-b', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T2 }),
    ]);
    const ws = workspacesStore();
    ws.pinWorkspace('ws-b');
    ws.pinnedWorkspaceIds = ['gone', ...ws.pinnedWorkspaceIds];

    const views = sessionViewsStore();
    expect(views.workspaceGroups.map((group) => group.workspace.id)).toEqual(['ws-a', 'ws-b']);
    expect(views.unpinnedWorkspaceGroups.map((group) => group.workspace.id)).toEqual(['ws-a']);
    expect(views.pinnedWorkspaceGroups.map((group) => group.workspace.id)).toEqual(['ws-b']);
    expect(views.pinnedWorkspaceGroups[0]?.sessions.map((session) => session.id)).toEqual(['s-b']);
    expect(views.mobileWorkspaceGroups.map((group) => group.workspace.id)).toEqual(['ws-a', 'ws-b']);
    expect(views.flatSessionsAll.map((session) => session.id)).toEqual(['s-b', 's-a']);

    ws.unpinWorkspace('ws-b');
    expect(views.unpinnedWorkspaceGroups.map((group) => group.workspace.id)).toEqual(['ws-a', 'ws-b']);
    expect(views.pinnedWorkspaceGroups).toEqual([]);
    expect(views.flatSessionsAll.map((session) => session.id)).toEqual(['s-b', 's-a']);
  });

  it('keeps pinned sessions inside mobile groups', () => {
    seedWorkspaces();
    sessionsStore().setSessions([
      sessionRow('s-b', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T2 }),
    ]);
    sessionsStore().pinSession('s-b');

    const groups = sessionViewsStore().mobileWorkspaceGroups;
    const groupB = groups.find((g) => g.workspace.id === 'ws-b');

    expect(groupB?.sessions.map((s) => s.id)).toEqual(['s-b']);
    expect(groupB?.pinnedCount).toBe(0);
  });
  it('hides sessions of a disabled or removed host while keeping its workspace group', () => {
    seedWorkspaces();
    sessionsStore().setSessions([
      sessionRow('s-local', { updatedAt: T1 }),
      sessionRow('s-remote', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T2 }),
      sessionRow('s-remote-pinned', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T3 }),
    ]);
    sessionsStore().pinSession('s-remote-pinned');
    approvalsStore().setSessionApprovals('s-remote', [{ approvalId: 'a1' } as AppApprovalRequest]);
    workspacesStore().sessionsHasMoreByWorkspace = { 'ws-b': true };
    workspacesStore().sessionsLoadingMoreByWorkspace = { 'ws-b': true };
    hostsStore().applySnapshot([{ id: 'devbox', host: 'dev.test', status: 'disconnected', enabled: false }]);

    const views = sessionViewsStore();
    const groupB = views.workspaceGroups.find((g) => g.workspace.id === 'ws-b');
    expect(groupB).toMatchObject({
      sessions: [],
      pinnedCount: 0,
      hasMore: false,
      loadingMore: false,
    });
    expect(views.mobileWorkspaceGroups.find((g) => g.workspace.id === 'ws-b')?.sessions).toEqual([]);
    expect(views.sessionsForView.map((s) => s.id)).toEqual(['s-local']);
    expect(views.flatSessionsAll.map((s) => s.id)).toEqual(['s-local']);
    expect(views.pinnedSessions).toEqual([]);
    expect(views.recentSessionsForWorkspace('ws-b', 6, [])).toEqual([]);
    expect(views.attentionByWorkspace['ws-b']).toBeUndefined();

    hostsStore().applySnapshot([{ id: 'devbox', host: 'dev.test', status: 'ready' }]);
    expect(views.workspaceGroups.find((g) => g.workspace.id === 'ws-b')?.sessions.map((s) => s.id)).toEqual(['s-remote']);
    expect(views.pinnedSessions.map((s) => s.id)).toEqual(['s-remote-pinned']);
  });
});

describe('pinnedSessions', () => {
  it('lists pinned sessions in pin order, appends new pins at the tail and drops archived, children and hidden workspaces', () => {
    seedWorkspaces();
    workspacesStore().hiddenWorkspaceIds = ['ws-hidden'];
    sessionsStore().setSessions([
      sessionRow('s1', { updatedAt: T2 }),
      sessionRow('s2', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T3 }),
      sessionRow('s3', { archived: true }),
      sessionRow('s4', { parentSessionId: 's1' }),
      sessionRow('s5', { workspaceId: 'ws-hidden', cwd: '/repo/hidden' }),
    ]);
    for (const id of ['s1', 's2', 's3', 's4', 's5']) sessionsStore().pinSession(id);

    const rows = sessionViewsStore().pinnedSessions;

    expect(rows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(rows[0]).toMatchObject({ pinned: true, workspaceName: 'Alpha', cwdLabel: 'a' });
    expect(rows[1]).toMatchObject({ pinned: true, workspaceName: 'Beta', hostId: 'devbox', cwdLabel: 'b' });
  });

  it('interleaves pinned workspaces and sessions, appends new pins at the tail, supports targeted drop-pinning and persists manual reordering', () => {
    seedWorkspaces();
    sessionsStore().setSessions([
      sessionRow('s1', { updatedAt: T1 }),
      sessionRow('s2', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T3 }),
    ]);

    sessionsStore().pinSession('s1');
    workspacesStore().pinWorkspace('ws-b');

    const views = sessionViewsStore();
    expect(views.pinnedEntries.map((e) => e.key)).toEqual(['session:s1', 'ws:ws-b']);

    sessionsStore().pinSession('s2', { key: 'session:s1', position: 'before' });
    expect(views.pinnedEntries.map((e) => e.key)).toEqual([
      'session:s2',
      'session:s1',
      'ws:ws-b',
    ]);
    expect(views.pinnedSessions.map((s) => s.id)).toEqual(['s2', 's1']);

    pinnedOrderStore().reorder('ws:ws-b', 'session:s2', 'before');
    expect(views.pinnedEntries.map((e) => e.key)).toEqual([
      'ws:ws-b',
      'session:s2',
      'session:s1',
    ]);
    expect(JSON.parse(memStorage.get(STORAGE_KEYS.pinnedOrder) ?? '[]')).toEqual([
      'ws:ws-b',
      'session:s2',
      'session:s1',
    ]);

    workspacesStore().unpinWorkspace('ws-b');
    expect(views.pinnedEntries.map((e) => e.key)).toEqual(['session:s2', 'session:s1']);
  });
});

describe('flatSessionsAll', () => {
  it('flattens by recency, excludes pinned/archived/children/hidden and applies the frontier with a status exemption', () => {
    seedWorkspaces();
    workspacesStore().hiddenWorkspaceIds = ['ws-hidden'];
    sessionsStore().setSessions([
      sessionRow('s-new', { updatedAt: T3 }),
      sessionRow('s-old-idle', { updatedAt: T1 }),
      sessionRow('s-old-unread', { updatedAt: T1 }),
      sessionRow('s-old-approval', { updatedAt: T1 }),
      sessionRow('s-pinned', { updatedAt: T3 }),
      sessionRow('s-archived', { archived: true }),
      sessionRow('s-child', { parentSessionId: 's-new' }),
      sessionRow('s-hidden', { workspaceId: 'ws-hidden', cwd: '/repo/hidden' }),
    ]);
    sessionsStore().pinSession('s-pinned');
    sessionViewsStore().markUnread('s-old-unread');
    approvalsStore().setSessionApprovals('s-old-approval', [
      { approvalId: 'a1' } as AppApprovalRequest,
    ]);
    sessionViewsStore().setFlatSessionsFrontier(Date.parse(T2));

    const rows = sessionViewsStore().flatSessionsAll;

    expect(rows.map((r) => r.id)).toEqual(['s-new', 's-old-unread', 's-old-approval']);
    expect(rows[0]).toMatchObject({
      id: 's-new',
      workspaceId: 'ws-a',
      workspaceName: 'Alpha',
      cwdLabel: 'a',
      updatedAt: T3,
    });
  });

  it('includes every visible pooled session when the frontier is null', () => {
    seedWorkspaces();
    sessionsStore().setSessions([
      sessionRow('s1', { updatedAt: T1 }),
      sessionRow('s2', { updatedAt: T2 }),
    ]);

    expect(sessionViewsStore().flatSessionsAll.map((r) => r.id)).toEqual(['s2', 's1']);
  });

  it('keeps workspace names reactive and falls back to the directory for legacy sessions', () => {
    workspacesStore().workspaces = [{ id: 'wm_1', root: '/repo/root', name: 'Custom', sessionCount: 0 }];
    const legacy = { ...sessionRow('legacy', { workspaceId: 'wm_1', cwd: '/repo/root' }), workspaceId: undefined };
    sessionsStore().setSessions([legacy]);

    expect(sessionViewsStore().flatSessionsAll[0]).toMatchObject({
      workspaceName: 'Custom',
      cwdLabel: 'root',
    });

    workspacesStore().applyWorkspaceRename('wm_1', 'Renamed');
    expect(sessionViewsStore().flatSessionsAll[0]).toMatchObject({
      workspaceName: 'Renamed',
      cwdLabel: 'root',
    });

    const orphan = { ...sessionRow('orphan', { workspaceId: 'wm_1', cwd: '/repo/orphan' }), workspaceId: undefined };
    sessionsStore().setSessions([orphan]);
    expect(sessionViewsStore().flatSessionsAll[0]).toMatchObject({
      workspaceName: 'orphan',
      cwdLabel: 'orphan',
    });
  });
});

describe('recentSessionsForWorkspace', () => {
  it('merges open and done sessions of the workspace, open first, done marked archived', () => {
    seedWorkspaces();
    sessionsStore().setSessions([
      sessionRow('s1', { updatedAt: T2 }),
      sessionRow('s2', { updatedAt: T3 }),
      sessionRow('s3', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T3 }),
    ]);
    const done = [
      sessionRow('d1', { updatedAt: T1, archived: true }),
      sessionRow('d2', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T1, archived: true }),
    ];

    const rows = sessionViewsStore().recentSessionsForWorkspace('ws-a', 6, done);

    expect(rows.map((r) => r.id)).toEqual(['s2', 's1', 'd1']);
    expect(rows[2]).toMatchObject({
      archived: true,
      busy: false,
      pendingInteraction: undefined,
      lastTurnReason: undefined,
      time: formatTime(T1),
    });
  });

  it('honors the limit and returns nothing for a null workspace', () => {
    seedWorkspaces();
    sessionsStore().setSessions([
      sessionRow('s1', { updatedAt: T2 }),
      sessionRow('s2', { updatedAt: T3 }),
    ]);

    expect(
      sessionViewsStore().recentSessionsForWorkspace('ws-a', 1, []).map((r) => r.id),
    ).toEqual(['s2']);
    expect(sessionViewsStore().recentSessionsForWorkspace(null, 6, [])).toEqual([]);
  });
});

describe('active session projections', () => {
  it('resolves the active session title, empty when no active session or unknown id', () => {
    sessionsStore().setSessions([sessionRow('s1'), sessionRow('s2')]);

    expect(sessionViewsStore().activeSessionTitle).toBe('');

    sessionsStore().setActiveSessionId('s2');
    expect(sessionViewsStore().activeSessionTitle).toBe('s2');

    sessionsStore().setActiveSessionId('s-gone');
    expect(sessionViewsStore().activeSessionTitle).toBe('');

    sessionsStore().setActiveSessionId(undefined);
    expect(sessionViewsStore().activeSessionTitle).toBe('');
  });

  it('tracks whether the active session is pinned', () => {
    sessionsStore().setSessions([sessionRow('s1'), sessionRow('s2')]);
    sessionsStore().pinSession('s1');

    expect(sessionViewsStore().activeSessionPinned).toBe(false);

    sessionsStore().setActiveSessionId('s1');
    expect(sessionViewsStore().activeSessionPinned).toBe(true);

    sessionsStore().setActiveSessionId('s2');
    expect(sessionViewsStore().activeSessionPinned).toBe(false);

    sessionsStore().setActiveSessionId(undefined);
    expect(sessionViewsStore().activeSessionPinned).toBe(false);
  });

  it('exposes the active session last turn reason, null when unset or no active session', () => {
    sessionsStore().setSessions([
      sessionRow('s1', { lastTurnReason: 'cancelled' }),
      sessionRow('s2'),
    ]);

    expect(sessionViewsStore().activeLastTurnReason).toBeNull();

    sessionsStore().setActiveSessionId('s1');
    expect(sessionViewsStore().activeLastTurnReason).toBe('cancelled');

    sessionsStore().setActiveSessionId('s2');
    expect(sessionViewsStore().activeLastTurnReason).toBeNull();
  });
});

describe('attention projections', () => {
  it('includes local browser approval counts in sidebar and workspace attention', () => {
    seedWorkspaces();
    sessionsStore().setSessions([sessionRow('s1')]);
    const store = sessionViewsStore();
    store.localApprovalCounts = { s1: 1 };
    approvalsStore().setSessionApprovals('s1', [{ approvalId: 'a1' } as AppApprovalRequest]);
    expect(store.attentionBySession.s1).toBe(2);
    expect(store.pendingBySession.s1?.approvals).toBe(2);
    expect(Object.values(store.attentionByWorkspace).reduce((sum, count) => sum + count, 0)).toBe(2);
    store.localApprovalCounts = {};
    expect(store.attentionBySession.s1).toBe(1);
  });

  it('aggregates approvals and questions per session and rolls them up per workspace', () => {
    seedWorkspaces();
    sessionsStore().setSessions([
      sessionRow('s1'),
      sessionRow('s2', { workspaceId: 'ws-b', cwd: '/repo/b' }),
    ]);
    approvalsStore().setSessionApprovals('s1', [
      { approvalId: 'a1' } as AppApprovalRequest,
      { approvalId: 'a2' } as AppApprovalRequest,
    ]);
    approvalsStore().setSessionQuestions('s1', [{ questionId: 'q1' } as AppQuestionRequest]);
    approvalsStore().setSessionApprovals('s2', [{ approvalId: 'a3' } as AppApprovalRequest]);

    expect(sessionViewsStore().attentionBySession).toEqual({ s1: 3, s2: 1 });
    expect(sessionViewsStore().pendingBySession).toEqual({
      s1: { approvals: 2, questions: 1 },
      s2: { approvals: 1, questions: 0 },
    });
    expect(sessionViewsStore().attentionByWorkspace).toEqual({ 'ws-a': 3, 'ws-b': 1 });
  });

  it('ignores empty lists and sessions outside the pool in the workspace rollup', () => {
    seedWorkspaces();
    sessionsStore().setSessions([sessionRow('s1')]);
    approvalsStore().setSessionApprovals('s1', []);
    approvalsStore().setSessionApprovals('s-gone', [{ approvalId: 'a1' } as AppApprovalRequest]);

    expect(sessionViewsStore().attentionBySession).toEqual({ 's-gone': 1 });
    expect(sessionViewsStore().attentionByWorkspace).toEqual({});
  });
});

describe('unread persistence', () => {
  it('marks unread in memory and persists to storage', () => {
    sessionViewsStore().markUnread('s1');
    sessionViewsStore().markUnread('s2');

    expect(sessionViewsStore().unreadBySession).toEqual({ s1: true, s2: true });
    expect(JSON.parse(memStorage.get(STORAGE_KEYS.unread)!)).toEqual({ s1: true, s2: true });
  });

  it('clears unread in memory and drops the persisted entry', () => {
    sessionViewsStore().markUnread('s1');
    sessionViewsStore().clearUnread('s1');

    expect(sessionViewsStore().unreadBySession).toEqual({});
    expect(JSON.parse(memStorage.get(STORAGE_KEYS.unread)!)).toEqual({});
  });

  it('keeps manual unread when automatic unread is cleared and clears both on open', () => {
    sessionViewsStore().markManualUnread('s1');
    sessionViewsStore().markUnread('s2');
    sessionViewsStore().clearAutomaticUnread('s1');

    expect(sessionViewsStore().unreadBySession).toEqual({ s1: true, s2: true });
    expect(JSON.parse(memStorage.get(STORAGE_KEYS.manualUnread)!)).toEqual({ s1: true });
    expect(JSON.parse(memStorage.get(STORAGE_KEYS.unread)!)).toEqual({ s2: true });

    sessionViewsStore().clearUnread('s1');

    expect(sessionViewsStore().unreadBySession).toEqual({ s2: true });
    expect(JSON.parse(memStorage.get(STORAGE_KEYS.manualUnread)!)).toEqual({});
    expect(JSON.parse(memStorage.get(STORAGE_KEYS.unread)!)).toEqual({ s2: true });
  });

  it('reloads from storage keeping only truthy entries', () => {
    memStorage.set(STORAGE_KEYS.unread, JSON.stringify({ s9: true, s8: false }));
    memStorage.set(STORAGE_KEYS.manualUnread, JSON.stringify({ s7: true, s6: false }));
    sessionViewsStore().markUnread('s1');
    memStorage.set(STORAGE_KEYS.unread, JSON.stringify({ s9: true, s8: false }));

    sessionViewsStore().reloadUnread();

    expect(sessionViewsStore().unreadBySession).toEqual({ s9: true, s7: true });
  });
});

describe('flatSessionsFrontier', () => {
  it('round-trips the frontier cursor', () => {
    const views = sessionViewsStore();
    expect(views.flatSessionsFrontier).toBeNull();
    views.setFlatSessionsFrontier(123);
    expect(views.flatSessionsFrontier).toBe(123);
    views.setFlatSessionsFrontier(null);
    expect(views.flatSessionsFrontier).toBeNull();
  });
});

describe('sessionTimeClock', () => {
  it('ticks every 30s once ensured and stops cleanly', () => {
    vi.useFakeTimers();
    const views = sessionViewsStore();
    views.ensureSessionTimeClock();
    views.ensureSessionTimeClock();

    vi.advanceTimersByTime(30_000);
    expect(views.sessionTimeClock).toBe(1);

    views.stopSessionTimeClock();
    vi.advanceTimersByTime(60_000);
    expect(views.sessionTimeClock).toBe(1);
  });

  describe('with a document', () => {
    type FakeDocument = EventTarget & { visibilityState: DocumentVisibilityState };
    let fakeDocument: FakeDocument;
    const globalWithDocument = globalThis as { document?: unknown };
    let previousDocument: unknown;

    function setVisibility(state: DocumentVisibilityState): void {
      fakeDocument.visibilityState = state;
      fakeDocument.dispatchEvent(new Event('visibilitychange'));
    }

    beforeEach(() => {
      previousDocument = globalWithDocument.document;
      fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
      globalWithDocument.document = fakeDocument;
      vi.useFakeTimers();
    });

    afterEach(() => {
      sessionViewsStore().stopSessionTimeClock();
      globalWithDocument.document = previousDocument;
    });

    it('pauses while the document is hidden and catches up once visible again', () => {
      const views = sessionViewsStore();
      views.ensureSessionTimeClock();
      vi.advanceTimersByTime(30_000);
      expect(views.sessionTimeClock).toBe(1);

      setVisibility('hidden');
      vi.advanceTimersByTime(120_000);
      expect(views.sessionTimeClock).toBe(1);

      setVisibility('visible');
      expect(views.sessionTimeClock).toBe(2);
      vi.advanceTimersByTime(30_000);
      expect(views.sessionTimeClock).toBe(3);
    });

    it('does not catch up when the last tick is still fresh', () => {
      const views = sessionViewsStore();
      views.ensureSessionTimeClock();
      vi.advanceTimersByTime(10_000);
      setVisibility('hidden');
      vi.advanceTimersByTime(5_000);
      setVisibility('visible');
      expect(views.sessionTimeClock).toBe(0);
      vi.advanceTimersByTime(14_999);
      expect(views.sessionTimeClock).toBe(0);
      vi.advanceTimersByTime(1);
      expect(views.sessionTimeClock).toBe(1);
    });

    it('resumes on the original cadence after a short hide', () => {
      const views = sessionViewsStore();
      views.ensureSessionTimeClock();
      vi.advanceTimersByTime(30_000);
      expect(views.sessionTimeClock).toBe(1);

      vi.advanceTimersByTime(5_000);
      setVisibility('hidden');
      vi.advanceTimersByTime(20_000);
      setVisibility('visible');
      expect(views.sessionTimeClock).toBe(1);

      vi.advanceTimersByTime(5_000);
      expect(views.sessionTimeClock).toBe(2);
      vi.advanceTimersByTime(30_000);
      expect(views.sessionTimeClock).toBe(3);
    });

    it('drops a pending resume when hidden again before it fires', () => {
      const views = sessionViewsStore();
      views.ensureSessionTimeClock();
      vi.advanceTimersByTime(10_000);
      setVisibility('hidden');
      setVisibility('visible');
      vi.advanceTimersByTime(5_000);
      setVisibility('hidden');
      vi.advanceTimersByTime(60_000);
      expect(views.sessionTimeClock).toBe(0);

      setVisibility('visible');
      expect(views.sessionTimeClock).toBe(1);
      vi.advanceTimersByTime(30_000);
      expect(views.sessionTimeClock).toBe(2);
    });

    it('does not double-schedule on repeated visible events', () => {
      const views = sessionViewsStore();
      views.ensureSessionTimeClock();
      vi.advanceTimersByTime(10_000);
      setVisibility('hidden');
      setVisibility('visible');
      setVisibility('visible');
      vi.advanceTimersByTime(20_000);
      expect(views.sessionTimeClock).toBe(1);
      vi.advanceTimersByTime(30_000);
      expect(views.sessionTimeClock).toBe(2);
    });

    it('stays idle when ensured while hidden', () => {
      fakeDocument.visibilityState = 'hidden';
      const views = sessionViewsStore();
      views.ensureSessionTimeClock();
      views.ensureSessionTimeClock();
      vi.advanceTimersByTime(90_000);
      expect(views.sessionTimeClock).toBe(0);

      setVisibility('visible');
      expect(views.sessionTimeClock).toBe(1);
      vi.advanceTimersByTime(30_000);
      expect(views.sessionTimeClock).toBe(2);
    });

    it('stops reacting to visibility changes once stopped', () => {
      const views = sessionViewsStore();
      views.ensureSessionTimeClock();
      views.stopSessionTimeClock();
      vi.advanceTimersByTime(60_000);
      setVisibility('hidden');
      setVisibility('visible');
      vi.advanceTimersByTime(60_000);
      expect(views.sessionTimeClock).toBe(0);
    });

    it('cancels a pending resume when stopped', () => {
      const views = sessionViewsStore();
      views.ensureSessionTimeClock();
      vi.advanceTimersByTime(10_000);
      setVisibility('hidden');
      setVisibility('visible');
      views.stopSessionTimeClock();
      vi.advanceTimersByTime(60_000);
      expect(views.sessionTimeClock).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('view identity stability', () => {
  function seedTwo(): void {
    seedWorkspaces();
    sessionsStore().setSessions([
      sessionRow('s1', { updatedAt: T2 }),
      sessionRow('s2', { workspaceId: 'ws-b', cwd: '/repo/b', updatedAt: T1 }),
    ]);
  }

  function bumpUsage(id: string): void {
    sessionsStore().updateSession(id, (s) => ({ ...s, usage: { ...s.usage, inputTokens: s.usage.inputTokens + 1 } }));
  }

  it('keeps sessionsForView, flatSessionsAll, pinnedSessions and workspaceGroups identities when only invisible fields change', () => {
    seedTwo();
    sessionsStore().pinSession('s2');
    const views = sessionViewsStore();
    const forView = views.sessionsForView;
    const flat = views.flatSessionsAll;
    const pinned = views.pinnedSessions;
    const groups = views.workspaceGroups;
    const mobileGroups = views.mobileWorkspaceGroups;

    bumpUsage('s1');

    expect(views.sessionsForView).toBe(forView);
    expect(views.flatSessionsAll).toBe(flat);
    expect(views.pinnedSessions).toBe(pinned);
    expect(views.workspaceGroups).toBe(groups);
    expect(views.mobileWorkspaceGroups).toBe(mobileGroups);
  });

  it('reuses untouched rows and rebuilds only the changed one', () => {
    seedTwo();
    const views = sessionViewsStore();
    const before = views.sessionsForView;

    sessionsStore().updateSession('s1', (s) => ({ ...s, title: 'renamed' }));

    const after = views.sessionsForView;
    expect(after).not.toBe(before);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]).toMatchObject({ id: 's1', title: 'renamed' });
    expect(after[1]).toBe(before[1]);
  });

  it('keeps untouched workspace groups and their session arrays when another workspace changes', () => {
    seedTwo();
    const views = sessionViewsStore();
    const before = views.workspaceGroups;
    const betaBefore = before.find((g) => g.workspace.id === 'ws-b')!;

    promptStore().setInFlight('s1', true);

    const after = views.workspaceGroups;
    expect(after).not.toBe(before);
    const alpha = after.find((g) => g.workspace.id === 'ws-a')!;
    const beta = after.find((g) => g.workspace.id === 'ws-b')!;
    expect(alpha.sessions[0]).toMatchObject({ id: 's1', busy: true });
    expect(beta).toBe(betaBefore);
    expect(beta.sessions).toBe(betaBefore.sessions);
  });

  it('keeps the workspace view identity when sessions change without touching workspaces', () => {
    seedTwo();
    const before = workspacesStore().workspacesView;
    bumpUsage('s2');
    expect(workspacesStore().workspacesView).toBe(before);
  });
});

describe('formatTime', () => {
  it('formats relative buckets', () => {
    expect(formatTime(new Date(Date.now() - 30_000).toISOString())).toBe('sessions.justNow');
    expect(formatTime(new Date(Date.now() - 50 * 60_000).toISOString())).toBe('50m');
    expect(formatTime(new Date(Date.now() - 2 * 3_600_000).toISOString())).toBe('2h');
    expect(formatTime(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe('3d');
  });
});
