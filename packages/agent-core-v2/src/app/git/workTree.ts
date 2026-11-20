import { dirname, isAbsolute, join, normalize } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

export interface GitWorkTree {
  readonly root: string;
  readonly dotGitPath: string;
  readonly controlDirPath: string;
}

interface GitMarkerPlace {
  readonly root: string;
  readonly dotGitPath: string;
}

export type GitMarker =
  | (GitMarkerPlace & { readonly kind: 'directory' })
  | (GitMarkerPlace & { readonly kind: 'pointer'; readonly gitDir: string })
  | (GitMarkerPlace & { readonly kind: 'invalid' });

export async function findNearestGitMarker(
  fs: IHostFileSystem,
  start: string,
): Promise<GitMarker | undefined> {
  let current = normalize(start);
  while (true) {
    const dotGitPath = join(current, '.git');
    if (await pathExists(fs, dotGitPath)) return classifyGitMarker(fs, current, dotGitPath);

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function findGitWorkTree(
  fs: IHostFileSystem,
  cwd: string,
): Promise<GitWorkTree | null> {
  if (cwd.length === 0 || !isAbsolute(cwd)) return null;

  const marker = await findNearestGitMarker(fs, cwd);
  if (marker === undefined || marker.kind === 'invalid') return null;
  return {
    root: marker.root,
    dotGitPath: marker.dotGitPath,
    controlDirPath: marker.kind === 'pointer' ? marker.gitDir : marker.dotGitPath,
  };
}

async function classifyGitMarker(
  fs: IHostFileSystem,
  root: string,
  dotGitPath: string,
): Promise<GitMarker> {
  try {
    const stat = await fs.stat(dotGitPath);
    if (stat.isDirectory) return { kind: 'directory', root, dotGitPath };
    const gitDir = stat.isFile ? parseGitDirPointer(await fs.readText(dotGitPath), root) : undefined;
    return gitDir === undefined
      ? { kind: 'invalid', root, dotGitPath }
      : { kind: 'pointer', root, dotGitPath, gitDir };
  } catch {
    return { kind: 'invalid', root, dotGitPath };
  }
}

async function pathExists(fs: IHostFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
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
