import { describe, expect, it } from 'vitest';

import { HostFsError, toHostFsError } from '#/os/interface/hostFsErrors';

function errnoError(code: string, syscall = 'open'): NodeJS.ErrnoException {
  const error = new Error(`${code}: mock failure`) as NodeJS.ErrnoException;
  error.code = code;
  error.syscall = syscall;
  return error;
}

describe('toHostFsError', () => {
  const CTX = { path: '/x/y.txt', op: 'read' };

  it.each([
    ['ENOENT', 'os.fs.not_found'],
    ['EISDIR', 'os.fs.is_directory'],
    ['ENOTDIR', 'os.fs.not_directory'],
    ['EEXIST', 'os.fs.already_exists'],
    ['EACCES', 'os.fs.permission_denied'],
    ['EPERM', 'os.fs.permission_denied'],
    ['ENOTEMPTY', 'os.fs.not_empty'],
    ['EIO', 'os.fs.unknown'],
    ['ESOMETHINGELSE', 'os.fs.unknown'],
  ])('maps errno %s to %s', (errno, code) => {
    const error = toHostFsError(errnoError(errno), CTX);
    expect(error).toBeInstanceOf(HostFsError);
    expect(error.code).toBe(code);
  });

  it('maps an error without a code to os.fs.unknown', () => {
    expect(toHostFsError(new Error('boom'), CTX).code).toBe('os.fs.unknown');
    expect(toHostFsError('not an error', CTX).code).toBe('os.fs.unknown');
  });

  it('carries path/op/errno/syscall in JSON-serializable details and keeps the cause', () => {
    const raw = errnoError('EACCES', 'stat');
    const error = toHostFsError(raw, { path: '/secret', op: 'stat' });
    expect(error.details).toEqual({
      path: '/secret',
      op: 'stat',
      errno: 'EACCES',
      syscall: 'stat',
    });
    expect(error.cause).toBe(raw);
    expect(() => JSON.stringify(error.details)).not.toThrow();
    expect(error.message).not.toContain('/secret');
    expect(error.message).not.toContain('EACCES');
  });

  it('is idempotent: a HostFsError passes through untouched', () => {
    const first = toHostFsError(errnoError('ENOENT'), CTX);
    expect(toHostFsError(first, { path: '/other', op: 'write' })).toBe(first);
  });
});
