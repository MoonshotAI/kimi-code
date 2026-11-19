import { isAbsoluteLocalPath } from './isAbsoluteLocalPath';
import { isWindowsPath } from './workspacePathInput';

export function resolveLocalPath(root: string, path: string): string {
  if (isAbsoluteLocalPath(path)) return path;
  const separator = isWindowsPath(root) ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return `${base}${separator}${path.replace(/[\\/]+/g, separator)}`;
}
