import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { Agent } from '../..';
import { isWithinDirectory, type PathClass } from '../../../tools/policies/path-access';
import { isSensitiveFile } from '../../../tools/policies/sensitive';
import {
  findGitWorkTreeMarker,
  type GitWorkTreeMarker,
} from '../../../tools/support/git-worktree';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../policy';
import { fileInputDisplay, resolvePathToolAccess } from './utils';

export class SystemSafetyPathAskPermissionPolicy implements PermissionPolicy {
  private readonly gitMarkerCache = new Map<string, GitWorkTreeMarker>();
  readonly name = 'system.ask.safety-path';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const access = resolvePathToolAccess(this.agent, context);
    if (access === undefined) return undefined;

    if (isSensitiveFile(access.path, access.pathClass)) {
      return {
        kind: 'ask',
        action: freshSafetyAction(context, 'sensitive file', access.path),
        display: fileInputDisplay(access, 'Sensitive file access requires explicit approval.'),
      };
    }

    const cwd = this.agent.config.cwd;
    if (!mayBeGitControlPath(access.path, cwd, access.pathClass)) return undefined;

    const marker =
      this.gitMarkerCache.get(cwd) ?? (await findGitWorkTreeMarker(this.agent.runtime.kaos, cwd));
    if (marker !== null) this.gitMarkerCache.set(cwd, marker);
    if (marker !== null && isGitControlPath(access.path, cwd, marker, access.pathClass)) {
      return {
        kind: 'ask',
        action: freshSafetyAction(context, 'git control path', access.path),
        display: fileInputDisplay(access, 'Git control path access requires explicit approval.'),
      };
    }

    return undefined;
  }
}

function freshSafetyAction(
  context: PermissionPolicyContext,
  boundary: string,
  path: string,
): string {
  const name = context.toolCall.function.name;
  const id = context.toolCall.id;
  return `Confirm ${name} on ${boundary}: ${path} for tool call ${id}`;
}

function mayBeGitControlPath(targetPath: string, cwd: string, pathClass: PathClass): boolean {
  return relativePathParts(targetPath, cwd, pathClass).some((part) =>
    part.toLowerCase().startsWith('.git'),
  );
}

function isGitControlPath(
  targetPath: string,
  cwd: string,
  marker: GitWorkTreeMarker,
  pathClass: PathClass,
): boolean {
  if (relativePathParts(targetPath, cwd, pathClass).some((part) => part.toLowerCase() === '.git')) {
    return true;
  }
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
