import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { Agent } from '../..';
import type { ToolFileAccess } from '../../../loop/tool-access';
import { isWithinDirectory, type PathClass } from '../../../tools/policies/path-access';
import { isSensitiveFile } from '../../../tools/policies/sensitive';
import {
  findGitWorkTreeMarker,
  type GitWorkTreeMarker,
} from '../../../tools/support/git-worktree';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class SensitiveFileAccessAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'sensitive-file-access-ask';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const access = fileAccesses(context).find((fileAccess) =>
      isSensitiveFile(fileAccess.path),
    );
    if (access === undefined) return;
    return {
      kind: 'ask',
      reason: fileAccessReason(access, { sensitive_path: true }),
    };
  }
}

export class GitControlPathAccessAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'git-control-path-access-ask';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return;
    const pathClass = this.agent.kaos.pathClass();
    const accesses = fileAccesses(context);
    if (accesses.length === 0) return;

    const directGitAccess = accesses.find((fileAccess) => {
      return hasGitPathComponent(fileAccess.path, cwd, pathClass);
    });
    if (directGitAccess !== undefined) {
      return {
        kind: 'ask',
        reason: fileAccessReason(directGitAccess, { git_control_path: true }),
      };
    }

    const marker = await findGitWorkTreeMarker(this.agent.kaos, cwd);
    if (marker === null) return;
    const access = accesses.find((fileAccess) => {
      return isGitControlPath(fileAccess.path, marker, pathClass);
    });
    if (access === undefined) return;
    return {
      kind: 'ask',
      reason: fileAccessReason(access, { git_control_path: true }),
    };
  }
}

function fileAccesses(context: PermissionPolicyContext): ToolFileAccess[] {
  return (
    context.execution.accesses?.filter((access): access is ToolFileAccess => access.kind === 'file') ??
    []
  );
}

export function writeFileAccesses(context: PermissionPolicyContext): ToolFileAccess[] {
  return fileAccesses(context).filter(
    (access) => access.operation === 'write' || access.operation === 'readwrite',
  );
}

function fileAccessReason(access: ToolFileAccess, extra: Record<string, boolean>) {
  return {
    file_access_operation: access.operation,
    recursive: access.recursive === true,
    ...extra,
  };
}

function hasGitPathComponent(
  targetPath: string,
  cwd: string,
  pathClass: PathClass,
): boolean {
  return relativePathParts(targetPath, cwd, pathClass).some((part) => part.toLowerCase() === '.git');
}

function isGitControlPath(
  targetPath: string,
  marker: GitWorkTreeMarker,
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
