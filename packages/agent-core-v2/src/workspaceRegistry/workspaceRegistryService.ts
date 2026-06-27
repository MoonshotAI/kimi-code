/**
 * `workspaceRegistry` domain (L1) — `IWorkspaceRegistry` implementation.
 *
 * In-memory skeleton of the known-workspaces catalog; persistence through
 * `IConfigStore` will replace the map in a later phase. Bound at Core scope.
 */

import { createHash } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IWorkspaceRegistry, type Workspace } from './workspaceRegistry';

export class WorkspaceRegistryService implements IWorkspaceRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly workspaces = new Map<string, Workspace>();

  list(): Promise<readonly Workspace[]> {
    return Promise.resolve([...this.workspaces.values()]);
  }

  get(id: string): Promise<Workspace | undefined> {
    return Promise.resolve(this.workspaces.get(id));
  }

  createOrTouch(root: string, name?: string): Promise<Workspace> {
    const id = createHash('sha256').update(root).digest('hex').slice(0, 12);
    const existing = this.workspaces.get(id);
    if (existing !== undefined) return Promise.resolve(existing);
    const ws: Workspace = { id, root, name: name ?? root.split('/').pop() ?? root };
    this.workspaces.set(id, ws);
    return Promise.resolve(ws);
  }

  delete(id: string): Promise<void> {
    this.workspaces.delete(id);
    return Promise.resolve();
  }
}

registerScopedService(
  LifecycleScope.Core,
  IWorkspaceRegistry,
  WorkspaceRegistryService,
  InstantiationType.Delayed,
  'workspaceRegistry',
);
