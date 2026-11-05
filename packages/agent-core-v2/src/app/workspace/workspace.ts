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
  readonly primaryEnvironmentId?: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly additionalDirs: readonly string[];
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface WorkspaceCreate {
  readonly root: string;
  readonly primaryEnvironmentId?: string;
  readonly name?: string;
  readonly additionalDirs?: readonly string[];
  readonly idempotencyKey?: string;
}

export interface WorkspaceUpdate {
  readonly name?: string;
  readonly additionalDirs?: readonly string[];
  readonly directories?: readonly WorkspaceDirectory[];
}

export function workspaceEnvironmentId(workspace: Pick<Workspace, 'primaryEnvironmentId'>): string {
  return workspace.primaryEnvironmentId ?? LOCAL_ENVIRONMENT_ID;
}

export function workspaceDirectories(workspace: Pick<Workspace, 'root' | 'primaryEnvironmentId' | 'additionalDirs'>): readonly WorkspaceDirectory[] {
  const environmentId = workspaceEnvironmentId(workspace);
  return [workspace.root, ...workspace.additionalDirs].map((path) => ({ environmentId, path }));
}

export function workspaceDirectoryParts(
  directories: readonly WorkspaceDirectory[],
): Pick<Workspace, 'root' | 'primaryEnvironmentId' | 'additionalDirs'> {
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
    primaryEnvironmentId: primary.environmentId === LOCAL_ENVIRONMENT_ID ? undefined : primary.environmentId,
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
