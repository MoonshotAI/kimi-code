import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindingKeyNames,
  formatShortcutKeys,
  formatShortcutText,
  isApplePlatform,
} from '../src/lib/shortcutKeys';

describe('isApplePlatform', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the platform from navigator.platform', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(isApplePlatform()).toBe(true);
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' });
    expect(isApplePlatform()).toBe(false);
  });

  it('falls back to userAgentData.platform', () => {
    vi.stubGlobal('navigator', { platform: '', userAgentData: { platform: 'macOS' } });
    expect(isApplePlatform()).toBe(true);
    vi.stubGlobal('navigator', { platform: '', userAgentData: { platform: 'Windows' } });
    expect(isApplePlatform()).toBe(false);
  });

  it('defaults the formatter to the detected platform', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(formatShortcutText(['mod', 'k'])).toEqual(['⌘', 'K']);
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(formatShortcutText(['mod', 'k'])).toEqual(['Ctrl', 'K']);
  });
});

describe('bindingKeyNames', () => {
  it('orders modifiers ctrl, alt, shift, mod before the key', () => {
    expect(bindingKeyNames('mod+shift+a')).toEqual(['shift', 'mod', 'a']);
    expect(bindingKeyNames('mod+alt+ctrl+s')).toEqual(['ctrl', 'alt', 'mod', 's']);
    expect(bindingKeyNames('escape')).toEqual(['escape']);
  });

  it('returns nothing for bindings without exactly one key', () => {
    expect(bindingKeyNames('mod')).toEqual([]);
    expect(bindingKeyNames('mod+a+b')).toEqual([]);
    expect(bindingKeyNames('')).toEqual([]);
  });
});

describe('formatShortcutKeys on Apple platforms', () => {
  const text = (keys: string | string[]) => formatShortcutText(keys, true);

  it('renders modifiers as symbols with key-cap icons and spoken names', () => {
    expect(formatShortcutKeys(['ctrl', 'alt', 'shift', 'mod'], true)).toEqual([
      { name: 'ctrl', text: '⌃', icon: 'key-control', spokenKey: 'shortcuts.keys.control' },
      { name: 'alt', text: '⌥', icon: 'key-option', spokenKey: 'shortcuts.keys.option' },
      { name: 'shift', text: '⇧', icon: 'key-shift', spokenKey: 'shortcuts.keys.shift' },
      { name: 'mod', text: '⌘', icon: 'key-command', spokenKey: 'shortcuts.keys.command' },
    ]);
  });

  it('accepts binding strings', () => {
    expect(text('shift+mod+a')).toEqual(['⇧', '⌘', 'A']);
    expect(text('alt+mod+s')).toEqual(['⌥', '⌘', 'S']);
    expect(text('mod+,')).toEqual(['⌘', ',']);
    expect(text('shift+enter')).toEqual(['⇧', '↵']);
  });
});

describe('formatShortcutKeys on other platforms', () => {
  const text = (keys: string | string[]) => formatShortcutText(keys, false);

  it('renders modifiers as words without icons', () => {
    expect(formatShortcutKeys(['mod', 'ctrl', 'alt', 'shift'], false)).toEqual([
      { name: 'mod', text: 'Ctrl' },
      { name: 'ctrl', text: 'Ctrl' },
      { name: 'alt', text: 'Alt' },
      { name: 'shift', text: 'Shift' },
    ]);
  });

  it('accepts binding strings', () => {
    expect(text('shift+mod+a')).toEqual(['Shift', 'Ctrl', 'A']);
    expect(text('alt+mod+s')).toEqual(['Alt', 'Ctrl', 'S']);
    expect(text('mod+enter')).toEqual(['Ctrl', '↵']);
  });
});

describe('formatShortcutKeys for named keys', () => {
  it.each([true, false])('formats the same on both platforms (apple=%s)', (apple) => {
    expect(formatShortcutKeys(['enter', 'tab', 'backspace', 'plus'], apple).map((cap) => cap.icon)).toEqual([
      'key-enter',
      'key-tab',
      'key-backspace',
      'key-plus',
    ]);
    expect(formatShortcutKeys(['arrowup', 'arrowdown', 'arrowleft', 'arrowright'], apple).map((cap) => cap.spokenKey)).toEqual([
      'shortcuts.keys.arrowUp',
      'shortcuts.keys.arrowDown',
      'shortcuts.keys.arrowLeft',
      'shortcuts.keys.arrowRight',
    ]);
    expect(
      formatShortcutText(['escape', 'space', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown'], apple),
    ).toEqual(['Esc', 'Space', 'Del', 'Ins', 'Home', 'End', 'PgUp', 'PgDn']);
    expect(formatShortcutText(['k', '/', 'f5', 'F5'], apple)).toEqual(['K', '/', 'f5', 'F5']);
  });
});
