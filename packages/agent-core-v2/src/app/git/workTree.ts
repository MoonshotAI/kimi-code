import { dirname, isAbsolute, join, normalize } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

export interface GitWorkTree {
  readonly root: string;
  readonly dotGitPath: string;
  readonly controlDirPath: string;
}

export async function findGitWorkTree(
  fs: IHostFileSystem,
  cwd: string,
): Promise<GitWorkTree | null> {
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
  fs: IHostFileSystem,
  dotGitPath: string,
  markerParent: string,
): Promise<string | null> {
  try {
    const stat = await fs.stat(dotGitPath);
    if (stat.isDirectory) return dotGitPath;
    if (!stat.isFile) return null;

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
