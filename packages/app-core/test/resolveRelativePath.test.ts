// packages/app-core/test/resolveRelativePath.test.ts
import { describe, expect, it } from 'vitest';
import { resolveRelativePath } from '../src/lib/resolveRelativePath';

describe('resolveRelativePath', () => {
  it('joins bare and ./ segments against a POSIX-absolute base', () => {
    // An out-of-workspace Markdown resolves against its own directory, not
    // the workspace.
    expect(resolveRelativePath('./b.md', '/tmp/notes')).toBe('/tmp/notes/b.md');
    expect(resolveRelativePath('sub/b.md', '/tmp/notes')).toBe('/tmp/notes/sub/b.md');
  });

  it('resolves .. against a POSIX-absolute base and clamps at the root', () => {
    expect(resolveRelativePath('../b.md', '/tmp/notes')).toBe('/tmp/b.md');
    expect(resolveRelativePath('../../../x.md', '/tmp/notes')).toBe('/x.md');
  });

  it('keeps .. that a RELATIVE base cannot absorb (workspace-rooted Markdown)', () => {
    // Dropping the excess '..' would resolve a sibling-of-workspace target
    // INTO the workspace — the probe, copy button and click would all act on
    // the wrong file.
    expect(resolveRelativePath('../sibling/file.md', '')).toBe('../sibling/file.md');
    expect(resolveRelativePath('../../x.md', 'docs')).toBe('../x.md');
    expect(resolveRelativePath('../x.md', 'docs/sub')).toBe('docs/x.md');
  });

  it('splits a Windows drive base on backslashes for .. resolution', () => {
    // The base arrives with '\' separators from the filesystem; '..' must pop
    // ONE directory, not the whole base as a single segment.
    expect(resolveRelativePath('../child.md', 'C:\\docs\\sub')).toBe('C:/docs/child.md');
    expect(resolveRelativePath('child.md', 'C:\\docs\\sub')).toBe('C:/docs/sub/child.md');
  });

  it('clamps .. at the Windows drive root', () => {
    expect(resolveRelativePath('../../x.md', 'C:\\docs')).toBe('C:/x.md');
  });

  it('keeps the UNC root across .. resolution', () => {
    expect(resolveRelativePath('../child.md', '\\\\server\\share\\docs')).toBe(
      '\\\\server\\share/child.md',
    );
    expect(resolveRelativePath('../../x.md', '\\\\server\\share\\docs')).toBe('\\\\server\\share/x.md');
  });

  it('keeps the double slash of a forward-slash UNC root', () => {
    // '//server/share/docs' is NOT a plain POSIX root: the POSIX branch alone
    // would keep one '/' and resolve into '/server/share/docs/…'.
    expect(resolveRelativePath('child.md', '//server/share/docs')).toBe('//server/share/docs/child.md');
    expect(resolveRelativePath('../x.md', '//server/share/docs')).toBe('//server/share/x.md');
  });

  it('treats a backslash inside the SRC as a literal character, not a separator', () => {
    // Href text is URI-ish: only '/' separates. A Windows-style '..' with a
    // backslash stays a literal filename segment.
    expect(resolveRelativePath('sub\\weird.md', '/tmp/notes')).toBe('/tmp/notes/sub\\weird.md');
  });
});
