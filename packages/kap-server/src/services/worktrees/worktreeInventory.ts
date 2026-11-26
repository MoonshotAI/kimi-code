import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

import {
  ErrorCodes,
  ISessionActivityView,
  ISessionIndex,
  IProjectService,
  IWorktreeService,
  getLiveSessionById,
  isError2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { Project } from '@moonshot-ai/agent-core-v2/app/project/project';

import { ErrorCode } from '../../protocol/error-codes';
import type {
  DeleteSessionWorktreeOutcome,
  InspectWorktreesResponse,
  ListWorktreesResponse,
  RemoveWorktreeResponse,
  WorktreeRemoveFailedDetails,
} from '../../protocol/rest-worktree';
import type { Worktree, WorktreeSessionRef } from '../../protocol/worktree';
import { gitText, runCommand } from './command';
import { headBranch, listWorktrees } from './gitRefs';
import { publishSessionUpdated } from './sessionUpdates';
import { forgetWorktreeFacts, storedSessionWorktree } from './sessionWorktreeState';
import { WorktreeError } from './worktreeError';

interface KnownWorktree {
  readonly path: string;
  readonly key: string;
  readonly repoRoot: string;
  readonly branch?: string;
  readonly origin: Worktree['origin'];
  readonly workspace?: Project;
  readonly exists: boolean;
}

interface SessionsByDirectory {
  under(directory: string): WorktreeSessionRef[];
}

const IN_USE_OUTPUT = /resource busy|being used by another process|permission denied|directory not empty/i;
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

  constructor(private readonly core: Scope) {}

  private async known(): Promise<readonly KnownWorktree[]> {
    const projects = await this.core.accessor.get(IProjectService).list();
    const projectByRoot = new Map<string, Project>();
    for (const project of projects) {
      const key = await canonical(project.root);
      if (!projectByRoot.has(key)) projectByRoot.set(key, project);
    }
    const service = this.core.accessor.get(IWorktreeService);
    const listings = await Promise.all(
      [...projectByRoot.keys()].map((root) => service.list(root).catch(() => undefined)),
    );
    const found = new Map<string, KnownWorktree>();
    const scanned = new Set<string>();
    for (const listing of listings) {
      if (listing === undefined || scanned.has(listing.repoRoot)) continue;
      scanned.add(listing.repoRoot);
      for (const worktree of listing.worktrees) {
        const key = await canonical(worktree.path);
        found.set(key, {
          path: worktree.path,
          key,
          repoRoot: listing.repoRoot,
          branch: worktree.branch,
          origin: worktree.managed ? 'product' : 'external',
          workspace: projectByRoot.get(listing.repoRoot),
          exists: !worktree.missing,
        });
      }
    }
    return [...found.values()];
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
    const entries: { readonly key: string; readonly ref: WorktreeSessionRef }[] = [];
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
      entries.push({
        key,
        ref: {
          id: summary.id,
          title: summary.title ?? '',
          archived: summary.archived,
          busy:
            activity?.busy === true ||
            activity?.mainTurnActive === true ||
            storedSessionWorktree(summary.custom)?.setup.status === 'running',
        },
      });
    }
    return {
      under: (directory) => {
        const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
        return entries.filter(({ key }) => key === directory || key.startsWith(prefix)).map(({ ref }) => ref);
      },
    };
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
        size_bytes: this.sizes.get(worktree.key),
        sessions: sessions.under(worktree.key),
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
      const refs = sessions.under(key);
      try {
        const check = await this.core.accessor.get(IWorktreeService).inspectRemoval({
          repoRoot: worktree.repoRoot,
          path: worktree.path,
          deleteBranch: true,
          excludeSessionIds: refs.map((ref) => ref.id),
        });
        const openElsewhere = new Set(check.openSessionIds);
        items.push({
          path,
          branch: check.branch,
          uncommitted_files: check.uncommittedFiles,
          unpushed_commits: check.uniqueCommits,
          sessions: refs.map((ref) => (openElsewhere.has(ref.id) ? { ...ref, busy: true } : ref)),
        });
      } catch (error) {
        errors[path] = { code: ErrorCode.FS_GIT_UNAVAILABLE, msg: errorMessage(error) };
      }
    }
    return { items, errors };
  }

  async remove(path: string, deleteBranch: boolean): Promise<RemoveWorktreeResponse> {
    const worktree = await this.find(path);
    const sessions = (await this.sessionsByDirectory()).under(worktree.key);
    if (sessions.some((session) => session.busy)) {
      throw removeFailed(path, 'session_busy', 'a session that uses this worktree is running');
    }
    const branchDeleted = await this.discard(
      worktree,
      deleteBranch,
      sessions.map((session) => session.id),
    );
    for (const session of sessions) publishSessionUpdated(this.core, session.id);
    return { removed: true, branch_deleted: branchDeleted };
  }

  private async discard(
    worktree: KnownWorktree,
    deleteBranch: boolean,
    sessionIds: readonly string[],
  ): Promise<boolean> {
    try {
      await this.core.accessor.get(IWorktreeService).remove({
        repoRoot: worktree.repoRoot,
        path: worktree.path,
        deleteBranch,
        discard: 'all',
        force: true,
        excludeSessionIds: sessionIds,
      });
    } catch (error) {
      throw removalError(worktree.path, error);
    }
    this.sizes.delete(worktree.key);
    forgetWorktreeFacts({ repo_root: worktree.repoRoot, path: worktree.path, branch: worktree.branch });
    return deleteBranch && worktree.branch !== undefined;
  }

  async removeAfterSessionDeletion(
    directory: string,
    deleteBranch: boolean,
  ): Promise<DeleteSessionWorktreeOutcome | undefined> {
    const key = await canonical(directory);
    const worktree = (await this.known()).find((candidate) => candidate.key === key);
    if (worktree === undefined) return undefined;
    const others = (await this.sessionsByDirectory()).under(key);
    if (others.length > 0) return { outcome: 'kept_in_use', other_sessions: others.length };
    try {
      const branchDeleted = await this.discard(worktree, deleteBranch, []);
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
        readonly workspace?: Project;
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
    const workspaces = await this.core.accessor.get(IProjectService).list();
    let workspace: Project | undefined;
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
      sessionCount: (await this.sessionsByDirectory()).under(key).length,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removalError(path: string, error: unknown): WorktreeError {
  if (!isError2(error)) return removeFailed(path, 'unknown', errorMessage(error));
  if (error.code === ErrorCodes.WORKTREE_IN_USE) {
    return removeFailed(path, 'session_busy', 'a session that uses this worktree is open in another window or in the CLI');
  }
  if (error.code === ErrorCodes.WORKTREE_NOT_FOUND) {
    return new WorktreeError(ErrorCode.WORKTREE_NOT_FOUND, error.message);
  }
  if (error.code === ErrorCodes.WORKTREE_DISABLED) {
    return new WorktreeError(ErrorCode.WORKTREE_UNSUPPORTED, error.message);
  }
  const stderr = error.details?.['stderr'];
  const output = typeof stderr === 'string' && stderr.length > 0 ? stderr : error.message;
  return removeFailed(path, IN_USE_OUTPUT.test(output) ? 'in_use' : 'unknown', output);
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
