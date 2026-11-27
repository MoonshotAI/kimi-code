import { beforeEach, describe, expect, it, vi } from 'vitest';

const register = vi.fn<(accel: string, cb: () => void) => boolean>();
const unregister = vi.fn<(accel: string) => void>();
const unregisterAll = vi.fn<() => void>();
const showMainWindow = vi.fn<() => void>();
const sendToRenderer = vi.fn();
const getMainWindow = vi.fn<() => { isVisible: () => boolean } | null>(() => null);
const isRendererReady = vi.fn<() => boolean>(() => true);
const focus = vi.fn();
const noteHotkeyTrigger = vi.fn();
const captureScreenshot = vi.fn<() => Promise<unknown>>();
const trackDesktopEvent = vi.fn();
let appVersion = '1.0.1';

vi.mock('electron', () => ({
  app: { focus, getVersion: () => appVersion },
  globalShortcut: { register, unregister, unregisterAll },
}));

vi.mock('../../../src/main/shell/menu', () => ({
  bindingToAccelerator: (binding: string | null) => {
    if (binding === null) return undefined;
    const tokens = binding.split('+').filter((t) => t !== '');
    if (tokens.length === 0) return undefined;
    const key = tokens[tokens.length - 1] as string;
    const modMap: Record<string, string> = {
      mod: 'CommandOrControl',
      ctrl: 'Control',
      alt: 'Alt',
      shift: 'Shift',
    };
    const mods = tokens.slice(0, -1).map((t) => modMap[t] ?? t);
    const keyMap: Record<string, string> = { space: 'Space' };
    const accelKey = keyMap[key] ?? (/^[a-z0-9]$/.test(key) ? key.toUpperCase() : undefined);
    return accelKey === undefined ? undefined : [...mods, accelKey].join('+');
  },
}));

vi.mock('../../../src/main/window/window-registry', () => ({
  getMainWindow,
  sendToRenderer,
}));
vi.mock('../../../src/main/window/main-window', () => ({
  isRendererReady,
  showMainWindow,
}));

vi.mock('../../../src/main/screenshot/controller', () => ({
  noteHotkeyTrigger,
  captureScreenshot,
}));

vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { warn: vi.fn() },
}));

vi.mock('../../../src/main/diagnostics/track', () => ({
  trackDesktopEvent,
  trySendDesktopEvent: vi.fn(),
}));

async function importShortcuts(): Promise<typeof import('../../../src/main/shell/shortcuts')> {
  return import('../../../src/main/shell/shortcuts');
}

beforeEach(() => {
  vi.resetModules();
  appVersion = '1.0.1';
  register.mockReset();
  unregister.mockReset();
  unregisterAll.mockReset();
  showMainWindow.mockReset();
  sendToRenderer.mockReset();
  getMainWindow.mockReset();
  isRendererReady.mockReset();
  isRendererReady.mockReturnValue(true);
  focus.mockReset();
  noteHotkeyTrigger.mockReset();
  captureScreenshot.mockReset();
  captureScreenshot.mockReturnValue(Promise.resolve({ status: 'cancelled' }));
  trackDesktopEvent.mockReset();
});

const DEFAULT_BINDING = 'shift+mod+space';
const DEFAULT_ACCEL = 'Shift+CommandOrControl+Space';

describe('global summon-app shortcut', () => {
  it('registers nothing before the first renderer push', async () => {
    await importShortcuts();
    expect(register).not.toHaveBeenCalled();
  });

  it('registers the pushed binding (startup: the renderer replays the default)', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    expect(register).toHaveBeenCalledWith(DEFAULT_ACCEL, expect.any(Function));
  });

  it('invokes showMainWindow when the accelerator fires', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    const callback = register.mock.calls[0]?.[1];
    expect(typeof callback).toBe('function');
    callback?.();
    expect(showMainWindow).toHaveBeenCalledOnce();
  });

  it('re-registers when the renderer pushes a new binding', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcut('shift+mod+a');
    expect(unregister).toHaveBeenCalledWith(DEFAULT_ACCEL);
    expect(register).toHaveBeenCalledWith('Shift+CommandOrControl+A', expect.any(Function));
  });

  it('unregisters without re-registering when the binding is cleared', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcut(null);
    expect(unregister).toHaveBeenCalledWith(DEFAULT_ACCEL);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('logs and keeps state consistent when the OS refuses the accelerator', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValue(false);
    setGlobalShortcut(DEFAULT_BINDING);
    expect(register).toHaveBeenCalledWith(DEFAULT_ACCEL, expect.any(Function));
    setGlobalShortcut('mod+a');
    expect(unregister).not.toHaveBeenCalled();
  });

  it('keeps the working shortcut when the OS refuses a rebind', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValueOnce(true);
    expect(setGlobalShortcut(DEFAULT_BINDING)).toEqual({ ok: true });
    register.mockReturnValueOnce(false);
    expect(setGlobalShortcut('mod+a')).toEqual({ ok: false, reason: 'conflicted' });
    expect(unregister).not.toHaveBeenCalled();
    register.mockReturnValueOnce(true);
    expect(setGlobalShortcut('mod+b')).toEqual({ ok: true });
    expect(register).toHaveBeenLastCalledWith('CommandOrControl+B', expect.any(Function));
    expect(unregister).toHaveBeenCalledWith(DEFAULT_ACCEL);
  });

  it('restores the committed binding across a suspend cycle after a failed rebind', async () => {
    const { setGlobalShortcut, setGlobalShortcutSuspended } = await importShortcuts();
    register.mockReturnValueOnce(true);
    setGlobalShortcut(DEFAULT_BINDING);
    register.mockReturnValueOnce(false);
    setGlobalShortcut('mod+space');
    expect(unregister).not.toHaveBeenCalled();
    setGlobalShortcutSuspended(true);
    expect(unregister).toHaveBeenCalledWith(DEFAULT_ACCEL);
    register.mockReturnValueOnce(true);
    setGlobalShortcutSuspended(false);
    expect(register).toHaveBeenLastCalledWith(DEFAULT_ACCEL, expect.any(Function));
  });

  it('falls back to the committed binding when a deferred push fails on resume', async () => {
    const { setGlobalShortcut, setGlobalShortcutSuspended } = await importShortcuts();
    register.mockReturnValueOnce(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcutSuspended(true);
    setGlobalShortcut('mod+a');
    register.mockReturnValueOnce(false);
    register.mockReturnValueOnce(true);
    expect(setGlobalShortcutSuspended(false)).toBe(false);
    expect(register).toHaveBeenLastCalledWith(DEFAULT_ACCEL, expect.any(Function));
  });

  it('reports on resume whether the deferred binding went live', async () => {
    const { setGlobalShortcut, setGlobalShortcutSuspended } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    expect(setGlobalShortcutSuspended(true)).toBe(true);
    setGlobalShortcut('mod+a');
    expect(setGlobalShortcutSuspended(false)).toBe(true);
    setGlobalShortcutSuspended(true);
    setGlobalShortcut('mod+b');
    register.mockReturnValueOnce(false);
    expect(setGlobalShortcutSuspended(false)).toBe(false);
    expect(register).toHaveBeenLastCalledWith('CommandOrControl+A', expect.any(Function));
  });

  it('honours an unassign pushed while suspended', async () => {
    const { setGlobalShortcut, setGlobalShortcutSuspended } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcutSuspended(true);
    setGlobalShortcut(null);
    expect(setGlobalShortcutSuspended(false)).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('unregisters while suspended and re-registers the current binding on resume', async () => {
    const { setGlobalShortcut, setGlobalShortcutSuspended } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcutSuspended(true);
    expect(unregister).toHaveBeenCalledWith(DEFAULT_ACCEL);
    expect(register).toHaveBeenCalledTimes(1);
    setGlobalShortcutSuspended(false);
    expect(register).toHaveBeenCalledWith(DEFAULT_ACCEL, expect.any(Function));
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('skips re-registering when the pushed binding matches the live one', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcut(DEFAULT_BINDING);
    expect(register).toHaveBeenCalledTimes(1);
    expect(unregister).not.toHaveBeenCalled();
  });

  it('unregisters everything on teardown', async () => {
    const { setGlobalShortcut, unregisterGlobalShortcuts } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    unregisterGlobalShortcuts();
    expect(unregisterAll).toHaveBeenCalledOnce();
  });

  it('tracks global_shortcut_invoked when the accelerator fires', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    register.mock.calls[0]?.[1]?.();
    expect(trackDesktopEvent).toHaveBeenCalledWith('global_shortcut_invoked', { action: 'summonApp' });
  });

  it('tracks a register failure as invalid when the chord cannot be expressed', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    expect(setGlobalShortcut('mod+unknown')).toEqual({ ok: false, reason: 'invalid' });
    expect(trackDesktopEvent).toHaveBeenCalledWith('global_shortcut_register_failed', { action: 'summonApp', reason: 'invalid' });
  });

  it('tracks a register failure as conflicted when the OS refuses the chord', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValue(false);
    expect(setGlobalShortcut(DEFAULT_BINDING)).toEqual({ ok: false, reason: 'conflicted' });
    expect(trackDesktopEvent).toHaveBeenCalledWith('global_shortcut_register_failed', { action: 'summonApp', reason: 'conflicted' });
  });

  it('suspends the registration while the terminal is focused, resumes on blur', async () => {
    const { setGlobalShortcut, setGlobalShortcutTerminalFocus } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcutTerminalFocus(true);
    expect(unregister).toHaveBeenCalledWith(DEFAULT_ACCEL);
    setGlobalShortcutTerminalFocus(false);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('a recording resume does not re-activate while the terminal still holds the suspension', async () => {
    const { setGlobalShortcut, setGlobalShortcutSuspended, setGlobalShortcutTerminalFocus } =
      await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcutTerminalFocus(true);
    setGlobalShortcutSuspended(true);
    setGlobalShortcutSuspended(false);
    expect(register).toHaveBeenCalledTimes(1);
    setGlobalShortcutTerminalFocus(false);
    expect(register).toHaveBeenCalledTimes(2);
  });
});

describe('global capture-screenshot shortcut', () => {
  const SHOT_BINDING = 'shift+mod+s';
  const SHOT_ACCEL = 'Shift+CommandOrControl+S';

  it('keeps capture registered while terminal focus suspends summonApp', async () => {
    const { setGlobalShortcutForAction, setGlobalShortcutTerminalFocus, setGlobalShortcutSuspended } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING);
    setGlobalShortcutTerminalFocus(true);
    expect(unregister).not.toHaveBeenCalled();
    setGlobalShortcutForAction('captureScreenshot', 'alt+mod+s');
    expect(register).toHaveBeenLastCalledWith('Alt+CommandOrControl+S', expect.any(Function));
    setGlobalShortcutSuspended(true);
    expect(unregister).toHaveBeenCalledWith('Alt+CommandOrControl+S');
    setGlobalShortcutSuspended(false);
    expect(register).toHaveBeenCalledTimes(3);
    setGlobalShortcutTerminalFocus(false);
    expect(register).toHaveBeenCalledTimes(3);
  });

  it('registers the pushed binding independently from summonApp', async () => {
    const { setGlobalShortcut, setGlobalShortcutForAction } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenLastCalledWith(SHOT_ACCEL, expect.any(Function));
    expect(unregister).not.toHaveBeenCalled();
  });

  it('keeps the source app in front until capture is ready and notifies the renderer', async () => {
    const { setGlobalShortcutForAction } = await importShortcuts();
    register.mockReturnValue(true);
    getMainWindow.mockReturnValue({ isVisible: () => true });
    setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING);
    const callback = register.mock.calls[0]?.[1];
    callback?.();
    expect(focus).not.toHaveBeenCalled();
    expect(noteHotkeyTrigger).toHaveBeenCalledWith(true);
    expect(sendToRenderer).toHaveBeenCalledWith('kimi:screenshot-hotkey', null);
    expect(showMainWindow).not.toHaveBeenCalled();
  });

  it('starts the capture in the main process instead of bouncing through the renderer', async () => {
    const { setGlobalShortcutForAction } = await importShortcuts();
    register.mockReturnValue(true);
    getMainWindow.mockReturnValue({ isVisible: () => false });
    setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING);
    register.mock.calls[0]?.[1]?.();
    expect(captureScreenshot).toHaveBeenCalledOnce();
    expect(noteHotkeyTrigger).toHaveBeenCalledWith(false);
    expect(sendToRenderer).toHaveBeenCalledWith('kimi:screenshot-hotkey', null);
  });

  it('forwards the capture outcome to the renderer on the hotkey-result channel', async () => {
    const { setGlobalShortcutForAction } = await importShortcuts();
    register.mockReturnValue(true);
    getMainWindow.mockReturnValue({ isVisible: () => true });
    let resolveCapture: (value: unknown) => void = () => undefined;
    captureScreenshot.mockReturnValue(new Promise((resolve) => {
      resolveCapture = resolve;
    }));
    setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING);
    register.mock.calls[0]?.[1]?.();
    const result = { status: 'ok', pngBytes: new Uint8Array(8), comment: 'note' };
    resolveCapture(result);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToRenderer).toHaveBeenCalledWith('kimi:screenshot-hotkey-result', result);
  });

  it('does not start a capture while the renderer is not ready to consume the result', async () => {
    const { setGlobalShortcutForAction } = await importShortcuts();
    register.mockReturnValue(true);
    isRendererReady.mockReturnValue(false);
    setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING);
    register.mock.calls[0]?.[1]?.();
    expect(captureScreenshot).not.toHaveBeenCalled();
    expect(noteHotkeyTrigger).not.toHaveBeenCalled();
    expect(sendToRenderer).not.toHaveBeenCalled();
  });

  it('clears only its own registration when its binding is cleared', async () => {
    const { setGlobalShortcut, setGlobalShortcutForAction } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING);
    setGlobalShortcutForAction('captureScreenshot', null);
    expect(unregister).toHaveBeenCalledWith(SHOT_ACCEL);
    expect(unregister).not.toHaveBeenCalledWith(DEFAULT_ACCEL);
  });

  it('suspends and resumes both registrations together', async () => {
    const { setGlobalShortcut, setGlobalShortcutForAction, setGlobalShortcutSuspended } = await importShortcuts();
    register.mockReturnValue(true);
    setGlobalShortcut(DEFAULT_BINDING);
    setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING);
    setGlobalShortcutSuspended(true);
    expect(unregister).toHaveBeenCalledWith(DEFAULT_ACCEL);
    expect(unregister).toHaveBeenCalledWith(SHOT_ACCEL);
    setGlobalShortcutSuspended(false);
    expect(register).toHaveBeenCalledTimes(4);
  });
});

describe('capture-screenshot shortcut release gate', () => {
  const SHOT_BINDING = 'shift+mod+s';
  const SHOT_ACCEL = 'Shift+CommandOrControl+S';

  it('registers capture on stable builds', async () => {
    const { setGlobalShortcutForAction } = await importShortcuts();
    register.mockReturnValue(true);
    expect(setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING)).toEqual({ ok: true });
    expect(register).toHaveBeenCalledWith(SHOT_ACCEL, expect.any(Function));
  });

  it('refuses capture registration on canary builds', async () => {
    appVersion = '1.0.2-canary.95';
    const { setGlobalShortcutForAction } = await importShortcuts();
    expect(setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING)).toEqual({ ok: false, reason: 'channel-disabled' });
    expect(register).not.toHaveBeenCalled();
  });

  it('refuses capture registration on preview builds', async () => {
    appVersion = '1.0.1-preview.91.1.g3edbe866';
    const { setGlobalShortcutForAction } = await importShortcuts();
    expect(setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING)).toEqual({ ok: false, reason: 'channel-disabled' });
    expect(register).not.toHaveBeenCalled();
  });

  it('still registers summonApp on canary builds', async () => {
    appVersion = '1.0.2-canary.95';
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValue(true);
    expect(setGlobalShortcut(DEFAULT_BINDING)).toEqual({ ok: true });
    expect(register).toHaveBeenCalledWith(DEFAULT_ACCEL, expect.any(Function));
  });

  it('accepts a capture clear on gated builds', async () => {
    appVersion = '1.0.2-canary.95';
    const { setGlobalShortcutForAction } = await importShortcuts();
    expect(setGlobalShortcutForAction('captureScreenshot', null)).toEqual({ ok: true });
    expect(register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
  });

  it('reports an unexpressible capture binding as invalid', async () => {
    const { setGlobalShortcutForAction } = await importShortcuts();
    expect(setGlobalShortcutForAction('captureScreenshot', 'mod+unknown')).toEqual({ ok: false, reason: 'invalid' });
    expect(trackDesktopEvent).toHaveBeenCalledWith('global_shortcut_register_failed', { action: 'captureScreenshot', reason: 'invalid' });
  });

  it('reports a refused capture registration as conflicted', async () => {
    const { setGlobalShortcutForAction } = await importShortcuts();
    register.mockReturnValue(false);
    expect(setGlobalShortcutForAction('captureScreenshot', SHOT_BINDING)).toEqual({ ok: false, reason: 'conflicted' });
    expect(trackDesktopEvent).toHaveBeenCalledWith('global_shortcut_register_failed', { action: 'captureScreenshot', reason: 'conflicted' });
  });
});
