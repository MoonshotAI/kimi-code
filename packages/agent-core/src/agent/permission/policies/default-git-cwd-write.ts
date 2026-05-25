import * as posixPath from 'node:path/posix';

import type { Kaos } from '@moonshot-ai/kaos';

import type { Agent } from '../..';
import {
  DEFAULT_WORKSPACE_ACCESS_POLICY,
  isWithinDirectory,
  resolvePathAccess,
} from '../../../tools/policies/path-access';
import { isSensitiveFile } from '../../../tools/policies/sensitive';
import {
  findGitWorkTreeMarker,
  type GitWorkTreeMarker,
} from '../../../tools/support/git-worktree';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../policy';

const AUTO_REASON = 'default_git_cwd_write';
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export class DefaultGitCwdWritePermissionPolicy implements PermissionPolicy {
  // Cache positive marker lookups only. A session that starts in a non-git
  // directory and later `git init`s should pick up the new work tree on the
  // next call; negative results pay one extra stat per call, which is
  // acceptable.
  private readonly cache = new Map<string, GitWorkTreeMarker>();
  readonly name = 'default.git-cwd-write';

  constructor(private readonly agent: Agent) {}

  async evaluate({
    matchedRule,
    toolCall,
    args,
  }: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    if (this.agent.permission.mode !== 'manual') return undefined;
    if (matchedRule !== undefined) return undefined;

    const name = toolCall.function.name;
    if (name !== 'Write' && name !== 'Edit') return undefined;

    const kaos = this.agent.runtime.kaos;
    const pathClass = kaos.pathClass();
    if (pathClass !== 'posix') return undefined;

    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return undefined;

    const path = readStringField(args, 'path');
    if (path === undefined) return undefined;

    let access;
    try {
      access = resolvePathAccess(
        path,
        cwd,
        { workspaceDir: cwd, additionalDirs: [] },
        {
          operation: 'write',
          pathClass,
          homeDir: kaos.gethome(),
          policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
        },
      );
    } catch {
      return undefined;
    }
    if (access.outsideWorkspace) return undefined;

    const marker = this.cache.get(cwd) ?? (await findGitWorkTreeMarker(kaos, cwd));
    if (marker === null) return undefined;
    this.cache.set(cwd, marker);

    if (isGitControlPath(access.path, cwd, marker)) return undefined;
    if (isSensitiveFile(access.path.toLowerCase(), 'posix')) return undefined;
    if (await hasSymlinkInPath(kaos, cwd, access.path)) return undefined;

    this.agent.telemetry.track('tool_approved', {
      tool_name: name,
      approval_mode: 'manual',
      auto_reason: AUTO_REASON,
    });
    return { kind: 'allow' };
  }
}

function readStringField(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function isGitControlPath(targetPath: string, cwd: string, marker: GitWorkTreeMarker): boolean {
  const foldedTarget = targetPath.toLowerCase();
  return (
    posixPath.relative(cwd.toLowerCase(), foldedTarget).split(posixPath.sep).includes('.git') ||
    isWithinDirectory(foldedTarget, marker.dotGitPath.toLowerCase(), 'posix') ||
    isWithinDirectory(foldedTarget, marker.controlDirPath.toLowerCase(), 'posix')
  );
}

async function hasSymlinkInPath(kaos: Kaos, cwd: string, targetPath: string): Promise<boolean> {
  const relative = posixPath.relative(cwd, targetPath);
  const parts = [cwd];

  let current = cwd;
  for (const part of relative.split(posixPath.sep)) {
    if (part.length === 0 || part === '.') continue;
    current = posixPath.join(current, part);
    parts.push(current);
  }

  for (let index = 0; index < parts.length; index += 1) {
    try {
      const stat = await kaos.stat(parts[index]!, { followSymlinks: false });
      if ((stat.stMode & S_IFMT) === S_IFLNK) return true;
    } catch (error) {
      return !(index === parts.length - 1 && isFileNotFoundError(error));
    }
  }
  return false;
}

function isFileNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if ((error as { name?: unknown }).name === 'KaosFileNotFoundError') return true;
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 2) return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('ENOENT') || message.includes('ENOTDIR');
}
