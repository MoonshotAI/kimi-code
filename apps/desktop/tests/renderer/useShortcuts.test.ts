import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatShortcutText } from '@moonshot-ai/app-core/lib';
import type { GlobalShortcutResult } from '../../src/shared/global-shortcut';

const setGlobalShortcut = vi.fn<(action: string, binding: string | null) => Promise<GlobalShortcutResult>>();

function windowStub(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { addEventListener: vi.fn(), removeEventListener: vi.fn(), ...extra };
}

async function importUseShortcuts(): Promise<typeof import('../../src/renderer/composables/useShortcuts')> {
  return import('../../src/renderer/composables/useShortcuts');
}

beforeEach(() => {
  vi.resetModules();
  setGlobalShortcut.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal('window', windowStub({ kimiDesktop: { setGlobalShortcut } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useShortcuts OS-global registration failure surface', () => {
  it('keeps screenshot keys available for display when registration fails and follows rebinding', async () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    vi.stubGlobal('window', windowStub({ kimiDesktop: { setGlobalShortcut, isScreenshotSupported: () => true } }));
    setGlobalShortcut.mockResolvedValue({ ok: false, reason: 'conflicted' });
    const { osGlobalFailures, resolvedBindingKeys, setShortcutBinding, matchShortcutAction } = await importUseShortcuts();
    await vi.waitFor(() => {
      expect(osGlobalFailures.captureScreenshot).toBe('conflicted');
    });
    expect(formatShortcutText(resolvedBindingKeys('captureScreenshot'))).toEqual(['Shift', 'Ctrl', 'S']);
    expect(matchShortcutAction({
      key: 's', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
    } as KeyboardEvent, 'global')).toBe('captureScreenshot');
    setGlobalShortcut.mockResolvedValue({ ok: true });
    setShortcutBinding('captureScreenshot', 'alt+mod+s');
    await vi.waitFor(() => {
      expect(osGlobalFailures.captureScreenshot).toBeUndefined();
    });
    expect(formatShortcutText(resolvedBindingKeys('captureScreenshot'))).toEqual(['Alt', 'Ctrl', 'S']);
    setShortcutBinding('captureScreenshot', null);
    expect(resolvedBindingKeys('captureScreenshot')).toEqual([]);
  });

  it('flags the action when the OS refuses the replayed binding, clears on the next success', async () => {
    setGlobalShortcut.mockResolvedValue({ ok: false, reason: 'conflicted' });
    const { osGlobalFailures, setShortcutBinding } = await importUseShortcuts();
    await vi.waitFor(() => {
      expect(osGlobalFailures['summonApp']).toBe('conflicted');
    });
    setGlobalShortcut.mockResolvedValue({ ok: true });
    expect(setShortcutBinding('summonApp', 'alt+mod+s')).toBe(true);
    await vi.waitFor(() => {
      expect(osGlobalFailures['summonApp']).toBeUndefined();
    });
  });

  it('pushes every rebind through the bridge', async () => {
    setGlobalShortcut.mockResolvedValue({ ok: true });
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
    vi.stubGlobal('window', windowStub());
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
    expect(resolvedBinding('toggleSidebar')).toBeNull();
    expect(resolvedBinding('newSession')).toBe('mod+b');
  });

  it('a saved rebind of ctrl+` keeps the chord when the toggleTerminal default moves onto it', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === 'kimi-web.shortcut-overrides'
          ? JSON.stringify({ openDiffTab: 'ctrl+`' })
          : null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const { resolvedBinding, matchShortcutAction, resetShortcutBinding } = await importUseShortcuts();
    expect(resolvedBinding('openDiffTab')).toBe('ctrl+`');
    expect(resolvedBinding('toggleTerminal')).toBeNull();
    const event = { key: '`', code: 'Backquote', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
    expect(matchShortcutAction(event, 'global')).toBe('openDiffTab');
    resetShortcutBinding('openDiffTab');
    expect(resolvedBinding('toggleTerminal')).toBe('ctrl+`');
    expect(matchShortcutAction(event, 'global')).toBe('toggleTerminal');
  });
});

function stubMacosDesktop(): void {
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  vi.stubGlobal('window', windowStub({
    kimiDesktop: { setGlobalShortcut },
    location: { search: '?kimi_desktop=1&platform=darwin' },
  }));
  vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
}

interface KeyEventInit {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

function keyEvent(init: KeyEventInit): KeyboardEvent {
  const { key, code, ctrlKey = false, metaKey = false, altKey = false, shiftKey = false } = init;
  return { key, code, ctrlKey, metaKey, altKey, shiftKey } as KeyboardEvent;
}

it('routes Control+Tab through app shortcuts even when terminal input has focus', async () => {
  vi.stubGlobal('kimiDesktop', { setGlobalShortcut });
  const { matchShortcutAction, terminalPassesChordToPty } = await importUseShortcuts();
  const event = keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true });
  const shiftEvent = keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true });
  expect(matchShortcutAction(event, 'global')).toBe('nextPanelTab');
  expect(matchShortcutAction(shiftEvent, 'global')).toBe('previousPanelTab');
  expect(terminalPassesChordToPty(event, 'nextPanelTab')).toBe(false);
  expect(terminalPassesChordToPty(shiftEvent, 'previousPanelTab')).toBe(false);
});

it('routes the right-panel chord through app shortcuts even when terminal input has focus', async () => {
  vi.stubGlobal('navigator', { platform: 'Win32' });
  vi.stubGlobal('kimiDesktop', { setGlobalShortcut });
  const { matchShortcutAction, terminalPassesChordToPty } = await importUseShortcuts();
  const event = keyEvent({ key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: true });
  expect(matchShortcutAction(event, 'global')).toBe('toggleRightPanel');
  expect(terminalPassesChordToPty(event, 'toggleRightPanel')).toBe(false);
});

it('treats Cmd+K as the terminal clear chord on macOS desktop', async () => {
  stubMacosDesktop();
  const { isTerminalClearChord } = await importUseShortcuts();
  expect(isTerminalClearChord(keyEvent({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(true);
  expect(isTerminalClearChord(keyEvent({ key: 'k', code: 'KeyK', metaKey: true, shiftKey: true }))).toBe(false);
  expect(isTerminalClearChord(keyEvent({ key: 'p', code: 'KeyP', metaKey: true }))).toBe(false);
  expect(isTerminalClearChord(keyEvent({ key: 'k', code: 'KeyK', ctrlKey: true }))).toBe(false);
});

it('keeps the terminal clear chord on Cmd+K when the search binding moves elsewhere', async () => {
  stubMacosDesktop();
  const { isTerminalClearChord, matchShortcutAction, setShortcutBinding, terminalPassesChordToPty } = await importUseShortcuts();
  expect(setShortcutBinding('searchSessions', 'mod+p')).toBe(true);
  const cmdK = keyEvent({ key: 'k', code: 'KeyK', metaKey: true });
  const cmdP = keyEvent({ key: 'p', code: 'KeyP', metaKey: true });
  expect(isTerminalClearChord(cmdK)).toBe(true);
  expect(matchShortcutAction(cmdK, 'global')).toBeNull();
  expect(matchShortcutAction(cmdP, 'global')).toBe('searchSessions');
  expect(terminalPassesChordToPty(cmdP, 'searchSessions')).toBe(false);
});

it('passes the search chord to the pty off macOS (readline kill-line)', async () => {
  vi.stubGlobal('navigator', { platform: 'Win32' });
  vi.stubGlobal('kimiDesktop', { setGlobalShortcut });
  const { isTerminalClearChord, matchShortcutAction, terminalPassesChordToPty } = await importUseShortcuts();
  const event = keyEvent({ key: 'k', code: 'KeyK', ctrlKey: true });
  expect(isTerminalClearChord(event)).toBe(false);
  expect(matchShortcutAction(event, 'global')).toBe('searchSessions');
  expect(terminalPassesChordToPty(event, 'searchSessions')).toBe(true);
});

it('treats Ctrl+C as the terminal copy chord off macOS', async () => {
  vi.stubGlobal('navigator', { platform: 'Win32' });
  const { isTerminalCopyChord } = await importUseShortcuts();
  expect(isTerminalCopyChord(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBe(true);
  expect(isTerminalCopyChord(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true }))).toBe(false);
  expect(isTerminalCopyChord(keyEvent({ key: 'c', code: 'KeyC' }))).toBe(false);
});

it('does not treat Ctrl+C as the terminal copy chord on macOS desktop', async () => {
  stubMacosDesktop();
  const { isTerminalCopyChord } = await importUseShortcuts();
  expect(isTerminalCopyChord(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBe(false);
});

describe('shortcutTooltip', () => {
  beforeEach(() => {
    vi.stubGlobal('kimiDesktop', {});
  });

  it('returns the label with per-key display glyphs on Apple platforms', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    const { shortcutTooltip } = await importUseShortcuts();
    const tooltip = shortcutTooltip('Close right panel', 'toggleRightPanel');
    expect(tooltip).toEqual({ text: 'Close right panel', keys: ['shift', 'mod', 'b'] });
    expect(formatShortcutText(tooltip.keys)).toEqual(['⇧', '⌘', 'B']);
  });

  it('returns modifier names on non-Apple platforms', async () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    const { shortcutTooltip } = await importUseShortcuts();
    const tooltip = shortcutTooltip('Close right panel', 'toggleRightPanel');
    expect(tooltip).toEqual({ text: 'Close right panel', keys: ['shift', 'mod', 'b'] });
    expect(formatShortcutText(tooltip.keys)).toEqual(['Shift', 'Ctrl', 'B']);
  });

  it('returns no keys when the action is unassigned', async () => {
    const { shortcutTooltip, setShortcutBinding } = await importUseShortcuts();
    setShortcutBinding('toggleRightPanel', null);
    expect(shortcutTooltip('Close right panel', 'toggleRightPanel')).toEqual({
      text: 'Close right panel',
      keys: [],
    });
  });
});

describe('useShortcuts browser-reserved hint filtering', () => {
  it('shows every hint when the desktop bridge is present', async () => {
    stubMacosDesktop();
    vi.stubGlobal('kimiDesktop', {});
    const { resolvedBindingKeys, shortcutTooltip } = await importUseShortcuts();
    expect(formatShortcutText(resolvedBindingKeys('newSession'))).toEqual(['⌘', 'N']);
    expect(formatShortcutText(resolvedBindingKeys('nextPanelTab'))).toEqual(['⌃', '⇥']);
    expect(shortcutTooltip('新建会话', 'newSession')).toEqual({ text: '新建会话', keys: ['mod', 'n'] });
  });

  it('hides browser-reserved hints without the bridge and keeps usable ones', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    vi.stubGlobal('window', windowStub());
    const { resolvedBindingKeys, shortcutTooltip } = await importUseShortcuts();
    expect(resolvedBindingKeys('newSession')).toEqual([]);
    expect(resolvedBindingKeys('closeSessionView')).toEqual([]);
    expect(resolvedBindingKeys('nextPanelTab')).toEqual([]);
    expect(resolvedBindingKeys('previousPanelTab')).toEqual([]);
    expect(resolvedBindingKeys('openFolder')).toEqual([]);
    expect(resolvedBindingKeys('openSettings')).toEqual([]);
    expect(resolvedBindingKeys('toggleSideChat')).toEqual([]);
    expect(resolvedBindingKeys('selectPrevSibling')).toEqual([]);
    expect(resolvedBindingKeys('selectNextSibling')).toEqual([]);
    expect(formatShortcutText(resolvedBindingKeys('toggleRightPanel'))).toEqual(['⇧', '⌘', 'B']);
    expect(resolvedBindingKeys('sidebarTabDone')).toEqual([]);
    expect(resolvedBindingKeys('sidebarTabWorkspaces')).toEqual([]);
    expect(formatShortcutText(resolvedBindingKeys('searchSessions'))).toEqual(['⌘', 'K']);
    expect(formatShortcutText(resolvedBindingKeys('toggleSidebar'))).toEqual(['⌘', 'B']);
    expect(shortcutTooltip('新建会话', 'newSession')).toEqual({ text: '新建会话', keys: [] });
    expect(shortcutTooltip('搜索', 'searchSessions')).toEqual({ text: '搜索', keys: ['mod', 'k'] });
  });

  it('hides Windows-only browser chords like Ctrl+K without the bridge', async () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    vi.stubGlobal('window', windowStub());
    const { resolvedBindingKeys } = await importUseShortcuts();
    expect(resolvedBindingKeys('searchSessions')).toEqual([]);
    expect(resolvedBindingKeys('toggleRightPanel')).toEqual([]);
    expect(resolvedBindingKeys('openFolder')).toEqual([]);
    expect(resolvedBindingKeys('sidebarTabOpen')).toEqual([]);
    expect(formatShortcutText(resolvedBindingKeys('openSettings'))).toEqual(['Ctrl', ',']);
    expect(formatShortcutText(resolvedBindingKeys('toggleSideChat'))).toEqual(['Alt', 'Ctrl', 'B']);
    expect(formatShortcutText(resolvedBindingKeys('toggleSidebar'))).toEqual(['Ctrl', 'B']);
  });

  it('follows rebinding into and out of browser-reserved chords without the bridge', async () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    vi.stubGlobal('window', windowStub());
    const { resolvedBindingKeys, setShortcutBinding } = await importUseShortcuts();
    expect(formatShortcutText(resolvedBindingKeys('toggleSidebar'))).toEqual(['Ctrl', 'B']);
    expect(setShortcutBinding('toggleSidebar', 'mod+k')).toBe(true);
    expect(resolvedBindingKeys('toggleSidebar')).toEqual([]);
    expect(setShortcutBinding('toggleSidebar', 'alt+mod+s')).toBe(true);
    expect(formatShortcutText(resolvedBindingKeys('toggleSidebar'))).toEqual(['Alt', 'Ctrl', 'S']);
  });
});
