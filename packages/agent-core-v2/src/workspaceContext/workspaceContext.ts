/**
 * `workspaceContext` domain (L1) — session workspace root and path access.
 *
 * Defines the `IWorkspaceContext` used by the Agent side to resolve relative
 * paths against the session work directory and to enforce that file/process
 * operations stay within the workspace (plus any additional dirs). Pure
 * configuration + boundary — it performs no IO. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type PathAccessOperation = 'read' | 'write' | 'execute';

export interface IWorkspaceContext {
  readonly _serviceBrand: undefined;

  readonly workDir: string;
  readonly additionalDirs: readonly string[];

  setWorkDir(workDir: string): void;
  resolve(rel: string): string;
  isWithin(absPath: string): boolean;
  assertAllowed(absPath: string, op: PathAccessOperation): string;
  addAdditionalDir(dir: string): void;
  removeAdditionalDir(dir: string): void;
}

export const IWorkspaceContext: ServiceIdentifier<IWorkspaceContext> =
  createDecorator<IWorkspaceContext>('workspaceContext');
