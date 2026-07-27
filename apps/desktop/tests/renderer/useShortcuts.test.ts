import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// useShortcuts' OS-global failure surface: the registration result of every
// pushed binding is tracked so the settings panel can flag chords the OS
// refused. The bridge is stubbed on `window`; the module re-imports fresh per
// test (its overrides state is module-level).
const setGlobalShortcut = vi.fn<(action: string, binding: string | null) => Promise<boolean>>();

async function importUseShortcuts(): Promise<typeof import('../../src/renderer/composables/useShortcuts')> {
  return import('../../src/renderer/composables/useShortcuts');
}

beforeEach(() => {
  vi.resetModules();
  setGlobalShortcut.mockReset();
  vi.stubGlobal('window', { kimiDesktop: { setGlobalShortcut } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useShortcuts OS-global registration failure surface', () => {
  it('flags the action when the OS refuses the replayed binding, clears on the next success', async () => {
    setGlobalShortcut.mockResolvedValue(false);
    const { osGlobalFailures, setShortcutBinding } = await importUseShortcuts();
    // The immediate watch replays the default on import — a refusal flags it.
    await vi.waitFor(() => {
      expect(osGlobalFailures['summonApp']).toBe(true);
    });
    setGlobalShortcut.mockResolvedValue(true);
    expect(setShortcutBinding('summonApp', 'alt+mod+s')).toBe(true);
    await vi.waitFor(() => {
      expect(osGlobalFailures['summonApp']).toBeUndefined();
    });
  });

  it('pushes every rebind through the bridge', async () => {
    setGlobalShortcut.mockResolvedValue(true);
    const { setShortcutBinding, resetShortcutBinding } = await importUseShortcuts();
    setShortcutBinding('summonApp', 'alt+mod+s');
    await vi.waitFor(() => {
      expect(setGlobalShortcut).toHaveBeenCalledWith('summonApp', 'alt+mod+s');
    });
    resetShortcutBinding('summonApp');
    await vi.waitFor(() => {
      expect(setGlobalShortcut).toHaveBeenCalledWith('summonApp', 'shift+mod+space');
    });
  });

  it('stays quiet without a bridge (plain web / old preload)', async () => {
    vi.stubGlobal('window', {});
    const { osGlobalFailures } = await importUseShortcuts();
    await Promise.resolve();
    expect(setGlobalShortcut).not.toHaveBeenCalled();
    expect(osGlobalFailures['summonApp']).toBeUndefined();
  });
});

describe('useShortcuts persisted-override migration', () => {
  it('migrates legacy overrides killed by reservations to explicit unassigned', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === 'kimi-web.shortcut-overrides'
          ? JSON.stringify({ toggleSidebar: 'mod+f', newSession: 'mod+b' })
          : null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const { resolvedBinding } = await importUseShortcuts();
    // Unassigned, NOT back to the default: the user may have handed the freed
    // default (mod+b) to another action (here newSession), and restoring it
    // would shadow that action behind the registry order.
    expect(resolvedBinding('toggleSidebar')).toBeNull();
    expect(resolvedBinding('newSession')).toBe('mod+b');
  });
});
