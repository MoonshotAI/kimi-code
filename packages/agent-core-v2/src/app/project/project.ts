import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { RepositoryStore } from '#/app/git/repository';

export type Project = {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly additionalDirs: readonly string[];
  readonly createdAt: number;
  readonly lastOpenedAt: number;
} & (
  | { readonly kind: 'managed'; readonly vcs?: never }
  | { readonly kind: 'implicit'; readonly vcs?: RepositoryStore }
);

export type ProjectKind = Project['kind'];

export interface ProjectCreate {
  readonly root: string;
  readonly name?: string;
  readonly additionalDirs?: readonly string[];
  readonly idempotencyKey?: string;
}

export interface ProjectUpdate {
  readonly name?: string;
  readonly additionalDirs?: readonly string[];
}

export interface IProjectService {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly Project[]>;
  get(id: string): Promise<Project | undefined>;
  create(input: ProjectCreate): Promise<Project>;
  createOrTouch(root: string, name?: string): Promise<Project>;
  implicitDirectories(cwd: string): Promise<readonly string[]>;
  touch(id: string): Promise<Project | undefined>;
  update(id: string, patch: ProjectUpdate): Promise<Project | undefined>;
  addDirectory(id: string, dir: string): Promise<Project | undefined>;
  setPrimary(id: string, path: string): Promise<Project | undefined>;
  readProjectConfigDirs(root: string): Promise<readonly string[]>;
  delete(id: string): Promise<void>;
}

export const IProjectService: ServiceIdentifier<IProjectService> =
  createDecorator<IProjectService>('workspaceService');
