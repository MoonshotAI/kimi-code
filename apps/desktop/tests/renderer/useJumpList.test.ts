import { computed, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createJumpListReporter,
  createLaunchActionRouter,
  jumpListEntriesEqual,
  useJumpList,
  type JumpListWorkspaceEntry,
  type LaunchActionPayload,
} from '../../src/renderer/composables/useJumpList';

function entries(...roots: string[]): JumpListWorkspaceEntry[] {
  return roots.map((root) => ({ name: root.split('/').pop() ?? root, root }));
}

describe('jumpListEntriesEqual', () => {
  it('compares entry lists structurally', () => {
    expect(jumpListEntriesEqual(entries('/a', '/b'), entries('/a', '/b'))).toBe(true);
    expect(jumpListEntriesEqual(entries('/a'), entries('/a', '/b'))).toBe(false);
    expect(jumpListEntriesEqual(entries('/a'), entries('/b'))).toBe(false);
    expect(jumpListEntriesEqual([{ name: 'x', root: '/a' }], [{ name: 'y', root: '/a' }])).toBe(false);
  });
});

describe('createJumpListReporter', () => {
  it('is a no-op without the bridge', () => {
    const source = ref<JumpListWorkspaceEntry[] | null>(entries('/a'));
    expect(() => createJumpListReporter(undefined, computed(() => source.value))).not.toThrow();
  });

  it('does not push null (client still loading) and pushes once loaded', async () => {
    const setJumpList = vi.fn();
    const source = ref<JumpListWorkspaceEntry[] | null>(null);
    createJumpListReporter({ setJumpList }, computed(() => source.value));
    expect(setJumpList).not.toHaveBeenCalled();
    source.value = entries('/a', '/b');
    await nextTick();
    expect(setJumpList).toHaveBeenCalledWith(entries('/a', '/b'));
  });

  it('pushes identical successive lists only once', async () => {
    const setJumpList = vi.fn();
    const source = ref<JumpListWorkspaceEntry[] | null>(entries('/a'));
    createJumpListReporter({ setJumpList }, computed(() => source.value));
    // A re-render producing a fresh but identical array must not re-push.
    source.value = entries('/a');
    await nextTick();
    source.value = entries('/a', '/b');
    await nextTick();
    expect(setJumpList).toHaveBeenCalledTimes(2);
    expect(setJumpList).toHaveBeenLastCalledWith(entries('/a', '/b'));
  });
});

describe('createLaunchActionRouter', () => {
  it('is a no-op without the bridge method', () => {
    expect(() => createLaunchActionRouter(undefined, () => {})).not.toThrow();
  });

  it('forwards payloads to the handler and unsubscribes', () => {
    const listeners = new Set<(payload: LaunchActionPayload) => void>();
    const bridge = {
      onLaunchAction: vi.fn((cb: (payload: LaunchActionPayload) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }),
    };
    const handler = vi.fn();
    const stop = createLaunchActionRouter(bridge, handler);
    listeners.forEach((cb) => cb({ action: 'new-chat' }));
    expect(handler).toHaveBeenCalledWith({ action: 'new-chat' });
    stop();
    listeners.forEach((cb) => cb({ action: 'new-chat' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('useJumpList', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function client(initialized: boolean, roots: string[]) {
    return {
      workspacesView: computed(() =>
        roots.map((root, i) => ({ name: `w${i}`, root, id: `id${i}` })),
      ),
      initialized: ref(initialized),
    };
  }

  it('is a no-op without the bridge', () => {
    vi.stubGlobal('window', {});
    expect(() => useJumpList(client(true, ['/a']), () => {})).not.toThrow();
  });

  it('pushes the workspace list (capped at 9) once initialized', () => {
    const setJumpList = vi.fn();
    vi.stubGlobal('window', { kimiDesktop: { setJumpList } });
    const many = Array.from({ length: 12 }, (_, i) => `/w${i}`);
    useJumpList(client(true, many), () => {});
    expect(setJumpList).toHaveBeenCalledTimes(1);
    expect(setJumpList.mock.calls[0]![0]).toHaveLength(9);
  });

  it('holds the first push until the client initializes', () => {
    const setJumpList = vi.fn();
    vi.stubGlobal('window', { kimiDesktop: { setJumpList } });
    useJumpList(client(false, ['/a']), () => {});
    expect(setJumpList).not.toHaveBeenCalled();
  });

  it('routes launch actions when the bridge method exists', () => {
    const listeners = new Set<(payload: LaunchActionPayload) => void>();
    vi.stubGlobal('window', {
      kimiDesktop: {
        onLaunchAction: (cb: (payload: LaunchActionPayload) => void) => {
          listeners.add(cb);
          return () => {};
        },
      },
    });
    const handler = vi.fn();
    useJumpList(client(true, []), handler);
    listeners.forEach((cb) => cb({ action: 'open-workspace', root: '/a' }));
    expect(handler).toHaveBeenCalledWith({ action: 'open-workspace', root: '/a' });
  });
});
