import { afterEach, describe, expect, it, vi } from 'vitest';
import { closestRegion, isApplePlatform, isEditableTarget, isSelectAllKeyEvent } from '../src/lib/transcriptSelectAll';

// Minimal KeyboardEvent stand-in for the node test environment.
function keyEvent(init: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
}) {
  return {
    key: init.key,
    code: init.code,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
  };
}

describe('isSelectAllKeyEvent', () => {
  it('matches Cmd+A on Apple platforms and Ctrl+A elsewhere', () => {
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', metaKey: true }), true)).toBe(true);
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', ctrlKey: true }), false)).toBe(true);
  });

  it('ignores the non-platform modifier', () => {
    // macOS: plain Ctrl+A stays free for custom keymap bindings (the keymap
    // reserves only mod+A as the native select-all role).
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', ctrlKey: true }), true)).toBe(false);
    // Off-Mac there is no Cmd — Win/Super+A is not select-all.
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', metaKey: true }), false)).toBe(false);
  });

  it('ignores chords that add the non-platform modifier', () => {
    // ⌃⌘A is a different chord: not the native select-all accelerator (extra
    // modifiers don't match menu roles) and bindable in the desktop keymap.
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', metaKey: true, ctrlKey: true }), true)).toBe(
      false,
    );
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', metaKey: true, ctrlKey: true }), false)).toBe(
      false,
    );
  });

  it('matches caps-lock A', () => {
    expect(isSelectAllKeyEvent(keyEvent({ key: 'A', metaKey: true }), true)).toBe(true);
    expect(isSelectAllKeyEvent(keyEvent({ key: 'A', ctrlKey: true }), false)).toBe(true);
  });

  it('matches the physical KeyA on non-Latin layouts (browser select-all behavior)', () => {
    // Cyrillic layout: physical A produces 'ф', but the browser still fires
    // select-all on that key position.
    expect(
      isSelectAllKeyEvent(keyEvent({ key: 'ф', code: 'KeyA', metaKey: true }), true),
    ).toBe(true);
    expect(
      isSelectAllKeyEvent(keyEvent({ key: 'ф', code: 'KeyA', ctrlKey: true }), false),
    ).toBe(true);
    // AZERTY is the reverse: 'a' lives on KeyQ, so the key fallback must match.
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', code: 'KeyQ', metaKey: true }), true)).toBe(
      true,
    );
    // A non-A key position with a non-'a' char is not select-all.
    expect(isSelectAllKeyEvent(keyEvent({ key: 'з', code: 'KeyQ', metaKey: true }), true)).toBe(
      false,
    );
  });

  it('rejects combinations that are not plain select-all', () => {
    // ⌥⌘A is the archive-session shortcut; Shift mod-combos are app bindings.
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', metaKey: true, altKey: true }), true)).toBe(false);
    expect(isSelectAllKeyEvent(keyEvent({ key: 'A', metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSelectAllKeyEvent(keyEvent({ key: 'b', metaKey: true }), true)).toBe(false);
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a' }), true)).toBe(false);
  });

  it('leaves keys an earlier component consumed alone', () => {
    expect(
      isSelectAllKeyEvent(keyEvent({ key: 'a', metaKey: true, defaultPrevented: true }), true),
    ).toBe(false);
  });
});

describe('isEditableTarget', () => {
  // Node env has no HTMLElement: every target reads as non-editable (the
  // DOM-dependent paths are exercised manually in the app).
  it('treats null and non-element targets as non-editable', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });
});

describe('closestRegion', () => {
  // Node env has no Element: no region can match (DOM paths exercised manually).
  it('returns null for null and non-element targets', () => {
    expect(closestRegion(null, '.global-preview')).toBeNull();
    expect(closestRegion({} as EventTarget, '.global-preview')).toBeNull();
  });
});

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
});
