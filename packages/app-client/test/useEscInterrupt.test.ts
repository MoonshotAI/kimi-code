import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useEscInterrupt } from '../src/composables/useEscInterrupt';

function setup() {
  const sessionId = ref('session-a');
  const working = ref(true);
  const interrupt = vi.fn();
  const scope = effectScope();
  const control = scope.run(() => useEscInterrupt({
    sessionId: () => sessionId.value,
    working: () => working.value,
    interrupt,
  }))!;
  return { ...control, sessionId, working, interrupt, scope };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Esc interrupt confirmation', () => {
  it('shows confirmation on the first press and interrupts on the second within two seconds', () => {
    const control = setup();
    control.press();
    expect(control.armed.value).toBe(true);
    expect(control.interrupt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    control.press();
    expect(control.interrupt).toHaveBeenCalledTimes(1);
    expect(control.armed.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    control.scope.stop();
  });

  it('expires after two seconds and requires a new pair of presses', () => {
    const control = setup();
    control.press();
    vi.advanceTimersByTime(2000);
    expect(control.armed.value).toBe(false);
    control.press();
    expect(control.interrupt).not.toHaveBeenCalled();
    expect(control.armed.value).toBe(true);
    control.scope.stop();
  });

  it('does not interrupt after the deadline even if the timeout callback was delayed', () => {
    const control = setup();
    control.press();
    vi.setSystemTime(Date.now() + 2000);
    control.press();
    expect(control.interrupt).not.toHaveBeenCalled();
    expect(control.armed.value).toBe(true);
    control.scope.stop();
  });

  it('does not carry confirmation to another session', () => {
    const control = setup();
    control.press();
    control.sessionId.value = 'session-b';
    expect(control.armed.value).toBe(false);
    control.press();
    expect(control.interrupt).not.toHaveBeenCalled();
    control.scope.stop();
  });

  it('clears confirmation when work ends and ignores presses while idle', () => {
    const control = setup();
    control.press();
    control.working.value = false;
    expect(control.armed.value).toBe(false);
    control.press();
    expect(control.armed.value).toBe(false);
    control.working.value = true;
    control.press();
    expect(control.interrupt).not.toHaveBeenCalled();
    control.scope.stop();
  });

  it('clears confirmation after a direct stop or disposal', () => {
    const control = setup();
    control.press();
    control.reset();
    expect(control.armed.value).toBe(false);
    control.press();
    expect(control.interrupt).not.toHaveBeenCalled();
    control.scope.stop();
    expect(control.armed.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
