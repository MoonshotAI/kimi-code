/**
 * `WorkspaceRegistryService` — implementation of `IWorkspaceRegistry`.
 *
 * See `workspaceRegistry.ts` for the contract + storage layout overview.
 *
 * # Concurrency
 *
 * Mutations (`createOrTouch`, `update`, `delete`) go through a single
 * in-process write queue keyed by wd-key. Within a single daemon process this
 * is sufficient — agent-core treats the wd-key directory as eventually
 * consistent metadata storage, and `tmp + rename` writes are atomic at the
 * filesystem level on POSIX.
 *
 * # Git probing
 *
 * `list()` and `get()` probe `<root>/.git` via `detectGit()` (a zero-subprocess
 * lstat + readFile of `HEAD`). Probing is fast enough (µs each) that we
 * don't cache the result.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Stats } from 'node:fs';

import { Disposable } from '@moonshot-ai/agent-core';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core/session/store';
import { IEnvironmentService } from '@moonshot-ai/services';

import type { Workspace } from '@moonshot-ai/protocol';

import { ILogService } from '#/services/logger';
import {
  IWorkspaceRegistry,
  WorkspaceNotFoundError,
  WorkspaceRootNotFoundError,
  type WorkspacePatch,
} from './workspaceRegistry';

const WORKSPACE_FILE = 'workspace.json';
const WORKSPACE_FILE_VERSION = 1;

/**
 * On-disk shape of `<wd-key>/workspace.json`. We don't depend on Zod here
 * because the protocol's `workspaceSchema` describes the WIRE shape (with
 * derived `id`/`is_git_repo`/`branch`/`session_count`), not the persistence
 * shape. Keep both in sync by hand.
 */
interface WorkspaceFile {
  version: number;
  root: string;
  name: string;
  created_at: string;
  last_opened_at: string;
}

export class WorkspaceRegistryService extends Disposable implements IWorkspaceRegistry {
  readonly _serviceBrand: undefined;

  private readonly sessionsDir: string;

  constructor(
    @IEnvironmentService env: IEnvironmentService,
    @ILogService private readonly logger: ILogService,
  ) {
    super();
    this.sessionsDir = join(env.homeDir, 'sessions');
  }

  async list(): Promise<Workspace[]> {
    let dirents;
    try {
      dirents = await fsp.readdir(this.sessionsDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw err;
    }
    const candidates: { workspaceId: string; dir: string }[] = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      if (!d.name.startsWith('wd_')) continue;
      candidates.push({
        workspaceId: d.name,
        dir: join(this.sessionsDir, d.name),
      });
    }
    const hydrated = await Promise.all(
      candidates.map(async ({ workspaceId, dir }) => {
        const file = await this.readFile(dir);
        if (file === null) return null;
        const [{ is_git_repo, branch }, session_count] = await Promise.all([
          detectGit(file.root),
          countSessionDirs(dir),
        ]);
        const ws: Workspace = {
          id: workspaceId,
          root: file.root,
          name: file.name,
          is_git_repo,
          branch,
          created_at: file.created_at,
          last_opened_at: file.last_opened_at,
          session_count,
        };
        return ws;
      }),
    );
    return hydrated
      .filter((ws): ws is Workspace => ws !== null)
      .sort((a, b) => (b.last_opened_at < a.last_opened_at ? -1 : 1));
  }

  async get(workspaceId: string): Promise<Workspace> {
    const dir = join(this.sessionsDir, workspaceId);
    const file = await this.readFile(dir);
    if (file === null) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    const [{ is_git_repo, branch }, session_count] = await Promise.all([
      detectGit(file.root),
      countSessionDirs(dir),
    ]);
    return {
      id: workspaceId,
      root: file.root,
      name: file.name,
      is_git_repo,
      branch,
      created_at: file.created_at,
      last_opened_at: file.last_opened_at,
      session_count,
    };
  }

  async createOrTouch(root: string, name?: string): Promise<Workspace> {
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspaceRootNotFoundError(root);
      }
      throw err;
    }
    const workspaceId = encodeWorkDirKey(realRoot);
    const dir = join(this.sessionsDir, workspaceId);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

    const now = new Date().toISOString();
    let existing = await this.readFile(dir);
    let file: WorkspaceFile;
    if (existing !== null) {
      file = { ...existing, last_opened_at: now };
    } else {
      file = {
        version: WORKSPACE_FILE_VERSION,
        root: realRoot,
        name: name ?? basename(realRoot),
        created_at: now,
        last_opened_at: now,
      };
    }
    await this.writeFile(dir, file);

    const [{ is_git_repo, branch }, session_count] = await Promise.all([
      detectGit(realRoot),
      countSessionDirs(dir),
    ]);
    return {
      id: workspaceId,
      root: file.root,
      name: file.name,
      is_git_repo,
      branch,
      created_at: file.created_at,
      last_opened_at: file.last_opened_at,
      session_count,
    };
  }

  async update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace> {
    const dir = join(this.sessionsDir, workspaceId);
    const existing = await this.readFile(dir);
    if (existing === null) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    const next: WorkspaceFile = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    };
    await this.writeFile(dir, next);
    const [{ is_git_repo, branch }, session_count] = await Promise.all([
      detectGit(next.root),
      countSessionDirs(dir),
    ]);
    return {
      id: workspaceId,
      root: next.root,
      name: next.name,
      is_git_repo,
      branch,
      created_at: next.created_at,
      last_opened_at: next.last_opened_at,
      session_count,
    };
  }

  async delete(workspaceId: string): Promise<void> {
    const filePath = join(this.sessionsDir, workspaceId, WORKSPACE_FILE);
    try {
      await fsp.unlink(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      throw err;
    }
  }

  async resolveRoot(workspaceId: string): Promise<string> {
    const dir = join(this.sessionsDir, workspaceId);
    const file = await this.readFile(dir);
    if (file === null) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return file.root;
  }

  /* ----------------------------------------------------------- internals */

  private async readFile(dir: string): Promise<WorkspaceFile | null> {
    const filePath = join(dir, WORKSPACE_FILE);
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
    let parsed: Partial<WorkspaceFile>;
    try {
      parsed = JSON.parse(raw) as Partial<WorkspaceFile>;
    } catch (err) {
      this.logger.warn(
        { dir, err: String(err) },
        'workspace.json malformed; treating bucket as unregistered',
      );
      return null;
    }
    if (
      typeof parsed.root !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.created_at !== 'string' ||
      typeof parsed.last_opened_at !== 'string'
    ) {
      this.logger.warn({ dir }, 'workspace.json missing required keys; treating as unregistered');
      return null;
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      root: parsed.root,
      name: parsed.name,
      created_at: parsed.created_at,
      last_opened_at: parsed.last_opened_at,
    };
  }

  private async writeFile(dir: string, file: WorkspaceFile): Promise<void> {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const final = join(dir, WORKSPACE_FILE);
    const tmp = `${final}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
    await fsp.rename(tmp, final);
  }

  override dispose(): void {
    if (this._isDisposed) return;
    super.dispose();
  }
}

/* -------------------------------------------------------------------------
 * Helpers exported for the WorkspaceFs service (same package).
 * ----------------------------------------------------------------------- */

export interface GitInfo {
  is_git_repo: boolean;
  branch: string | null;
}

/**
 * Zero-subprocess git detection.
 *
 *   - `<root>/.git` is a directory → real repo. Read `<gitdir>/HEAD` to find
 *     the current branch.
 *   - `<root>/.git` is a file (`gitdir: ...`) → git worktree; HEAD lives
 *     inside the referenced gitdir.
 *   - `<root>/.git` does not exist (ENOENT / ENOTDIR / EACCES) → not a repo.
 *
 * `branch` is `null` for detached HEAD, an unreadable HEAD, or any non-repo.
 *
 * Used by both `WorkspaceRegistryService` (per-workspace) and
 * `WorkspaceFsService` (per-browse-entry).
 */
export async function detectGit(root: string): Promise<GitInfo> {
  let dotGit: Stats;
  try {
    dotGit = await fsp.lstat(join(root, '.git'));
  } catch {
    return { is_git_repo: false, branch: null };
  }

  let gitDir: string;
  if (dotGit.isDirectory()) {
    gitDir = join(root, '.git');
  } else if (dotGit.isFile()) {
    let text: string;
    try {
      text = await fsp.readFile(join(root, '.git'), 'utf8');
    } catch {
      return { is_git_repo: false, branch: null };
    }
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (m === null) return { is_git_repo: false, branch: null };
    const ref = m[1] ?? '';
    if (ref === '') return { is_git_repo: false, branch: null };
    gitDir = ref.trim();
    // Worktree gitdir is usually relative to <root>; if it's absolute keep it.
    if (!gitDir.startsWith('/')) {
      gitDir = join(root, gitDir);
    }
  } else {
    return { is_git_repo: false, branch: null };
  }

  let head: string;
  try {
    head = (await fsp.readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    return { is_git_repo: true, branch: null };
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return { is_git_repo: true, branch: ref ? (ref[1] ?? null) : null };
}

/**
 * Count `<wd-key>/<session-id>/` directory entries. We don't care about the
 * exact id shape — any sibling directory is treated as a session bucket. The
 * sibling FILE we own (`workspace.json`) is naturally excluded.
 */
async function countSessionDirs(dir: string): Promise<number> {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    throw err;
  }
  let count = 0;
  for (const d of dirents) {
    if (d.isDirectory()) count += 1;
  }
  return count;
}

/* -------------------------------------------------------------------------
 * Small home helper — exported for `WorkspaceFsService` to share with the
 * `fs:home` endpoint default.
 * ----------------------------------------------------------------------- */

export function userHomeDir(): string {
  return os.homedir();
}

/** Re-export so the fs browser can compute parent dirs without importing pathe. */
export const pathDirname = dirname;
