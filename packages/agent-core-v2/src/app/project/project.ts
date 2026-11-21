import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ImplicitDecision, ImplicitRule, ImplicitProject } from './implicitProject';

export type ProjectKind = 'managed' | 'implicit';

export interface Project {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly kind: ProjectKind;
  readonly additionalDirs: readonly string[];
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

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

export interface ImplicitProjectResult {
  readonly project: ImplicitProject;
  readonly rule: ImplicitRule;
}

export interface IProjectService {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly Project[]>;
  get(id: string): Promise<Project | undefined>;
  create(input: ProjectCreate): Promise<Project>;
  resolveImplicit(dir: string): Promise<ImplicitProjectResult>;
  peekImplicit(dir: string): Promise<ImplicitDecision>;
  reviveImplicit(id: string, workDir: string): Promise<Project>;
  contains(project: Pick<Project, 'root' | 'additionalDirs'>, dir: string): Promise<boolean>;
  touch(id: string): Promise<Project | undefined>;
  update(id: string, patch: ProjectUpdate): Promise<Project | undefined>;
  setPrimary(id: string, path: string): Promise<Project | undefined>;
  readProjectConfigDirs(root: string): Promise<readonly string[]>;
  delete(id: string): Promise<void>;
}

export const IProjectService: ServiceIdentifier<IProjectService> =
  createDecorator<IProjectService>('workspaceService');
