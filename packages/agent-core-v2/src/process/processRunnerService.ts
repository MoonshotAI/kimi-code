/**
 * `process` domain (L1) — `IProcessRunner` implementation.
 *
 * Resolves the working directory through `workspaceContext` and delegates
 * spawning to the injected `IProcessBackend`. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IWorkspaceContext } from '#/workspaceContext';

import {
  type IProcess,
  IProcessBackend,
  IProcessRunner,
  type ProcessExecOptions,
} from './process';

export class ProcessRunner implements IProcessRunner {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProcessBackend private readonly backend: IProcessBackend,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
  ) {}

  exec(args: readonly string[], options?: ProcessExecOptions): Promise<IProcess> {
    return this.backend.spawn(args, {
      cwd: options?.cwd ?? this.workspace.workDir,
      env: options?.env,
    });
  }
}

registerScopedService(
  LifecycleScope.Session,
  IProcessRunner,
  ProcessRunner,
  InstantiationType.Delayed,
  'process',
);
