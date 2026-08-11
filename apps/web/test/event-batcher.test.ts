/**
 * Scenario: WebSocket resync and snapshot replacement reach the live
 * useKimiWebClient singleton. Responsibilities: queued deltas flush in order
 * around an authoritative snapshot, and a stale snapshot never overwrites a
 * newer session object. Wiring: real client against a mocked api singleton.
 * Run: pnpm --filter kimi-code-web exec vitest run test/event-batcher.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  AppSession,
  AppSessionSnapshot,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
} from '../src/api/types';
import type { PendingAppEvent } from '@moonshot-ai/app-core/client';

const clientApiMock = vi.hoisted(() => ({}));

vi.mock('../src/api', () => ({
  getKimiWebApi: () => clientApiMock,
}));

interface DeltaOptions {
  sessionId?: string;
  messageId?: string;
  contentIndex?: number;
  turnId?: number;
  kind?: 'text' | 'thinking';
  stream?: boolean;
  seq?: number;
}

function pendingDelta(value: string, offset: number, options: DeltaOptions = {}): PendingAppEvent {
  const sessionId = options.sessionId ?? 'session-1';
  const kind = options.kind ?? 'text';
  return {
    appEvent: {
      type: 'assistantDelta',
      sessionId,
      messageId: options.messageId ?? 'message-1',
      contentIndex: options.contentIndex ?? 0,
      delta: kind === 'text' ? { text: value } : { thinking: value },
    },
    meta: {
      sessionId,
      seq: options.seq ?? offset + value.length,
      stream:
        options.stream === false
          ? undefined
          : {
              turnId: options.turnId ?? 1,
              offset,
              kind,
            },
    },
  };
}

describe('useKimiWebClient (resync integration)', () => {
  it('flushes queued deltas around an authoritative snapshot before live streaming resumes', async () => {
    vi.stubGlobal('WebSocket', class {});

    const sessionId = 'session-1';
    const session: AppSession = {
      id: sessionId,
      title: 'Session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      archived: false,
      currentPromptId: 'prompt-1',
      cwd: '/workspace',
      model: 'model-1',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        contextTokens: 0,
        contextLimit: 0,
        turnCount: 1,
      },
      messageCount: 1,
      lastSeq: 10,
      workspaceId: 'workspace-1',
    };
    const snapshot = (text: string, asOfSeq: number, epoch: string): AppSessionSnapshot => ({
      asOfSeq,
      epoch,
      session: { ...session, lastSeq: asOfSeq },
      messages: [
        {
          id: 'message-1',
          sessionId,
          role: 'assistant',
          content: [{ type: 'text', text }],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      hasMoreMessages: false,
      inFlightTurn: {
        turnId: 1,
        assistantText: text,
        thinkingText: '',
        runningTools: [],
        promptId: 'prompt-1',
      },
      subagents: [],
      pendingApprovals: [],
      pendingQuestions: [],
    });
    const initialSnapshot = snapshot('seed', 10, 'epoch-1');
    const authoritativeSnapshot = snapshot('snapshot', 20, 'epoch-2');

    let handlers: KimiEventHandlers | undefined;
    let resolveSnapshotRequest!: () => void;
    const snapshotRequested = new Promise<void>((resolve) => {
      resolveSnapshotRequest = resolve;
    });
    let resolveAuthoritativeSnapshot!: (value: AppSessionSnapshot) => void;
    const authoritativeSnapshotResponse = new Promise<AppSessionSnapshot>((resolve) => {
      resolveAuthoritativeSnapshot = resolve;
    });
    let resolveSnapshotApplied!: () => void;
    const snapshotApplied = new Promise<void>((resolve) => {
      resolveSnapshotApplied = resolve;
    });
    let snapshotCalls = 0;
    const getSessionSnapshot = vi.fn((_id: string) => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return Promise.resolve(initialSnapshot);
      resolveSnapshotRequest();
      return authoritativeSnapshotResponse;
    });
    let seedCalls = 0;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      bindNextPromptId: vi.fn(),
      seedSnapshot: vi.fn(() => {
        seedCalls += 1;
        if (seedCalls === 2) resolveSnapshotApplied();
      }),
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
      getAuth: vi.fn(async () => ({
        ready: true,
        defaultModel: 'model-1',
        managedProvider: null,
      })),
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
        {
          id: 'workspace-1',
          root: '/workspace',
          name: 'Workspace',
          sessionCount: 1,
        },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [session], hasMore: false })),
      getSessionSnapshot,
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
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      const assistantText = (): string | undefined =>
        client.turns.value.find((turn) => turn.role === 'assistant')?.text;

      expect(assistantText()).toBe('seed');
      expect(handlers).toBeDefined();

      const beforeResync = pendingDelta('before', 4, { seq: 11 });
      handlers!.onEvent(beforeResync.appEvent, beforeResync.meta);
      handlers!.onResync(sessionId, 11, 'epoch-2');

      // onResync synchronously drains pre-resync text onto the old state.
      expect(assistantText()).toBe('seedbefore');
      await snapshotRequested;

      // A frame can race the REST request. The second flush must consume it on
      // the old state before the authoritative snapshot replaces that state.
      const duringSnapshot = pendingDelta('old', 10, { seq: 12 });
      handlers!.onEvent(duringSnapshot.appEvent, duringSnapshot.meta);
      resolveAuthoritativeSnapshot(authoritativeSnapshot);
      await snapshotApplied;
      expect(assistantText()).toBe('snapshot');

      const live = pendingDelta(' live', 8, { seq: 21 });
      handlers!.onEvent(live.appEvent, live.meta);
      handlers!.onEvent(
        { type: 'sessionMetaUpdated', sessionId, title: 'Session' },
        { sessionId, seq: 22 },
      );

      expect(assistantText()).toBe('snapshot live');
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });
});

describe('useKimiWebClient (snapshot recency guard)', () => {
  it('keeps the newer updatedAt when a snapshot replaces the session object', async () => {
    vi.stubGlobal('WebSocket', class {});
    // Fresh module state: useKimiWebClient holds a module-level singleton
    // (rawState), and the resync test above already populated it.
    vi.resetModules();

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
    const makeSession = (id: string, updatedAt: string): AppSession => ({
      id,
      title: id,
      createdAt: updatedAt,
      updatedAt,
      busy: false,
      archived: false,
      cwd: '/workspace',
      model: 'model-1',
      usage: { ...usage },
      messageCount: 0,
      lastSeq: 1,
      workspaceId: 'workspace-1',
    });
    const snapshotFor = (
      session: AppSession,
      serverUpdatedAt: string,
      mainTurnActive = false,
    ): AppSessionSnapshot => ({
      asOfSeq: 1,
      epoch: 'epoch-1',
      session: { ...session, updatedAt: serverUpdatedAt, mainTurnActive },
      messages: [],
      hasMoreMessages: false,
      inFlightTurn: null,
      subagents: [],
      pendingApprovals: [],
      pendingQuestions: [],
    });
    // The server is prompt-submit-grained, the client bumps at turn end: for
    // s-local-newer the client value is ahead (keep it); for s-local-older
    // the server recorded newer activity the client missed (adopt it).
    const serverUpdatedAtById: Record<string, string> = {
      's-local-newer': '2026-05-01T00:00:00.000Z',
      's-local-older': '2026-03-01T00:00:00.000Z',
      's-mid-turn': '2026-05-01T00:00:00.000Z',
    };
    const localNewer = makeSession('s-local-newer', '2026-06-01T12:00:00.000Z');
    const localOlder = makeSession('s-local-older', '2026-01-01T00:00:00.000Z');
    // Server bumped mid-turn (prompt submit / auto title / subagent register);
    // importing that on click would float the workspace before the turn ends.
    const midTurn = makeSession('s-mid-turn', '2026-01-01T00:00:00.000Z');
    const getSessionSnapshot = vi.fn((id: string) =>
      Promise.resolve(
        id === 's-mid-turn'
          ? snapshotFor(midTurn, serverUpdatedAtById[id]!, true)
          : snapshotFor(
              id === 's-local-newer' ? localNewer : localOlder,
              serverUpdatedAtById[id]!,
            ),
      ),
    );
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
      getAuth: vi.fn(async () => ({
        ready: true,
        defaultModel: 'model-1',
        managedProvider: null,
      })),
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
        {
          id: 'workspace-1',
          root: '/workspace',
          name: 'Workspace',
          sessionCount: 2,
        },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({
        items: [localNewer, localOlder, midTurn],
        hasMore: false,
      })),
      getSessionSnapshot,
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
      connectEvents: vi.fn(() => connection),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      await client.selectSession('s-local-newer');
      await client.selectSession('s-local-older');
      await client.selectSession('s-mid-turn');

      const byId = (id: string) =>
        client.workspaceGroups.value.flatMap((g) => g.sessions).find((s) => s.id === id);
      expect(byId('s-local-newer')?.updatedAt).toBe('2026-06-01T12:00:00.000Z');
      expect(byId('s-local-older')?.updatedAt).toBe('2026-03-01T00:00:00.000Z');
      // A mid-turn server bump must NOT be imported on click — the turn's end
      // bumps recency via the WS event instead.
      expect(byId('s-mid-turn')?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });
});
