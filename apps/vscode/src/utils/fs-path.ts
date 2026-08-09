import * as path from "node:path";

/** Return a forward-slash relative path when `candidate` is inside `root`. */
export function relativeFsPath(root: string, candidate: string): string | undefined {
  const paths = isWindowsPath(root) || isWindowsPath(candidate) ? path.win32 : path;
  const relativePath = paths.relative(paths.resolve(root), paths.resolve(candidate));
  if (
    relativePath === "" ||
    (!relativePath.startsWith(`..${paths.sep}`) && relativePath !== ".." && !paths.isAbsolute(relativePath))
  ) {
    return relativePath.split(paths.sep).join("/");
  }
  return undefined;
}

/** Whether two native filesystem paths identify the same location. */
export function areSameFsPath(left: string, right: string): boolean {
  return relativeFsPath(left, right) === "";
}

/** Whether `candidate` is `root` or a descendant using native path rules. */
export function isFsPathInsideOrEqual(root: string, candidate: string): boolean {
  return relativeFsPath(root, candidate) !== undefined;
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}
