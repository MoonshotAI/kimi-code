// packages/app-core/src/lib/pathRelativeTo.ts
import { isWindowsPath } from './workspacePathInput';

/** The `path` made relative to `root` when it sits under it, else null.
 *  Separators are normalized for the comparison; the comparison is
 *  case-insensitive only for a Windows drive / UNC root (POSIX stays
 *  case-sensitive, so `/Repo` ≠ `/repo`). A filesystem-root root ("/" / "C:/")
 *  prefixes every path. The result keeps the input's own casing and uses '/'. */
export function pathRelativeTo(path: string, root: string): string | null {
  if (!root) return null;
  const norm = (p: string) => p.replace(/\\/g, '/');
  const p = norm(path);
  let r = norm(root);
  if (r.length > 1) r = r.replace(/\/+$/, '');
  const insensitive = isWindowsPath(r) || isWindowsPath(p);
  const rCmp = insensitive ? r.toLowerCase() : r;
  const pCmp = insensitive ? p.toLowerCase() : p;
  const prefix = rCmp.endsWith('/') ? rCmp : `${rCmp}/`;
  if (pCmp !== rCmp && !pCmp.startsWith(prefix)) return null;
  const relative = pCmp === rCmp ? '' : p.slice(prefix.length);
  // A prefix match that escapes via ".." ("/repo/../other") is NOT under the
  // root — reject it so the outside path stays absolute.
  if (relative.split('/').includes('..')) return null;
  return relative || null;
}
