import { describe, expect, it } from 'vitest';
import { closestRegion, isEditableTarget, isSelectAllKeyEvent } from '../src/lib/transcriptSelectAll';

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
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', ctrlKey: true }), true)).toBe(false);
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', metaKey: true }), false)).toBe(false);
  });

  it('ignores chords that add the non-platform modifier', () => {
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
    expect(
      isSelectAllKeyEvent(keyEvent({ key: 'ф', code: 'KeyA', metaKey: true }), true),
    ).toBe(true);
    expect(
      isSelectAllKeyEvent(keyEvent({ key: 'ф', code: 'KeyA', ctrlKey: true }), false),
    ).toBe(true);
    expect(isSelectAllKeyEvent(keyEvent({ key: 'a', code: 'KeyQ', metaKey: true }), true)).toBe(
      true,
    );
    expect(isSelectAllKeyEvent(keyEvent({ key: 'з', code: 'KeyQ', metaKey: true }), true)).toBe(
      false,
    );
  });

  it('rejects combinations that are not plain select-all', () => {
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
  it('treats null and non-element targets as non-editable', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });
});

describe('closestRegion', () => {
  it('returns null for null and non-element targets', () => {
    expect(closestRegion(null, '.global-preview')).toBeNull();
    expect(closestRegion({} as EventTarget, '.global-preview')).toBeNull();
  });
});
