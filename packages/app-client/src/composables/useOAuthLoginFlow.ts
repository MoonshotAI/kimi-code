// packages/app-client/src/composables/useOAuthLoginFlow.ts
// Shared device-code OAuth login state machine, used by both the standalone
// LoginDialog and the onboarding wizard's embedded login step. Owns the flow
// lifecycle (start → poll → terminal), the countdown, and the timers; the
// components own layout and copy.
//
// Polling here does NOT drive the protocol — the daemon polls the OAuth host
// internally; we only ask it for the flow snapshot at the server-suggested
// interval. A single null poll can be a transient blip; several in a row
// means the daemon is gone, so we stop instead of stranding the user on
// "waiting for authorization".

import { getCurrentScope, onScopeDispose, ref } from 'vue';

import { track } from '../contracts';

export type OAuthLoginStep = 'starting' | 'device-code' | 'success' | 'expired' | 'error';

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

export interface OAuthLoginFlowCallbacks {
  onStartOAuthLogin: () => Promise<OAuthLoginStartResult | null>;
  onPollOAuthLogin: () => Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null>;
  onCancelOAuthLogin: () => Promise<void>;
}

export interface UseOAuthLoginFlowOptions extends OAuthLoginFlowCallbacks {
  /** Invoked once the flow reaches the authenticated state (after the brief
      success dwell — shorter for the already-authenticated fast path). */
  onSuccess?: () => void;
}

const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export function useOAuthLoginFlow(options: UseOAuthLoginFlowOptions) {
  const step = ref<OAuthLoginStep>('starting');
  // True when the error step came from repeated poll failures (daemon gone)
  // rather than startOAuthLogin failing (unsupported endpoint) — picks the copy.
  const pollError = ref(false);
  const flow = ref<OAuthFlowData | null>(null);
  const secondsLeft = ref(0);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let successTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutivePollFailures = 0;
  // startFlow timestamp — every stage report carries the elapsed duration.
  let flowStartedAt = 0;
  // Guards against duplicate cancels when cancelFlow fires twice for the same
  // pending flow (the step stays 'device-code' until the daemon confirms).
  let flowCancelled = false;
  // Set on scope dispose. The in-flight start/poll awaits check it before
  // touching state or starting new timers — once the component is gone,
  // anything they would surface is an orphan nobody can see or stop.
  let disposed = false;

  function stopTimers(): void {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (successTimer) { clearTimeout(successTimer); successTimer = null; }
  }

  function reachSuccess(dwellMs: number): void {
    stopTimers();
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
    }, dwellMs);
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

  function scheduleNextPoll(intervalSec: number): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      const result = await options.onPollOAuthLogin();
      if (disposed) return;
      // A user-initiated cancel is terminal; a poll already in flight when it
      // lands must not double-report or silently resume polling.
      if (flowCancelled) return;
      if (result === null) {
        // Poll failed (or no active flow). Keep polling through transient
        // blips, but give up with an explicit error after several in a row.
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          stopTimers();
          pollError.value = true;
          step.value = 'error';
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
      } else if (result.status === 'expired' || result.status === 'cancelled') {
        stopTimers();
        step.value = 'expired';
        track('oauth_login_step', {
          stage: 'expired',
          ok: false,
          method: 'oauth',
          duration_ms: Date.now() - flowStartedAt,
          error_class: result.status === 'cancelled' ? 'cancelled' : 'expired',
        });
      } else {
        // pending — keep polling
        scheduleNextPoll(intervalSec);
      }
    }, intervalSec * 1000);
  }

  async function startFlow(): Promise<void> {
    stopTimers();
    flow.value = null;
    pollError.value = false;
    consecutivePollFailures = 0;
    flowCancelled = false;
    flowStartedAt = Date.now();
    step.value = 'starting';
    track('oauth_login_step', { stage: 'starting', method: 'oauth', duration_ms: 0 });

    const result = await options.onStartOAuthLogin();
    if (disposed) {
      // Dismissed while the start request was in flight: don't surface (and
      // poll) a flow nobody can see — cancel it on the daemon so it can't
      // keep polling or interfere with the next login attempt.
      if (result !== null && result.status !== 'authenticated') {
        void options.onCancelOAuthLogin();
      }
      return;
    }
    if (!result) {
      step.value = 'error';
      track('oauth_login_step', {
        stage: 'error',
        ok: false,
        method: 'oauth',
        duration_ms: Date.now() - flowStartedAt,
        error_class: 'start_failed',
      });
      return;
    }

    // Already-authenticated fast path: the server had a usable cached token and
    // did not issue a device code. Skip the device-code UI entirely and surface
    // the success state — the poller is irrelevant here.
    if (result.status === 'authenticated') {
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
    startCountdown();
    scheduleNextPoll(result.interval);
  }

  /** Best-effort cancel of a pending flow (dialog closed mid-wait, wizard
      skipped). A flow that already reached success is left untouched: the
      daemon has authenticated, and the still-pending onSuccess delivery is
      what makes the parent refresh auth — dismissing in that window must not
      swallow it (the UI would stay logged-out until a manual refresh). */
  function cancelFlow(): void {
    if (step.value === 'success') return;
    stopTimers();
    if (step.value === 'device-code' && !flowCancelled) {
      flowCancelled = true;
      // The user-initiated cancel is the flow's terminal state: our own timers
      // are stopped, so the poller will never observe the daemon's 'cancelled'.
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

  // Unmount cleans up via cancelFlow: timers stop, and a pending device-code
  // flow is cancelled on the daemon too — nobody can show the code anymore,
  // and leaving it would keep the daemon polling (and could still log the
  // user in after they explicitly skipped the wizard's login step). The
  // disposed flag covers awaits still in flight at this moment.
  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      cancelFlow();
    });
  }

  return { step, pollError, flow, secondsLeft, startFlow, cancelFlow };
}
