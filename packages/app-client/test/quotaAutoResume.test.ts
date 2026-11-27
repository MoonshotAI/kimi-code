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
import { DaemonApiError, MANAGED_KIMI_CODE_PROVIDER_ID } from '@moonshot-ai/app-core/api';
import type { ConversationError, ConversationTurnHeader } from '@moonshot-ai/app-core/conversation';
import { STORAGE_KEYS, safeSetJson } from '@moonshot-ai/app-core/lib';
import {
  createQuotaAutoResume,
  isManagedQuotaError,
  QUOTA_AUTO_RESUME_FALLBACK_DELAYS_MS,
  QUOTA_AUTO_RESUME_GRACE_MS,
  QUOTA_AUTO_RESUME_MAX_WAIT_MS,
  QUOTA_AUTO_RESUME_MIN_JITTER_MS,
  QUOTA_AUTO_RESUME_RESERVATION_LEASE_MS,
  QUOTA_AUTO_RESUME_RETRY_DELAYS_MS,
} from '../src/client/quotaAutoResume';
import { isLocalPromptId, stablePromptId } from '../src/client/promptId';
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
  managed?: boolean | ((sessionId: string) => boolean | Promise<boolean>);
  usages?: ManagedQuotaResult[];
  ready?: () => Promise<boolean>;
  submit?: (sessionId: string, input: { turnId: string; resetAt: string | null; promptId: string }) => Promise<void>;
  onGiveUp?: (sessionId: string, error: unknown) => void;
} = {}) {
  let enabled = overrides.enabled ?? true;
  const usageQueue = [...(overrides.usages ?? [])];
  const getUsage = vi.fn(async (_sessionId: string): Promise<ManagedQuotaResult> => {
    return usageQueue.length > 0 ? usageQueue.shift()! : quotaOk({ limit5h: { usedRatio: 0.2 } });
  });
  const checkSessionReady = vi.fn(overrides.ready ?? (async () => true));
  const submitResume = vi.fn(overrides.submit ?? (async () => {}));
  const isManagedKimiSession = vi.fn((sessionId: string) =>
    typeof overrides.managed === 'function' ? overrides.managed(sessionId) : (overrides.managed ?? true),
  );
  const onGiveUp = vi.fn(overrides.onGiveUp ?? (() => {}));
  const host = {
    enabled: () => enabled,
    isManagedKimiSession,
    getUsage,
    checkSessionReady,
    submitResume,
    onGiveUp,
    random: () => 0,
  };
  const controller = createQuotaAutoResume(host);
  return {
    controller,
    getUsage,
    isManagedKimiSession,
    checkSessionReady,
    submitResume,
    onGiveUp,
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

describe('stablePromptId', () => {
  it('is deterministic, well-formed, and registered as a local prompt', () => {
    const a = stablePromptId('kimi-quota-auto-resume:s1:t1');
    const b = stablePromptId('kimi-quota-auto-resume:s1:t1');
    const c = stablePromptId('kimi-quota-auto-resume:s1:t2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(isLocalPromptId(a)).toBe(true);
  });
});

describe('createQuotaAutoResume', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    stubStorage();
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
    expect(rig.submitResume).toHaveBeenCalledWith('s1', {
      turnId: 't1',
      resetAt,
      promptId: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
    });
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
    expect(rig.submitResume).toHaveBeenCalledWith('s1', {
      turnId: 't1',
      resetAt: reset7d,
      promptId: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
    });
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
    expect(rig.submitResume).toHaveBeenCalledWith('s1', {
      turnId: 't1',
      resetAt: null,
      promptId: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
    });
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
    expect(rig.submitResume).toHaveBeenCalledWith('s1', {
      turnId: 't1',
      resetAt,
      promptId: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
    });

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

  it('treats an empty usage payload as unknown and keeps polling instead of firing', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const rig = controllerRig({
      usages: [quotaOk({}), quotaOk({ limit5h: { usedRatio: 1, resetAt } })],
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await flushAsync();
    expect(rig.getUsage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(QUOTA_AUTO_RESUME_MIN_JITTER_MS + 10_000);
    expect(rig.submitResume).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(QUOTA_AUTO_RESUME_FALLBACK_DELAYS_MS[0]);
    expect(rig.getUsage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    expect(rig.submitResume).toHaveBeenCalledTimes(1);
  });

  it('does not loop on null-reset resumes when usage keeps reporting quota available', async () => {
    const rig = controllerRig({
      usages: [
        quotaOk({ limit5h: { usedRatio: 0.2 } }),
        quotaOk({ limit5h: { usedRatio: 0.2 } }),
        quotaOk({ limit5h: { usedRatio: 0.2 } }),
      ],
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await vi.advanceTimersByTimeAsync(QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    expect(rig.submitResume).toHaveBeenCalledTimes(1);
    expect(rig.submitResume.mock.calls[0]![1].resetAt).toBeNull();

    rig.controller.handleTurnFailed('s1', 't2', QUOTA_403);
    await flushAsync();
    expect(rig.controller.hasPending()).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(rig.submitResume).toHaveBeenCalledTimes(1);
  });

  it('elects a single scheduler across tabs sharing a reset window', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    let lockTail: Promise<unknown> = Promise.resolve();
    const request = vi.fn(<T,>(_name: string, _opts: { mode: string }, fn: () => Promise<T>): Promise<T> => {
      const run = lockTail.then(fn, fn);
      lockTail = run.catch(() => undefined);
      return run;
    });
    vi.stubGlobal('navigator', { locks: { request } });
    let releaseSubmit!: () => void;
    let notifySubmitStarted!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      notifySubmitStarted = resolve;
    });
    const submitResume = vi.fn(async () => {
      notifySubmitStarted();
      await new Promise<void>((resolve) => {
        releaseSubmit = resolve;
      });
    });
    const tabA = createQuotaAutoResume({
      enabled: () => true,
      isManagedKimiSession: () => true,
      getUsage: async () => quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
      checkSessionReady: async () => true,
      submitResume,
      random: () => 0,
    });
    const tabB = createQuotaAutoResume({
      enabled: () => true,
      isManagedKimiSession: () => true,
      getUsage: async () => quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
      checkSessionReady: async () => true,
      submitResume,
      random: () => 0,
    });
    tabA.handleTurnFailed('s1', 't1', QUOTA_403);
    tabB.handleTurnFailed('s2', 't2', QUOTA_403);
    await flushAsync();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    await submitStarted;
    await flushAsync();
    releaseSubmit();
    await flushAsync();
    expect(request).toHaveBeenCalledWith(
      'kimi-web.quota-auto-resume.fire',
      { mode: 'exclusive' },
      expect.any(Function),
    );
    expect(submitResume).toHaveBeenCalledTimes(1);
    expect(submitResume).toHaveBeenCalledWith('s1', expect.objectContaining({ turnId: 't1', resetAt }));
    expect(tabA.hasPending()).toBe(false);
    expect(tabB.hasPending()).toBe(false);
  });

  it('treats a server prompt_id conflict from another client as already resumed', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const rig = controllerRig({
      usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt } }), quotaOk({ limit5h: { usedRatio: 1, resetAt } })],
      submit: async () => {
        throw new DaemonApiError({ code: 40927, msg: 'prompt_id already used', requestId: 'r1' });
      },
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    expect(rig.submitResume).toHaveBeenCalledTimes(1);
    expect(rig.onGiveUp).not.toHaveBeenCalled();

    rig.controller.handleTurnFailed('s2', 't2', QUOTA_403);
    await flushAsync();
    expect(rig.controller.hasPending()).toBe(false);
  });

  it('retries trigger-time network failures with the same idempotent prompt id', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    let failSubmit = true;
    const rig = controllerRig({
      usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt } })],
      submit: async () => {
        if (failSubmit) {
          failSubmit = false;
          throw new Error('network offline');
        }
      },
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    expect(rig.submitResume).toHaveBeenCalledTimes(1);
    expect(rig.controller.hasPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(QUOTA_AUTO_RESUME_RETRY_DELAYS_MS[0]);
    expect(rig.submitResume).toHaveBeenCalledTimes(2);
    expect(rig.submitResume.mock.calls[1]![1].promptId).toBe(rig.submitResume.mock.calls[0]![1].promptId);
    expect(rig.controller.hasPending()).toBe(false);
    expect(rig.onGiveUp).not.toHaveBeenCalled();
  });

  it('surfaces a give-up after bounded retries are exhausted', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const rig = controllerRig({
      usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt } })],
      ready: async () => {
        throw new Error('connection refused');
      },
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    for (const delay of QUOTA_AUTO_RESUME_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(rig.checkSessionReady).toHaveBeenCalledTimes(1 + QUOTA_AUTO_RESUME_RETRY_DELAYS_MS.length);
    expect(rig.submitResume).not.toHaveBeenCalled();
    expect(rig.onGiveUp).toHaveBeenCalledTimes(1);
    expect(rig.onGiveUp).toHaveBeenCalledWith('s1', expect.any(Error));
    expect(rig.controller.hasPending()).toBe(false);
  });

  it('cancels if the session is no longer a managed Kimi session at fire time', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    let managed = true;
    const rig = controllerRig({
      managed: () => managed,
      usages: [quotaOk({ limit5h: { usedRatio: 1, resetAt } })],
    });
    rig.controller.handleTurnFailed('s1', 't1', QUOTA_403);
    await flushAsync();
    managed = false;

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    expect(rig.checkSessionReady).not.toHaveBeenCalled();
    expect(rig.submitResume).not.toHaveBeenCalled();
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
  autoContinue?: boolean;
  historyFailed?: boolean;
  usage: ManagedQuotaResult;
  trusted?: boolean;
  sshBackground?: boolean;
  deferTurns?: boolean;
  failSubmits?: number;
}) {
  stubStorage({
    ...(opts.enabled ? { [STORAGE_KEYS.quotaAutoResume]: 'true' } : {}),
    ...(opts.autoContinue === undefined ? {} : { [STORAGE_KEYS.quotaAutoContinue]: String(opts.autoContinue) }),
  });
  vi.stubGlobal('WebSocket', function () {});
  vi.resetModules();

  const sessions = opts.sshBackground === true
    ? [
        { ...clientSession('s1'), workspaceId: 'ws-remote', hostId: 'ssh-remote' },
        { ...clientSession('s2', 'local-custom'), workspaceId: 'ws-local' },
      ]
    : [clientSession('s1'), clientSession('s2')];
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
  const pendingTurnLookups: Array<() => void> = [];
  const getUsage = vi.fn(async () =>
    opts.sshBackground === true ? { kind: 'error' as const, message: 'not signed in locally' } : opts.usage,
  );
  const getAgentTurns = vi.fn(async (sid: string) => {
    if (opts.deferTurns === true) {
      await new Promise<void>((resolve) => {
        pendingTurnLookups.push(resolve);
      });
    }
    return {
      turns: [{ ...failedHeader, turn_id: latestTurnBySession.get(sid) ?? 't0', items: [] }],
      has_more: false,
    };
  });
  let remainingSubmitFailures = opts.failSubmits ?? 0;
  const submitPrompt = vi.fn<(sid: string, input: PromptSubmission) => Promise<PromptSubmitResult>>(
    async (_sid, input) => {
      if (remainingSubmitFailures > 0) {
        remainingSubmitFailures -= 1;
        throw new Error('network offline');
      }
      return { promptId: input.promptId!, userMessageId: input.promptId!, status: 'running' };
    },
  );
  const remoteListModels = vi.fn(async () => [
    { id: 'k2', provider: MANAGED_KIMI_CODE_PROVIDER_ID, model: 'k2', maxContextSize: 200000 },
  ]);
  const remoteGetConfig = vi.fn(async () => ({ providers: {}, defaultModel: 'k2' }));
  const remoteGetUsage = vi.fn(async () => opts.usage);
  const remoteApi = {
    listModels: remoteListModels,
    getConfig: remoteGetConfig,
    getUsage: remoteGetUsage,
  } as unknown as KimiWebApi;
  const routedApi = new Proxy(
    { deviceApi: (hostId: string | undefined) => (hostId === 'ssh-remote' ? remoteApi : clientApiMock) },
    {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        return clientApiMock[prop as string];
      },
    },
  );
  setKimiClientDeps({ api: () => routedApi as unknown as KimiWebApi, t: (key) => key });

  const workspaces = opts.sshBackground === true
    ? [
        { id: 'ws-remote', root: '/remote/workspace', name: 'Remote', sessionCount: 1, hostId: 'ssh-remote' },
        { id: 'ws-local', root: '/workspace', name: 'Local', sessionCount: 1 },
      ]
    : [{ id: 'ws1', root: '/workspace', name: 'Workspace', sessionCount: 2 }];
  const localModels = opts.sshBackground === true
    ? [{ id: 'local-custom', provider: 'custom-openai', model: 'local-custom', maxContextSize: 128000 }]
    : [{ id: 'k2', provider: MANAGED_KIMI_CODE_PROVIDER_ID, model: 'k2', maxContextSize: 200000 }];
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
    getConfig: vi.fn(async () => ({
      providers: {},
      defaultModel: opts.sshBackground === true ? 'local-custom' : 'k2',
    })),
    listModels: vi.fn(async () => localModels),
    listProviders: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => workspaces),
    getWorkspaceTrust: vi.fn(async () => ({ trusted: opts.trusted ?? true })),
    getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
    listSessions: vi.fn(async () => ({ items: sessions, hasMore: false, nextPageToken: null, total: sessions.length })),
    listSessionGroups: vi.fn(async () => ({
      groups: workspaces.map((w) => ({
        workspaceId: w.id,
        sessions: sessions.filter((s) => (s.workspaceId ?? 'ws1') === w.id).map((s) => ({ ...s, lastPrompt: 'hi' })),
        total: sessions.length,
      })),
      hasMore: false,
      nextPageToken: null,
      total: sessions.length,
    })),
    updateSession: vi.fn(async (id: string, patch: { model?: string }) => {
      const target = sessions.find((s) => s.id === id);
      if (target !== undefined && patch.model !== undefined) target.model = patch.model;
      return target ?? clientSession(id);
    }),
    getSession: vi.fn(async (id: string) => sessions.find((s) => s.id === id) ?? clientSession(id)),
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
  const { useQuotaAutoResume } = await import('@moonshot-ai/app-core/composables');
  const { modelsStore } = await import('../src/stores/models');
  const { promptStore } = await import('../src/stores/prompt');
  const { sessionsStore } = await import('../src/stores/sessions');
  const { warningsStore } = await import('../src/stores/warnings');
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
    sessions,
    getUsage,
    remoteGetUsage,
    remoteListModels,
    getAgentTurns,
    releaseTurnLookups: () => {
      for (const release of pendingTurnLookups.splice(0)) release();
    },
    submitPrompt,
    startLiveTurn,
    failLiveTurn,
    setAgentStatus,
    removeTurns,
    deleteSession,
    useQuotaAutoResume,
    modelsStore: modelsStore(),
    promptStore: promptStore(),
    sessionsStore: sessionsStore(),
    warningsStore: warningsStore(),
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

describe('useQuotaAutoResume cross-tab storage sync', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('disables the switch in other renderers when a storage event reports opt-out or key removal', async () => {
    stubStorage({ [STORAGE_KEYS.quotaAutoResume]: 'true' });
    const listeners = new Set<(event: { key: string | null; newValue: string | null }) => void>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event: { key: string | null; newValue: string | null }) => void) => {
        if (type === 'storage') listeners.add(listener);
      }),
      removeEventListener: vi.fn(),
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    vi.resetModules();
    const { useQuotaAutoResume } = await import('@moonshot-ai/app-core/composables');
    const { quotaAutoResumeEnabled } = useQuotaAutoResume();
    expect(quotaAutoResumeEnabled.value).toBe(true);

    for (const listener of listeners) listener({ key: STORAGE_KEYS.quotaAutoResume, newValue: 'false' });
    expect(quotaAutoResumeEnabled.value).toBe(false);

    for (const listener of listeners) listener({ key: STORAGE_KEYS.quotaAutoResume, newValue: 'true' });
    expect(quotaAutoResumeEnabled.value).toBe(true);

    for (const listener of listeners) listener({ key: STORAGE_KEYS.quotaAutoResume, newValue: null });
    expect(quotaAutoResumeEnabled.value).toBe(false);
  });
});

describe('useKimiWebClient quota auto-resume edge cases', () => {
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

  it('routes quota and model checks through the failed SSH session host while viewing a local workspace', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const h = await bootClient({
      enabled: true,
      sshBackground: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    await flushAsync();
    h.startLiveTurn('s1', 't-ssh');
    await flushAsync();
    await h.client.selectSession('s2');
    expect(h.modelsStore.activeHostId).toBeUndefined();

    h.failLiveTurn('s1', 't-ssh');
    await flushAsync();
    expect(h.remoteListModels).toHaveBeenCalled();
    expect(h.remoteGetUsage).toHaveBeenCalledTimes(1);
    expect(h.getUsage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(h.remoteGetUsage).toHaveBeenCalledTimes(1);
    expect(h.getUsage).not.toHaveBeenCalled();
    expect(h.submitPrompt).toHaveBeenCalledTimes(1);
    expect(h.submitPrompt.mock.calls[0]![0]).toBe('s1');
  });

  it('does not resume if the session switched to a custom model while waiting or during turn lookup', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const h = await bootClient({
      enabled: true,
      deferTurns: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    h.modelsStore.setModels([
      { id: 'k2', provider: MANAGED_KIMI_CODE_PROVIDER_ID, model: 'k2', maxContextSize: 200000 },
      { id: 'local-custom', provider: 'custom-openai', model: 'local-custom', maxContextSize: 128000 },
    ]);
    h.startLiveTurn('s1', 't1');
    h.failLiveTurn('s1', 't1');
    await flushAsync();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(h.getAgentTurns).toHaveBeenCalledTimes(1);
    h.sessionsStore.updateSession('s1', (s) => ({ ...s, model: 'local-custom' }));
    h.releaseTurnLookups();
    await flushAsync();
    expect(h.submitPrompt).not.toHaveBeenCalled();
  });

  it('cancels immediately on model profile updates while waiting', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const h = await bootClient({
      enabled: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    h.modelsStore.setModels([
      { id: 'k2', provider: MANAGED_KIMI_CODE_PROVIDER_ID, model: 'k2', maxContextSize: 200000 },
      { id: 'local-custom', provider: 'custom-openai', model: 'local-custom', maxContextSize: 128000 },
    ]);
    h.startLiveTurn('s1', 't1');
    h.failLiveTurn('s1', 't1');
    await flushAsync();

    await h.client.setSessionModel('s1', 'local-custom');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(h.getAgentTurns).not.toHaveBeenCalled();
    expect(h.submitPrompt).not.toHaveBeenCalled();
  });

  it('rechecks session activity after the turn lookup and cancels on manual prompt initiation', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const racing = await bootClient({
      enabled: true,
      deferTurns: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    racing.startLiveTurn('s1', 't1');
    racing.failLiveTurn('s1', 't1');
    await flushAsync();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(racing.getAgentTurns).toHaveBeenCalledTimes(1);
    racing.promptStore.setInFlight('s1', true);
    racing.releaseTurnLookups();
    await flushAsync();
    expect(racing.submitPrompt).not.toHaveBeenCalled();

    vi.resetModules();
    const manual = await bootClient({
      enabled: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    manual.startLiveTurn('s1', 't1');
    manual.failLiveTurn('s1', 't1');
    await flushAsync();

    await manual.client.sendPrompt({ text: 'manual continue', attachments: [], skills: [] });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    const autoCalls = manual.submitPrompt.mock.calls.filter(
      ([, input]) => input.metadata?.['kimi_quota_auto_resume'] !== undefined,
    );
    expect(autoCalls).toHaveLength(0);
  });

  it('shows an error notice when all auto-resume retries fail', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const h = await bootClient({
      enabled: true,
      failSubmits: 10,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    h.startLiveTurn('s1', 't1');
    h.failLiveTurn('s1', 't1');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    for (const delay of QUOTA_AUTO_RESUME_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(h.submitPrompt).toHaveBeenCalledTimes(1 + QUOTA_AUTO_RESUME_RETRY_DELAYS_MS.length);
    const promptIds = new Set(h.submitPrompt.mock.calls.map(([, input]) => input.promptId));
    expect(promptIds.size).toBe(1);
    expect(
      h.warningsStore.warnings.some((notice) => notice.title === 'conversation.quotaAutoResumeFailedTitle'),
    ).toBe(true);
  });
});

describe('quotaAutoContinue card view and preference wiring', () => {
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

  it('hides the inline toggle when the lab gate is off, the model is custom, or the failure is not a quota error', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const labOff = await bootClient({
      enabled: false,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    labOff.startLiveTurn('s1', 't1');
    labOff.failLiveTurn('s1', 't1');
    await flushAsync();
    expect(labOff.client.quotaAutoContinueFor('s1', labOff.client.activeTurnError.value)).toBeNull();

    vi.resetModules();
    const custom = await bootClient({
      enabled: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    custom.modelsStore.setModels([
      { id: 'local-custom', provider: 'custom-openai', model: 'local-custom', maxContextSize: 128000 },
    ]);
    custom.sessionsStore.updateSession('s1', (s) => ({ ...s, model: 'local-custom' }));
    custom.startLiveTurn('s1', 't1');
    custom.failLiveTurn('s1', 't1');
    await flushAsync();
    expect(custom.client.quotaAutoContinueFor('s1', custom.client.activeTurnError.value)).toBeNull();

    vi.resetModules();
    const nonQuota = await bootClient({
      enabled: true,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    nonQuota.startLiveTurn('s1', 't1');
    nonQuota.failLiveTurn('s1', 't1', { code: 'provider.api_error', status_code: 500, message: 'Internal error' });
    await flushAsync();
    expect(nonQuota.client.quotaAutoContinueFor('s1', nonQuota.client.activeTurnError.value)).toBeNull();
    expect(
      nonQuota.client.quotaAutoContinueFor('s1', {
        code: 'provider.auth_error',
        statusCode: 403,
        message: QUOTA_403.message,
        endReason: 'user_cancelled',
      }),
    ).toBeNull();
  });

  it('arms an already-failed quota card and shows resetAt when turned on, and cancels pending immediately when turned off', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const h = await bootClient({
      enabled: true,
      autoContinue: false,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    h.startLiveTurn('s1', 't1');
    h.failLiveTurn('s1', 't1');
    await flushAsync();
    expect(h.getUsage).not.toHaveBeenCalled();
    expect(h.client.quotaAutoContinueFor('s1', h.client.activeTurnError.value)).toEqual({
      enabled: false,
      resetAt: null,
    });

    h.client.setQuotaAutoContinuePreference(true, 's1');
    await flushAsync();
    expect(h.getUsage).toHaveBeenCalledTimes(1);
    expect(h.client.quotaAutoContinueFor('s1', h.client.activeTurnError.value)).toEqual({
      enabled: true,
      resetAt,
    });

    h.client.setQuotaAutoContinuePreference(false, 's1');
    await flushAsync();
    expect(h.client.quotaAutoContinueFor('s1', h.client.activeTurnError.value)).toEqual({
      enabled: false,
      resetAt: null,
    });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(h.submitPrompt).not.toHaveBeenCalled();
  });

  it('prioritizes the session whose card enabled auto-continue under the global keep-first guard', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const h = await bootClient({
      enabled: true,
      autoContinue: false,
      usage: quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
    });
    h.startLiveTurn('s1', 't1');
    h.failLiveTurn('s1', 't1');
    await h.client.selectSession('s2');
    await vi.waitFor(() => expect(h.client.sessionLoading.value).toBe(false));
    h.startLiveTurn('s2', 't2');
    h.failLiveTurn('s2', 't2');
    await flushAsync();

    h.client.setQuotaAutoContinuePreference(true, 's1');
    await flushAsync();
    expect(h.getUsage).toHaveBeenCalledTimes(1);
    expect(h.client.quotaAutoContinueFor('s1', h.client.activeTurnError.value)?.resetAt).toBe(resetAt);
    expect(h.client.quotaAutoContinueFor('s2', h.client.activeTurnError.value)?.resetAt).toBeNull();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15_000);
    expect(h.submitPrompt).toHaveBeenCalledTimes(1);
    expect(h.submitPrompt.mock.calls[0]![0]).toBe('s1');
  });
});

describe('useQuotaAutoResume auto-continue preference storage sync', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('defaults auto-continue to on and syncs cross-tab opt-out, opt-in, and key removal', async () => {
    stubStorage();
    const listeners = new Set<(event: { key: string | null; newValue: string | null }) => void>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event: { key: string | null; newValue: string | null }) => void) => {
        if (type === 'storage') listeners.add(listener);
      }),
      removeEventListener: vi.fn(),
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    vi.resetModules();
    const { useQuotaAutoResume } = await import('@moonshot-ai/app-core/composables');
    const { quotaAutoResumeEnabled, quotaAutoContinueEnabled } = useQuotaAutoResume();
    expect(quotaAutoResumeEnabled.value).toBe(false);
    expect(quotaAutoContinueEnabled.value).toBe(true);

    for (const listener of listeners) listener({ key: STORAGE_KEYS.quotaAutoContinue, newValue: 'false' });
    expect(quotaAutoContinueEnabled.value).toBe(false);

    for (const listener of listeners) listener({ key: STORAGE_KEYS.quotaAutoContinue, newValue: 'true' });
    expect(quotaAutoContinueEnabled.value).toBe(true);

    for (const listener of listeners) listener({ key: STORAGE_KEYS.quotaAutoContinue, newValue: 'false' });
    for (const listener of listeners) listener({ key: STORAGE_KEYS.quotaAutoContinue, newValue: null });
    expect(quotaAutoContinueEnabled.value).toBe(true);

    for (const listener of listeners) listener({ key: STORAGE_KEYS.quotaAutoContinue, newValue: 'not-json' });
    expect(quotaAutoContinueEnabled.value).toBe(true);
  });
});

describe('createQuotaAutoResume cross-window reservation', () => {
  type WindowListener = (event: { key?: string | null; newValue?: string | null }) => void;
  let listeners: Map<string, Set<WindowListener>>;
  let lockTail: Promise<unknown>;

  function emitWindow(type: string, event: { key?: string | null; newValue?: string | null } = {}): void {
    for (const listener of listeners.get(type) ?? []) listener(event);
  }

  function windowRig(resetAt: string) {
    const submitResume = vi.fn(async (_sessionId: string, _input: { turnId: string; resetAt: string | null; promptId: string }) => {});
    const makeTab = (sessionId: string, turnId: string) => {
      let eligible = true;
      const onReservationAvailable = vi.fn(() => {
        if (eligible) controller.handleTurnFailed(sessionId, turnId, QUOTA_403);
      });
      const controller = createQuotaAutoResume({
        enabled: () => true,
        isManagedKimiSession: () => true,
        getUsage: async () => quotaOk({ limit5h: { usedRatio: 1, resetAt } }),
        checkSessionReady: async () => true,
        submitResume,
        onReservationAvailable,
        random: () => 0,
      });
      return {
        controller,
        onReservationAvailable,
        arm: () => controller.handleTurnFailed(sessionId, turnId, QUOTA_403),
        setEligible: (value: boolean) => {
          eligible = value;
        },
      };
    };
    return { makeTab, submitResume };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    stubStorage();
    listeners = new Map();
    lockTail = Promise.resolve();
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: WindowListener) => {
        const set = listeners.get(type) ?? new Set<WindowListener>();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, listener: WindowListener) => {
        listeners.get(type)?.delete(listener);
      },
    });
    vi.stubGlobal('navigator', {
      locks: {
        request: <T,>(_name: string, _opts: { mode: string }, fn: () => Promise<T>): Promise<T> => {
          const run = lockTail.then(fn, fn);
          lockTail = run.catch(() => undefined);
          return run;
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('shows the scheduled time only on the window holding the reservation and fires only that session', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const { makeTab, submitResume } = windowRig(resetAt);
    const tabA = makeTab('s1', 't1');
    const tabB = makeTab('s2', 't2');

    tabA.arm();
    await flushAsync();
    tabB.arm();
    await flushAsync();

    expect(tabA.controller.pendingFor('s1', 't1')?.resetAt).toBe(resetAt);
    expect(tabB.controller.pendingFor('s2', 't2')).toBeNull();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    await flushAsync();
    expect(submitResume).toHaveBeenCalledTimes(1);
    expect(submitResume.mock.calls[0]![0]).toBe('s1');
    expect(tabA.controller.pendingFor('s1', 't1')).toBeNull();
    expect(tabB.controller.pendingFor('s2', 't2')).toBeNull();
  });

  it('hands the reservation to a standby window on holder cancellation or pagehide and fires the successor', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const { makeTab, submitResume } = windowRig(resetAt);
    const tabA = makeTab('s1', 't1');
    const tabB = makeTab('s2', 't2');

    tabA.arm();
    await flushAsync();
    tabB.arm();
    await flushAsync();
    expect(tabA.controller.pendingFor('s1', 't1')?.resetAt).toBe(resetAt);
    expect(tabB.controller.pendingFor('s2', 't2')).toBeNull();

    tabA.setEligible(false);
    tabA.controller.cancelSession('s1');
    expect(tabA.controller.pendingFor('s1', 't1')).toBeNull();
    emitWindow('storage', { key: STORAGE_KEYS.quotaAutoResumeReservation, newValue: null });
    await flushAsync();

    expect(tabB.onReservationAvailable).toHaveBeenCalled();
    expect(tabB.controller.pendingFor('s2', 't2')?.resetAt).toBe(resetAt);

    const tabC = makeTab('s3', 't3');
    tabC.arm();
    await flushAsync();
    expect(tabC.controller.pendingFor('s3', 't3')).toBeNull();

    tabB.setEligible(false);
    emitWindow('pagehide');
    emitWindow('storage', { key: STORAGE_KEYS.quotaAutoResumeReservation, newValue: null });
    await flushAsync();
    expect(tabB.controller.pendingFor('s2', 't2')).toBeNull();
    expect(tabC.controller.pendingFor('s3', 't3')?.resetAt).toBe(resetAt);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    await flushAsync();
    expect(submitResume).toHaveBeenCalledTimes(1);
    expect(submitResume.mock.calls[0]![0]).toBe('s3');
  });

  it('takes over an expired lease from a crashed window without firing the dead session', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    safeSetJson(STORAGE_KEYS.quotaAutoResumeReservation, {
      ownerId: 'crashed-window',
      sessionId: 's-dead',
      failedTurnId: 't-dead',
      resetAt,
      expiresAt: BASE_MS + QUOTA_AUTO_RESUME_RESERVATION_LEASE_MS,
    });
    const { makeTab, submitResume } = windowRig(resetAt);
    const tabB = makeTab('s2', 't2');

    tabB.arm();
    await flushAsync();
    expect(tabB.controller.pendingFor('s2', 't2')).toBeNull();

    await vi.advanceTimersByTimeAsync(QUOTA_AUTO_RESUME_RESERVATION_LEASE_MS + 1_000);
    await flushAsync();
    expect(tabB.onReservationAvailable).toHaveBeenCalled();
    expect(tabB.controller.pendingFor('s2', 't2')?.resetAt).toBe(resetAt);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    await flushAsync();
    expect(submitResume).toHaveBeenCalledTimes(1);
    expect(submitResume.mock.calls[0]![0]).toBe('s2');
  });

  it('drops a stale holder display when another window claimed the lease during sleep', async () => {
    const resetAt = new Date(BASE_MS + 60 * 60 * 1000).toISOString();
    const { makeTab, submitResume } = windowRig(resetAt);
    const tabA = makeTab('s1', 't1');
    tabA.arm();
    await flushAsync();
    expect(tabA.controller.pendingFor('s1', 't1')?.resetAt).toBe(resetAt);

    safeSetJson(STORAGE_KEYS.quotaAutoResumeReservation, {
      ownerId: 'other-window',
      sessionId: 's2',
      failedTurnId: 't2',
      resetAt,
      expiresAt: BASE_MS + 2 * 60 * 60 * 1000,
    });
    emitWindow('storage', {
      key: STORAGE_KEYS.quotaAutoResumeReservation,
      newValue: globalThis.localStorage.getItem(STORAGE_KEYS.quotaAutoResumeReservation),
    });
    await flushAsync();
    expect(tabA.controller.pendingFor('s1', 't1')).toBeNull();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + QUOTA_AUTO_RESUME_MIN_JITTER_MS);
    await flushAsync();
    expect(submitResume).not.toHaveBeenCalled();
  });
});
