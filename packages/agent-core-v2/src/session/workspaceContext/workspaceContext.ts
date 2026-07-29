/**
 * `workspaceContext` domain (L1) — session workspace root and path access.
 *
 * Defines the `ISessionWorkspaceContext` used by the Agent side to resolve relative
 * paths against the session work directory and to enforce that file/process
 * operations stay within the workspace (plus any additional dirs). The view is
 * read-only: `workDir` / `additionalDirs` are fixed at session creation (seeded
 * from `ISessionContext`) and never change for the session's lifetime. Pure
 * configuration + boundary — it performs no IO. Session-scoped.
 */

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
