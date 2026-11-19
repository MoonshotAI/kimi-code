import { afterEach, describe, expect, it } from 'vitest';
import { effectScope, watch } from 'vue';
import { notifySessionDestroyed, notifyWorkspaceDestroyed, resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import {
  createObservationScope,
  resetObservationScopes,
  sessionObservationOptions,
  sessionReadScope,
  workspaceReadScope,
} from '../src/client/observationScope';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';

afterEach(() => {
  resetKimiClientDeps();
  resetObservationScopes();
});

describe('observation scopes', () => {
  it('reactively exposes replacement owners for the same session after reset and forget', () => {
    const observation = createObservationScope();
    const scope = effectScope();
    const signals: (AbortSignal | undefined)[] = [];
    scope.run(() => watch(
      () => observation.options('a').signal,
      signal => signals.push(signal),
      { immediate: true, flush: 'sync' },
    ));
    try {
      expect(signals.at(-1)?.aborted).toBe(true);
      observation.activate('a');
      const first = signals.at(-1);
      expect(first).toBe(observation.options('a').signal);
      expect(first?.aborted).toBe(false);
      observation.reset();
      expect(first?.aborted).toBe(true);
      expect(signals.at(-1)?.aborted).toBe(true);
      observation.activate('a');
      const next = signals.at(-1);
      expect(next).not.toBe(first);
      expect(next?.aborted).toBe(false);
      const count = signals.length;
      expect(observation.activate('a')).toBe(false);
      expect(signals).toHaveLength(count);
      observation.forget('a');
      expect(next?.aborted).toBe(true);
      expect(signals.at(-1)?.aborted).toBe(true);
    } finally {
      scope.stop();
      observation.reset();
    }
  });

  it('reuses the current visit and invalidates previous visits across A-B-A', () => {
    const scope = createObservationScope();
    scope.activate('a');
    const first = scope.options('a');
    scope.activate('a');
    expect(scope.options('a').signal).toBe(first.signal);
    scope.activate('b');
    expect(first.signal?.aborted).toBe(true);
    expect(scope.options('a').signal?.aborted).toBe(true);
    const second = scope.options('b');
    scope.activate('a');
    const third = scope.options('a');
    expect(second.signal?.aborted).toBe(true);
    expect(third.signal).not.toBe(first.signal);
    expect(third.signal?.aborted).toBe(false);
    expect(third.background).toBe(true);
  });

  it('keeps unrelated offscreen reads alive and replaces only the revisited owner', () => {
    const scope = createObservationScope();
    scope.activate('a');
    const firstVisit = scope.options('a');
    scope.activate('b');
    const backgroundA = scope.offscreenOptions('a');
    const backgroundC = scope.offscreenOptions('c');
    expect(firstVisit.signal?.aborted).toBe(true);
    expect(backgroundA.signal?.aborted).toBe(false);
    expect(scope.offscreenOptions('a').signal).toBe(backgroundA.signal);
    expect(scope.offscreenOptions('b').signal).toBe(scope.options('b').signal);

    scope.activate('d');
    scope.activate(undefined);
    expect(backgroundA.signal?.aborted).toBe(false);
    expect(backgroundC.signal?.aborted).toBe(false);
    expect(scope.activate('a')).toBe(true);
    expect(backgroundA.signal?.aborted).toBe(true);
    expect(backgroundC.signal?.aborted).toBe(false);
    expect(scope.options('a').signal).not.toBe(backgroundA.signal);
    expect(scope.options('a').signal?.aborted).toBe(false);
    expect(scope.activate('a')).toBe(false);
  });

  it('forgets current and offscreen owners independently and resets every remaining owner', () => {
    const scope = createObservationScope();
    scope.activate('a');
    const a = scope.options('a');
    const b = scope.offscreenOptions('b');
    const c = scope.offscreenOptions('c');
    scope.forget('b');
    expect(b.signal?.aborted).toBe(true);
    expect(a.signal?.aborted).toBe(false);
    expect(c.signal?.aborted).toBe(false);
    const nextB = scope.offscreenOptions('b');
    expect(nextB.signal).not.toBe(b.signal);
    scope.forget('a');
    expect(a.signal?.aborted).toBe(true);
    expect(c.signal?.aborted).toBe(false);
    scope.reset();
    expect(nextB.signal?.aborted).toBe(true);
    expect(c.signal?.aborted).toBe(true);
    expect(scope.offscreenOptions('c').signal).not.toBe(c.signal);
    expect(scope.offscreenOptions('c').signal?.aborted).toBe(false);
    scope.reset();
  });

  it('reports a new visit when the same key is reactivated after reset', () => {
    const scope = createObservationScope();
    expect(scope.activate(undefined)).toBe(false);
    expect(scope.activate('a')).toBe(true);
    const first = scope.options('a');
    expect(scope.activate('a')).toBe(false);
    scope.reset();
    expect(first.signal?.aborted).toBe(true);
    expect(scope.options('a').signal?.aborted).toBe(true);
    expect(scope.activate('a')).toBe(true);
    expect(scope.options('a').signal?.aborted).toBe(false);
    expect(scope.options('a').signal).not.toBe(first.signal);
    expect(scope.activate('a')).toBe(false);
    expect(scope.activate(undefined)).toBe(false);
    expect(scope.options('a').signal?.aborted).toBe(true);
  });

  it('does not cancel workspace reads when the session changes', () => {
    workspaceReadScope.activate('workspace');
    const workspace = workspaceReadScope.options('workspace');
    sessionReadScope.activate('a');
    sessionReadScope.activate('b');
    expect(workspace.signal?.aborted).toBe(false);
    workspaceReadScope.activate(undefined);
    expect(workspace.signal?.aborted).toBe(true);
  });

  it('invalidates a deleted active session without affecting another visit', () => {
    const scope = createObservationScope();
    scope.activate('a');
    const options = scope.options('a');
    scope.forget('b');
    expect(options.signal?.aborted).toBe(false);
    scope.forget('a');
    expect(options.signal?.aborted).toBe(true);
    scope.activate('a');
    expect(scope.options('a').signal?.aborted).toBe(false);
  });

  it('cancels offscreen reads through session deletion, workspace deletion and reset hooks', () => {
    sessionReadScope.activate('current');
    const current = sessionReadScope.options('current');
    const a = sessionReadScope.offscreenOptions('a');
    const b = sessionReadScope.offscreenOptions('b');
    const c = sessionReadScope.offscreenOptions('c');
    const workspace = workspaceReadScope.offscreenOptions('workspace');
    notifySessionDestroyed('a');
    expect(a.signal?.aborted).toBe(true);
    expect(b.signal?.aborted).toBe(false);
    notifyWorkspaceDestroyed('workspace', '/workspace', ['b']);
    expect(b.signal?.aborted).toBe(true);
    expect(workspace.signal?.aborted).toBe(true);
    expect(c.signal?.aborted).toBe(false);
    expect(current.signal?.aborted).toBe(false);
    resetObservationScopes();
    expect(c.signal?.aborted).toBe(true);
    expect(current.signal?.aborted).toBe(true);
  });

  it('cancels old observations when client dependencies change or reset', () => {
    sessionReadScope.activate('a');
    workspaceReadScope.activate('workspace');
    const old = sessionReadScope.options('a');
    const workspace = workspaceReadScope.options('workspace');
    setKimiClientDeps({ api: () => ({} as KimiWebApi), t: key => key });
    expect(old.signal?.aborted).toBe(true);
    expect(workspace.signal?.aborted).toBe(true);
    sessionReadScope.activate('b');
    const next = sessionObservationOptions('b');
    resetKimiClientDeps();
    expect(next?.signal?.aborted).toBe(true);
    expect(sessionObservationOptions(undefined)).toBeUndefined();
  });
});
