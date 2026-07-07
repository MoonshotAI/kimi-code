

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
}
