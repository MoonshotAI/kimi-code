import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { GitWorkTree } from '#/app/git/workTree';
import type { ToolFileAccess } from '#/tool/toolContract';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import {
  isWithinDirectory,
  type PathClass,
} from '#/tool/path-access';

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
  marker: GitWorkTree,
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

function relativePathParts(targetPath: string, cwd: string, pathClass: PathClass): string[] {
  return pathMod(pathClass)
    .relative(cwd, targetPath)
    .split(/[\\/]+/)
    .filter((part) => part.length > 0);
}

function pathMod(pathClass: PathClass): typeof posixPath {
  return pathClass === 'win32' ? win32Path : posixPath;
}
