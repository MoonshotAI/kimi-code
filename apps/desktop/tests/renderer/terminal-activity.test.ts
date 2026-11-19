import { computed, effectScope, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useTerminalActivity } from '../../src/renderer/composables/useTerminalActivity';
import type { TerminalActivity } from '../../src/shared/terminal-activity';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('checks only visible terminals, uses the configured Windows interval, and pauses while hidden', async () => {
  vi.useFakeTimers();
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', documentTarget);
  const visible = ref(['a']);
  const allTabs = computed(() => ['a', 'b'].map(id => ({ id, shell: 'pwsh', cwd: '/work', status: 'running' as const, exitCode: null })));
  const inspect = vi.fn(async (_ids: string[]) => [] as TerminalActivity[]);
  const scope = effectScope();
  try {
    scope.run(() => useTerminalActivity({ allTabs, inspect }, { visibleIds: () => visible.value, intervalMs: 10_000 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(['a']);
    await vi.advanceTimersByTimeAsync(9999);
    expect(inspect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(inspect).toHaveBeenCalledTimes(2);
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inspect).toHaveBeenCalledTimes(2);
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(inspect).toHaveBeenCalledTimes(3);
    visible.value = [];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inspect).toHaveBeenCalledTimes(3);
  } finally { scope.stop(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('serializes inspections across rapid visibility changes', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  const visible = ref(['a']);
  const allTabs = computed(() => ['a', 'b'].map(id => ({ id, shell: 'pwsh', cwd: '/', status: 'running' as const, exitCode: null })));
  let resolve!: (value: TerminalActivity[]) => void;
  const inspect = vi.fn<(_ids: string[]) => Promise<TerminalActivity[]>>().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue([]);
  const scope = effectScope();
  try {
    scope.run(() => useTerminalActivity({ allTabs, inspect }, { visibleIds: () => visible.value, intervalMs: 10_000 }));
    await vi.advanceTimersByTimeAsync(0);
    visible.value = ['b'];
    visible.value = [];
    visible.value = ['a'];
    await vi.advanceTimersByTimeAsync(0);
    expect(inspect).toHaveBeenCalledTimes(1);
    resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenLastCalledWith(['a']);
  } finally { scope.stop(); }
  expect(vi.getTimerCount()).toBe(0);
});
