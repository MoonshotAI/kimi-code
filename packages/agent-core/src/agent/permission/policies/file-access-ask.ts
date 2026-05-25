import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { Agent } from '../..';
import type { ToolResourceAccess } from '../../../loop/tool-access';
import { isWithinDirectory, type PathClass } from '../../../tools/policies/path-access';
import { isSensitiveFile } from '../../../tools/policies/sensitive';
import {
  findGitWorkTreeMarker,
  type GitWorkTreeMarker,
} from '../../../tools/support/git-worktree';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class SensitiveFileAccessAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'sensitive-file-access-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const pathClass = this.agent.runtime.kaos.pathClass();
    const access = firstFileAccess(context, (fileAccess) =>
      fileAccess.path === undefined ? false : isSensitiveFile(fileAccess.path, pathClass),
    );
    if (access === undefined) return undefined;
    return {
      kind: 'ask',
      reason: fileAccessReason(access, { sensitive_path: true }),
    };
  }
}

export class GitControlPathAccessAskPermissionPolicy implements PermissionPolicy {
  private readonly gitMarkerCache = new Map<string, GitWorkTreeMarker | null>();
  readonly name = 'git-control-path-access-ask';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return undefined;
    const pathClass = this.agent.runtime.kaos.pathClass();
    const accesses = fileAccesses(context);
    if (accesses.length === 0) return undefined;

    const directGitAccess = accesses.find((fileAccess) => {
      if (fileAccess.path === undefined) return false;
      return hasGitPathComponent(fileAccess.path, cwd, pathClass);
    });
    if (directGitAccess !== undefined) {
      return {
        kind: 'ask',
        reason: fileAccessReason(directGitAccess, { git_control_path: true }),
      };
    }

    const marker = await this.findGitMarker(cwd);
    if (marker === null) return undefined;
    const access = accesses.find((fileAccess) => {
      if (fileAccess.path === undefined) return false;
      return isGitControlPath(fileAccess.path, marker, pathClass);
    });
    if (access === undefined) return undefined;
    return {
      kind: 'ask',
      reason: fileAccessReason(access, { git_control_path: true }),
    };
  }

  private async findGitMarker(cwd: string): Promise<GitWorkTreeMarker | null> {
    if (this.gitMarkerCache.has(cwd)) return this.gitMarkerCache.get(cwd) ?? null;
    const marker = await findGitWorkTreeMarker(this.agent.runtime.kaos, cwd);
    this.gitMarkerCache.set(cwd, marker);
    return marker;
  }
}

export class CwdOutsideFileAccessAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'cwd-outside-file-access-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return undefined;
    const pathClass = this.agent.runtime.kaos.pathClass();
    const access = firstFileAccess(context, (fileAccess) => {
      if (fileAccess.path === undefined) return false;
      return !isWithinDirectory(fileAccess.path, cwd, pathClass);
    });
    if (access === undefined) return undefined;
    return {
      kind: 'ask',
      reason: fileAccessReason(access, { cwd_outside: true }),
    };
  }
}

type FileAccess = Extract<ToolResourceAccess, { kind: 'file' }>;

function firstFileAccess(
  context: PermissionPolicyContext,
  predicate: (access: FileAccess) => boolean,
): FileAccess | undefined {
  return fileAccesses(context).find((access) => predicate(access));
}

function fileAccesses(context: PermissionPolicyContext): FileAccess[] {
  return (
    context.execution.accesses?.filter((access): access is FileAccess => access.kind === 'file') ??
    []
  );
}

function fileAccessReason(access: FileAccess, extra: Record<string, boolean>) {
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
