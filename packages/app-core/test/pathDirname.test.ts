// packages/app-core/test/pathDirname.test.ts
import { describe, expect, it } from 'vitest';
import { pathDirname } from '../src/lib/pathDirname';

describe('pathDirname', () => {
  it('takes the directory of POSIX paths', () => {
    expect(pathDirname('/tmp/notes/a.md')).toBe('/tmp/notes');
    expect(pathDirname('docs/a.md')).toBe('docs');
  });

  it('returns "" for a bare-name path (relative links resolve against the workspace)', () => {
    expect(pathDirname('README.md')).toBe('');
    expect(pathDirname('')).toBe('');
  });

  it('keeps the POSIX root for a root-level file', () => {
    // '/README.md' must resolve [child](child.md) to '/child.md', not into
    // the workspace.
    expect(pathDirname('/README.md')).toBe('/');
  });

  it('takes the directory of Windows paths on either separator', () => {
    expect(pathDirname('C:\\docs\\a.md')).toBe('C:\\docs');
    expect(pathDirname('C:/docs/a.md')).toBe('C:/docs');
    expect(pathDirname('C:\\a.md')).toBe('C:');
  });

  it('takes the directory of UNC paths', () => {
    expect(pathDirname('\\\\server\\share\\docs\\a.md')).toBe('\\\\server\\share\\docs');
    expect(pathDirname('\\\\server\\share\\a.md')).toBe('\\\\server\\share');
  });
});
