import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { ProgramWorkdir } from '#/program/program';

import type { WorkspaceInstance, WorkspaceInstanceSnapshot } from './workspaceInstance';

export type WorkspaceInstanceRef =
  | { readonly workspaceId: string; readonly reviveFrom?: string }
  | { readonly cwd: string };

export interface WorkspaceInstanceChange {
  readonly workspaceId: string;
  readonly instance?: WorkspaceInstance;
}

export interface WorkspaceInstancesSnapshot {
  readonly workspaces: readonly WorkspaceInstanceSnapshot[];
}

export interface WorkspaceInstanceLease {
  readonly instance: WorkspaceInstance;
  dispose(): void;
}

export interface WorkdirLease {
  readonly instance: WorkspaceInstance;
  readonly workdir: ProgramWorkdir;
  dispose(): void;
}

export interface IWorkspaceInstanceManager {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<WorkspaceInstanceChange>;
  acquire(ref: WorkspaceInstanceRef): Promise<WorkspaceInstanceLease>;
  acquireWorkdir(cwd: string): Promise<WorkdirLease>;
  get(workspaceId: string): WorkspaceInstance | undefined;
  list(): readonly WorkspaceInstance[];
  snapshot(): WorkspaceInstancesSnapshot;
}

export const IWorkspaceInstanceManager: ServiceIdentifier<IWorkspaceInstanceManager> = createDecorator<IWorkspaceInstanceManager>('workspaceInstanceManager');
