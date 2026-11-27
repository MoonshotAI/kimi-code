import { describe, expect, it } from 'vitest';
import { resolveRelativePath } from '../src/lib/resolveRelativePath';

describe('resolveRelativePath', () => {
  it('joins bare and ./ segments against a POSIX-absolute base', () => {
    expect(resolveRelativePath('./b.md', '/tmp/notes')).toBe('/tmp/notes/b.md');
    expect(resolveRelativePath('sub/b.md', '/tmp/notes')).toBe('/tmp/notes/sub/b.md');
  });

  it('resolves .. against a POSIX-absolute base and clamps at the root', () => {
    expect(resolveRelativePath('../b.md', '/tmp/notes')).toBe('/tmp/b.md');
    expect(resolveRelativePath('../../../x.md', '/tmp/notes')).toBe('/x.md');
  });

  it('keeps .. that a RELATIVE base cannot absorb (workspace-rooted Markdown)', () => {
    expect(resolveRelativePath('../sibling/file.md', '')).toBe('../sibling/file.md');
    expect(resolveRelativePath('../../x.md', 'docs')).toBe('../x.md');
    expect(resolveRelativePath('../x.md', 'docs/sub')).toBe('docs/x.md');
  });

  it('splits a Windows drive base on backslashes for .. resolution', () => {
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
    expect(resolveRelativePath('child.md', '//server/share/docs')).toBe('//server/share/docs/child.md');
    expect(resolveRelativePath('../x.md', '//server/share/docs')).toBe('//server/share/x.md');
  });

  it('treats a backslash inside the SRC as a literal character, not a separator', () => {
    expect(resolveRelativePath('sub\\weird.md', '/tmp/notes')).toBe('/tmp/notes/sub\\weird.md');
  });
});
