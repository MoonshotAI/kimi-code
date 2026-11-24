import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type { FsBrowseEntry, FsBrowseResponse, FsHomeResponse } from './hostFolderBrowser';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IProjectService } from '#/app/project/project';

import {
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IHostFolderBrowser,
  RECENT_ROOTS_LIMIT,
} from './hostFolderBrowser';

export class HostFolderBrowser implements IHostFolderBrowser {
  declare readonly _serviceBrand: undefined;

  constructor(@IProjectService private readonly registry: IProjectService) {}

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

    const entries: FsBrowseEntry[] = [];
    for (const d of dirents) {
      const entryPath = join(realTarget, d.name);
      if (d.isDirectory()) {
        entries.push({ name: d.name, path: entryPath, is_dir: true as const });
      } else if (d.isSymbolicLink()) {
        try {
          const targetStat = await stat(entryPath);
          if (targetStat.isDirectory()) {
            entries.push({ name: d.name, path: entryPath, is_dir: true as const });
          }
        } catch {
          // Ignore broken symlinks, loops (ELOOP), or unreadable targets.
        }
      }
    }

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
  ScopeActivation.OnScopeCreated,
  'hostFolderBrowser',
);
