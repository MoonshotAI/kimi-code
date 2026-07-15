const PATH_LIKE = /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const FORWARD_UNC = /^\/\/(?!\/)/;

export type WorkspacePathSeparator = '/' | '\\';

export interface ParsedWorkspacePathInput {
  target: string;
  parent: string;
  base: string;
  separator: WorkspacePathSeparator;
}

export function isWorkspacePathInput(raw: string): boolean {
  return PATH_LIKE.test(raw.trim());
}

function expandTilde(raw: string, homePath: string): string {
  if (raw === '~') return homePath || raw;
  if (raw.startsWith('~/')) return (homePath || '~') + raw.slice(1);
  return raw;
}

function normalizeForwardSlashes(path: string): string {
  if (FORWARD_UNC.test(path)) {
    return `//${path.slice(2).replaceAll(/\/{2,}/g, '/')}`;
  }
  return path.replaceAll(/\/{2,}/g, '/');
}

function isWindowsPath(path: string): boolean {
  return WINDOWS_DRIVE.test(path) || path.startsWith('\\\\') || path.startsWith('//');
}

function rootLength(path: string): number {
  if (WINDOWS_DRIVE.test(path)) return 3;
  if (path.startsWith('\\\\') || path.startsWith('//')) return 2;
  if (path.startsWith('/')) return 1;
  return 0;
}

export function parseWorkspacePathInput(
  raw: string,
  homePath: string,
): ParsedWorkspacePathInput {
  let target = normalizeForwardSlashes(expandTilde(raw.trim(), homePath));
  const windowsPath = isWindowsPath(target);
  const isRoot =
    target === '/' ||
    target === '//' ||
    target === '\\\\' ||
    /^[A-Za-z]:[\\/]$/.test(target);

  // A trailing backslash is a separator only for Windows-shaped paths. On
  // POSIX it may be part of the directory name and must stay untouched.
  const hasTrailingSeparator = windowsPath ? /[\\/]$/.test(target) : target.endsWith('/');
  if (!isRoot && hasTrailingSeparator) target = target.slice(0, -1);

  const slash = target.lastIndexOf('/');
  const backslash = windowsPath ? target.lastIndexOf('\\') : -1;
  const lastSeparator = Math.max(slash, backslash);
  const separator: WorkspacePathSeparator = backslash > slash ? '\\' : '/';
  const root = rootLength(target);
  const parent =
    lastSeparator < root
      ? target.slice(0, root) || '/'
      : target.slice(0, lastSeparator) || '/';

  return {
    target,
    parent,
    base: target.slice(lastSeparator + 1),
    separator,
  };
}

export function joinWorkspacePathCandidate(
  parent: string,
  name: string,
  separator: WorkspacePathSeparator,
): string {
  return `${parent}${parent.endsWith(separator) ? '' : separator}${name}`;
}

export function currentValidatedWorkspacePath(
  raw: string,
  homePath: string,
  validatedPath: string | null,
): string | null {
  if (validatedPath === null) return null;
  const { target } = parseWorkspacePathInput(raw, homePath);
  return target === validatedPath ? validatedPath : null;
}
