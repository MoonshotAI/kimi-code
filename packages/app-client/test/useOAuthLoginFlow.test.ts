import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, type EffectScope } from 'vue';
import {
  useOAuthLoginFlow,
  type OAuthLoginFlowCallbacks,
  type OAuthLoginStartResult,
} from '../src/composables/useOAuthLoginFlow';
import type { OAuthAutoOpenDriver } from '../src/lib/oauthAutoOpen';
import { noopProductTracker, setProductTracker } from '../src/contracts';

const pendingStart: OAuthLoginStartResult = {
  flowId: 'oauth_1',
  provider: 'kimi-code',
  status: 'pending',
  verificationUri: 'https://example.com/device',
  verificationUriComplete: 'https://example.com/device?code=ABCD',
  userCode: 'ABCD-EFGH',
  expiresIn: 900,
  interval: 5,
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
};

function makeCallbacks(over: Partial<OAuthLoginFlowCallbacks> = {}) {
  return {
    onStartOAuthLogin: vi.fn(async () => pendingStart),
    onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'pending' as const })),
    onCancelOAuthLogin: vi.fn(async () => {}),
    ...over,
  };
}

describe('useOAuthLoginFlow', () => {
  let scope: EffectScope;

  beforeEach(() => {
    vi.useFakeTimers();
    scope = effectScope();
  });

  afterEach(() => {
    scope.stop();
    vi.useRealTimers();
  });

  it('enters the device-code step with flow data after a pending start', async () => {
    const callbacks = makeCallbacks();
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;
    expect(flow.step.value).toBe('starting');

    await flow.startFlow();
    expect(flow.step.value).toBe('device-code');
    expect(flow.flow.value?.userCode).toBe('ABCD-EFGH');
    expect(flow.secondsLeft.value).toBe(900);
  });

  it('takes the already-authenticated fast path and reports success after a short dwell', async () => {
    const onSuccess = vi.fn();
    const callbacks = makeCallbacks({
      onStartOAuthLogin: vi.fn(async () => ({
        flowId: 'oauth_1',
        provider: 'kimi-code',
        status: 'authenticated' as const,
      })),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, onSuccess }))!;

    await flow.startFlow();
    expect(flow.step.value).toBe('success');
    expect(onSuccess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error when start fails', async () => {
    const callbacks = makeCallbacks({ onStartOAuthLogin: vi.fn(async () => null) });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;

    await flow.startFlow();
    expect(flow.step.value).toBe('error');
    expect(flow.pollError.value).toBe(false);
  });

  it('polls at the server interval and succeeds when the flow authenticates', async () => {
    const onSuccess = vi.fn();
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'authenticated' as const })),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, onSuccess }))!;

    await flow.startFlow();
    expect(flow.step.value).toBe('device-code');

    await vi.advanceTimersByTimeAsync(5000);
    expect(flow.step.value).toBe('success');
    await vi.advanceTimersByTimeAsync(1200);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('moves to expired when the poll reports expiry', async () => {
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'expired' as const })),
    });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;

    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(flow.step.value).toBe('expired');
  });

  it('tolerates transient poll failures but errors out after three in a row', async () => {
    const callbacks = makeCallbacks({ onPollOAuthLogin: vi.fn(async () => null) });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;

    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(10000); // two failed polls
    expect(flow.step.value).toBe('device-code');
    await vi.advanceTimersByTimeAsync(5000); // third failure
    expect(flow.step.value).toBe('error');
    expect(flow.pollError.value).toBe(true);
  });

  it('cancelFlow issues a best-effort cancel only while waiting on the device code', async () => {
    const callbacks = makeCallbacks();
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;

    await flow.startFlow();
    flow.cancelFlow();
    expect(callbacks.onCancelOAuthLogin).toHaveBeenCalledTimes(1);

    // Already terminal / not in device-code → no further cancel calls.
    flow.cancelFlow();
    expect(callbacks.onCancelOAuthLogin).toHaveBeenCalledTimes(1);
  });

  it('counts down the device-code expiry clock', async () => {
    const callbacks = makeCallbacks();
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;

    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(2000);
    expect(flow.secondsLeft.value).toBe(898);
  });

  it('keeps delivering onSuccess when cancelFlow fires in the success state', async () => {
    const onSuccess = vi.fn();
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'authenticated' as const })),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, onSuccess }))!;

    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(5000); // poll → authenticated
    expect(flow.step.value).toBe('success');

    // Dismiss inside the success dwell: no daemon cancel, no swallowed callback.
    flow.cancelFlow();
    expect(callbacks.onCancelOAuthLogin).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending device-code flow when the owning scope is disposed', async () => {
    const callbacks = makeCallbacks();
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;

    await flow.startFlow();
    expect(flow.step.value).toBe('device-code');

    // Unmount mid-wait (e.g. the wizard was skipped): the daemon flow is cancelled.
    scope.stop();
    expect(callbacks.onCancelOAuthLogin).toHaveBeenCalledTimes(1);
  });

  it('still delivers onSuccess when the scope is disposed in the success state', async () => {
    const onSuccess = vi.fn();
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'authenticated' as const })),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, onSuccess }))!;

    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(flow.step.value).toBe('success');

    scope.stop();
    await vi.advanceTimersByTimeAsync(1200);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('cancels the flow on the daemon when disposed while the start request is in flight', async () => {
    let resolveStart: (value: OAuthLoginStartResult) => void = () => {};
    const callbacks = makeCallbacks({
      onStartOAuthLogin: vi.fn(
        () => new Promise<OAuthLoginStartResult>((resolve) => { resolveStart = resolve; }),
      ),
    });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;

    const startPromise = flow.startFlow();
    expect(flow.step.value).toBe('starting');
    scope.stop(); // unmount mid-start

    resolveStart(pendingStart);
    await startPromise;
    // The freshly issued pending flow is cancelled on the daemon and never
    // surfaces as an orphan device-code UI with its own polling.
    expect(callbacks.onCancelOAuthLogin).toHaveBeenCalledTimes(1);
    expect(flow.step.value).toBe('starting');
    await vi.advanceTimersByTimeAsync(30000);
    expect(callbacks.onPollOAuthLogin).not.toHaveBeenCalled();
  });

  it('stops scheduling polls when disposed while a poll request is in flight', async () => {
    let resolvePoll: (value: { flowId: string; status: 'pending' }) => void = () => {};
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(
        () =>
          new Promise<{ flowId: string; status: 'pending' }>((resolve) => { resolvePoll = resolve; }),
      ),
    });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;

    await flow.startFlow();
    expect(flow.step.value).toBe('device-code');

    await vi.advanceTimersByTimeAsync(5000); // first poll fires; its await is in flight
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(1);
    scope.stop(); // unmount mid-poll — also cancels the daemon flow
    expect(callbacks.onCancelOAuthLogin).toHaveBeenCalledTimes(1);

    resolvePoll({ flowId: 'oauth_1', status: 'pending' });
    await vi.advanceTimersByTimeAsync(30000);
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(1); // no further polls
  });
});

describe('autoOpen driver', () => {
  let scope: EffectScope;

  beforeEach(() => {
    vi.useFakeTimers();
    scope = effectScope();
  });

  afterEach(() => {
    scope.stop();
    vi.useRealTimers();
  });

  function makeDriver(over: Partial<OAuthAutoOpenDriver> = {}) {
    const driver = {
      onGesture: vi.fn(),
      openUrl: vi.fn(() => true),
      settle: vi.fn(),
    };
    Object.assign(driver, over);
    return driver;
  }

  it('opens the verification URL once the flow arrives, gesture first', async () => {
    const order: string[] = [];
    const driver = makeDriver({ onGesture: vi.fn(() => { order.push('gesture'); }) });
    const callbacks = makeCallbacks({
      onStartOAuthLogin: vi.fn(async () => { order.push('start'); return pendingStart; }),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, autoOpen: driver }))!;

    await flow.startFlow();
    // The gesture hook fires before the start request goes out (placeholder
    // tabs must open inside the click's transient activation).
    expect(order).toEqual(['gesture', 'start']);
    expect(driver.openUrl).toHaveBeenCalledTimes(1);
    expect(driver.openUrl).toHaveBeenCalledWith('https://example.com/device?code=ABCD', 'oauth_1');
    expect(flow.autoOpenBlocked.value).toBe(false);
    expect(driver.settle).not.toHaveBeenCalled();
  });

  it('flags autoOpenBlocked when the driver cannot deliver the URL', async () => {
    const driver = makeDriver({ openUrl: vi.fn(() => false) });
    const flow = scope.run(() => useOAuthLoginFlow({ ...makeCallbacks(), autoOpen: driver }))!;

    await flow.startFlow();
    expect(flow.step.value).toBe('device-code');
    expect(flow.autoOpenBlocked.value).toBe(true);
  });

  it('flags autoOpenBlocked when the driver reports delivery failure asynchronously', async () => {
    // The desktop bridge call rejects after openUrl returned — the blocked
    // state flips when the promise lands.
    const driver = makeDriver({ openUrl: vi.fn(() => Promise.resolve(false)) });
    const flow = scope.run(() => useOAuthLoginFlow({ ...makeCallbacks(), autoOpen: driver }))!;

    await flow.startFlow();
    expect(flow.step.value).toBe('device-code');
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.autoOpenBlocked.value).toBe(true);
  });

  it('ignores an asynchronous failure from a superseded flow', async () => {
    // The first flow's bridge call fails after a retry already opened the
    // second flow fine — the stale failure must not flag the new flow.
    let startCall = 0;
    const driver = makeDriver({
      openUrl: vi.fn((url: string, flowId: string) =>
        flowId === 'oauth_1' ? Promise.resolve(false) : Promise.resolve(true)),
    });
    const callbacks = makeCallbacks({
      onStartOAuthLogin: vi.fn(async (): Promise<OAuthLoginStartResult> =>
        ++startCall === 1 ? pendingStart : { ...pendingStart, flowId: 'oauth_2' }),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, autoOpen: driver }))!;

    await flow.startFlow();
    await flow.startFlow(); // retry supersedes oauth_1 with oauth_2
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.flow.value?.flowId).toBe('oauth_2');
    expect(flow.autoOpenBlocked.value).toBe(false);
  });

  it('passes every flow arrival to the driver, even a re-issued flow id', async () => {
    const driver = makeDriver();
    const flow = scope.run(() => useOAuthLoginFlow({ ...makeCallbacks(), autoOpen: driver }))!;

    await flow.startFlow();
    flow.cancelFlow();
    await flow.startFlow(); // the daemon handed back the same flow id
    expect(driver.onGesture).toHaveBeenCalledTimes(2);
    // Both arrivals reach the driver — idempotence lives in the drivers (web
    // must navigate the fresh placeholder, desktop must not re-pop the system
    // browser; both covered in oauthAutoOpen.test.ts).
    expect(driver.openUrl).toHaveBeenCalledTimes(2);
    expect(driver.openUrl).toHaveBeenLastCalledWith(
      'https://example.com/device?code=ABCD',
      'oauth_1',
    );
  });

  it('re-opens on a retry from the expired state (new flow id)', async () => {
    const driver = makeDriver();
    let startCall = 0;
    const callbacks = makeCallbacks({
      onStartOAuthLogin: vi.fn(async (): Promise<OAuthLoginStartResult> =>
        ++startCall === 1 ? pendingStart : { ...pendingStart, flowId: 'oauth_2' }),
      onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'expired' as const })),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, autoOpen: driver }))!;

    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(5000); // poll → expired
    expect(flow.step.value).toBe('expired');
    expect(driver.settle).toHaveBeenCalledWith(false);

    await flow.startFlow(); // the retry button — still inside a click gesture
    expect(flow.step.value).toBe('device-code');
    expect(flow.flow.value?.flowId).toBe('oauth_2');
    expect(driver.onGesture).toHaveBeenCalledTimes(2);
    expect(driver.openUrl).toHaveBeenCalledTimes(2);
    expect(flow.autoOpenBlocked.value).toBe(false);
  });

  it('settles false when the start request fails', async () => {
    const driver = makeDriver();
    const callbacks = makeCallbacks({ onStartOAuthLogin: vi.fn(async () => null) });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, autoOpen: driver }))!;

    await flow.startFlow();
    expect(flow.step.value).toBe('error');
    expect(driver.openUrl).not.toHaveBeenCalled();
    expect(driver.settle).toHaveBeenCalledWith(false);
  });

  it('settles false with keepNavigated after repeated poll failures', async () => {
    const driver = makeDriver();
    const callbacks = makeCallbacks({ onPollOAuthLogin: vi.fn(async () => null) });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, autoOpen: driver }))!;

    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(15000); // three failed polls
    expect(flow.step.value).toBe('error');
    // The daemon being unreachable says nothing about the auth site — a tab
    // already navigated to it stays open (the user may be mid-authorization).
    expect(driver.settle).toHaveBeenCalledWith(false, { keepNavigated: true });
  });

  it('settles false on a user cancel while waiting', async () => {
    const driver = makeDriver();
    const flow = scope.run(() => useOAuthLoginFlow({ ...makeCallbacks(), autoOpen: driver }))!;

    await flow.startFlow();
    flow.cancelFlow();
    expect(driver.settle).toHaveBeenCalledWith(false);
  });

  it('settles true without opening on the already-authenticated fast path', async () => {
    const driver = makeDriver();
    const callbacks = makeCallbacks({
      onStartOAuthLogin: vi.fn(async () => ({
        flowId: 'oauth_1',
        provider: 'kimi-code',
        status: 'authenticated' as const,
      })),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, autoOpen: driver }))!;

    await flow.startFlow();
    expect(flow.step.value).toBe('success');
    expect(driver.onGesture).toHaveBeenCalledTimes(1);
    expect(driver.openUrl).not.toHaveBeenCalled();
    expect(driver.settle).toHaveBeenCalledWith(true);
  });

  it('keeps the tab open when a device-code flow succeeds (no settle)', async () => {
    const driver = makeDriver();
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'authenticated' as const })),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, autoOpen: driver }))!;

    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(5000); // poll → authenticated
    expect(flow.step.value).toBe('success');
    expect(driver.openUrl).toHaveBeenCalledTimes(1);
    expect(driver.settle).not.toHaveBeenCalled();
  });

  it('settles false when the scope is disposed mid-wait', async () => {
    const driver = makeDriver();
    const flow = scope.run(() => useOAuthLoginFlow({ ...makeCallbacks(), autoOpen: driver }))!;

    await flow.startFlow();
    scope.stop();
    expect(driver.settle).toHaveBeenCalledWith(false);
  });
});

describe('oauth_login_step tracking', () => {
  let scope: EffectScope;
  let spy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    scope = effectScope();
    spy = vi.fn();
    setProductTracker({ track: spy });
  });

  afterEach(() => {
    scope.stop();
    vi.useRealTimers();
    setProductTracker(noopProductTracker);
  });

  /** The properties bags of every emitted event, in order. */
  function payloads(): Array<Record<string, unknown> | undefined> {
    return spy.mock.calls.map((call) => call[1]);
  }

  it('tracks starting → device-code for a pending start (no ok flag mid-flow)', async () => {
    const flow = scope.run(() => useOAuthLoginFlow(makeCallbacks()))!;
    await flow.startFlow();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(payloads()).toEqual([
      { stage: 'starting', method: 'oauth', duration_ms: 0 },
      { stage: 'device-code', method: 'oauth', duration_ms: 0 },
    ]);
  });

  it('tracks success with ok on the already-authenticated fast path', async () => {
    const callbacks = makeCallbacks({
      onStartOAuthLogin: vi.fn(async () => ({
        flowId: 'oauth_1',
        provider: 'kimi-code',
        status: 'authenticated' as const,
      })),
    });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;
    await flow.startFlow();
    expect(payloads()).toEqual([
      { stage: 'starting', method: 'oauth', duration_ms: 0 },
      { stage: 'success', ok: true, method: 'oauth', duration_ms: 0 },
    ]);
  });

  it('tracks error with ok=false and start_failed when the start request fails', async () => {
    const callbacks = makeCallbacks({ onStartOAuthLogin: vi.fn(async () => null) });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;
    await flow.startFlow();
    expect(payloads()).toEqual([
      { stage: 'starting', method: 'oauth', duration_ms: 0 },
      { stage: 'error', ok: false, method: 'oauth', duration_ms: 0, error_class: 'start_failed' },
    ]);
  });

  it('tracks success with ok and the flow duration when a poll authenticates', async () => {
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'authenticated' as const })),
    });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;
    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(payloads()).toEqual([
      { stage: 'starting', method: 'oauth', duration_ms: 0 },
      { stage: 'device-code', method: 'oauth', duration_ms: 0 },
      { stage: 'success', ok: true, method: 'oauth', duration_ms: 5000 },
    ]);
  });

  it('tracks expired with ok=false and the expired class when the flow expires', async () => {
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'expired' as const })),
    });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;
    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(payloads()).toEqual([
      { stage: 'starting', method: 'oauth', duration_ms: 0 },
      { stage: 'device-code', method: 'oauth', duration_ms: 0 },
      { stage: 'expired', ok: false, method: 'oauth', duration_ms: 5000, error_class: 'expired' },
    ]);
  });

  it('tracks expired with the cancelled class when the user cancels on the OAuth host', async () => {
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'cancelled' as const })),
    });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;
    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(payloads()).toEqual([
      { stage: 'starting', method: 'oauth', duration_ms: 0 },
      { stage: 'device-code', method: 'oauth', duration_ms: 0 },
      { stage: 'expired', ok: false, method: 'oauth', duration_ms: 5000, error_class: 'cancelled' },
    ]);
  });

  it('tracks error with ok=false and poll_failed after repeated poll failures', async () => {
    const callbacks = makeCallbacks({ onPollOAuthLogin: vi.fn(async () => null) });
    const flow = scope.run(() => useOAuthLoginFlow(callbacks))!;
    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(15000); // three failed polls
    expect(payloads()).toEqual([
      { stage: 'starting', method: 'oauth', duration_ms: 0 },
      { stage: 'device-code', method: 'oauth', duration_ms: 0 },
      { stage: 'error', ok: false, method: 'oauth', duration_ms: 15000, error_class: 'poll_failed' },
    ]);
  });
});

describe('authWake driver', () => {
  let scope: EffectScope;

  beforeEach(() => {
    vi.useFakeTimers();
    scope = effectScope();
  });

  afterEach(() => {
    scope.stop();
    vi.useRealTimers();
  });

  /** A wake driver stub: captures the subscribed callback so a test can fire
      wakes by hand, and spies on the returned unsubscribe. */
  function makeAuthWake() {
    let wake: (() => void) | null = null;
    const unsubscribe = vi.fn(() => { wake = null; });
    const subscribe = vi.fn((run: () => void) => {
      wake = run;
      return unsubscribe;
    });
    return {
      driver: { subscribe },
      subscribe,
      unsubscribe,
      fire() { wake?.(); },
    };
  }

  it('subscribes on entering device-code and polls immediately on wake', async () => {
    const wake = makeAuthWake();
    const callbacks = makeCallbacks();
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, authWake: wake.driver }))!;

    expect(wake.subscribe).not.toHaveBeenCalled();
    await flow.startFlow();
    expect(flow.step.value).toBe('device-code');
    expect(wake.subscribe).toHaveBeenCalledTimes(1);
    expect(callbacks.onPollOAuthLogin).not.toHaveBeenCalled();

    wake.fire();
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(1);
  });

  it('a wake replaces the pending interval poll instead of adding to it', async () => {
    const wake = makeAuthWake();
    const callbacks = makeCallbacks();
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, authWake: wake.driver }))!;

    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(2000); // 2s into the 5s interval
    wake.fire();
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000); // the original 5s slot passes silently
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); // 5s after the wake: the rescheduled poll
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(2);
  });

  it('ignores wakes outside the device-code step', async () => {
    const wake = makeAuthWake();
    const callbacks = makeCallbacks();
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, authWake: wake.driver }))!;

    flow.pollNow(); // step 'starting' — nothing to fetch
    expect(callbacks.onPollOAuthLogin).not.toHaveBeenCalled();

    await flow.startFlow();
    flow.pollNow();
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(1);
  });

  it('dedupes wakes while a poll is in flight', async () => {
    const wake = makeAuthWake();
    let resolvePoll: (value: { flowId: string; status: 'pending' }) => void = () => {};
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(
        () =>
          new Promise<{ flowId: string; status: 'pending' }>((resolve) => { resolvePoll = resolve; }),
      ),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, authWake: wake.driver }))!;

    await flow.startFlow();
    flow.pollNow();
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(1);
    wake.fire(); // the first poll is still awaiting the daemon
    flow.pollNow();
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(1);

    resolvePoll({ flowId: 'oauth_1', status: 'pending' });
    await vi.advanceTimersByTimeAsync(0);
    wake.fire(); // resolved — a fresh wake goes through
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(2);
  });

  it('stops waking the poller after a terminal state', async () => {
    const wake = makeAuthWake();
    const callbacks = makeCallbacks({
      onPollOAuthLogin: vi.fn(async () => ({ flowId: 'oauth_1', status: 'authenticated' as const })),
    });
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, authWake: wake.driver }))!;

    await flow.startFlow();
    await vi.advanceTimersByTimeAsync(5000); // poll → authenticated
    expect(flow.step.value).toBe('success');
    expect(wake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(1);
    wake.fire(); // unsubscribed — nothing happens
    expect(callbacks.onPollOAuthLogin).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on cancelFlow and on scope dispose', async () => {
    const wake = makeAuthWake();
    const callbacks = makeCallbacks();
    const flow = scope.run(() => useOAuthLoginFlow({ ...callbacks, authWake: wake.driver }))!;

    await flow.startFlow();
    flow.cancelFlow();
    expect(wake.unsubscribe).toHaveBeenCalledTimes(1);
    wake.fire();
    expect(callbacks.onPollOAuthLogin).not.toHaveBeenCalled();

    // A restart subscribes again; disposing the scope drops that one too.
    await flow.startFlow();
    expect(wake.subscribe).toHaveBeenCalledTimes(2);
    scope.stop();
    expect(wake.unsubscribe).toHaveBeenCalledTimes(2);
  });
});
