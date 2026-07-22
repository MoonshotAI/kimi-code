import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, type EffectScope } from 'vue';
import {
  useOAuthLoginFlow,
  type OAuthLoginFlowCallbacks,
  type OAuthLoginStartResult,
} from '../src/composables/useOAuthLoginFlow';

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
