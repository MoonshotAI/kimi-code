import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePanelSlide } from '../src/composables/usePanelSlide';

let frames: Map<number, FrameRequestCallback>;
let sequence = 0;
beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('getComputedStyle', () => ({ transitionDuration: '0.26s' }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup() {
  const visible = ref(false);
  const enabled = ref(true);
  const element = ref({} as HTMLElement);
  const changed = vi.fn();
  const scope = effectScope();
  const state = scope.run(() => usePanelSlide({ visible, enabled, element, onGeometryChange: changed }))!;
  return { visible, enabled, element, changed, scope, state };
}
async function layout() { await nextTick(); await nextTick(); }
function frame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

it('reports moving geometry throughout the slide and once after it finishes', async () => {
  const test = setup();
  test.visible.value = true;
  await layout();
  expect(test.state.contentVisible.value).toBe(true);
  expect(test.changed).toHaveBeenCalledOnce();
  frame(); frame();
  expect(test.changed).toHaveBeenCalledTimes(3);
  test.state.onTransitionEnd({ target: test.element.value, propertyName: 'width' } as unknown as TransitionEvent);
  await layout();
  expect(test.changed).toHaveBeenCalledTimes(4);
  expect(frames.size).toBe(0);
  test.visible.value = false;
  await layout();
  expect(test.state.contentVisible.value).toBe(true);
  await vi.advanceTimersByTimeAsync(310);
  expect(test.state.contentVisible.value).toBe(false);
  expect(frames.size).toBe(0);
  test.scope.stop();
});

it('cancels obsolete frames on reversal, immediate layout changes and disposal', async () => {
  const test = setup();
  test.visible.value = true;
  await layout();
  const obsolete = [...frames.values()][0]!;
  test.visible.value = false;
  await layout();
  const calls = test.changed.mock.calls.length;
  obsolete(0);
  expect(test.changed).toHaveBeenCalledTimes(calls);
  expect(frames.size).toBe(1);
  test.enabled.value = false;
  await layout();
  expect(frames.size).toBe(0);
  expect(test.state.contentVisible.value).toBe(false);
  test.enabled.value = true;
  await layout();
  test.visible.value = true;
  await layout();
  test.scope.stop();
  expect(frames.size).toBe(0);
});

it('reports settled geometry without starting a loop when motion is disabled', async () => {
  vi.stubGlobal('getComputedStyle', () => ({ transitionDuration: '0s' }));
  const test = setup();
  test.visible.value = true;
  await layout();
  expect(test.changed).toHaveBeenCalledOnce();
  expect(test.state.sliding.value).toBe(false);
  expect(frames.size).toBe(0);
  test.scope.stop();
});
