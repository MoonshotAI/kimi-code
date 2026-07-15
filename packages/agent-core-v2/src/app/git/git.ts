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

  status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse>;
  diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse>;
}

export const IGitService: ServiceIdentifier<IGitService> =
  createDecorator<IGitService>('gitService');
