import { describe, expect, it } from 'vitest';

import { isDeadTerminalError } from '#/tui/utils/dead-terminal';

describe('isDeadTerminalError', () => {
  it('returns false for null', () => {
    expect(isDeadTerminalError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isDeadTerminalError(undefined)).toBe(false);
  });

  it('returns false for a primitive', () => {
    expect(isDeadTerminalError('EIO')).toBe(false);
    expect(isDeadTerminalError(42)).toBe(false);
  });

  it('returns false for an object without a code field', () => {
    expect(isDeadTerminalError(new Error('boom'))).toBe(false);
    expect(isDeadTerminalError({})).toBe(false);
  });

  it('returns true for EIO', () => {
    expect(isDeadTerminalError(Object.assign(new Error('write EIO'), { code: 'EIO' }))).toBe(true);
  });

  it('returns true for EPIPE', () => {
    expect(isDeadTerminalError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(
      true,
    );
  });

  it('returns true for ENOTCONN', () => {
    expect(
      isDeadTerminalError(Object.assign(new Error('write ENOTCONN'), { code: 'ENOTCONN' })),
    ).toBe(true);
  });

  it('returns false for unrelated error codes', () => {
    expect(isDeadTerminalError(Object.assign(new Error('not found'), { code: 'ENOENT' }))).toBe(
      false,
    );
    expect(isDeadTerminalError({ code: 'EACCES' })).toBe(false);
  });

  it('returns false when code is undefined', () => {
    expect(isDeadTerminalError({ code: undefined })).toBe(false);
  });
});
