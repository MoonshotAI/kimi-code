// packages/app-core/src/lib/resolveRelativePath.ts

/**
 * Resolve a relative path (from inside a Markdown file) against that file's
 * directory, on either path separator. Handles "./foo", "../foo", and bare
 * "foo" segments.
 *
 * The BASE is a filesystem path, so BOTH '/' and '\' separate its segments —
 * a Windows base like C:\docs\sub must resolve '..' per directory, not pop
 * the whole base as one segment. The SRC is href text, where only '/'
 * separates (a '\' inside a Markdown link is a literal filename character).
 *
 * Root handling: an absolute base keeps its root — POSIX '/', drive 'C:', or
 * UNC in either separator form ('\\server\share' or '//server/share') — and
 * excess '..' clamp at that root. A RELATIVE base (a workspace-rooted
 * Markdown) instead keeps the '..' it cannot absorb: dropping it would
 * resolve a sibling-of-workspace target INTO the workspace (wrong probe,
 * wrong copy, wrong open).
 */
export function resolveRelativePath(src: string, base: string): string {
  let root = '';
  let rest = base;
  // UNC first ('\\server\share' or '//server/share'): a '//' base is also
  // '/-'-prefixed, and the POSIX branch would keep only ONE slash of its
  // root.
  const unc = /^((?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+)/.exec(base);
  const drive = /^([a-zA-Z]:)[\\/]?/.exec(base);
  if (unc) {
    root = unc[1]!;
    rest = base.slice(unc[1]!.length);
  } else if (base.startsWith('/')) {
    root = '/';
    rest = base.slice(1);
  } else if (drive) {
    root = drive[1]!;
    rest = base.slice(drive[0].length);
  }
  const absolute = root !== '';
  const result = rest.split(/[\\/]+/).filter(Boolean);
  for (const part of src.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') result.pop();
      else if (!absolute) result.push('..');
    } else {
      result.push(part);
    }
  }
  const joined = result.join('/');
  if (root === '/') return `/${joined}`;
  if (root !== '') return joined ? `${root}/${joined}` : `${root}/`;
  return joined;
}
