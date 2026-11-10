import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export interface SessionWorkspaceAssociationSnapshot {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly cwd: string;
}

export interface ISessionContext {
  readonly _serviceBrand: undefined;

  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly metaScope: string;
  readonly cwd: string;
  scope(subKey?: string): string;
}

export const ISessionContext: ServiceIdentifier<ISessionContext> =
  createDecorator<ISessionContext>('sessionContext');

export function snapshotSessionWorkspaceAssociation(
  context: ISessionContext,
): SessionWorkspaceAssociationSnapshot {
  return {
    sessionId: context.sessionId,
    workspaceId: context.workspaceId,
    cwd: context.cwd,
  };
}

export function sessionContextSeed(ctx: ISessionContext): ScopeSeed {
  return [[ISessionContext as ServiceIdentifier<unknown>, ctx]];
}

export function makeSessionContext(input: {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly sessionScope: string;
  readonly cwd: string;
  readonly metaScope?: string;
}): ISessionContext {
  const { sessionScope } = input;
  return {
    _serviceBrand: undefined,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    sessionDir: input.sessionDir,
    metaScope: input.metaScope ?? sessionScope,
    cwd: input.cwd,
    scope: (subKey?: string): string =>
      subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
  };
}
