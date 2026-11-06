import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { ErrorCodes, Error2 } from '#/errors';

export type WorkspaceKind = 'managed' | 'implicit';

export interface WorkspaceDirectory {
  readonly environmentId: string;
  readonly path: string;
}

export interface Workspace {
  readonly id: string;
  readonly root: string;
  readonly directories: readonly WorkspaceDirectory[];
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly additionalDirs: readonly string[];
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface WorkspaceCreate {
  readonly directories: readonly WorkspaceDirectory[];
  readonly name?: string;
  readonly idempotencyKey?: string;
}

export interface WorkspaceUpdate {
  readonly name?: string;
  readonly directories?: readonly WorkspaceDirectory[];
}

export function workspaceEnvironmentId(workspace: Pick<Workspace, 'directories'>): string {
  return workspace.directories[0]?.environmentId ?? LOCAL_ENVIRONMENT_ID;
}

export function workspaceDirectoryParts(directories: readonly WorkspaceDirectory[]): Pick<Workspace, 'root' | 'directories' | 'additionalDirs'> {
  const primary = directories[0];
  if (primary === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'workspace requires a primary directory');
  }
  if (directories.some((dir) => dir.environmentId !== primary.environmentId)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'workspace directories must share one environment');
  }
  if (primary.environmentId !== LOCAL_ENVIRONMENT_ID && directories.length > 1) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'remote workspaces support a single directory');
  }
  return {
    root: primary.path,
    directories,
    additionalDirs: directories.slice(1).map((dir) => dir.path),
  };
}

export interface IWorkspaceService {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly Workspace[]>;
  get(id: string): Promise<Workspace | undefined>;
  create(input: WorkspaceCreate): Promise<Workspace>;
  createOrTouch(root: string, name?: string): Promise<Workspace>;
  touch(id: string): Promise<Workspace | undefined>;
  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined>;
  setPrimary(id: string, path: string): Promise<Workspace | undefined>;
  readProjectConfigDirs(root: string): Promise<readonly string[]>;
  delete(id: string): Promise<void>;
}

export const IWorkspaceService: ServiceIdentifier<IWorkspaceService> =
  createDecorator<IWorkspaceService>('workspaceService');
