/**
 * `hostFolderBrowser` domain (L2) — `IHostFolderBrowser` implementation.
 *
 * Browses the real local filesystem through `node:fs/promises` and derives
 * `recent_roots` from the process-wide `IWorkspaceRegistry`. Bound at App
 * scope. Mirrors the v1 `WorkspaceFsService` behaviour so the `/api/v1`
 * transport stays wire-compatible: realpath resolution, directory-only
 * entries, git metadata, dot-last sorting, and `parent` resolution.
 */

import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type { FsBrowseEntry, FsBrowseResponse, FsHomeResponse } from './hostFolderBrowser';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IWorkspaceRegistry } from '#/app/workspaceRegistry/workspaceRegistry';

import {
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IHostFolderBrowser,
  RECENT_ROOTS_LIMIT,
} from './hostFolderBrowser';

export class HostFolderBrowser implements IHostFolderBrowser {
  declare readonly _serviceBrand: undefined;

  constructor(@IWorkspaceRegistry private readonly registry: IWorkspaceRegistry) {}

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

    const dirOnly = dirents.filter((d) => d.isDirectory());
    const entries: FsBrowseEntry[] = await Promise.all(
      dirOnly.map(async (d) => {
        const childAbs = join(realTarget, d.name);
        const git = await detectGit(childAbs);
        return {
          name: d.name,
          path: childAbs,
          is_dir: true as const,
          is_git_repo: git.is_git_repo,
          branch: git.branch ?? undefined,
        };
      }),
    );

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

interface GitInfo {
  readonly is_git_repo: boolean;
  readonly branch: string | null;
}

async function detectGit(root: string): Promise<GitInfo> {
  let dotGit;
  try {
    dotGit = await lstat(join(root, '.git'));
  } catch {
    return { is_git_repo: false, branch: null };
  }

  let gitDir: string;
  if (dotGit.isDirectory()) {
    gitDir = join(root, '.git');
  } else if (dotGit.isFile()) {
    let text: string;
    try {
      text = await readFile(join(root, '.git'), 'utf8');
    } catch {
      return { is_git_repo: false, branch: null };
    }
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (m === null) return { is_git_repo: false, branch: null };
    const ref = m[1] ?? '';
    if (ref === '') return { is_git_repo: false, branch: null };
    gitDir = ref.trim();
    if (!gitDir.startsWith('/')) {
      gitDir = join(root, gitDir);
    }
  } else {
    return { is_git_repo: false, branch: null };
  }

  let head: string;
  try {
    head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    return { is_git_repo: true, branch: null };
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return { is_git_repo: true, branch: ref ? (ref[1] ?? null) : null };
}

registerScopedService(
  LifecycleScope.App,
  IHostFolderBrowser,
  HostFolderBrowser,
  InstantiationType.Eager,
  'hostFolderBrowser',
);
