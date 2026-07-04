/**
 * `git` domain (L1) — git integration for a repository on the local disk.
 *
 * Defines the `IGitService` that runs `git status` / `git diff` (plus `gh pr
 * view`) against a repository identified by an absolute `cwd`. App-scoped; it
 * spawns `git` / `gh` through the `os/interface` process service rather than a
 * Session's execution environment, so it never depends on a Session. Path
 * confinement is the caller's responsibility — the service receives
 * already-resolved absolute `cwd` and repo-relative paths.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { FsDiffResponse, FsGitStatusResponse } from '@moonshot-ai/protocol';

export interface IGitService {
  readonly _serviceBrand: undefined;

  /**
   * `git status` for the repo at `cwd`. `pathFilter`, when provided, restricts
   * `entries` to the given repo-relative posix paths; `branch` / `ahead` /
   * `behind` / `additions` / `deletions` / `pullRequest` always reflect the
   * the whole tree. Throws `FS_GIT_UNAVAILABLE` when `cwd` is not a git work
   * tree or git itself fails.
   */
  status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse>;
  /**
   * `git diff HEAD -- <relPath>` for the repo at `cwd`. `relPath` is the
   * repo-relative posix path passed to git; `absPath` is the confined absolute
   * path used only to tell "clean file" apart from "path does not exist".
   * Throws `FS_GIT_UNAVAILABLE` on git failure, `FS_PATH_NOT_FOUND` when the path
   * is missing.
   */
  diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse>;
}

export const IGitService: ServiceIdentifier<IGitService> =
  createDecorator<IGitService>('gitService');
