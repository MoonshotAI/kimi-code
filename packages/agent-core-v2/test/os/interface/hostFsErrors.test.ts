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

type HostFsErrorCase = {
  name: string;
  errors: unknown[];
  expected: boolean;
};

describe('isHostFsNotFound', () => {
  it.each<HostFsErrorCase>([
    {
      name: 'matches a bare Node ENOENT error',
      errors: [errnoError('ENOENT')],
      expected: true,
    },
    {
      name: 'matches a HostFsError carrying a Node ENOENT cause (node-local shape)',
      errors: [toHostFsError(errnoError('ENOENT'), CTX)],
      expected: true,
    },
    {
      name: 'matches a HostFsError with an fs-domain code and no Node cause (remote shape)',
      errors: [
        new HostFsError('os.fs.not_found', 'stat failed: path does not exist', {
          details: { path: '/x/y.txt', op: 'stat', domainCode: 'os.fs.not_found' },
        }),
      ],
      expected: true,
    },
    {
      name: 'matches an Error2 wrapper whose unwrapped cause carries ENOENT',
      errors: [new Error2('os.fs.unknown', 'outer', { cause: errnoError('ENOENT') })],
      expected: true,
    },
    {
      name: 'does not match not-directory errors',
      errors: [
        errnoError('ENOTDIR'),
        toHostFsError(errnoError('ENOTDIR'), CTX),
        new HostFsError('os.fs.not_directory', 'stat failed'),
      ],
      expected: false,
    },
    {
      name: 'does not match non-matching codes or non-error values',
      errors: [
        errnoError('EACCES'),
        toHostFsError(errnoError('EACCES'), CTX),
        new HostFsError('os.fs.permission_denied', 'read failed'),
        new HostFsError('os.fs.unknown', 'read failed'),
        new Error('boom'),
        undefined,
        null,
        'ENOENT',
      ],
      expected: false,
    },
  ])('$name', ({ errors, expected }) => {
    for (const error of errors) {
      expect(isHostFsNotFound(error)).toBe(expected);
    }
  });
});

describe('isHostFsNotDirectory', () => {
  it.each<HostFsErrorCase>([
    {
      name: 'matches a bare Node ENOTDIR error',
      errors: [errnoError('ENOTDIR')],
      expected: true,
    },
    {
      name: 'matches a HostFsError carrying a Node ENOTDIR cause (node-local shape)',
      errors: [toHostFsError(errnoError('ENOTDIR'), CTX)],
      expected: true,
    },
    {
      name: 'matches a HostFsError with an fs-domain code and no Node cause (remote shape)',
      errors: [
        new HostFsError('os.fs.not_directory', 'stat failed: a path component is not a directory'),
      ],
      expected: true,
    },
    {
      name: 'does not match not-found errors or non-matching codes',
      errors: [
        errnoError('ENOENT'),
        toHostFsError(errnoError('ENOENT'), CTX),
        new HostFsError('os.fs.not_found', 'stat failed'),
        errnoError('EACCES'),
        new Error('boom'),
        undefined,
      ],
      expected: false,
    },
  ])('$name', ({ errors, expected }) => {
    for (const error of errors) {
      expect(isHostFsNotDirectory(error)).toBe(expected);
    }
  });
});
