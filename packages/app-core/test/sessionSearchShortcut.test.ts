import { describe, expect, it } from 'vitest';
import { isSessionSearchKeyEvent } from '../src/lib/sessionSearchShortcut';

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

describe('isSessionSearchKeyEvent', () => {
  it('matches Cmd+K on Apple platforms and Ctrl+K elsewhere', () => {
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'k', metaKey: true }), true)).toBe(true);
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'k', ctrlKey: true }), false)).toBe(true);
  });

  it('ignores the non-platform modifier', () => {
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'k', ctrlKey: true }), true)).toBe(false);
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'k', metaKey: true }), false)).toBe(false);
  });

  it('rejects chords that add extra modifiers', () => {
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'k', metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'k', metaKey: true, altKey: true }), true)).toBe(false);
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'K', metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'k' }), true)).toBe(false);
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'j', metaKey: true }), true)).toBe(false);
  });

  it('matches caps-lock K', () => {
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'K', metaKey: true }), true)).toBe(true);
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'K', ctrlKey: true }), false)).toBe(true);
  });

  it('matches the physical KeyK on non-Latin layouts', () => {
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'л', code: 'KeyK', metaKey: true }), true)).toBe(true);
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'л', code: 'KeyK', ctrlKey: true }), false)).toBe(true);
    expect(isSessionSearchKeyEvent(keyEvent({ key: 'з', code: 'KeyQ', metaKey: true }), true)).toBe(false);
  });

  it('leaves keys an earlier component consumed alone', () => {
    expect(
      isSessionSearchKeyEvent(keyEvent({ key: 'k', metaKey: true, defaultPrevented: true }), true),
    ).toBe(false);
  });
});
