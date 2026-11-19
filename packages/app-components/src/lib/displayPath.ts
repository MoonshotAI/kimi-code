import { isWindowsPath } from '@moonshot-ai/app-core/lib';

function isAbsoluteFsPath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function nativeFilePath(path: string): string {
  return isWindowsPath(path) ? path.replaceAll('/', '\\') : path;
}

export function absoluteFilePath(args: { path: string; cwd?: string }): string {
  if (/^[\\/](?![\\/])/.test(args.path) && args.cwd) {
    const root =
      /^([a-zA-Z]:)[\\/]/.exec(args.cwd)?.[1] ??
      /^(\\\\[^\\/]+\\[^\\/]+)(?=[\\/]|$)/.exec(args.cwd)?.[1];
    if (root !== undefined) return nativeFilePath(`${root}${args.path}`);
  }
  const cwd = isAbsoluteFsPath(args.path) || !args.cwd ? '' : args.cwd;
  return nativeFilePath(cwd ? (/[/\\]$/.test(cwd) ? `${cwd}${args.path}` : `${cwd}/${args.path}`) : args.path);
}

export function displayFilePath(args: { path: string; cwd?: string }): string {
  return stripLeadingSlash(absoluteFilePath(args));
}

export function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}
