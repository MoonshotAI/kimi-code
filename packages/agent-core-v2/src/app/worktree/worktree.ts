import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const WORKTREE_FLAG_ID = 'worktree';

export type WorktreeCheckoutKind = 'main' | 'managed' | 'linked';

export interface WorktreeCheckout {
  readonly repoRoot: string;
  readonly checkoutRoot: string;
  readonly relativePath: string;
  readonly kind: WorktreeCheckoutKind;
  readonly bare: boolean;
}

export interface KimiWorktree {
  readonly path: string;
  readonly name: string;
  readonly head: string | undefined;
  readonly branch: string | undefined;
  readonly missing: boolean;
  readonly managed: boolean;
}

export interface WorktreeListing {
  readonly repoRoot: string;
  readonly currentCheckoutRoot: string;
  readonly bare: boolean;
  readonly repoBranch?: string;
  readonly repoHead?: string;
  readonly worktrees: readonly KimiWorktree[];
}

export type WorktreeCreateStep = 'check' | 'add' | 'include';

export type WorktreeCreateEvent =
  | {
      readonly type: 'step';
      readonly step: WorktreeCreateStep;
      readonly status: 'started' | 'finished';
    }
  | { readonly type: 'output'; readonly step: WorktreeCreateStep; readonly text: string }
  | { readonly type: 'planned'; readonly name: string; readonly path: string; readonly head: string };

export interface CreateWorktreeInput {
  readonly cwd: string;
  readonly name?: string;
  readonly base?: string;
  readonly branch?: string;
}

export interface CreateWorktreeOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: WorktreeCreateEvent) => void;
}

export interface CreatedWorktree {
  readonly worktree: KimiWorktree;
  readonly repoRoot: string;
  readonly sourceRoot: string;
  readonly cwd: string;
  readonly cwdFallback: boolean;
  readonly copiedFiles: readonly string[];
  readonly sourceDirty: boolean;
}

export interface CopyIncludedFilesInput {
  readonly sourceRoot: string;
  readonly worktreePath: string;
}

export interface InspectWorktreeRemovalInput {
  readonly repoRoot: string;
  readonly path: string;
  readonly deleteBranch: boolean;
  readonly excludeSessionId?: string;
  readonly excludeSessionIds?: readonly string[];
  readonly removedTogether?: readonly string[];
}

export interface WorktreeRemovalCheck {
  readonly path: string;
  readonly missing: boolean;
  readonly branch: string | undefined;
  readonly uncommittedFiles: number;
  readonly uniqueCommits: number;
  readonly openSessionIds: readonly string[];
  readonly closedSessionCount: number;
  readonly hasSubmodules?: boolean;
  readonly locked?: boolean;
}

export interface RemoveWorktreeInput extends InspectWorktreeRemovalInput {
  readonly discard: Pick<WorktreeRemovalCheck, 'uncommittedFiles' | 'uniqueCommits'> | 'all';
  readonly force?: boolean;
}

export interface WorktreeLocation {
  readonly cwd: string;
  readonly projectRoot: string;
  readonly isGitRepo: boolean;
  readonly worktree?: {
    readonly root: string;
    readonly name: string;
    readonly repoRoot: string;
  };
}

export interface IWorktreeService {
  readonly _serviceBrand: undefined;

  resolveCheckout(cwd: string): Promise<WorktreeCheckout | undefined>;
  locate(cwd: string): Promise<WorktreeLocation>;
  worktreesDir(repoRoot: string): string;
  list(cwd: string): Promise<WorktreeListing>;
  create(input: CreateWorktreeInput, options?: CreateWorktreeOptions): Promise<CreatedWorktree>;
  copyIncludedFiles(input: CopyIncludedFilesInput, options?: { readonly signal?: AbortSignal }): Promise<readonly string[]>;
  inspectRemoval(input: InspectWorktreeRemovalInput): Promise<WorktreeRemovalCheck>;
  remove(input: RemoveWorktreeInput): Promise<void>;
}

export const IWorktreeService: ServiceIdentifier<IWorktreeService> =
  createDecorator<IWorktreeService>('worktreeService');
