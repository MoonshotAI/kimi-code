import { isWindowsPath } from './workspacePathInput';

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
  if (relative.split('/').includes('..')) return null;
  return relative || null;
}
