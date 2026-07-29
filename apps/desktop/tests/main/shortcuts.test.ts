import { beforeEach, describe, expect, it, vi } from 'vitest';

const register = vi.fn<(accel: string, cb: () => void) => boolean>();
const unregister = vi.fn<(accel: string) => void>();
const unregisterAll = vi.fn<() => void>();
const showMainWindow = vi.fn<() => void>();

vi.mock('electron', () => ({
  globalShortcut: { register, unregister, unregisterAll },
}));

vi.mock('../../src/main/menu', () => ({
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

vi.mock('../../src/main/window', () => ({
  showMainWindow,
}));

vi.mock('../../src/main/log', () => ({
  log: { warn: vi.fn() },
}));

async function importShortcuts(): Promise<typeof import('../../src/main/shortcuts')> {
  return import('../../src/main/shortcuts');
}

beforeEach(() => {
  vi.resetModules();
  register.mockReset();
  unregister.mockReset();
  unregisterAll.mockReset();
  showMainWindow.mockReset();
});

// Registration is push-driven: nothing is grabbed at startup, the renderer
// replays the saved binding (default, custom, or null) on every boot.
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
    // Failed registrations must not be unregistered later.
    setGlobalShortcut('mod+a');
    expect(unregister).not.toHaveBeenCalled();
  });

  it('keeps the working shortcut when the OS refuses a rebind', async () => {
    const { setGlobalShortcut } = await importShortcuts();
    register.mockReturnValueOnce(true);
    expect(setGlobalShortcut(DEFAULT_BINDING)).toBe(true);
    // The rebind is refused — the previously working accelerator must survive
    // untouched, or the app would be left with no summon shortcut at all.
    register.mockReturnValueOnce(false);
    expect(setGlobalShortcut('mod+a')).toBe(false);
    expect(unregister).not.toHaveBeenCalled();
    // A later valid rebind still replaces the original registration.
    register.mockReturnValueOnce(true);
    expect(setGlobalShortcut('mod+b')).toBe(true);
    expect(register).toHaveBeenLastCalledWith('CommandOrControl+B', expect.any(Function));
    expect(unregister).toHaveBeenCalledWith(DEFAULT_ACCEL);
  });

  it('restores the committed binding across a suspend cycle after a failed rebind', async () => {
    const { setGlobalShortcut, setGlobalShortcutSuspended } = await importShortcuts();
    register.mockReturnValueOnce(true);
    setGlobalShortcut(DEFAULT_BINDING);
    register.mockReturnValueOnce(false);
    setGlobalShortcut('mod+space'); // refused — the committed chord stays live
    expect(unregister).not.toHaveBeenCalled();
    // A recording suspends and resumes registrations; the resume must restore
    // the COMMITTED chord, not retry the refused candidate into nothing.
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
    setGlobalShortcut('mod+a'); // deferred while suspended
    register.mockReturnValueOnce(false); // deferred refused on resume…
    register.mockReturnValueOnce(true); // …committed restore accepted
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
    // …and false when the OS refuses the deferred chord (committed restored).
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
    setGlobalShortcutSuspended(false); // recording lifts, terminal still focused
    expect(register).toHaveBeenCalledTimes(1); // no re-register yet
    setGlobalShortcutTerminalFocus(false);
    expect(register).toHaveBeenCalledTimes(2);
  });
});
