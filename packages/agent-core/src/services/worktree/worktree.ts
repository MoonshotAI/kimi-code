import { createDecorator } from '../../di';
import type { IDisposable } from '../../di';
import type {
  CreateWorktreeRequest,
  RemoveWorktreeRequest,
  Worktree,
} from '@moonshot-ai/protocol';

/** Base error for all worktree operations. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/** The workspace root is not a git repository (or git is unavailable). */
export class WorktreeGitUnavailableError extends WorktreeError {
  readonly cwd: string;
  constructor(cwd: string, detail: string) {
    super(`git unavailable at ${cwd}: ${detail}`);
    this.name = 'WorktreeGitUnavailableError';
    this.cwd = cwd;
  }
}

/** The target worktree (by path) does not exist in this repository. */
export class WorktreeNotFoundError extends WorktreeError {
  readonly worktreePath: string;
  constructor(worktreePath: string) {
    super(`worktree not found: ${worktreePath}`);
    this.name = 'WorktreeNotFoundError';
    this.worktreePath = worktreePath;
  }
}

/**
 * The operation conflicts with git state: branch already checked out in another
 * worktree, target path already exists, or the worktree has uncommitted changes
 * on a non-forced remove.
 */
export class WorktreeConflictError extends WorktreeError {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeConflictError';
  }
}

export interface IWorktreeService extends IDisposable {
  readonly _serviceBrand: undefined;

  /** List all worktrees of the workspace's repository, enriched with status. */
  list(workspaceId: string): Promise<Worktree[]>;

  /** Create a new worktree (and branch) off the workspace's repository. */
  create(workspaceId: string, req: CreateWorktreeRequest): Promise<Worktree>;

  /** Remove a worktree. Optionally force-remove and/or delete its branch. */
  remove(workspaceId: string, req: RemoveWorktreeRequest): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWorktreeService = createDecorator<IWorktreeService>('worktreeService');
