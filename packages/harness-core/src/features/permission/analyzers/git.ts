import { posix as posixPath, win32 as win32Path } from 'pathe';

import type { OsFsPort } from '#/features/os/host/index';

import { dirname, isAbsolute, join, normalize } from 'pathe';

import { isWithinDirectory, type PathClass } from '#/features/os/path-access';

export interface GitWorkTree {
  readonly root: string;
  readonly dotGitPath: string;
  readonly controlDirPath: string;
}

export async function findGitWorkTree(fs: OsFsPort, cwd: string): Promise<GitWorkTree | null> {
  if (cwd.length === 0 || !isAbsolute(cwd)) return null;

  let current = normalize(cwd);
  while (true) {
    const dotGitPath = join(current, '.git');
    const controlDirPath = await probeGitControlDir(fs, dotGitPath, current);
    if (controlDirPath !== null) return { root: current, dotGitPath, controlDirPath };

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function probeGitControlDir(
  fs: OsFsPort,
  dotGitPath: string,
  markerParent: string,
): Promise<string | null> {
  try {
    const stats = await fs.stat(dotGitPath);
    if (stats.isDirectory) return dotGitPath;
    if (!stats.isFile) return null;

    const content = await fs.readText(dotGitPath);
    return parseGitDirPointer(content, markerParent) ?? null;
  } catch {
    return null;
  }
}

function parseGitDirPointer(content: string, markerParent: string): string | undefined {
  const stripped = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
  const line = stripped.trimStart().split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined || !line.startsWith('gitdir:')) return undefined;

  const rawPath = line.slice('gitdir:'.length).trim();
  if (rawPath.length === 0) return undefined;
  return normalize(isAbsolute(rawPath) ? rawPath : join(markerParent, rawPath));
}

export function hasGitPathComponent(
  targetPath: string,
  cwd: string,
  pathClass: PathClass,
): boolean {
  return relativePathParts(targetPath, cwd, pathClass).some(
    (part) => part.toLowerCase() === '.git',
  );
}

export function isGitControlPath(
  targetPath: string,
  marker: GitWorkTree,
  pathClass: PathClass,
): boolean {
  return (
    isWithinDirectory(targetPath, marker.dotGitPath, pathClass) ||
    isWithinDirectory(targetPath, marker.controlDirPath, pathClass)
  );
}

function relativePathParts(targetPath: string, cwd: string, pathClass: PathClass): string[] {
  return pathMod(pathClass)
    .relative(cwd, targetPath)
    .split(/[\\/]+/)
    .filter((part) => part.length > 0);
}

function pathMod(pathClass: PathClass): typeof posixPath {
  return pathClass === 'win32' ? win32Path : posixPath;
}
