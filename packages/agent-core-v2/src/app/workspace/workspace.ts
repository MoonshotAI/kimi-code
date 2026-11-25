import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ImplicitDecision } from './implicitProject';

export type WorkspaceKind = 'managed' | 'implicit';

export interface Workspace {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly additionalDirs: readonly string[];
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface WorkspaceCreate {
  readonly root: string;
  readonly name?: string;
  readonly additionalDirs?: readonly string[];
  readonly idempotencyKey?: string;
}

export interface WorkspaceUpdate {
  readonly name?: string;
  readonly additionalDirs?: readonly string[];
}

export interface IWorkspaceService {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly Workspace[]>;
  get(id: string): Promise<Workspace | undefined>;
  create(input: WorkspaceCreate): Promise<Workspace>;
  resolveImplicit(dir: string): Promise<Workspace>;
  peekImplicit(dir: string): Promise<ImplicitDecision>;
  reviveImplicit(id: string, workDir: string): Promise<Workspace>;
  projectDirAt(project: Pick<Workspace, 'root'>, dir: string): Promise<string | undefined>;
  acceptsWorkDir(project: Pick<Workspace, 'root'>, dir: string): Promise<boolean>;
  touch(id: string): Promise<Workspace | undefined>;
  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined>;
  setPrimary(id: string, path: string): Promise<Workspace | undefined>;
  readProjectConfigDirs(root: string): Promise<readonly string[]>;
  delete(id: string): Promise<void>;
}

export const IWorkspaceService: ServiceIdentifier<IWorkspaceService> =
  createDecorator<IWorkspaceService>('workspaceService');
