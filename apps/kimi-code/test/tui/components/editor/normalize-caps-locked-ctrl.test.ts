import { describe, it, expect } from 'vitest';

import { normalizeCapsLockedCtrl } from '#/tui/components/editor/custom-editor';

describe('normalizeCapsLockedCtrl', () => {
  it('rewrites ctrl+D reported with caps_lock back to ctrl+d', () => {
    expect(normalizeCapsLockedCtrl('\u001B[68;69u')).toBe('\u001B[100;5u');
  });

  it('rewrites ctrl+C / ctrl+O / ctrl+S under caps_lock', () => {
    expect(normalizeCapsLockedCtrl('\u001B[67;69u')).toBe('\u001B[99;5u');
    expect(normalizeCapsLockedCtrl('\u001B[79;69u')).toBe('\u001B[111;5u');
    expect(normalizeCapsLockedCtrl('\u001B[83;69u')).toBe('\u001B[115;5u');
  });

  it('preserves the trailing event-type sub-parameter', () => {
    expect(normalizeCapsLockedCtrl('\u001B[68;69:3u')).toBe('\u001B[100;5:3u');
    expect(normalizeCapsLockedCtrl('\u001B[68;69:3:1u')).toBe('\u001B[100;5:3:1u');
  });

  it('leaves plain uppercase typed with only caps_lock alone', () => {
    expect(normalizeCapsLockedCtrl('\u001B[68;65u')).toBe('\u001B[68;65u');
  });

  it('leaves ctrl+letter without caps_lock alone', () => {
    expect(normalizeCapsLockedCtrl('\u001B[68;5u')).toBe('\u001B[68;5u');
    expect(normalizeCapsLockedCtrl('\u001B[100;5u')).toBe('\u001B[100;5u');
  });

  it('leaves ctrl+shift+letter with caps_lock alone', () => {
    expect(normalizeCapsLockedCtrl('\u001B[68;70u')).toBe('\u001B[68;70u');
  });

  it('rewrites ctrl+alt+letter under caps_lock (shift not involved)', () => {
    expect(normalizeCapsLockedCtrl('\u001B[68;71u')).toBe('\u001B[100;7u');
  });

  it('ignores codepoints outside A-Z even with ctrl+caps_lock', () => {
    expect(normalizeCapsLockedCtrl('\u001B[49;69u')).toBe('\u001B[49;69u');
    expect(normalizeCapsLockedCtrl('\u001B[91;69u')).toBe('\u001B[91;69u');
    expect(normalizeCapsLockedCtrl('\u001B[64;69u')).toBe('\u001B[64;69u');
  });

  it('passes through non-CSI-u input unchanged', () => {
    expect(normalizeCapsLockedCtrl('H')).toBe('H');
    expect(normalizeCapsLockedCtrl('\u0004')).toBe('\u0004');
    expect(normalizeCapsLockedCtrl('\u0003')).toBe('\u0003');
    expect(normalizeCapsLockedCtrl('\u001B[A')).toBe('\u001B[A');
    expect(normalizeCapsLockedCtrl('')).toBe('');
  });
});
