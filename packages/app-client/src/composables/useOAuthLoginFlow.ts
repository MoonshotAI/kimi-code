
import { getCurrentScope, onScopeDispose, ref } from 'vue';

import { track } from '../contracts';
import type { OAuthAutoOpenDriver } from '../lib/oauthAutoOpen';
import type { OAuthAuthWakeDriver } from '../lib/oauthAuthWake';
import type { OAuthRegion } from '@moonshot-ai/app-core/api';

export type { OAuthRegion };

export type OAuthLoginStep = 'starting' | 'device-code' | 'success' | 'denied' | 'expired' | 'error';

export interface OAuthFlowData {
  flowId: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export type OAuthLoginStartResult =
  | ({ flowId: string; provider: string; status: 'pending' } & Omit<OAuthFlowData, 'flowId'> & {
        expiresAt: string;
      })
  | { flowId: string; provider: string; status: 'authenticated' };

export interface OAuthLoginStartError {
  error: string;
}

export interface OAuthLoginFlowCallbacks {
  onStartOAuthLogin: (region?: OAuthRegion) => Promise<OAuthLoginStartResult | OAuthLoginStartError | null>;
  onPollOAuthLogin: () => Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';
    resolvedAt?: string;
    errorMessage?: string;
  } | null>;
  onCancelOAuthLogin: () => Promise<void>;
}

export interface UseOAuthLoginFlowOptions extends OAuthLoginFlowCallbacks {
  onSuccess?: () => void;
  successDwellMs?: number;
  autoOpen?: OAuthAutoOpenDriver;
  authWake?: OAuthAuthWakeDriver;
}

const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export function useOAuthLoginFlow(options: UseOAuthLoginFlowOptions) {
  const step = ref<OAuthLoginStep>('starting');
  const pollError = ref(false);
  const errorMessage = ref<string | null>(null);
  const flow = ref<OAuthFlowData | null>(null);
  const secondsLeft = ref(0);
  const autoOpenBlocked = ref(false);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let successTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutivePollFailures = 0;
  let flowStartedAt = 0;
  let flowCancelled = false;
  let activeRegion: OAuthRegion | undefined;
  let pollInFlight = false;
  let wakeUnsubscribe: (() => void) | null = null;
  let disposed = false;

  function stopTimers(): void {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (successTimer) { clearTimeout(successTimer); successTimer = null; }
  }

  function reachSuccess(dwellMs: number): void {
    stopTimers();
    dropAuthWake();
    step.value = 'success';
    track('oauth_login_step', {
      stage: 'success',
      ok: true,
      method: 'oauth',
      duration_ms: Date.now() - flowStartedAt,
    });
    successTimer = setTimeout(() => {
      successTimer = null;
      options.onSuccess?.();
    }, options.successDwellMs ?? dwellMs);
  }

  function startCountdown(): void {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      if (secondsLeft.value > 0) {
        secondsLeft.value--;
      } else {
        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = null;
      }
    }, 1000);
  }

  function dropAuthWake(): void {
    wakeUnsubscribe?.();
    wakeUnsubscribe = null;
  }

  async function runPollOnce(intervalSec: number): Promise<void> {
    pollInFlight = true;
    try {
      const result = await options.onPollOAuthLogin();
      if (disposed) return;
      if (flowCancelled) return;
      if (result === null) {
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          stopTimers();
          dropAuthWake();
          pollError.value = true;
          step.value = 'error';
          options.autoOpen?.settle(false, { keepNavigated: true });
          track('oauth_login_step', {
            stage: 'error',
            ok: false,
            method: 'oauth',
            duration_ms: Date.now() - flowStartedAt,
            error_class: 'poll_failed',
          });
          return;
        }
        scheduleNextPoll(intervalSec);
        return;
      }
      consecutivePollFailures = 0;
      if (result.status === 'authenticated') {
        reachSuccess(1200);
      } else if (result.status === 'denied') {
        stopTimers();
        dropAuthWake();
        step.value = 'denied';
        options.autoOpen?.settle(false);
        track('oauth_login_step', {
          stage: 'denied',
          ok: false,
          method: 'oauth',
          duration_ms: Date.now() - flowStartedAt,
          error_class: 'denied',
        });
      } else if (result.status === 'expired' || result.status === 'cancelled') {
        stopTimers();
        dropAuthWake();
        step.value = 'expired';
        options.autoOpen?.settle(false);
        track('oauth_login_step', {
          stage: 'expired',
          ok: false,
          method: 'oauth',
          duration_ms: Date.now() - flowStartedAt,
          error_class: result.status === 'cancelled' ? 'cancelled' : 'expired',
        });
      } else {
        scheduleNextPoll(intervalSec);
      }
    } finally {
      pollInFlight = false;
    }
  }

  function scheduleNextPoll(intervalSec: number): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void runPollOnce(intervalSec);
    }, intervalSec * 1000);
  }

  function pollNow(): void {
    if (step.value !== 'device-code' || flow.value === null) return;
    if (flowCancelled || pollInFlight) return;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    void runPollOnce(flow.value.interval);
  }

  async function startFlow(region?: OAuthRegion): Promise<void> {
    if (region !== undefined) activeRegion = region;
    stopTimers();
    dropAuthWake();
    flow.value = null;
    pollError.value = false;
    errorMessage.value = null;
    consecutivePollFailures = 0;
    flowCancelled = false;
    flowStartedAt = Date.now();
    step.value = 'starting';
    autoOpenBlocked.value = false;
    options.autoOpen?.onGesture?.();
    track('oauth_login_step', { stage: 'starting', method: 'oauth', duration_ms: 0 });

    const result = await options.onStartOAuthLogin(activeRegion);
    if (disposed) {
      if (result !== null && !('error' in result) && result.status !== 'authenticated') {
        void options.onCancelOAuthLogin();
      }
      return;
    }
    if (!result || 'error' in result) {
      errorMessage.value = result !== null && 'error' in result ? result.error : null;
      step.value = 'error';
      options.autoOpen?.settle(false);
      track('oauth_login_step', {
        stage: 'error',
        ok: false,
        method: 'oauth',
        duration_ms: Date.now() - flowStartedAt,
        error_class: 'start_failed',
      });
      return;
    }

    if (result.status === 'authenticated') {
      options.autoOpen?.settle(true);
      reachSuccess(800);
      return;
    }

    flow.value = {
      flowId: result.flowId,
      verificationUri: result.verificationUri,
      verificationUriComplete: result.verificationUriComplete,
      userCode: result.userCode,
      expiresIn: result.expiresIn,
      interval: result.interval,
    };
    secondsLeft.value = result.expiresIn;
    step.value = 'device-code';
    track('oauth_login_step', {
      stage: 'device-code',
      method: 'oauth',
      duration_ms: Date.now() - flowStartedAt,
    });
    if (options.autoOpen) {
      const opened = options.autoOpen.openUrl(result.verificationUriComplete, result.flowId);
      if (opened === false) {
        autoOpenBlocked.value = true;
      } else if (opened instanceof Promise) {
        const flowId = result.flowId;
        void opened.then((ok) => {
          if (!ok && !disposed && flow.value?.flowId === flowId) {
            autoOpenBlocked.value = true;
          }
        });
      }
    }
    startCountdown();
    scheduleNextPoll(result.interval);
    wakeUnsubscribe = options.authWake?.subscribe(pollNow) ?? null;
  }

  function cancelFlow(): void {
    if (step.value === 'success') return;
    stopTimers();
    dropAuthWake();
    options.autoOpen?.settle(false);
    if (step.value === 'device-code' && !flowCancelled) {
      flowCancelled = true;
      track('oauth_login_step', {
        stage: 'expired',
        ok: false,
        method: 'oauth',
        duration_ms: Date.now() - flowStartedAt,
        error_class: 'cancelled',
      });
      void options.onCancelOAuthLogin();
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      cancelFlow();
    });
  }

  return { step, pollError, flow, secondsLeft, autoOpenBlocked, errorMessage, startFlow, cancelFlow, pollNow };
}
