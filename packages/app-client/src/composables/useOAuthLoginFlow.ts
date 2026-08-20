// packages/app-client/src/composables/useOAuthLoginFlow.ts
// Shared device-code OAuth login state machine, used by both the standalone
// LoginDialog and the onboarding wizard's embedded login step. Owns the flow
// lifecycle (start → poll → terminal), the countdown, and the timers; the
// components own layout and copy. An optional `autoOpen` driver (see
// lib/oauthAutoOpen.ts) opens the verification page in the browser as soon as
// its URL arrives, and `autoOpenBlocked` reports a failed automatic open. An
// optional `authWake` driver (see lib/oauthAuthWake.ts) tells the poller the
// user is back from the authorization page (deep link / window focus), so a
// completed login surfaces immediately instead of at the next interval tick.
//
// Polling here does NOT drive the protocol — the daemon polls the OAuth host
// internally; we only ask it for the flow snapshot at the server-suggested
// interval. A single null poll can be a transient blip; several in a row
// means the daemon is gone, so we stop instead of stranding the user on
// "waiting for authorization".

import { getCurrentScope, onScopeDispose, ref } from 'vue';

import { track } from '../contracts';
import type { OAuthAutoOpenDriver } from '../lib/oauthAutoOpen';
import type { OAuthAuthWakeDriver } from '../lib/oauthAuthWake';
import type { OAuthRegion } from '@moonshot-ai/app-core/api';

export type { OAuthRegion };

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
  /** `region` pins the OAuth host region for the flow (the login UI offers one
      card per region); undefined lets the daemon resolve it itself. */
  onStartOAuthLogin: (region?: OAuthRegion) => Promise<OAuthLoginStartResult | null>;
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
  /** Auto-opens the verification page as soon as its URL arrives (browser tab
      on web, system browser on desktop). Without a driver the waiting page's
      manual link stays the only path. */
  autoOpen?: OAuthAutoOpenDriver;
  /** Wake signals meaning "the user is back from the authorization page"
      (deep link / window focus). The composable subscribes while a
      device-code flow waits and polls immediately on each wake instead of
      waiting out the current interval. */
  authWake?: OAuthAuthWakeDriver;
}

const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export function useOAuthLoginFlow(options: UseOAuthLoginFlowOptions) {
  const step = ref<OAuthLoginStep>('starting');
  // True when the error step came from repeated poll failures (daemon gone)
  // rather than startOAuthLogin failing (unsupported endpoint) — picks the copy.
  const pollError = ref(false);
  const flow = ref<OAuthFlowData | null>(null);
  const secondsLeft = ref(0);
  // True when the auto-open driver could not deliver the verification URL
  // (popup blocked, tab closed, bridge missing) — the waiting page then
  // surfaces a prominent manual-open button.
  const autoOpenBlocked = ref(false);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let successTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutivePollFailures = 0;
  // startFlow timestamp — every stage report carries the elapsed duration.
  let flowStartedAt = 0;
  // Guards against duplicate cancels when cancelFlow fires twice for the same
  // pending flow (the step stays 'device-code' until the daemon confirms).
  let flowCancelled = false;
  // Region picked on the choice cards; a retry (startFlow with no argument)
  // restarts the flow against the same region.
  let activeRegion: OAuthRegion | undefined;
  // True while a poll request is awaiting the daemon — the wake path
  // (pollNow) dedupes against it so a wake storm can't stack up requests.
  let pollInFlight = false;
  // Unsubscribe of the live auth-wake subscription; non-null only while a
  // device-code flow waits. Every terminal path and cancelFlow drops it.
  let wakeUnsubscribe: (() => void) | null = null;
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

  function dropAuthWake(): void {
    wakeUnsubscribe?.();
    wakeUnsubscribe = null;
  }

  /** One poll round: ask the daemon for the flow snapshot, then act on it —
      reschedule on pending, settle on a terminal status. Shared by the
      interval timer (scheduleNextPoll) and the wake path (pollNow). */
  async function runPollOnce(intervalSec: number): Promise<void> {
    pollInFlight = true;
    try {
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
          dropAuthWake();
          pollError.value = true;
          step.value = 'error';
          // The daemon being unreachable says nothing about the auth site —
          // the user may be mid-authorization (password, MFA) in the
          // auto-opened tab, so keep a navigated page open; only a blank
          // placeholder gets cleaned up.
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
        // pending — keep polling
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

  /** Wake path (authWake driver): the user is back from the authorization
      page, so poll now instead of finishing out the current interval. Only
      meaningful while a device-code flow is live — every other step has no
      pending snapshot to fetch. A poll already in flight dedupes the wake. */
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
    consecutivePollFailures = 0;
    flowCancelled = false;
    flowStartedAt = Date.now();
    step.value = 'starting';
    autoOpenBlocked.value = false;
    // Still inside the click gesture (startFlow is only ever invoked from a
    // click handler) — the web driver must open its placeholder tab now,
    // before the popup blocker's transient activation expires.
    options.autoOpen?.onGesture?.();
    track('oauth_login_step', { stage: 'starting', method: 'oauth', duration_ms: 0 });

    const result = await options.onStartOAuthLogin(activeRegion);
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

    // Already-authenticated fast path: the server had a usable cached token and
    // did not issue a device code. Skip the device-code UI entirely and surface
    // the success state — the poller is irrelevant here.
    if (result.status === 'authenticated') {
      // No verification URL ever arrives — close the blank placeholder tab.
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
    // Auto-open the verification page on every flow arrival — the drivers own
    // idempotence (web navigates/focuses its placeholder per URL; desktop
    // opens the system browser once per flow id), so a retry that re-issues
    // the same flow still navigates the fresh placeholder tab. The desktop
    // driver's delivery failure arrives asynchronously (the bridge call
    // rejects after openUrl returned) — flip the blocked state when it lands,
    // but only if this flow is still the live one.
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
    // The wake subscription lives exactly as long as the device-code wait —
    // every terminal branch, cancelFlow, and a restart drop it again.
    wakeUnsubscribe = options.authWake?.subscribe(pollNow) ?? null;
  }

  /** Best-effort cancel of a pending flow (dialog closed mid-wait, wizard
      skipped). A flow that already reached success is left untouched: the
      daemon has authenticated, and the still-pending onSuccess delivery is
      what makes the parent refresh auth — dismissing in that window must not
      swallow it (the UI would stay logged-out until a manual refresh). */
  function cancelFlow(): void {
    if (step.value === 'success') return;
    stopTimers();
    dropAuthWake();
    // Dismissed mid-wait (dialog closed, wizard skipped): close the auto-opened
    // tab too — the flow behind it is dead.
    options.autoOpen?.settle(false);
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

  return { step, pollError, flow, secondsLeft, autoOpenBlocked, startFlow, cancelFlow, pollNow };
}
