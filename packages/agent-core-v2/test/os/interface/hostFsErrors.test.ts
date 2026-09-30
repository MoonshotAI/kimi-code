import { describe, expect, it } from 'vitest';

import { Error2 } from '#/_base/errors/errors';
import {
  HostFsError,
  isHostFsNotDirectory,
  isHostFsNotFound,
  toHostFsError,
} from '#/os/interface/hostFsErrors';

function errnoError(code: string, syscall = 'open'): NodeJS.ErrnoException {
  const error = new Error(`${code}: mock failure`) as NodeJS.ErrnoException;
  error.code = code;
  error.syscall = syscall;
  return error;
}

const CTX = { path: '/x/y.txt', op: 'read' };

describe('toHostFsError', () => {
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

describe('isHostFsNotFound', () => {
  it('matches a bare Node ENOENT error', () => {
    expect(isHostFsNotFound(errnoError('ENOENT'))).toBe(true);
  });

  it('matches a HostFsError carrying a Node ENOENT cause (node-local shape)', () => {
    expect(isHostFsNotFound(toHostFsError(errnoError('ENOENT'), CTX))).toBe(true);
  });

  it('matches a HostFsError with an fs-domain code and no Node cause (remote shape)', () => {
    const remote = new HostFsError('os.fs.not_found', 'stat failed: path does not exist', {
      details: { path: '/x/y.txt', op: 'stat', domainCode: 'os.fs.not_found' },
    });
    expect(remote.cause).toBeUndefined();
    expect(isHostFsNotFound(remote)).toBe(true);
  });

  it('matches an Error2 wrapper whose unwrapped cause carries ENOENT', () => {
    const wrapped = new Error2('os.fs.unknown', 'outer', { cause: errnoError('ENOENT') });
    expect(isHostFsNotFound(wrapped)).toBe(true);
  });

  it('does not match not-directory errors', () => {
    expect(isHostFsNotFound(errnoError('ENOTDIR'))).toBe(false);
    expect(isHostFsNotFound(toHostFsError(errnoError('ENOTDIR'), CTX))).toBe(false);
    expect(isHostFsNotFound(new HostFsError('os.fs.not_directory', 'stat failed'))).toBe(false);
  });

  it('does not match non-matching codes or non-error values', () => {
    expect(isHostFsNotFound(errnoError('EACCES'))).toBe(false);
    expect(isHostFsNotFound(toHostFsError(errnoError('EACCES'), CTX))).toBe(false);
    expect(isHostFsNotFound(new HostFsError('os.fs.permission_denied', 'read failed'))).toBe(false);
    expect(isHostFsNotFound(new HostFsError('os.fs.unknown', 'read failed'))).toBe(false);
    expect(isHostFsNotFound(new Error('boom'))).toBe(false);
    expect(isHostFsNotFound(undefined)).toBe(false);
    expect(isHostFsNotFound(null)).toBe(false);
    expect(isHostFsNotFound('ENOENT')).toBe(false);
  });
});

describe('isHostFsNotDirectory', () => {
  it('matches a bare Node ENOTDIR error', () => {
    expect(isHostFsNotDirectory(errnoError('ENOTDIR'))).toBe(true);
  });

  it('matches a HostFsError carrying a Node ENOTDIR cause (node-local shape)', () => {
    expect(isHostFsNotDirectory(toHostFsError(errnoError('ENOTDIR'), CTX))).toBe(true);
  });

  it('matches a HostFsError with an fs-domain code and no Node cause (remote shape)', () => {
    const remote = new HostFsError('os.fs.not_directory', 'stat failed: a path component is not a directory');
    expect(remote.cause).toBeUndefined();
    expect(isHostFsNotDirectory(remote)).toBe(true);
  });

  it('does not match not-found errors or non-matching codes', () => {
    expect(isHostFsNotDirectory(errnoError('ENOENT'))).toBe(false);
    expect(isHostFsNotDirectory(toHostFsError(errnoError('ENOENT'), CTX))).toBe(false);
    expect(isHostFsNotDirectory(new HostFsError('os.fs.not_found', 'stat failed'))).toBe(false);
    expect(isHostFsNotDirectory(errnoError('EACCES'))).toBe(false);
    expect(isHostFsNotDirectory(new Error('boom'))).toBe(false);
    expect(isHostFsNotDirectory(undefined)).toBe(false);
  });
});
