import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type PathAccessOperation = 'read' | 'write' | 'execute';

export interface ISessionWorkspaceContext {
  readonly _serviceBrand: undefined;

  readonly workDir: string;
  readonly additionalDirs: readonly string[];
  resolve(rel: string): string;
  isWithin(absPath: string): boolean;
  assertAllowed(absPath: string, op: PathAccessOperation): string;
}

export const ISessionWorkspaceContext: ServiceIdentifier<ISessionWorkspaceContext> =
  createDecorator<ISessionWorkspaceContext>('sessionWorkspaceContext');
