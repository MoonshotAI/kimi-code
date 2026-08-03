import { readFile, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { ToolFileAccess } from '#/tool/toolContract';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import {
  isWithinDirectory,
  type PathClass,
} from '#/tool/path-access';

export interface PermissionGitWorkTreeMarker {
  readonly dotGitPath: string;
  readonly controlDirPath: string;
}

export function fileAccesses(context: ResolvedToolExecutionHookContext): ToolFileAccess[] {
  return (
    context.execution.accesses?.filter((access): access is ToolFileAccess => access.kind === 'file') ??
    []
  );
}

export function writeFileAccesses(context: ResolvedToolExecutionHookContext): ToolFileAccess[] {
  return fileAccesses(context).filter(
    (access) => access.operation === 'write' || access.operation === 'readwrite',
  );
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
  marker: PermissionGitWorkTreeMarker,
  pathClass: PathClass,
): boolean {
  return (
    isWithinDirectory(targetPath, marker.dotGitPath, pathClass) ||
    isWithinDirectory(targetPath, marker.controlDirPath, pathClass)
  );
}

export function defaultPathClass(): PathClass {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

export async function findLocalGitWorkTreeMarker(
  cwd: string,
): Promise<PermissionGitWorkTreeMarker | null> {
  if (cwd.length === 0 || !nodePath.isAbsolute(cwd)) return null;

  let current = nodePath.normalize(cwd);
  for (let depth = 0; depth < 256; depth += 1) {
    const dotGitPath = nodePath.join(current, '.git');
    const marker = await probeLocalGitMarker(dotGitPath, current);
    if (marker !== null) return marker;

    const parent = nodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
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

async function probeLocalGitMarker(
  dotGitPath: string,
  markerParent: string,
): Promise<PermissionGitWorkTreeMarker | null> {
  try {
    const markerStat = await stat(dotGitPath);
    if (markerStat.isDirectory()) return { dotGitPath, controlDirPath: dotGitPath };
    if (!markerStat.isFile()) return null;

    const content = await readFile(dotGitPath, 'utf8');
    const controlDirPath = parseLocalGitDir(content, markerParent);
    return controlDirPath === undefined ? null : { dotGitPath, controlDirPath };
  } catch {
    return null;
  }
}

function parseLocalGitDir(content: string, markerParent: string): string | undefined {
  const stripped = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
  const line = stripped.trimStart().split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined || !line.startsWith('gitdir:')) return undefined;

  const rawPath = line.slice('gitdir:'.length).trim();
  if (rawPath.length === 0) return undefined;
  return nodePath.normalize(
    nodePath.isAbsolute(rawPath) ? rawPath : nodePath.join(markerParent, rawPath),
  );
}
