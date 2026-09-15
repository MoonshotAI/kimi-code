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
