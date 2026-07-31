/**
 * `workspaceContext` domain — session workspace root and path access.
 *
 * Defines the `ISessionWorkspaceContext` used by the Agent side to resolve relative
 * paths against the session work directory and to enforce that file/process
 * operations stay within the workspace (plus any additional dirs). The view is
 * read-only: `workDir` is fixed at session creation; `additionalDirs` mirrors
 * the handler-shared set and refreshes when the workspace-level add-dir
 * surface changes it. Pure configuration + boundary — it performs no IO.
 * Session-scoped.
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
