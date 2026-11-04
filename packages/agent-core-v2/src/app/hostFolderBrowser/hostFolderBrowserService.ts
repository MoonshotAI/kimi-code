import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type { FsBrowseEntry, FsBrowseResponse, FsHomeResponse } from './hostFolderBrowser';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEnvironmentService } from '#/app/environment/environment';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { LOCAL_ENVIRONMENT_ID, type EnvironmentPath } from '#/environment/environment';
import { POSIX_ENVIRONMENT_PATH } from '#/environment/environmentDefaults';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

import {
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IHostFolderBrowser,
  RECENT_ROOTS_LIMIT,
} from './hostFolderBrowser';

export class HostFolderBrowser implements IHostFolderBrowser {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceService private readonly registry: IWorkspaceService,
    @IEnvironmentService private readonly environments: IEnvironmentService,
  ) {}

  async browse(absPath?: string, environmentId = LOCAL_ENVIRONMENT_ID): Promise<FsBrowseResponse> {
    if (environmentId !== LOCAL_ENVIRONMENT_ID) return this.browseEnvironment(absPath, environmentId);
    const target = absPath ?? homedir();
    if (!isAbsolute(target)) {
      throw new HostFolderNotAbsoluteError(target);
    }

    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch (error) {
      throw mapFsError(error, target);
    }

    let dirents;
    try {
      dirents = await readdir(realTarget, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, realTarget);
    }

    return browseResponse(realTarget, dirents.filter((d) => d.isDirectory()).map((d) => d.name), { join, dirname });
  }

  private async browseEnvironment(absPath: string | undefined, environmentId: string): Promise<FsBrowseResponse> {
    const lease = await this.environments.acquireWhenReady({ environmentId }, ['fs']);
    try {
      const { fs, host } = lease.environment;
      const path = lease.environment.path ?? POSIX_ENVIRONMENT_PATH;
      const target = absPath ?? host?.homeDir;
      if (target === undefined || !path.isAbsolute(target)) {
        throw new HostFolderNotAbsoluteError(target ?? '');
      }
      let realTarget: string;
      let names: string[];
      try {
        realTarget = await fs!.realpath(target);
        names = (await fs!.readdir(realTarget)).filter((entry) => entry.isDirectory).map((entry) => entry.name);
      } catch (error) {
        throw mapFsError(error, target);
      }
      return browseResponse(realTarget, names, path);
    } finally {
      lease.dispose();
    }
  }

  async home(): Promise<FsHomeResponse> {
    const home = homedir();
    const workspaces = await this.registry.list();
    const recent_roots = workspaces.slice(0, RECENT_ROOTS_LIMIT).map((w) => w.root);
    return { home, recent_roots };
  }
}

function browseResponse(
  realTarget: string,
  names: readonly string[],
  path: Pick<EnvironmentPath, 'join' | 'dirname'>,
): FsBrowseResponse {
  const entries: FsBrowseEntry[] = names.map((name) => ({
    name,
    path: path.join(realTarget, name),
    is_dir: true as const,
  }));
  entries.sort(compareBrowseEntries);
  const parent = path.dirname(realTarget);
  return {
    path: realTarget,
    parent: parent === realTarget ? null : parent,
    entries,
  };
}

function mapFsError(err: unknown, path: string): Error {
  const code = err instanceof HostFsError ? err.code : (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === OsFsErrors.codes.OS_FS_NOT_FOUND || code === OsFsErrors.codes.OS_FS_NOT_DIRECTORY) {
    return new HostFolderNotFoundError(path);
  }
  if (code === 'EACCES' || code === 'EPERM' || code === OsFsErrors.codes.OS_FS_PERMISSION_DENIED) {
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
