import { afterEach, describe, expect, it, vi } from 'vitest';
import { panelLauncherItems, panelLauncherShortcutKeys } from '../../src/renderer/lib/panelLauncher';
import {
  resetAllShortcutBindings,
  setShortcutBinding,
} from '../../src/renderer/composables/useShortcuts';
import { setTraceEnabled } from '@moonshot-ai/app-client/trace';
import { formatShortcutText } from '@moonshot-ai/app-core/lib';

function stubPlatform(platform: string): void {
  vi.stubGlobal('navigator', { platform });
}

afterEach(() => {
  resetAllShortcutBindings();
  vi.unstubAllGlobals();
});

const t = (key: string) => key;
const allOpen = { diff: true, browser: true, term: true, btw: true, files: true };

describe('panelLauncherShortcutKeys', () => {
  it('renders the resolved macOS glyphs for each launcher entry', () => {
    stubPlatform('MacIntel');
    vi.stubGlobal('kimiDesktop', {});
    expect(formatShortcutText(panelLauncherShortcutKeys('diff'))).toEqual(['⌃', '⇧', 'G']);
    expect(formatShortcutText(panelLauncherShortcutKeys('browser'))).toEqual(['⌘', 'T']);
    expect(formatShortcutText(panelLauncherShortcutKeys('term'))).toEqual(['⌃', '`']);
    expect(formatShortcutText(panelLauncherShortcutKeys('btw'))).toEqual(['⌥', '⌘', 'B']);
    expect(formatShortcutText(panelLauncherShortcutKeys('files'))).toEqual(['⇧', '⌘', 'E']);
  });

  it('renders modifier names on non-Apple platforms', () => {
    stubPlatform('Win32');
    vi.stubGlobal('kimiDesktop', {});
    expect(formatShortcutText(panelLauncherShortcutKeys('diff'))).toEqual(['Ctrl', 'Shift', 'G']);
    expect(formatShortcutText(panelLauncherShortcutKeys('browser'))).toEqual(['Ctrl', 'T']);
    expect(formatShortcutText(panelLauncherShortcutKeys('term'))).toEqual(['Ctrl', '`']);
    expect(formatShortcutText(panelLauncherShortcutKeys('btw'))).toEqual(['Alt', 'Ctrl', 'B']);
    expect(formatShortcutText(panelLauncherShortcutKeys('files'))).toEqual(['Shift', 'Ctrl', 'E']);
  });

  it('follows user shortcut overrides', () => {
    stubPlatform('MacIntel');
    vi.stubGlobal('kimiDesktop', {});
    setShortcutBinding('openDiffTab', 'ctrl+shift+j');
    expect(formatShortcutText(panelLauncherShortcutKeys('diff'))).toEqual(['⌃', '⇧', 'J']);
  });
});

describe('panelLauncherItems', () => {
  it('orders entries as diff, browser, term, files, btw and applies availability', () => {
    vi.stubGlobal('kimiDesktop', {});
    const items = panelLauncherItems({ ...allOpen, term: false }, t);
    expect(items.map((item) => item.type)).toEqual(['diff', 'browser', 'term', 'files', 'btw']);
    expect(items.map((item) => item.disabled)).toEqual([false, false, true, false, false]);
    expect(items.map((item) => item.label)).toEqual([
      'panel.tabs.diff',
      'panel.tabs.browser',
      'panel.tabs.term',
      'panel.tabs.files',
      'sideChat.title',
    ]);
  });

  it('carries a shortcut hint for every entry', () => {
    stubPlatform('MacIntel');
    vi.stubGlobal('kimiDesktop', {});
    for (const item of panelLauncherItems(allOpen, t)) {
      expect(item.keys.length, item.type).toBeGreaterThan(0);
    }
  });

  it('hides native entries and shortcut hints without the desktop bridge', () => {
    stubPlatform('MacIntel');
    const items = panelLauncherItems(allOpen, t);
    expect(items.map((item) => item.type)).toEqual(['diff', 'files', 'btw']);
    expect(items.map((item) => item.disabled)).toEqual([false, false, false]);
    for (const item of items) {
      expect(item.keys, item.type).toEqual([]);
    }
  });

  it('keeps availability flags on the remaining entries without the desktop bridge', () => {
    const items = panelLauncherItems({ ...allOpen, diff: false }, t);
    expect(items.map((item) => item.type)).toEqual(['diff', 'files', 'btw']);
    expect(items.map((item) => item.disabled)).toEqual([true, false, false]);
  });

  it('lists the inspector last only while debug mode is on', () => {
    vi.stubGlobal('kimiDesktop', {});
    setTraceEnabled(true);
    try {
      const items = panelLauncherItems(allOpen, t);
      expect(items.at(-1)).toMatchObject({ type: 'inspector', label: 'panel.tabs.inspector', disabled: false, keys: [] });
    } finally {
      setTraceEnabled(false);
    }
    expect(panelLauncherItems(allOpen, t).map((item) => item.type)).not.toContain('inspector');
  });
});
