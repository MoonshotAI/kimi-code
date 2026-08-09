/**
 * `process` domain — the default `ISessionProcessRunner` implementation.
 *
 * Resolves the default cwd from the session's `ISessionContext` and delegates
 * the actual host spawn to the App-scope `IHostProcessService`. A per-call
 * `options.cwd` wins over the seeded cwd. A per-call `options.env` is overlaid
 * onto `process.env` and passed as the child's complete env bag (the host
 * replaces the child env with what we pass); when `options.env` is omitted we
 * pass `undefined` so the child inherits `process.env` verbatim.
 *
 * This Session-scope registration is the DEFAULT for scopes built without a
 * workspace handler (test hosts, harness agents). Real sessions get the
 * handler-shared Workspace-scope runner as a scope seed, which shadows this
 * registration — same pattern as the other workspace-capability injection
 * contracts.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { BugIndicatingError } from '#/errors';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { type IProcess, ISessionProcessRunner, type ProcessExecOptions } from './processRunner';

export class SessionProcessRunner implements ISessionProcessRunner {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
  ) {}

  async exec(args: readonly string[], options?: ProcessExecOptions): Promise<IProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new BugIndicatingError(
        'SessionProcessRunner.exec(): at least one argument (the command to run) is required.',
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
  LifecycleScope.Session,
  ISessionProcessRunner,
  SessionProcessRunner,
  ScopeActivation.OnScopeCreated,
  'process',
);
