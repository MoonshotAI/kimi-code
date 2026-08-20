/**
 * Scenario: a session running a goal drives many turn boundaries; intermediate
 * boundaries must not light the unread dot (and the shared predicate gates the
 * completion notification) — only the goal's terminal turn may.
 * Wiring: the real composable with daemon requests and the socket stubbed.
 * Run: cd packages/app-client && npx vitest run test/goal-turn-end.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppGoal,
  AppSession,
  AppSessionSnapshot,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  V2Session,
} from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

/** Convert an AppSession fixture to the v2 grouped-wire shape the initial
 *  load consumes (one group for the single stub workspace). */
function v2Of(s: AppSession): V2Session {
  return {
    id: s.id,
    workspace: { id: s.workspaceId ?? 'workspace-1', cwd: s.cwd },
    meta: {
      title: s.title,
      last_prompt: s.lastPrompt ?? 'prompt',
      created_at: Date.parse(s.createdAt),
      updated_at: Date.parse(s.updatedAt),
      archived: s.archived,
      archived_at: null,
    },
    activity: { status: s.busy ? 'running' : 'idle' },
  };
}

const clientApiMock: Record<string, unknown> = {};

// The client modules resolve the api through the deps registry at call time
// (the registry cell lives on globalThis, so the fresh module graph after
// vi.resetModules below still sees this registration).
beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
});

afterEach(() => {
  resetKimiClientDeps();
});

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

function session(id: string): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy: false,
    mainTurnActive: false,
    pendingInteraction: 'none',
    archived: false,
    cwd: '/workspace',
    model: 'model-1',
    usage: { ...usage },
    messageCount: 0,
    lastSeq: 0,
    workspaceId: 'workspace-1',
  };
}

function goal(status: AppGoal['status']): AppGoal {
  return {
    goalId: 'goal-1',
    objective: 'objective',
    status,
    turnsUsed: 1,
    tokensUsed: 100,
    wallClockMs: 1000,
    budget: {
      tokenBudget: null,
      remainingTokens: null,
      turnBudget: null,
      remainingTurns: null,
      wallClockBudgetMs: null,
      remainingWallClockMs: null,
      overBudget: false,
    },
  };
}

function snapshot(value: AppSession): AppSessionSnapshot {
  return {
    asOfSeq: value.lastSeq,
    epoch: 'epoch-1',
    session: value,
    messages: [],
    hasMoreMessages: false,
    inFlightTurn: null,
    subagents: [],
    pendingApprovals: [],
    pendingQuestions: [],
  };
}

describe('useKimiWebClient — goal turn-end suppression', () => {
  it('suppresses intermediate goal boundaries, not the terminal one', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    const initial = [session('selected'), session('goal-s'), session('blocked-s')];
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      bindNextPromptId: vi.fn(),
      seedSnapshot: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
      getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
      getMeta: vi.fn(async () => ({
        serverVersion: '0.0.0',
        serverId: 'server-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        capabilities: {},
        openInApps: [],
        dangerousBypassAuth: false,
        backend: 'v2',
      })),
      getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'model-1' })),
      listModels: vi.fn(async () => []),
      listProviders: vi.fn(async () => []),
      listWorkspaces: vi.fn(async () => [
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: initial.length },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: initial, hasMore: false })),
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: initial.map(v2Of),
            total: initial.length,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSessionSnapshot: vi.fn(async (id) => snapshot(initial.find((item) => item.id === id)!)),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
      getSessionGoal: vi.fn(async () => null),
      getSessionWarnings: vi.fn(async () => []),
      getGitStatus: vi.fn(async () => ({
        branch: '',
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
      })),
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getFileUrl: (fileId) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    Object.assign(clientApiMock, api);

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    // load() auto-selects the first session; both goal sessions stay backgrounded.
    expect(client.activeSessionId.value).toBe('selected');
    expect(handlers).toBeDefined();

    const seqBy = new Map<string, number>();
    function emit(sessionId: string, event: Parameters<NonNullable<typeof handlers>['onEvent']>[0]): void {
      const seq = (seqBy.get(sessionId) ?? 0) + 1;
      seqBy.set(sessionId, seq);
      handlers!.onEvent(event, { sessionId, seq });
    }
    function turnBoundary(sessionId: string, active: boolean): void {
      emit(sessionId, {
        type: 'turnActiveChanged',
        sessionId,
        active,
        promptId: `prompt-${sessionId}`,
        ...(active ? {} : { reason: 'completed' as const }),
      });
    }

    // ── Intermediate boundary of an ACTIVE goal: no unread dot.
    emit('goal-s', { type: 'goalUpdated', sessionId: 'goal-s', goal: goal('active') });
    turnBoundary('goal-s', true);
    turnBoundary('goal-s', false);
    expect(client.unreadBySession.value['goal-s']).toBeFalsy();

    // ── Terminal boundary: goalUpdated(complete) lands first (mid-turn), the
    // final turn end falls through to the ordinary completion — unread once.
    turnBoundary('goal-s', true);
    emit('goal-s', { type: 'goalUpdated', sessionId: 'goal-s', goal: goal('complete') });
    turnBoundary('goal-s', false);
    expect(client.unreadBySession.value['goal-s']).toBe(true);

    // ── blocked is a stopping point that needs the user: not suppressed.
    emit('blocked-s', { type: 'goalUpdated', sessionId: 'blocked-s', goal: goal('blocked') });
    turnBoundary('blocked-s', true);
    turnBoundary('blocked-s', false);
    expect(client.unreadBySession.value['blocked-s']).toBe(true);

    // ── Baseline: no goal at all → ordinary completion lights the dot.
    expect(client.unreadBySession.value['selected']).toBeFalsy();
  });

  it('a goalUpdated during a pending refill re-arms the terminal alert', async () => {
    vi.stubGlobal('WebSocket', class {});
    vi.resetModules();

    // Two background sessions mid main-turn at load() → the refill fires for
    // both and stays pending (their goal reads never resolve here).
    const midTurn = (id: string): AppSession => ({ ...session(id), busy: true, mainTurnActive: true });
    const initial = [session('selected'), midTurn('pending-s'), midTurn('quiet-s')];
    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      bindNextPromptId: vi.fn(),
      seedSnapshot: vi.fn(),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'model-1', managedProvider: null })),
      getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
      getMeta: vi.fn(async () => ({
        serverVersion: '0.0.0',
        serverId: 'server-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        capabilities: {},
        openInApps: [],
        dangerousBypassAuth: false,
        backend: 'v2',
      })),
      getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'model-1' })),
      listModels: vi.fn(async () => []),
      listProviders: vi.fn(async () => []),
      listWorkspaces: vi.fn(async () => [
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: initial.length },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: initial, hasMore: false })),
      listSessionGroupsV2: vi.fn(async () => ({
        groups: [
          {
            workspace: { id: 'workspace-1', cwd: '/workspace' },
            sessions: initial.map(v2Of),
            total: initial.length,
          },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 1,
      })),
      getSessionSnapshot: vi.fn(async (id) => snapshot(initial.find((item) => item.id === id)!)),
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
      // The refills that matter here never land inside the test.
      getSessionGoal: vi.fn((id: string) =>
        id === 'pending-s' || id === 'quiet-s'
          ? new Promise<null>(() => {})
          : Promise.resolve(null),
      ),
      getSessionWarnings: vi.fn(async () => []),
      getGitStatus: vi.fn(async () => ({
        branch: '',
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
      })),
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getFileUrl: (fileId) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    Object.assign(clientApiMock, api);

    const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
    const client = useKimiWebClient();
    await client.load();
    expect(client.activeSessionId.value).toBe('selected');
    expect(handlers).toBeDefined();

    const seqBy = new Map<string, number>();
    function emit(sessionId: string, event: Parameters<NonNullable<typeof handlers>['onEvent']>[0]): void {
      const seq = (seqBy.get(sessionId) ?? 0) + 1;
      seqBy.set(sessionId, seq);
      handlers!.onEvent(event, { sessionId, seq });
    }
    function turnBoundary(sessionId: string, active: boolean): void {
      emit(sessionId, {
        type: 'turnActiveChanged',
        sessionId,
        active,
        promptId: `prompt-${sessionId}`,
        ...(active ? {} : { reason: 'completed' as const }),
      });
    }

    // Refill still in flight, no goal event yet: an intermediate-looking
    // boundary IS suppressed (the pending read may yet prove an active goal).
    turnBoundary('quiet-s', true);
    turnBoundary('quiet-s', false);
    expect(client.unreadBySession.value['quiet-s']).toBeFalsy();

    // But once a live goalUpdated(complete) lands, the pending mark must not
    // outlive it: the terminal boundary re-arms the one completion alert.
    turnBoundary('pending-s', true);
    emit('pending-s', { type: 'goalUpdated', sessionId: 'pending-s', goal: goal('complete') });
    turnBoundary('pending-s', false);
    expect(client.unreadBySession.value['pending-s']).toBe(true);
  });
});
