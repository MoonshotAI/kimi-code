import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { Environment, EnvironmentBinding, EnvironmentCapability, EnvironmentLease } from '#/environment/environment';
import type { EnvironmentProviderFactory } from '#/environment/environmentProvider';

import type { WorkspaceInstance, WorkspaceInstanceSnapshot } from './workspaceInstance';

export type WorkspaceInstanceRef = { readonly workspaceId: string; readonly root?: string } | { readonly root: string };

export interface WorkspaceInstanceChange {
  readonly workspaceId: string;
  readonly instance?: WorkspaceInstance;
}

export interface WorkspaceInstancesSnapshot {
  readonly workspaces: readonly WorkspaceInstanceSnapshot[];
}

export interface IWorkspaceInstanceManager {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<WorkspaceInstanceChange>;
  getOrCreate(ref: WorkspaceInstanceRef): Promise<WorkspaceInstance>;
  get(workspaceId: string): WorkspaceInstance | undefined;
  findByRoot(root: string): WorkspaceInstance | undefined;
  findContaining(cwd: string): WorkspaceInstance | undefined;
  list(): readonly WorkspaceInstance[];
  snapshot(): WorkspaceInstancesSnapshot;
  close(workspaceId: string): Promise<void>;
  addProvider(factory: EnvironmentProviderFactory): Promise<{ dispose(): void | Promise<void> }>;
}

export const IWorkspaceInstanceManager: ServiceIdentifier<IWorkspaceInstanceManager> = createDecorator<IWorkspaceInstanceManager>('workspaceInstanceManager');

export interface IEnvironmentResolver {
  readonly _serviceBrand: undefined;
  inspect(binding: EnvironmentBinding): Environment;
  acquire(binding: EnvironmentBinding, required?: readonly EnvironmentCapability[]): EnvironmentLease;
  acquireWhenReady(binding: EnvironmentBinding, required?: readonly EnvironmentCapability[]): Promise<EnvironmentLease>;
}

export const IEnvironmentResolver: ServiceIdentifier<IEnvironmentResolver> = createDecorator<IEnvironmentResolver>('environmentResolver');
