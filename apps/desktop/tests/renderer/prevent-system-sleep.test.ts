import { createRenderer, defineComponent } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { usePreventSystemSleep } from '../../src/renderer/composables/usePreventSystemSleep';
import type { PreventSleepState } from '../../src/shared/prevent-sleep';

const renderer = createRenderer<object, object>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const enabled: PreventSleepState = { system: 'prevent-app-suspension', lid: true, lidSupported: true };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('refreshes unexpected helper exits, clears repair state, and stops polling on unmount', async () => {
  vi.useFakeTimers();
  const getState = vi.fn().mockResolvedValue({ ...enabled, lidNeedsRepair: true });
  vi.stubGlobal('window', { kimiDesktop: { getPreventSleepState: getState } });
  let result!: ReturnType<typeof usePreventSystemSleep>;
  const app = renderer.createApp(defineComponent(() => { result = usePreventSystemSleep(); return () => null; }));
  app.mount({});
  await vi.advanceTimersByTimeAsync(0);
  expect(result.preventSleepState.lid).toBe(true);
  getState.mockResolvedValue({ ...enabled, lid: false });
  await vi.advanceTimersByTimeAsync(2000);
  expect(result.preventSleepState.lid).toBe(false);
  expect(result.preventSleepState.lidNeedsRepair).toBe(false);
  expect(result.lidSleepStopped.value).toBe(true);
  app.unmount();
  await vi.advanceTimersByTimeAsync(4000);
  expect(getState).toHaveBeenCalledTimes(2);
});

it('does not overwrite a user change with an older refresh response', async () => {
  vi.useFakeTimers();
  let resolve!: (state: PreventSleepState) => void;
  vi.stubGlobal('window', { kimiDesktop: {
    getPreventSleepState: () => new Promise<PreventSleepState>((done) => { resolve = done; }),
    setPreventLidSleep: vi.fn().mockResolvedValue(enabled),
  } });
  let result!: ReturnType<typeof usePreventSystemSleep>;
  const app = renderer.createApp(defineComponent(() => { result = usePreventSystemSleep(); return () => null; }));
  app.mount({});
  await result.setPreventLidSleep(true);
  resolve({ ...enabled, lid: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(result.preventSleepState.lid).toBe(true);
  expect(result.lidSleepStopped.value).toBe(false);
  app.unmount();
});
