/**
 * `hostFolderBrowser` domain (L2) — `IHostFolderBrowser` implementation.
 *
 * Browses the real local filesystem through `node:fs/promises` and derives
 * `recent_roots` from the process-wide `IWorkspaceService`. Bound at App
 * scope. Mirrors the v1 `WorkspaceFsService` behaviour so the `/api/v1`
 * transport stays wire-compatible: realpath resolution, directory-only
 * entries, dot-last sorting, and `parent` resolution.
 */

import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type { FsBrowseEntry, FsBrowseResponse, FsHomeResponse } from './hostFolderBrowser';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IWorkspaceService } from '#/app/workspace/workspace';

import {
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IHostFolderBrowser,
  RECENT_ROOTS_LIMIT,
} from './hostFolderBrowser';

export class HostFolderBrowser implements IHostFolderBrowser {
  declare readonly _serviceBrand: undefined;

  constructor(@IWorkspaceService private readonly registry: IWorkspaceService) {}

  async browse(absPath?: string): Promise<FsBrowseResponse> {
    const target = absPath ?? homedir();
    if (!isAbsolute(target)) {
      throw new HostFolderNotAbsoluteError(target);
    }

    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch (err) {
      throw mapFsError(err, target);
    }

    let dirents;
    try {
      dirents = await readdir(realTarget, { withFileTypes: true });
    } catch (err) {
      throw mapFsError(err, realTarget);
    }

    const entries: FsBrowseEntry[] = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({
        name: d.name,
        path: join(realTarget, d.name),
        is_dir: true as const,
      }));

    entries.sort(compareBrowseEntries);

    const parent = dirname(realTarget);
    return {
      path: realTarget,
      parent: parent === realTarget ? null : parent,
      entries,
    };
  }

  async home(): Promise<FsHomeResponse> {
    const home = homedir();
    const workspaces = await this.registry.list();
    const recent_roots = workspaces.slice(0, RECENT_ROOTS_LIMIT).map((w) => w.root);
    return { home, recent_roots };
  }
}

function mapFsError(err: unknown, path: string): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new HostFolderNotFoundError(path);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new HostFolderPermissionError(path);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function compareBrowseEntries(a: FsBrowseEntry, b: FsBrowseEntry): number {
  const aDot = a.name.startsWith('.');
  const bDot = b.name.startsWith('.');
  if (aDot !== bDot) return aDot ? 1 : -1;
  return a.name.localeCompare(b.name);
}

registerScopedService(
  LifecycleScope.App,
  IHostFolderBrowser,
  HostFolderBrowser,
  InstantiationType.Eager,
  'hostFolderBrowser',
);
