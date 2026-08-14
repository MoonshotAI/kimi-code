/**
 * `workspaceContext` domain — seeded per-handler workspace facts.
 *
 * Defines the `IWorkspaceContext` carrying the workspace handler's identity
 * and storage addressing (`workspaceId`, `persistenceScope` — the handler's
 * persistence scope string `sessions/{wd_id}`), the workspace root (`cwd`)
 * and catalog metadata (`meta`), plus the runtime keying pair (`osBackendId`
 * × `persistenceBackendId`) that records which os/persistence backends the
 * handler binds — both `'local'` until a remote runtime exists (`remoteCwd`
 * reserves the remote root slot, never set by the local runtime). Seeded
 * into the Workspace scope when the handler is materialized. Pure facts —
 * no store, no IO. Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export type WorkspaceSource = 'local';

export interface WorkspaceMeta {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface IWorkspaceContext {
  readonly _serviceBrand: undefined;

  readonly workspaceId: string;
  readonly cwd: string;
  readonly source: WorkspaceSource;
  readonly remoteCwd?: string;
  readonly meta: WorkspaceMeta;
  readonly persistenceScope: string;
}

export const IWorkspaceContext: ServiceIdentifier<IWorkspaceContext> =
  createDecorator<IWorkspaceContext>('workspaceContext');

export function workspaceContextSeed(ctx: IWorkspaceContext): ScopeSeed {
  return [[IWorkspaceContext as ServiceIdentifier<unknown>, ctx]];
}
