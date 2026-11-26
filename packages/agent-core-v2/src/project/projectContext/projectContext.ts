import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { ProjectKind } from '#/app/project/project';

export type ProjectSource = 'local';

export interface ProjectMeta {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly kind: ProjectKind;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface IProjectContext {
  readonly _serviceBrand: undefined;

  readonly workspaceId: string;
  readonly cwd: string;
  readonly source: ProjectSource;
  readonly remoteCwd?: string;
  readonly meta: ProjectMeta;
  readonly persistenceScope: string;
}

export const IProjectContext: ServiceIdentifier<IProjectContext> =
  createDecorator<IProjectContext>('workspaceContext');

export function projectContextSeed(ctx: IProjectContext): ScopeSeed {
  return [[IProjectContext as ServiceIdentifier<unknown>, ctx]];
}
