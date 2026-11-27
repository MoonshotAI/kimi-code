import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppAgentState,
  AppSession,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  ManagedQuotaResult,
  PromptSubmission,
  PromptSubmitResult,
} from '@moonshot-ai/app-core/api';
import { MANAGED_KIMI_CODE_PROVIDER_ID } from '@moonshot-ai/app-core/api';
import type { ConversationError, ConversationTurnHeader } from '@moonshot-ai/app-core/conversation';
import {
  createQuotaAutoResume,
  isManagedQuotaError,
  QUOTA_AUTO_RESUME_FALLBACK_DELAYS_MS,
  QUOTA_AUTO_RESUME_GRACE_MS,
  QUOTA_AUTO_RESUME_MAX_WAIT_MS,
  QUOTA_AUTO_RESUME_MIN_JITTER_MS,
} from '../src/client/quotaAutoResume';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { agentState } from './agentFrames';

const BASE_MS = Date.parse('2026-11-27T10:00:00.000Z');
const QUOTA_403: ConversationError = {
  code: 'provider.auth_error',
  status_code: 403,
  message: "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
};

function quotaOk(
  usages: ManagedQuotaResult extends { kind: 'ok'; quota: infer Q }
    ? Q extends { usages: infer U }
      ? U
      : never
    : never,
): ManagedQuotaResult {
  return { kind: 'ok', quota: { usages, extraUsage: null } };
}

function controllerRig(overrides: {
  enabled?: boolean;
  managed?: boolean;
  usages?: ManagedQuotaResult[];
  ready?: () => Promise<boolean>;
} = {}) {
  let enabled = overrides.enabled ?? true;
  const usageQueue = [...(overrides.usages ?? [])];
  const getUsage = vi.fn(async (): Promise<ManagedQuotaResult> => {
    return usageQueue.length > 0 ? usageQueue.shift()! : quotaOk({ limit5h: { usedRatio: 0.2 } });
  });
  const checkSessionReady = vi.fn(overrides.ready ?? (async () => true));
  const submitResume = vi.fn(async () => {});
  const host = {
    enabled: () => enabled,
    isManagedKimiSession: () => overrides.managed ?? true,
    getUsage,
    checkSessionReady,
    submitResume,
    random: () => 0,
  };
  const controller = createQuotaAutoResume(host);
  return {
    controller,
    getUsage,
    checkSessionReady,
    submitResume,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

async function flushAsync(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('isManagedQuotaError', () => {
  it('recognizes managed 403 usage-limit errors and structured quota exhaustion', () => {
    expect(isManagedQuotaError(QUOTA_403)).toBe(true);
    expect(isManagedQuotaError({ code: 'provider.auth_error', status_code: 403, message: '5-hour usage limit reached' })).toBe(true);
    expect(isManagedQuotaError({ code: 'provider.auth_error', status_code: 403, message: 'weekly (7-day) usage limit reached' })).toBe(true);
    expect(isManagedQuotaError({ code: 'provider.api_error', name: 'APIProviderQuotaExhaustedError', status_code: 429, message: 'quota exhausted' })).toBe(true);
  });

  it('rejects ordinary auth errors, third-party 429s, and missing errors', () => {
    expect(isManagedQuotaError(undefined)).toBe(false);
    expect(isManagedQuotaError({ code: 'provider.auth_error', status_code: 401, message: 'Invalid token' })).toBe(false);
    expect(isManagedQuotaError({ code: 'provider.auth_error', status_code: 403, message: 'Forbidden by workspace policy' })).toBe(false);
    expect(isManagedQuotaError({ code: 'provider.api_error', status_code: 429, message: 'Rate limit reached, slow down' })).toBe(false);
  });
});

describe('createQuotaAutoResume', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does nothing when the lab switch is off', async () => {
    const rig = controllerRig({ enabled: false });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await flushAsync();
    expect(rig.getUsage).not.toHaveBeenCalled();
    expect(rig.controller.hasPending()).toBe(false);
  });

  it('does not arm for non-managed providers or non-quota failures', async () => {
    const rig = controllerRig({ managed: false });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    rig.controller.handleTurnFailed('s1', 't1', { code: 'provider.api_error', status_code: 500, message: 'boom' });
    await flushAsync();
    expect(rig.getUsage).not.toHaveBeenCalled();
  });

  it('fires once after the 5h resetAt plus jitter', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const rig = controllerRig({
      usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt }, limit7d: { usedRatio: 0.3 } })],
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await flushAsync();
    expect(rig.controller.hasPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS - 1);
    expect(rig.submitResume).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(rig.checkSessionReady).toHaveBeenCalledWith('s1', 't1');
    expect(rig.submitResume).toHaveBeenCalledTimes(1);
    expect(rig.submitResume).toHaveBeenCalledWith('s1', { turnId: 't1', resetAt });
    expect(rig.controller.hasPending()).toBe(false);
  });

  it('uses the later resetAt when both 5h and 7d windows are exhausted', async () => {
    const reset5h = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const reset7d = new Date(BASE_MS + 3 * 60 * 60 * 1000).toISOString();
    const rig = controllerRig({
      usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt: reset5h }, limit7d: { usedRatio: 1, resetAt: reset7d } })],
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    expect(rig.submitResume).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(rig.submitResume).toHaveBeenCalledWith('s1', { turnId: 't1', resetAt: reset7d });
  });

  it('falls back to 1m / 5m / 15m usage polling when resetAt is missing or usage fails', async () => {
    const rig = controllerRig({
      usages: [
        { kind: 'error', message: 'network down' },
        quotaOk({ limit5h: { usedRatio: 1 } }),
        quotaOk({ limit5h: { usedRatio: 1 } }),
        quotaOk({ limit5h: { usedRatio: 0.4 } }),
      ],
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await flushAsync();
    expect(rig.getUsage).toHaveBeenCalledTimes(1);

    const [first, second, third] = QUOTA_AUTO_RESUME_FALLBACK_DELAYS_MS;
    await vi.advanceTimersByTimeAsync(first);
    expect(rig.getUsage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(second);
    expect(rig.getUsage).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(third + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    expect(rig.getUsage).toHaveBeenCalledTimes(4);
    expect(rig.submitResume).toHaveBeenCalledWith('s1', { turnId: 't1', resetAt: null });
  });

  it('keeps only the first pending session and never resumes twice in the same reset window', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const rig = controllerRig({
      usages: [
        quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
        quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
      ],
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    rig.controller.handleTurnFailed('s2', 't9', QUOTA_403);
    await flushAsync();
    expect(rig.getUsage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    expect(rig.submitResume).toHaveBeenCalledTimes(1);
    expect(rig.submitResume).toHaveBeenCalledWith('s1', { turnId: 't1', resetAt });

    rig.controller.handleTurnFailed('s2', 't9', QUOTA_403);
    await flushAsync();
    expect(rig.controller.hasPending()).toBe(false);
    expect(rig.submitResume).toHaveBeenCalledTimes(1);
  });

  it('cancels only the affected session on new activity, undo, or deletion', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const rig = controllerRig({ usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt } })] });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await flushAsync();

    rig.controller.cancelSession('s2');
    expect(rig.controller.hasPending()).toBe(true);

    rig.controller.cancelSession('s1');
    expect(rig.controller.hasPending()).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(rig.submitResume).not.toHaveBeenCalled();
  });

  it('aborts submission if the session is cancelled while readiness is still being checked', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    let releaseReady!: (value: boolean) => void;
    const rig = controllerRig({
      usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt } })],
      ready: () => new Promise<boolean>((resolve) => {
        releaseReady = resolve;
      }),
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    expect(rig.checkSessionReady).toHaveBeenCalledTimes(1);

    rig.controller.cancelSession('s1');
    releaseReady(true);
    await flushAsync();
    expect(rig.submitResume).not.toHaveBeenCalled();
  });

  it('clears timers immediately when the switch is turned off and rechecks before firing', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const rig = controllerRig({ usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt } })] });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await flushAsync();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    rig.setEnabled(false);
    rig.controller.clearAll();
    expect(vi.getTimerCount()).toBe(0);
    expect(rig.controller.hasPending()).toBe(false);

    rig.setEnabled(true);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(rig.submitResume).not.toHaveBeenCalled();
  });

  it('rejects reset windows more than 24h away', async () => {
    const resetAt = new Date(BASE_MS + QUOTA_AUTO_RESUME_MAX_WAIT_MS + 60_000).toISOString();
    const rig = controllerRig({ usages: [quotaOk({ limit7d: { usedRatio: 1, resetAt } })] });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await flushAsync();
    expect(rig.controller.hasPending()).toBe(false);
  });

  it('drops a missed reset after 30 minutes of sleep but fires within the grace window', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const slept = controllerRig({ usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt } })] });
    slept.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await flushAsync();
    vi.setSystemTime(BASE_MS + 60 * 60 * 1000 + QUOTA_AUTO_RESUME_GRACE_MS + 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slept.submitResume).not.toHaveBeenCalled();
    expect(slept.controller.hasPending()).toBe(false);

    vi.setSystemTime(BASE_MS);
    const resetSoon = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const awake = controllerRig({ usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt: resetSoon } })] });
    awake.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await flushAsync();
    vi.setSystemTime(BASE_MS + 60 * 60 * 1000 + 10 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(awake.submitResume).toHaveBeenCalledTimes(1);
  });

  it('skips submission when the session is busy before firing', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const rig = controllerRig({
      usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt } })],
      ready: async () => false,
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    expect(rig.checkSessionReady).toHaveBeenCalledTimes(1);
    expect(rig.submitResume).not.toHaveBeenCalled();
    expect(rig.controller.hasPending()).toBe(false);
  });
});

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  });
  return map;
}

function clientSession(id: string, model = 'k2'): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-11-27T09:00:00.000Z',
    updatedAt: '2026-11-27T09:00:00.000Z',
    busy: false,
    mainTurnActive: false,
    pendingInteraction: 'none',
    archived: false,
    cwd: '/workspace',
    model,
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
    workspaceId: 'ws1',
  };
}

const clientApiMock: Record<string, unknown> = {};

async function bootClient(opts: {
  enabled: boolean;
  historyFailed?: boolean;
  usage: ManagedQuotaResult;
  trusted?: boolean;
}) {
  stubStorage(opts.enabled ? { 'kimi-web.quota-auto-resume': 'true' } : {});
  vi.stubGlobal('WebSocket', function () {});
  vi.resetModules();
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });

  const sessions = [clientSession('s1'), clientSession('s2')];
  let handlers: KimiEventHandlers | undefined;
  const failedHeader: ConversationTurnHeader = {
    turn_id: 't0',
    ordinal: 0,
    kind: 'agent',
    status: 'ended',
    outcome: 'failed',
    started_at: '2026-11-27T09:59:00.000Z',
    steps: [],
    error: QUOTA_403,
  };
  const connection: KimiEventConnection = {
    subscribeConversation: vi.fn((sid: string) => {
      queueMicrotask(() => {
        handlers?.onConversation?.(sid, 'main', {
          type: 'turns',
          turns: opts.historyFailed === true && sid === 's1' ? [{ ...failedHeader, items: [] }] : [],
          has_more: false,
        });
      });
    }),
    unsubscribeConversation: vi.fn(),
    watchTaskOutput: vi.fn(),
    unwatchTaskOutput: vi.fn(),
    stopTask: vi.fn(),
    backgroundTask: vi.fn(),
    health: () => ({ connected: true, open: true, stale: false }),
    reconnect: vi.fn(),
    close: vi.fn(),
  };
  const latestTurnBySession = new Map<string, string>([['s1', 't0'], ['s2', 't0']]);
  const getUsage = vi.fn(async () => opts.usage);
  const getAgentTurns = vi.fn(async (sid: string) => ({
    turns: [{ ...failedHeader, turn_id: latestTurnBySession.get(sid) ?? 't0', items: [] }],
    has_more: false,
  }));
  const submitPrompt = vi.fn<(sid: string, input: PromptSubmission) => Promise<PromptSubmitResult>>(
    async (_sid, input) => ({ promptId: input.promptId!, userMessageId: input.promptId!, status: 'running' }),
  );
  const api: Partial<KimiWebApi> = {
    getAuth: vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null })),
    getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
    getMeta: vi.fn(async () => ({
      serverVersion: '0.0.0',
      serverId: 'server-1',
      startedAt: '2026-11-27T09:00:00.000Z',
      capabilities: {},
      openInApps: [],
      dangerousBypassAuth: false,
      experimentalFlags: {},
      backend: 'v2' as const,
    })),
    getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'k2' })),
    listModels: vi.fn(async () => [{ id: 'k2', provider: MANAGED_KIMI_CODE_PROVIDER_ID, model: 'k2', maxContextSize: 200000 }]),
    listProviders: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => [{ id: 'ws1', root: '/workspace', name: 'Workspace', sessionCount: 2 }]),
    getWorkspaceTrust: vi.fn(async () => ({ trusted: opts.trusted ?? true })),
    getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
    listSessions: vi.fn(async () => ({ items: sessions, hasMore: false, nextPageToken: null, total: sessions.length })),
    listSessionGroups: vi.fn(async () => ({
      groups: [{ workspaceId: 'ws1', sessions: sessions.map((s) => ({ ...s, lastPrompt: 'hi' })), total: sessions.length }],
      hasMore: false,
      nextPageToken: null,
      total: sessions.length,
    })),
    getSession: vi.fn(async (id: string) => clientSession(id)),
    getSessionGoal: vi.fn(async () => null),
    getSessionWarnings: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ branch: '', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null })),
    listSkills: vi.fn(async () => []),
    listSkillsForWorkspace: vi.fn(async () => []),
    generateSessionTitle: vi.fn(async () => null),
    predictNextPrompt: vi.fn(async () => null),
    cancelPromptPrediction: vi.fn(async () => true),
    getFileUrl: (fileId: string) => `file:${fileId}`,
    getUsage,
    getAgentTurns,
    submitPrompt,
    connectEvents: vi.fn((next: KimiEventHandlers) => {
      handlers = next;
      return connection;
    }),
  };
  for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
  Object.assign(clientApiMock, api);

  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const { useQuotaAutoResume } = await import('@moonshot-ai/app-core');
  const client = useKimiWebClient();
  await client.load();
  await client.selectSession('s1');
  await vi.waitFor(() => expect(client.sessionLoading.value).toBe(false));

  const startLiveTurn = (sid: string, turnId: string) => {
    latestTurnBySession.set(sid, turnId);
    handlers!.onAgentState?.(sid, 'main', agentState('running'));
    handlers!.onConversation?.(sid, 'main', {
      type: 'turn.started',
      turn: { ...failedHeader, turn_id: turnId, status: 'running', outcome: undefined, error: undefined },
    });
  };
  const failLiveTurn = (sid: string, turnId: string, error: ConversationError = QUOTA_403) => {
    handlers!.onConversation?.(sid, 'main', {
      type: 'turn.ended',
      turn: { ...failedHeader, turn_id: turnId, error },
    });
    handlers!.onAgentState?.(sid, 'main', agentState('idle'));
  };
  const setAgentStatus = (sid: string, status: AppAgentState['status']) => {
    handlers!.onAgentState?.(sid, 'main', agentState(status));
  };
  const removeTurns = (sid: string, turnIds: string[]) => {
    handlers!.onConversation?.(sid, 'main', { type: 'turns.removed', turn_ids: turnIds });
  };
  const deleteSession = (sid: string) => {
    handlers!.onEvent({ type: 'sessionDeleted', sessionId: sid }, { sessionId: sid });
  };

  return {
    client,
    getUsage,
    getAgentTurns,
    submitPrompt,
    startLiveTurn,
    failLiveTurn,
    setAgentStatus,
    removeTurns,
    deleteSession,
    useQuotaAutoResume,
  };
}

describe('useKimiWebClient quota auto-resume wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetKimiClientDeps();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('never arms from initial history pages, even when the latest historical turn failed on quota', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const h = await bootClient({
      enabled: true,
      historyFailed: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    await flushAsync();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(h.getUsage).not.toHaveBeenCalled();
    expect(h.submitPrompt).not.toHaveBeenCalled();
  });

  it('resumes a live 403 quota failure as a user bubble even after switching to another session', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const h = await bootClient({
      enabled: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    h.startLiveTurn('s1', 't-live');
    h.failLiveTurn('s1', 't-live');
    await flushAsync();
    expect(h.getUsage).toHaveBeenCalledTimes(1);

    await h.client.selectSession('s2');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(h.submitPrompt).toHaveBeenCalledTimes(1);
    const [sid, submission] = h.submitPrompt.mock.calls[0]!;
    expect(sid).toBe('s1');
    expect(submission.content).toEqual([{ type: 'text', text: 'conversation.quotaAutoResumePrompt' }]);
    expect(submission.metadata).toEqual({
      kimi_quota_auto_resume: { turnId: 't-live', resetAt },
    });
  });

  it('cancels when a new turn starts in the failed session or when the lab switch is turned off', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const h = await bootClient({
      enabled: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    h.startLiveTurn('s1', 't1');
    h.failLiveTurn('s1', 't1');
    await flushAsync();
    h.startLiveTurn('s1', 't2');
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(h.submitPrompt).not.toHaveBeenCalled();

    h.failLiveTurn('s1', 't2');
    await flushAsync();
    const { setQuotaAutoResumeEnabled } = h.useQuotaAutoResume();
    setQuotaAutoResumeEnabled(false);
    await flushAsync();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(h.submitPrompt).not.toHaveBeenCalled();
  });

  it('keeps the armed session when another session starts a turn, and cancels on undo or delete', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const h = await bootClient({
      enabled: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    h.startLiveTurn('s1', 't1');
    h.failLiveTurn('s1', 't1');
    await flushAsync();

    h.startLiveTurn('s2', 'other-1');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(h.submitPrompt).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const undone = await bootClient({
      enabled: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    undone.startLiveTurn('s1', 't1');
    undone.failLiveTurn('s1', 't1');
    await flushAsync();
    undone.removeTurns('s1', ['t1']);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(undone.submitPrompt).not.toHaveBeenCalled();

    vi.resetModules();
    const deleted = await bootClient({
      enabled: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    deleted.startLiveTurn('s1', 't1');
    deleted.failLiveTurn('s1', 't1');
    await flushAsync();
    deleted.deleteSession('s1');
    await flushAsync();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(deleted.submitPrompt).not.toHaveBeenCalled();
  });

  it('skips when the workspace is untrusted or the session became busy before reset', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const untrusted = await bootClient({
      enabled: true,
      trusted: false,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    untrusted.startLiveTurn('s1', 't1');
    untrusted.failLiveTurn('s1', 't1');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(untrusted.submitPrompt).not.toHaveBeenCalled();

    vi.resetModules();
    const busy = await bootClient({
      enabled: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    busy.startLiveTurn('s1', 't1');
    busy.failLiveTurn('s1', 't1');
    await flushAsync();
    busy.setAgentStatus('s1', 'running');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(busy.submitPrompt).not.toHaveBeenCalled();
  });
});
