import { describe, expect, it } from 'vitest';

import {
  encodeWorkDirKey,
  isAncestorOrSelf,
  isWorkDirKey,
  sameDir,
  toAbsoluteDir,
} from '#/_base/utils/workdir-slug';

describe('directory identity', () => {
  it.each([
    ['a trailing separator', '/repo/app/', '/repo/app'],
    ['dot segments', '/repo/app/src/..', '/repo/./app'],
    ['Windows drive letter casing', 'C:\\Users\\Foo\\App', 'c:\\users\\foo\\app'],
    ['Windows separators and dot segments', 'C:/Users/Foo/App/', 'c:\\Users\\Foo\\Other\\..\\App'],
    ['UNC share casing', '\\\\Host\\Share\\App', '//host/share/app/'],
  ])('treats paths that differ only by %s as the same directory', (_label, a, b) => {
    expect(sameDir(a, b)).toBe(true);
  });

  it('keeps POSIX directories case-sensitive', () => {
    expect(sameDir('/repo/App', '/repo/app')).toBe(false);
  });

  it('matches ancestors on a separator boundary only', () => {
    expect(isAncestorOrSelf('/repo/app', '/repo/app')).toBe(true);
    expect(isAncestorOrSelf('/repo/app', '/repo/app/src/lib')).toBe(true);
    expect(isAncestorOrSelf('/repo/app', '/repo/app-fix')).toBe(false);
    expect(isAncestorOrSelf('C:\\Users\\Foo', 'c:/users/foo/app')).toBe(true);
    expect(isAncestorOrSelf('/', '/repo')).toBe(true);
  });

  it('normalizes absolute directories and rejects relative or empty input', () => {
    expect(toAbsoluteDir('/repo/app/')).toBe('/repo/app');
    expect(toAbsoluteDir('/repo/app/src/..')).toBe('/repo/app');
    expect(toAbsoluteDir('C:\\Users\\Foo\\App\\')).toBe('C:/Users/Foo/App');
    expect(toAbsoluteDir('/')).toBe('/');
    expect(toAbsoluteDir('C:\\')).toBe('C:/');
    expect(toAbsoluteDir('repo/app')).toBeUndefined();
    expect(toAbsoluteDir('')).toBeUndefined();
  });

  it('tells project ids computed from a directory apart from generated ones', () => {
    expect(isWorkDirKey(encodeWorkDirKey('/repo/app'))).toBe(true);
    expect(isWorkDirKey('wm_00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});
