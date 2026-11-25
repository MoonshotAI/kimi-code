import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  ISessionActivityView,
  ISessionIndex,
  IWorkspaceService,
  getLiveSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { Workspace } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';

import { ErrorCode } from '../../protocol/error-codes';
import type {
  DeleteSessionWorktreeOutcome,
  InspectWorktreesResponse,
  ListWorktreesResponse,
  RemoveWorktreeResponse,
  WorktreeRemoveFailedDetails,
} from '../../protocol/rest-worktree';
import type { Worktree, WorktreeSessionRef } from '../../protocol/worktree';
import { gitText, runCommand, runGit } from './command';
import { headBranch, listWorktrees } from './gitRefs';
import { publishSessionUpdated } from './sessionUpdates';
import type { SessionWorktreeService } from './sessionWorktreeService';
import { forgetWorktreeFacts, storedSessionWorktree } from './sessionWorktreeState';
import { WorktreeError } from './worktreeError';

interface KnownWorktree {
  readonly path: string;
  readonly key: string;
  readonly repoRoot: string;
  readonly branch?: string;
  readonly origin: Worktree['origin'];
  readonly createdAt?: string;
  readonly workspace?: Workspace;
  readonly exists: boolean;
}

type SessionsByDirectory = ReadonlyMap<string, readonly WorktreeSessionRef[]>;

const IN_USE_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const DU_TIMEOUT_MS = 10 * 60_000;

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
}

async function walkSize(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await walkSize(path);
      continue;
    }
    const info = await lstat(path).catch(() => undefined);
    if (info !== undefined) total += info.blocks > 0 ? info.blocks * 512 : info.size;
  }
  return total;
}

async function directorySize(directory: string): Promise<number> {
  if (process.platform !== 'win32') {
    const du = await runCommand('du', ['-sk', directory], { cwd: directory, timeoutMs: DU_TIMEOUT_MS });
    const kilobytes = Number.parseInt(du.stdout, 10);
    if (Number.isFinite(kilobytes)) return kilobytes * 1024;
  }
  return walkSize(directory);
}

export class WorktreeInventory {
  private readonly sizes = new Map<string, number>();
  private readonly sizing = new Map<string, Promise<void>>();

  constructor(
    private readonly core: Scope,
    private readonly sessionWorktrees: SessionWorktreeService,
  ) {}

  private async known(): Promise<readonly KnownWorktree[]> {
    const workspaces = await this.core.accessor.get(IWorkspaceService).list();
    const workspaceByRoot = new Map<string, Workspace>();
    for (const workspace of workspaces) {
      const key = await canonical(workspace.root);
      if (!workspaceByRoot.has(key)) workspaceByRoot.set(key, workspace);
    }
    const linked = new Map<string, KnownWorktree>();
    const scannedRepos = new Set<string>();
    const scan = async (directory: string): Promise<void> => {
      const worktrees = await listWorktrees(directory);
      const main = worktrees[0];
      if (main === undefined) return;
      const repoRoot = await canonical(main.path);
      if (scannedRepos.has(repoRoot)) return;
      scannedRepos.add(repoRoot);
      for (const worktree of worktrees.slice(1)) {
        const key = await canonical(worktree.path);
        linked.set(key, {
          path: worktree.path,
          key,
          repoRoot,
          branch: worktree.branch,
          origin: 'external',
          workspace: workspaceByRoot.get(repoRoot),
          exists: await isDirectory(worktree.path),
        });
      }
    };
    for (const root of workspaceByRoot.keys()) await scan(root);
    const registered = await this.sessionWorktrees.registry.list();
    for (const entry of registered) {
      if (!scannedRepos.has(await canonical(entry.repo_root))) await scan(entry.repo_root);
    }
    for (const entry of registered) {
      const key = await canonical(entry.path);
      const found = linked.get(key);
      const repoRoot = found?.repoRoot ?? (await canonical(entry.repo_root));
      linked.set(key, {
        path: entry.path,
        key,
        repoRoot,
        branch: found?.branch ?? entry.branch,
        origin: 'product',
        createdAt: entry.created_at,
        workspace:
          workspaces.find((workspace) => workspace.id === entry.workspace_id) ??
          workspaceByRoot.get(repoRoot),
        exists: found?.exists ?? (await isDirectory(entry.path)),
      });
    }
    return [...linked.values()];
  }

  private async find(path: string): Promise<KnownWorktree> {
    const key = await canonical(path);
    const found = (await this.known()).find((worktree) => worktree.key === key);
    if (found === undefined) {
      throw new WorktreeError(ErrorCode.WORKTREE_NOT_FOUND, `${path} is not a known worktree`);
    }
    return found;
  }

  private async sessionsByDirectory(): Promise<SessionsByDirectory> {
    const page = await this.core.accessor.get(ISessionIndex).listRecent({ includeArchived: true });
    const sessions = new Map<string, WorktreeSessionRef[]>();
    const canonicalByCwd = new Map<string, string>();
    for (const summary of page.items) {
      if (summary.cwd === undefined) continue;
      let key = canonicalByCwd.get(summary.cwd);
      if (key === undefined) {
        key = await canonical(summary.cwd);
        canonicalByCwd.set(summary.cwd, key);
      }
      const live = getLiveSessionById(this.core.accessor, summary.id);
      const activity = live?.accessor.get(ISessionActivityView).state();
      const refs = sessions.get(key) ?? [];
      refs.push({
        id: summary.id,
        title: summary.title ?? '',
        archived: summary.archived,
        busy:
          activity?.busy === true ||
          activity?.mainTurnActive === true ||
          storedSessionWorktree(summary.custom)?.setup.status === 'running',
      });
      sessions.set(key, refs);
    }
    return sessions;
  }

  private measure(worktree: KnownWorktree): Promise<void> {
    let pending = this.sizing.get(worktree.key);
    if (pending === undefined) {
      pending = directorySize(worktree.path)
        .then((bytes) => {
          this.sizes.set(worktree.key, bytes);
        })
        .catch(() => undefined)
        .finally(() => this.sizing.delete(worktree.key));
      this.sizing.set(worktree.key, pending);
    }
    return pending;
  }

  async list(refreshSizes: boolean): Promise<ListWorktreesResponse> {
    const [known, sessions] = await Promise.all([this.known(), this.sessionsByDirectory()]);
    const present = known.filter((worktree) => worktree.exists);
    if (refreshSizes) {
      await Promise.all(present.map((worktree) => this.measure(worktree)));
    } else {
      for (const worktree of present) {
        if (!this.sizes.has(worktree.key)) void this.measure(worktree);
      }
    }
    const items: Worktree[] = present
      .map((worktree) => ({
        path: worktree.path,
        name: basename(worktree.path),
        repo_root: worktree.repoRoot,
        workspace_id: worktree.workspace?.id,
        workspace_name: worktree.workspace?.name,
        branch: worktree.branch,
        origin: worktree.origin,
        created_at: worktree.createdAt,
        size_bytes: this.sizes.get(worktree.key),
        sessions: [...(sessions.get(worktree.key) ?? [])],
      }))
      .toSorted((a, b) => a.path.localeCompare(b.path));
    const sized = items.every((item) => item.size_bytes !== undefined);
    return {
      items,
      total_size_bytes: sized
        ? items.reduce((total, item) => total + (item.size_bytes ?? 0), 0)
        : undefined,
    };
  }

  async inspect(paths: readonly string[]): Promise<InspectWorktreesResponse> {
    const [known, sessions] = await Promise.all([this.known(), this.sessionsByDirectory()]);
    const items: InspectWorktreesResponse['items'] = [];
    const errors: InspectWorktreesResponse['errors'] = {};
    for (const path of new Set(paths)) {
      const key = await canonical(path);
      const worktree = known.find((candidate) => candidate.key === key);
      if (worktree === undefined || !worktree.exists) {
        errors[path] = {
          code: ErrorCode.WORKTREE_NOT_FOUND,
          msg:
            worktree === undefined
              ? `${path} is not a known worktree`
              : `worktree directory ${path} does not exist`,
        };
        continue;
      }
      const [status, unpushed, branch] = await Promise.all([
        runGit(worktree.path, ['status', '--porcelain', '--untracked-files=all']),
        gitText(worktree.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']),
        headBranch(worktree.path),
      ]);
      if (status.exitCode !== 0) {
        errors[path] = { code: ErrorCode.FS_GIT_UNAVAILABLE, msg: status.output.trim() };
        continue;
      }
      items.push({
        path,
        branch,
        uncommitted_files: status.stdout.split('\n').filter((line) => line.length > 0).length,
        unpushed_commits: Number.parseInt(unpushed ?? '0', 10) || 0,
        sessions: [...(sessions.get(key) ?? [])],
      });
    }
    return { items, errors };
  }

  async remove(path: string, deleteBranch: boolean): Promise<RemoveWorktreeResponse> {
    const worktree = await this.find(path);
    const sessions = (await this.sessionsByDirectory()).get(worktree.key) ?? [];
    if (sessions.some((session) => session.busy)) {
      throw removeFailed(path, 'session_busy', 'a session that uses this worktree is running');
    }
    const branchDeleted = await this.discard(worktree, deleteBranch);
    for (const session of sessions) publishSessionUpdated(this.core, session.id);
    return { removed: true, branch_deleted: branchDeleted };
  }

  private async discard(worktree: KnownWorktree, deleteBranch: boolean): Promise<boolean> {
    const branch = worktree.exists
      ? ((await headBranch(worktree.path)) ?? worktree.branch)
      : worktree.branch;
    if (worktree.exists) {
      const removed = await runGit(worktree.repoRoot, ['worktree', 'remove', '--force', worktree.path]);
      if (removed.exitCode !== 0 || (await isDirectory(worktree.path))) {
        try {
          await rm(worktree.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? '';
          throw removeFailed(
            worktree.path,
            IN_USE_CODES.has(code) ? 'in_use' : 'unknown',
            `${removed.output}${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    await runGit(worktree.repoRoot, ['worktree', 'prune']);
    await this.sessionWorktrees.registry.remove(worktree.path);
    this.sizes.delete(worktree.key);
    forgetWorktreeFacts({ repo_root: worktree.repoRoot, path: worktree.path, branch });
    if (!deleteBranch || branch === undefined) return false;
    const deleted = await runGit(worktree.repoRoot, ['branch', '-D', branch]);
    return deleted.exitCode === 0;
  }

  async removeAfterSessionDeletion(
    directory: string,
    deleteBranch: boolean,
  ): Promise<DeleteSessionWorktreeOutcome | undefined> {
    const key = await canonical(directory);
    const worktree = (await this.known()).find((candidate) => candidate.key === key);
    if (worktree === undefined) return undefined;
    const others = (await this.sessionsByDirectory()).get(key) ?? [];
    if (others.length > 0) return { outcome: 'kept_in_use', other_sessions: others.length };
    try {
      const branchDeleted = await this.discard(worktree, deleteBranch);
      return { outcome: worktree.exists ? 'removed' : 'missing', branch_deleted: branchDeleted };
    } catch (error) {
      const details = error instanceof WorktreeError ? (error.details as WorktreeRemoveFailedDetails) : undefined;
      return {
        outcome: 'failed',
        output: details?.output ?? (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async lookup(path: string): Promise<
    | {
        readonly repoRoot: string;
        readonly branch?: string;
        readonly workspace?: Workspace;
        readonly sessionCount: number;
      }
    | undefined
  > {
    if (!(await isDirectory(path))) return undefined;
    const key = await canonical(path);
    const top = await gitText(path, ['rev-parse', '--show-toplevel']);
    if (top === undefined || (await canonical(top)) !== key) return undefined;
    const worktrees = await listWorktrees(path);
    const main = worktrees[0];
    if (main === undefined) return undefined;
    const repoRoot = await canonical(main.path);
    if (repoRoot === key) return undefined;
    const workspaces = await this.core.accessor.get(IWorkspaceService).list();
    let workspace: Workspace | undefined;
    for (const candidate of workspaces) {
      if ((await canonical(candidate.root)) === repoRoot) {
        workspace = candidate;
        break;
      }
    }
    return {
      repoRoot,
      branch: await headBranch(path),
      workspace,
      sessionCount: ((await this.sessionsByDirectory()).get(key) ?? []).length,
    };
  }

  async enclosingRepoRoot(path: string): Promise<string | undefined> {
    if (!(await isDirectory(path))) return undefined;
    const top = await gitText(path, ['rev-parse', '--show-toplevel']);
    if (top === undefined || top.length === 0) return undefined;
    const root = await canonical(top);
    return root === (await canonical(path)) ? undefined : root;
  }
}

function removeFailed(
  path: string,
  reason: WorktreeRemoveFailedDetails['reason'],
  output: string,
): WorktreeError {
  const details: WorktreeRemoveFailedDetails = { reason, output };
  return new WorktreeError(
    ErrorCode.WORKTREE_REMOVE_FAILED,
    `worktree ${path} could not be removed: ${reason === 'session_busy' ? output : reason}`,
    details,
  );
}
