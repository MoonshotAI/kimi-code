import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalShortcutResult } from '../../src/shared/global-shortcut';

const { blocked, owned } = vi.hoisted(() => ({ blocked: new Set<string>(), owned: new Set<string>() }));

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.1' },
  globalShortcut: {
    register: (key: string) => {
      if (blocked.has(key) || owned.has(key)) return false;
      owned.add(key);
      return true;
    },
    unregister: (key: string) => owned.delete(key),
    unregisterAll: () => owned.clear(),
  },
}));
vi.mock('../../src/main/shell/menu', () => ({ bindingToAccelerator: (binding: string) => binding }));
vi.mock('../../src/main/window/main-window', () => ({ getMainWindow: () => null, sendToRenderer: vi.fn(), showMainWindow: vi.fn() }));
vi.mock('../../src/main/diagnostics/log', () => ({ log: { warn: vi.fn() } }));
vi.mock('../../src/main/diagnostics/track', () => ({ trackDesktopEvent: vi.fn(), trySendDesktopEvent: vi.fn() }));
vi.mock('../../src/main/screenshot/controller', () => ({ noteHotkeyTrigger: vi.fn() }));

interface TestBridge {
  isScreenshotSupported: () => boolean;
  setGlobalShortcut: (action: 'summonApp' | 'captureScreenshot', binding: string | null) => Promise<GlobalShortcutResult>;
  setGlobalShortcutSuspended: (suspended: boolean) => Promise<boolean>;
}

const windowListeners = new Map<string, Set<() => void>>();
let stubbedWindow: {
  kimiDesktop: TestBridge;
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
};

beforeEach(() => {
  vi.resetModules();
  blocked.clear();
  owned.clear();
  windowListeners.clear();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup(delay?: Promise<void>) {
  const main = await vi.importActual<{
    setGlobalShortcutForAction: (action: 'summonApp' | 'captureScreenshot', binding: string | null) => GlobalShortcutResult;
    setGlobalShortcutSuspended: (suspended: boolean) => boolean;
  }>('../../src/main/shell/shortcuts');
  stubbedWindow = {
    kimiDesktop: {
      isScreenshotSupported: () => true,
      setGlobalShortcut: async (action, binding) => {
        const result = main.setGlobalShortcutForAction(action, binding);
        if (action === 'summonApp') await delay;
        return result;
      },
      setGlobalShortcutSuspended: async (value: boolean) => main.setGlobalShortcutSuspended(value),
    },
    addEventListener: (type, cb) => {
      const set = windowListeners.get(type) ?? new Set<() => void>();
      set.add(cb);
      windowListeners.set(type, set);
    },
    removeEventListener: (type, cb) => {
      windowListeners.get(type)?.delete(cb);
    },
  };
  vi.stubGlobal('window', stubbedWindow);
  return import('../../src/renderer/composables/useShortcuts');
}

function dispatchWindowEvent(type: string): void {
  for (const cb of windowListeners.get(type) ?? []) cb();
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('shortcut settings with native registration', () => {
  it('waits for delayed registration replies and keeps the new shortcut when assignment fails', async () => {
    let reply!: () => void;
    const pending = new Promise<void>((done) => { reply = done; });
    const settings = await setup(pending);
    await vi.waitFor(() => expect(owned.has('shift+mod+space')).toBe(true));
    const starting = settings.setGlobalShortcutRecording(true);
    reply();
    await starting;
    blocked.add('shift+mod+x');
    settings.setShortcutBinding('captureScreenshot', 'shift+mod+x');
    await settings.setGlobalShortcutRecording(false);
    expect(settings.resolvedBinding('captureScreenshot')).toBe('shift+mod+x');
    expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted');
    expect(owned.has('shift+mod+s')).toBe(true);
    expect(owned.has('shift+mod+x')).toBe(false);
  });

  it('does not roll back a successful capture binding when summonApp is occupied', async () => {
    const settings = await setup();
    await vi.waitFor(() => expect(owned.has('shift+mod+s')).toBe(true));
    await settings.setGlobalShortcutRecording(true);
    blocked.add('shift+mod+space');
    settings.setShortcutBinding('captureScreenshot', 'shift+mod+x');
    await settings.setGlobalShortcutRecording(false);
    expect(settings.resolvedBinding('captureScreenshot')).toBe('shift+mod+x');
    expect(settings.osGlobalFailures.captureScreenshot).toBeUndefined();
    expect(settings.osGlobalFailures.summonApp).toBe('conflicted');
    expect(owned.has('shift+mod+x')).toBe(true);
    expect(owned.has('shift+mod+s')).toBe(false);
  });

  it('keeps the occupied default as the binding when resetting fails, including reset all', async () => {
    const settings = await setup();
    await vi.waitFor(() => expect(owned.has('shift+mod+s')).toBe(true));
    settings.setShortcutBinding('captureScreenshot', 'shift+mod+x');
    await vi.waitFor(() => expect(owned.has('shift+mod+x')).toBe(true));
    blocked.add('shift+mod+s');
    settings.resetShortcutBinding('captureScreenshot');
    await vi.waitFor(() => expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted'));
    expect(settings.resolvedBinding('captureScreenshot')).toBe('shift+mod+s');
    expect(owned.has('shift+mod+x')).toBe(true);
    settings.resetAllShortcutBindings();
    expect(settings.resolvedBinding('captureScreenshot')).toBe('shift+mod+s');
    expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted');
    expect(owned.has('shift+mod+x')).toBe(true);
    settings.setShortcutBinding('captureScreenshot', null);
    await vi.waitFor(() => expect(owned.has('shift+mod+x')).toBe(false));
    expect(settings.osGlobalFailures.captureScreenshot).toBeUndefined();
  });

  it('keeps the latest choice when bindings change rapidly', async () => {
    const settings = await setup();
    await vi.waitFor(() => expect(owned.has('shift+mod+s')).toBe(true));
    settings.setShortcutBinding('captureScreenshot', 'shift+mod+x');
    settings.setShortcutBinding('captureScreenshot', 'shift+mod+y');
    await vi.waitFor(() => expect(owned.has('shift+mod+y')).toBe(true));
    expect(settings.resolvedBinding('captureScreenshot')).toBe('shift+mod+y');
    expect(owned.has('shift+mod+x')).toBe(false);
    expect(owned.has('shift+mod+s')).toBe(false);
  });

  it('resumes both shortcuts when recording is cancelled without changing a binding', async () => {
    const settings = await setup();
    await vi.waitFor(() => expect(owned.size).toBe(2));
    await settings.setGlobalShortcutRecording(true);
    expect(owned.size).toBe(0);
    await settings.setGlobalShortcutRecording(false);
    expect(owned).toEqual(new Set(['shift+mod+space', 'shift+mod+s']));
  });

  it('retries the failed resume before sending any further registrations', async () => {
    const settings = await setup();
    await vi.waitFor(() => expect(owned.size).toBe(2));
    await settings.setGlobalShortcutRecording(true);
    expect(owned.size).toBe(0);
    const healthySuspended = stubbedWindow.kimiDesktop.setGlobalShortcutSuspended;
    let resumeHealthy = false;
    const resumeAttempts: number[] = [];
    stubbedWindow.kimiDesktop.setGlobalShortcutSuspended = async (value: boolean) => {
      if (!value) {
        resumeAttempts.push(1);
        if (!resumeHealthy) throw new Error('ipc down');
      }
      return healthySuspended(value);
    };
    const healthySet = stubbedWindow.kimiDesktop.setGlobalShortcut;
    const pushed: Array<[string, string | null]> = [];
    stubbedWindow.kimiDesktop.setGlobalShortcut = async (action, binding) => {
      pushed.push([action, binding]);
      return healthySet(action, binding);
    };
    await settings.setGlobalShortcutRecording(false);
    expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted');
    expect(pushed).toHaveLength(0);
    settings.setShortcutBinding('captureScreenshot', 'shift+mod+x');
    await vi.waitFor(() => expect(resumeAttempts.length).toBeGreaterThanOrEqual(3));
    expect(pushed).toHaveLength(0);
    expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted');
    resumeHealthy = true;
    dispatchWindowEvent('focus');
    await vi.waitFor(() => expect(owned.has('shift+mod+x')).toBe(true));
    expect(pushed).toContainEqual(['captureScreenshot', 'shift+mod+x']);
    expect(settings.osGlobalFailures.captureScreenshot).toBeUndefined();
  });

  it('heals a stale failure by re-pushing the live binding', async () => {
    const settings = await setup();
    await vi.waitFor(() => expect(owned.has('shift+mod+s')).toBe(true));
    const healthySet = stubbedWindow.kimiDesktop.setGlobalShortcut;
    const pushed: Array<[string, string | null]> = [];
    stubbedWindow.kimiDesktop.setGlobalShortcut = async (action, binding) => {
      pushed.push([action, binding]);
      return healthySet(action, binding);
    };
    blocked.add('shift+mod+x');
    settings.setShortcutBinding('captureScreenshot', 'shift+mod+x');
    await vi.waitFor(() => expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted'));
    pushed.length = 0;
    settings.resetShortcutBinding('captureScreenshot');
    await vi.waitFor(() => expect(settings.osGlobalFailures.captureScreenshot).toBeUndefined());
    expect(pushed).toContainEqual(['captureScreenshot', 'shift+mod+s']);
    expect(owned.has('shift+mod+s')).toBe(true);
    pushed.length = 0;
    settings.setShortcutBinding('summonApp', 'alt+mod+space');
    await vi.waitFor(() => expect(pushed).toContainEqual(['summonApp', 'alt+mod+space']));
    expect(pushed.some(([action]) => action === 'captureScreenshot')).toBe(false);
  });

  it('keeps retrying a registration the main process lost while recording was suspended', async () => {
    const settings = await setup();
    await vi.waitFor(() => expect(owned.has('shift+mod+s')).toBe(true));
    await settings.setGlobalShortcutRecording(true);
    blocked.add('shift+mod+s');
    await settings.setGlobalShortcutRecording(false);
    expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted');
    expect(owned.has('shift+mod+s')).toBe(false);
    const healthySet = stubbedWindow.kimiDesktop.setGlobalShortcut;
    const pushed: Array<[string, string | null]> = [];
    stubbedWindow.kimiDesktop.setGlobalShortcut = async (action, binding) => {
      pushed.push([action, binding]);
      return healthySet(action, binding);
    };
    settings.setShortcutBinding('summonApp', 'alt+mod+space');
    await vi.waitFor(() => expect(pushed).toContainEqual(['captureScreenshot', 'shift+mod+s']));
    expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted');
    expect(owned.has('shift+mod+s')).toBe(false);
    pushed.length = 0;
    settings.resetShortcutBinding('summonApp');
    await vi.waitFor(() => expect(pushed).toContainEqual(['captureScreenshot', 'shift+mod+s']));
    expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted');
  });

  it('records the failure reason reported by the bridge and clears it after a later success', async () => {
    const settings = await setup();
    await vi.waitFor(() => expect(owned.has('shift+mod+s')).toBe(true));
    const healthy = stubbedWindow.kimiDesktop.setGlobalShortcut;
    stubbedWindow.kimiDesktop.setGlobalShortcut = async () => ({ ok: false, reason: 'invalid' });
    settings.setShortcutBinding('captureScreenshot', 'shift+mod+x');
    await vi.waitFor(() => expect(settings.osGlobalFailures.captureScreenshot).toBe('invalid'));
    stubbedWindow.kimiDesktop.setGlobalShortcut = async () => ({ ok: false, reason: 'channel-disabled' });
    settings.setShortcutBinding('captureScreenshot', 'shift+mod+y');
    await vi.waitFor(() => expect(settings.osGlobalFailures.captureScreenshot).toBe('channel-disabled'));
    stubbedWindow.kimiDesktop.setGlobalShortcut = healthy;
    settings.setShortcutBinding('captureScreenshot', 'shift+mod+z');
    await vi.waitFor(() => expect(settings.osGlobalFailures.captureScreenshot).toBeUndefined());
    expect(owned.has('shift+mod+z')).toBe(true);
  });

  it('retries a failed registration on window focus, throttled to one attempt per 15 seconds', async () => {
    vi.useFakeTimers();
    blocked.add('shift+mod+s');
    const settings = await setup();
    await flushMicrotasks();
    expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted');
    dispatchWindowEvent('focus');
    await flushMicrotasks();
    expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted');
    blocked.delete('shift+mod+s');
    dispatchWindowEvent('focus');
    await flushMicrotasks();
    expect(settings.osGlobalFailures.captureScreenshot).toBe('conflicted');
    vi.advanceTimersByTime(15_000);
    dispatchWindowEvent('focus');
    await flushMicrotasks();
    expect(settings.osGlobalFailures.captureScreenshot).toBeUndefined();
    expect(owned.has('shift+mod+s')).toBe(true);
  });
});
