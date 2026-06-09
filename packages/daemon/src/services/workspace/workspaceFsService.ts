/**
 * `WorkspaceFsService` — implementation of `IWorkspaceFsService`.
 *
 * See `workspaceFs.ts` for the contract + error mapping overview.
 *
 * **Realpath consistency**: macOS routes `/tmp` to `/private/tmp`; we
 * always `realpath` before `readdir` and report the resolved path back to
 * the client. The recent-roots list is sourced from
 * `IWorkspaceRegistry.list()`, which itself records realpath'd roots, so
 * the picker round-trips cleanly into `POST /workspaces { root }`.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { Disposable } from '@moonshot-ai/agent-core';

import type { FsBrowseEntry, FsBrowseResponse, FsHomeResponse } from '@moonshot-ai/protocol';

import { IWorkspaceRegistry } from './workspaceRegistry';
import {
  IWorkspaceFsService,
  RECENT_ROOTS_LIMIT,
  WorkspaceFsNotAbsoluteError,
  WorkspaceFsNotFoundError,
  WorkspaceFsPermissionError,
} from './workspaceFs';
import { detectGit } from './workspaceRegistryService';

export class WorkspaceFsService extends Disposable implements IWorkspaceFsService {
  readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceRegistry private readonly registry: IWorkspaceRegistry,
  ) {
    super();
  }

  async browse(absPath?: string): Promise<FsBrowseResponse> {
    const target = absPath ?? os.homedir();
    if (!isAbsolute(target)) {
      throw new WorkspaceFsNotAbsoluteError(target);
    }
    let realTarget: string;
    try {
      realTarget = await fsp.realpath(target);
    } catch (err) {
      throw mapFsError(err, target);
    }
    let dirents;
    try {
      dirents = await fsp.readdir(realTarget, { withFileTypes: true });
    } catch (err) {
      throw mapFsError(err, realTarget);
    }
    const dirOnly = dirents.filter((d) => d.isDirectory());
    // Probe git for each in parallel. Cheap (lstat + readFile) — see
    // `detectGit` in workspaceRegistryService.ts.
    const entries: FsBrowseEntry[] = await Promise.all(
      dirOnly.map(async (d) => {
        const childAbs = join(realTarget, d.name);
        const git = await detectGit(childAbs);
        const base: FsBrowseEntry = {
          name: d.name,
          path: childAbs,
          is_dir: true,
          is_git_repo: git.is_git_repo,
        };
        if (git.branch !== null) {
          return { ...base, branch: git.branch };
        }
        return base;
      }),
    );
    // Sort: non-dot first, dot-prefixed last; alpha within each bucket.
    entries.sort(compareBrowseEntries);

    const parent = dirname(realTarget);
    return {
      path: realTarget,
      parent: parent === realTarget ? null : parent,
      entries,
    };
  }

  async home(): Promise<FsHomeResponse> {
    const home = os.homedir();
    const workspaces = await this.registry.list();
    const recent_roots = workspaces.slice(0, RECENT_ROOTS_LIMIT).map((w) => w.root);
    return { home, recent_roots };
  }

  override dispose(): void {
    if (this._isDisposed) return;
    super.dispose();
  }
}

/* -------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

function mapFsError(err: unknown, path: string): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new WorkspaceFsNotFoundError(path);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new WorkspaceFsPermissionError(path);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function compareBrowseEntries(a: FsBrowseEntry, b: FsBrowseEntry): number {
  const aDot = a.name.startsWith('.');
  const bDot = b.name.startsWith('.');
  if (aDot !== bDot) return aDot ? 1 : -1;
  return a.name.localeCompare(b.name);
}
