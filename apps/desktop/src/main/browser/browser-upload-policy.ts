import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export type BrowserUploadPermissionMode = 'manual' | 'auto' | 'yolo';

export interface BrowserUploadContext {
  workspaceRoot?: string | null;
  downloadsDirectory: string;
  permissionMode?: BrowserUploadPermissionMode;
}

export type BrowserUploadDecision =
  | { ok: true; path: string; needsApproval: boolean }
  | { ok: false; reason: string };

async function resolvedPath(path: string): Promise<string | null> {
  try { return await realpath(path); } catch { return null; }
}

function contains(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export async function fileUploadNeedsApproval(path: string, context: BrowserUploadContext): Promise<BrowserUploadDecision> {
  if (!isAbsolute(path)) return { ok: false, reason: `${JSON.stringify(path)} is not an absolute path.` };
  const resolved = await resolvedPath(path);
  if (resolved === null) return { ok: false, reason: `${JSON.stringify(path)} does not exist.` };
  const info = await stat(resolved).catch(() => null);
  if (info === null || !info.isFile()) return { ok: false, reason: `${JSON.stringify(path)} is not a regular file.` };
  const roots = await Promise.all([context.workspaceRoot, context.downloadsDirectory]
    .filter((root): root is string => typeof root === 'string' && root !== '' && isAbsolute(root))
    .map(resolvedPath));
  const trusted = roots.some(root => root !== null && contains(root, resolved));
  return { ok: true, path: resolved, needsApproval: !trusted && context.permissionMode !== 'auto' };
}
