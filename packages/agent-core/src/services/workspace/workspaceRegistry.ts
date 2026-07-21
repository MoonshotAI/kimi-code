

import { Disposable, createDecorator } from '../../di';

import type { Workspace } from '@moonshot-ai/protocol';

export class WorkspaceNotFoundError extends Error {
  readonly workspaceId: string;
  constructor(workspaceId: string) {
    super(`workspace not found: ${workspaceId}`);
    this.name = 'WorkspaceNotFoundError';
    this.workspaceId = workspaceId;
  }
}

export class WorkspaceRootNotFoundError extends Error {
  readonly root: string;
  constructor(root: string) {
    super(`workspace root does not exist: ${root}`);
    this.name = 'WorkspaceRootNotFoundError';
    this.root = root;
  }
}

export interface WorkspacePatch {

  name?: string;
}

export interface IWorkspaceRegistry {
  readonly _serviceBrand: undefined;

  list(): Promise<Workspace[]>;

  get(workspaceId: string): Promise<Workspace>;

  createOrTouch(root: string, name?: string): Promise<Workspace>;

  update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace>;

  delete(workspaceId: string): Promise<void>;

  resolveRoot(workspaceId: string): Promise<string>;

  /**
   * Identity-aware lookup: the id of the registered workspace whose root names
   * the same physical directory as `root` (case/slash variants fold for
   * Windows-shaped paths), or undefined when no registered entry matches.
   * Comparison only — the stored root is never rewritten.
   */
  findWorkspaceIdByRoot(root: string): Promise<string | undefined>;

  /**
   * Every workDir spelling naming the same physical root as `workspaceId`
   * (identity-folded via `workspaceRootKey`, so Windows case/slash variants
   * collapse): the resolved root itself plus each registered root and each
   * session-index workDir sharing the identity key. Index spellings matter —
   * split legacy buckets were never registered and exist only as index
   * workDir strings. Read-only; ids unknown to both sources resolve to [].
   */
  resolveAliasWorkDirs(workspaceId: string): Promise<readonly string[]>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWorkspaceRegistry = createDecorator<IWorkspaceRegistry>('workspaceRegistry');

export abstract class WorkspaceRegistryBase extends Disposable implements IWorkspaceRegistry {
  readonly _serviceBrand: undefined;
  abstract list(): Promise<Workspace[]>;
  abstract get(workspaceId: string): Promise<Workspace>;
  abstract createOrTouch(root: string, name?: string): Promise<Workspace>;
  abstract update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace>;
  abstract delete(workspaceId: string): Promise<void>;
  abstract resolveRoot(workspaceId: string): Promise<string>;
  abstract findWorkspaceIdByRoot(root: string): Promise<string | undefined>;
  abstract resolveAliasWorkDirs(workspaceId: string): Promise<readonly string[]>;
}
