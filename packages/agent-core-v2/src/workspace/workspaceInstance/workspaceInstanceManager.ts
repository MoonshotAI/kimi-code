import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { Runtime, RuntimeBinding, RuntimeCapability, RuntimeLease } from '#/runtime/runtime';
import type { RuntimeProviderFactory } from '#/runtime/runtimeProvider';

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
  addProvider(factory: RuntimeProviderFactory): Promise<{ dispose(): void | Promise<void> }>;
}

export const IWorkspaceInstanceManager: ServiceIdentifier<IWorkspaceInstanceManager> = createDecorator<IWorkspaceInstanceManager>('workspaceInstanceManager');

export interface IRuntimeResolver {
  readonly _serviceBrand: undefined;
  inspect(binding: RuntimeBinding): Runtime;
  acquire(binding: RuntimeBinding, required?: readonly RuntimeCapability[]): RuntimeLease;
}

export const IRuntimeResolver: ServiceIdentifier<IRuntimeResolver> = createDecorator<IRuntimeResolver>('runtimeResolver');
