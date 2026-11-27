import { describe, expect, it } from 'vitest';

import { nativePath } from '../src/lib/nativePath';

describe('nativePath', () => {
  it('spells Windows drive and UNC paths with backslashes', () => {
    expect(nativePath('C:/Users/me/app')).toBe('C:\\Users\\me\\app');
    expect(nativePath('C:\\Users/me\\app')).toBe('C:\\Users\\me\\app');
    expect(nativePath('//server/share/app')).toBe('\\\\server\\share\\app');
  });

  it('keeps POSIX, home-relative and relative paths as they are', () => {
    expect(nativePath('/home/me/app')).toBe('/home/me/app');
    expect(nativePath('~/app')).toBe('~/app');
    expect(nativePath('src/a.ts')).toBe('src/a.ts');
  });
});
