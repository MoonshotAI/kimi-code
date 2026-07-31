/**
 * `workspaceContext` domain (L1) — seeded per-handler workspace facts.
 *
 * Defines the `IWorkspaceContext` carrying the workspace handler's identity
 * and storage addressing (`workspaceId`, `persistenceScope` — the handler's
 * persistence scope string `sessions/{wd_id}` every session/agent scope
 * string derives from), the workspace root (`cwd`) and catalog metadata
 * (`meta`), plus the runtime keying pair (`osBackendId` ×
 * `persistenceBackendId`) that records which os/persistence backends the
 * handler binds — both `'local'` until a remote runtime exists (`remoteCwd`
 * reserves the remote root slot, never set by the local runtime). Seeded
 * into the Workspace scope by `workspaceLifecycle` when the handler is
 * materialized. Pure facts — no store, no IO. Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

/** The only runtime source today; remote runtimes will add their own. */
export type WorkspaceSource = 'local';

export const LOCAL_OS_BACKEND_ID = 'local';
export const LOCAL_PERSISTENCE_BACKEND_ID = 'local';

/**
 * Mirrors the `workspace` catalog's `Workspace` record field-for-field.
 * Re-declared structurally so this L1 seed does not import the L2 catalog
 * domain; a `Workspace` value is directly assignable here.
 */
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
  readonly osBackendId: string;
  readonly persistenceBackendId: string;
}

export const IWorkspaceContext: ServiceIdentifier<IWorkspaceContext> =
  createDecorator<IWorkspaceContext>('workspaceContext');

export function workspaceContextSeed(ctx: IWorkspaceContext): ScopeSeed {
  return [[IWorkspaceContext as ServiceIdentifier<unknown>, ctx]];
}
