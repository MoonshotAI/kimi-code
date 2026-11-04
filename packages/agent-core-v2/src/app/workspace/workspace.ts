import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type WorkspaceKind = 'managed' | 'implicit';

export interface WorkspaceDirectory {
  readonly environmentId: string;
  readonly path: string;
}

export type WorkspaceEnvironmentDir = WorkspaceDirectory;

export interface Workspace {
  readonly id: string;
  readonly root: string;
  readonly primaryEnvironmentId?: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly additionalDirs: readonly string[];
  readonly environmentDirs?: readonly WorkspaceEnvironmentDir[];
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface WorkspaceCreate {
  readonly root: string;
  readonly primaryEnvironmentId?: string;
  readonly name?: string;
  readonly additionalDirs?: readonly string[];
  readonly environmentDirs?: readonly WorkspaceEnvironmentDir[];
  readonly idempotencyKey?: string;
}

export interface WorkspaceUpdate {
  readonly name?: string;
  readonly additionalDirs?: readonly string[];
  readonly environmentDirs?: readonly WorkspaceEnvironmentDir[];
  readonly directories?: readonly WorkspaceDirectory[];
}

export function workspaceDirectories(workspace: Pick<Workspace, 'root' | 'primaryEnvironmentId' | 'additionalDirs' | 'environmentDirs'>): readonly WorkspaceDirectory[] {
  return [
    { environmentId: workspace.primaryEnvironmentId ?? 'local', path: workspace.root },
    ...workspace.additionalDirs.map((path) => ({ environmentId: 'local', path })),
    ...(workspace.environmentDirs ?? []),
  ];
}

export function workspaceDirectoryParts(directories: readonly WorkspaceDirectory[]): Pick<Workspace, 'root' | 'primaryEnvironmentId' | 'additionalDirs' | 'environmentDirs'> {
  const primary = directories[0];
  if (primary === undefined) throw new Error('workspace requires a primary directory');
  const rest = directories.slice(1);
  return {
    root: primary.path,
    primaryEnvironmentId: primary.environmentId,
    additionalDirs: rest.filter((dir) => dir.environmentId === 'local').map((dir) => dir.path),
    environmentDirs: rest.filter((dir) => dir.environmentId !== 'local'),
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
