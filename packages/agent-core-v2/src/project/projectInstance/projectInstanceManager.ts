import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { ProjectInstance, ProjectInstanceSnapshot } from './projectInstance';

export type ProjectInstanceRef =
  | { readonly workspaceId: string; readonly reviveFrom?: string }
  | { readonly cwd: string };

export interface ProjectInstanceChange {
  readonly workspaceId: string;
  readonly instance?: ProjectInstance;
}

export interface ProjectInstancesSnapshot {
  readonly workspaces: readonly ProjectInstanceSnapshot[];
}

export interface ProjectInstanceLease {
  readonly instance: ProjectInstance;
  dispose(): void;
}

export interface IProjectInstanceManager {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<ProjectInstanceChange>;
  acquire(ref: ProjectInstanceRef): Promise<ProjectInstanceLease>;
  get(workspaceId: string): ProjectInstance | undefined;
  findByRoot(root: string): ProjectInstance | undefined;
  findContaining(cwd: string): ProjectInstance | undefined;
  list(): readonly ProjectInstance[];
  snapshot(): ProjectInstancesSnapshot;
}

export const IProjectInstanceManager: ServiceIdentifier<IProjectInstanceManager> = createDecorator<IProjectInstanceManager>('workspaceInstanceManager');
