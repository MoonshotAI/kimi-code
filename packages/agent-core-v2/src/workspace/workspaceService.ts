/**
 * `workspace` domain (cross-cutting) — `IWorkspaceRegistry` /
 * `IWorkspaceFsService` implementation.
 *
 * In-memory registry of workspace roots; `WorkspaceFsService` resolves
 * relative paths against a registered workspace.
 */

import { join } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IKaosFactory } from '#/kaos/kaos';
import { ILogService } from '#/log/log';

import {
  type WorkspaceInfo,
  IWorkspaceFsService,
  IWorkspaceRegistry,
} from './workspace';

let nextWorkspaceId = 0;

export class WorkspaceRegistry implements IWorkspaceRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly workspaces = new Map<string, WorkspaceInfo>();

  constructor(
    @IKaosFactory _kaosFactory: IKaosFactory,
    @ILogService _log: ILogService,
  ) {}

  register(root: string): WorkspaceInfo {
    const id = `ws-${nextWorkspaceId++}`;
    const info: WorkspaceInfo = { id, root };
    this.workspaces.set(id, info);
    return info;
  }
  get(id: string): WorkspaceInfo | undefined {
    return this.workspaces.get(id);
  }
  list(): readonly WorkspaceInfo[] {
    return [...this.workspaces.values()];
  }
}

export class WorkspaceFsService implements IWorkspaceFsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IKaosFactory _kaosFactory: IKaosFactory,
    @ILogService _log: ILogService,
    private readonly registry: WorkspaceRegistry = new WorkspaceRegistry(undefined as never, undefined as never),
  ) {}

  resolve(workspaceId: string, rel: string): string {
    const ws = this.registry.get(workspaceId);
    if (ws === undefined) throw new Error(`unknown workspace '${workspaceId}'`);
    return join(ws.root, rel);
  }
}

registerScopedService(LifecycleScope.Core, IWorkspaceRegistry, WorkspaceRegistry, InstantiationType.Delayed, 'workspace');
registerScopedService(LifecycleScope.Core, IWorkspaceFsService, WorkspaceFsService, InstantiationType.Delayed, 'workspace');
