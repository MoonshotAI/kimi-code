/**
 * `workspaceProcess` domain — `ISessionProcessRunner` implementation.
 *
 * Resolves the default cwd from the handler's `IWorkspaceContext` (chdir is
 * gone, so the workspace root is the one fixed default) and delegates the
 * actual host spawn to the App-scope `IHostProcessService`. A per-call
 * `options.cwd` wins over the handler root. A per-call `options.env` is
 * overlaid onto `process.env` and passed as the child's complete env bag (the
 * host replaces the child env with what we pass); when `options.env` is
 * omitted we pass `undefined` so the child inherits `process.env` verbatim.
 *
 * Bound at Workspace scope — one runner per handler, shared by every session
 * of the workspace.
 */

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { BugIndicatingError } from '#/errors';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { type IProcess, ISessionProcessRunner, type ProcessExecOptions } from '#/session/process/processRunner';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

export class WorkspaceProcessRunnerService implements ISessionProcessRunner {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceContext private readonly ctx: IWorkspaceContext,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
  ) {}

  async exec(args: readonly string[], options?: ProcessExecOptions): Promise<IProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new BugIndicatingError(
        'WorkspaceProcessRunnerService.exec(): at least one argument (the command to run) is required.',
      );
    }
    const restArgs = args.slice(1);

    const cwd = options?.cwd ?? this.ctx.cwd;
    const env = this._buildExecEnv(options?.env);

    return this.hostProcess.spawn(command, restArgs, { cwd, env });
  }

  private _buildExecEnv(
    invocationEnv: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (invocationEnv === undefined) {
      return undefined;
    }
    return {
      ...(process.env as Record<string, string>),
      ...invocationEnv,
    };
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  ISessionProcessRunner,
  WorkspaceProcessRunnerService,
  ScopeActivation.OnScopeCreated,
  'workspaceProcess',
);
