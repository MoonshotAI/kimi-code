import { describe, expect, it } from 'vitest';
import {
  focusLeavesWindowsMenu,
  StandaloneAltTracker,
} from '../../src/renderer/lib/windowsMenuAccess';

describe('focusLeavesWindowsMenu', () => {
  const file = new EventTarget();
  const edit = new EventTarget();
  const triggers = [file, edit];

  it('keeps menu access active while focus moves between menu triggers', () => {
    expect(focusLeavesWindowsMenu(edit, triggers)).toBe(false);
  });

  it('exits menu access when focus moves outside the menu', () => {
    expect(focusLeavesWindowsMenu(new EventTarget(), triggers)).toBe(true);
    expect(focusLeavesWindowsMenu(null, [...triggers, undefined])).toBe(true);
  });
});

describe('StandaloneAltTracker', () => {
  const event = (
    key: string,
    overrides: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
  ) => ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it('enters menu access only after a standalone Alt is released', () => {
    const tracker = new StandaloneAltTracker();
    tracker.keydown(event('Alt'));
    expect(tracker.keyup(event('Alt'))).toBe(true);
    expect(tracker.keyup(event('Alt'))).toBe(false);
  });

  it('does not enter menu access when Alt forms a shortcut chord', () => {
    const tracker = new StandaloneAltTracker();
    tracker.keydown(event('Alt'));
    tracker.keydown(event('Enter', { altKey: true }));
    expect(tracker.keyup(event('Alt'))).toBe(false);
  });

  it('ignores Alt pressed with another modifier', () => {
    const tracker = new StandaloneAltTracker();
    tracker.keydown(event('Alt', { ctrlKey: true }));
    expect(tracker.keyup(event('Alt'))).toBe(false);
  });
});
