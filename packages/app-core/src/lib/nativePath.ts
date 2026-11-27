import { isWindowsPath } from './workspacePathInput';

export function nativePath(path: string): string {
  return isWindowsPath(path) ? path.replaceAll('/', '\\') : path;
}
