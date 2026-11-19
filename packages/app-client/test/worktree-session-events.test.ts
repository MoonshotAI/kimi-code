import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSession,
  AppSessionWorktree,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  PromptSubmission,
} from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

const SID = 'worktree-session';

function worktree(
  status: AppSessionWorktree['setup']['status'],
  overrides: Partial<AppSessionWorktree> = {},
): AppSessionWorktree {
  return {
    ...overrides,
    setup: {
      status,
      purpose: 'create',
      request: { sourceBranch: 'main' },
      steps: [],
      commandsRan: 0,
      startedAt: '2026-11-18T00:00:00.000Z',
      script: 'none',
    },
  };
}

function session(overrides: Partial<AppSession> = {}): AppSession {
  return {
    id: SID,
    title: SID,
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    busy: false,
    mainTurnActive: false,
    pendingInteraction: 'none',
    archived: false,
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
      turnCount: 0,
    },
    messageCount: 0,
    workspaceId: 'workspace-1',
    ...overrides,
  };
}

const clientApiMock: Record<string, unknown> = {};

beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
});

afterEach(() => {
  resetKimiClientDeps();
});

describe('useKimiWebClient worktree session', () => {
  it('holds the first prompt until the session update reports a ready worktree', { timeout: 30_000 }, async () => {
    vi.stubGlobal('WebSocket', class { close(): void {} });
    const storageData = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return storageData.size; },
      clear: () => storageData.clear(),
      getItem: (key: string) => storageData.get(key) ?? null,
      key: (index: number) => [...storageData.keys()][index] ?? null,
      removeItem: (key: string) => { storageData.delete(key); },
      setItem: (key: string, value: string) => { storageData.set(key, value); },
    });
    vi.resetModules();

    let handlers: KimiEventHandlers | undefined;
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn((sid: string, agentId: string) => {
        queueMicrotask(() => handlers?.onConversation?.(sid, agentId, { type: 'turns', turns: [], has_more: false }));
      }),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const created = session({ worktree: worktree('running') });
    const submitPrompt = vi.fn(async (_sid: string, input: PromptSubmission) => ({
      promptId: input.promptId!,
      userMessageId: input.promptId!,
    }));
    const sessionWorktreeAction = vi.fn(async () => session({ worktree: worktree('stopped') }));
    const cancelSession = vi.fn(async () => ({ cancelled: true }));
    const getGitStatus = vi.fn(async () => ({
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: {},
      additions: 0,
      deletions: 0,
      pullRequest: null,
    }));
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null })),
      getHealth: vi.fn(async () => ({ status: 'ok' as const, uptimeSec: 1 })),
      getMeta: vi.fn(async () => ({
        protocolVersion: '1',
        serverVersion: '0.0.0',
        serverId: 'server-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        capabilities: {},
        openInApps: [],
        dangerousBypassAuth: false,
        experimentalFlags: {},
        backend: 'v2' as const,
        webTitle: '',
      })),
      getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'model-1' }) as never),
      listModels: vi.fn(async () => [{ id: 'model-1', provider: 'p', model: 'model-1', maxContextSize: 0 }]),
      listProviders: vi.fn(async () => []),
      listWorkspaces: vi.fn(async () => [
        { id: 'workspace-1', root: '/workspace', name: 'Workspace', kind: 'managed' as const, additionalDirs: ['/extra'], sessionCount: 0 },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [], hasMore: false, nextPageToken: null, total: 0 })),
      listSessionGroups: vi.fn(async () => ({ groups: [], hasMore: false, nextPageToken: null, total: 0 })),
      getWorkspaceGitBranches: vi.fn(async () => ({
        isRepo: true,
        remotes: ['origin'],
        headBranch: 'main',
        dirty: false,
        branches: [{ name: 'main', committedAt: '2026-11-18T00:00:00.000Z' }],
      })),
      createSession: vi.fn(async () => created),
      getSession: vi.fn(async () => created),
      updateSession: vi.fn(async () => created),
      submitPrompt,
      sessionWorktreeAction,
      cancelSession,
      getSessionWarnings: vi.fn(async () => []),
      getGitStatus,
      getGitStatusBatch: vi.fn(async () => ({ results: {}, errors: {} })),
      getPullRequestBatch: vi.fn(async () => ({ results: {}, statuses: {}, errors: {} })),
      getWorkspaceTrust: vi.fn(async () => ({ trusted: true })),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      getSessionMediaUrl: (_sid: string, fileId: string) => `media:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
      const { newSessionEnvironmentStore } = await import('../src/stores/newSessionEnvironment');
      const { promptStore } = await import('../src/stores/prompt');
      const client = useKimiWebClient();
      await client.load();
      newSessionEnvironmentStore().selectEnvironment('worktree');
      await newSessionEnvironmentStore().ensureBranches('workspace-1');

      const started = await client.startSessionAndSendPrompt('workspace-1', client.createPromptEnvelope({ text: 'hello' }));

      expect(started).toEqual({ sessionId: SID, promptRejected: false, held: true });
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ worktree: { sourceBranch: 'main' } }));
      expect(client.activeSessionEnvironment.value).toBe('settingUp');
      expect(client.activeWorktreeHoldsPrompts.value).toBe(true);
      expect(client.activeMainDirectory.value).toBe('/workspace');
      expect(client.turns.value.filter((turn) => turn.role === 'user').map((turn) => turn.text)).toEqual(['hello']);
      expect(client.activity.value).toBe('idle');
      expect(submitPrompt).not.toHaveBeenCalled();

      expect(await client.sendPrompt(client.createPromptEnvelope({ text: 'second' }))).toBe('queued');
      expect(submitPrompt).not.toHaveBeenCalled();

      expect(await client.abortCurrentPrompt()).toBe(true);
      expect(sessionWorktreeAction).toHaveBeenCalledExactlyOnceWith(SID, 'cancel', undefined);
      expect(cancelSession).not.toHaveBeenCalled();
      expect(client.activeWorktreeCard.value).toBe('stopped');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(submitPrompt).not.toHaveBeenCalled();

      getGitStatus.mockClear();
      const ready = session({ cwd: '/wt/a', worktree: worktree('ready', { path: '/wt/a', branch: 'kimi/a' }) });
      handlers!.onEvent(
        { type: 'sessionWorkChanged', sessionId: SID, busy: false, mainTurnActive: false, session: ready },
        { sessionId: SID },
      );

      await vi.waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
      expect(submitPrompt.mock.calls[0]![1].content).toEqual([{ type: 'text', text: 'hello' }]);
      expect(client.activeSessionEnvironment.value).toBe('worktree');
      expect(client.activeWorktreeCard.value).toBeNull();
      expect(client.activeMainDirectory.value).toBe('/wt/a');
      expect(client.status.value.cwd).toBe('/wt/a');
      expect(getGitStatus).toHaveBeenCalled();
      expect(promptStore().heldFirstPromptBySession[SID]).toBeUndefined();
      expect(promptStore().queuedBySession[SID]?.map((entry) => entry.text)).toEqual(['second']);
      expect(client.turns.value.filter((turn) => turn.role === 'user').map((turn) => turn.text)).toEqual(['hello']);

      handlers!.onEvent(
        { type: 'sessionWorkChanged', sessionId: SID, busy: false, mainTurnActive: false, session: ready },
        { sessionId: SID },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(submitPrompt).toHaveBeenCalledTimes(1);
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });
});
