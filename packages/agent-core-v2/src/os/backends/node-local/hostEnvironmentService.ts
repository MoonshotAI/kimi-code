/**
 * `hostEnvironment` domain — `IHostEnvironment` implementation.
 *
 * Kicks off the OS / shell probe (`probeHostEnvironmentFromNode`) and the
 * login-shell PATH enrichment (`applyLoginShellPathFromNode`) at construction
 * time; the sync fields become populated once `ready` resolves. Reads before
 * `ready` throws with a clear message so misuse fails loudly instead of
 * returning stale zeros. A failed probe is translated at this boundary — a
 * missing Git Bash on Windows becomes `HostProcessError`
 * (`shell.git_bash_not_found`) — and surfaces identically from `ready` and
 * from sync field reads, while an internal no-op handler keeps the rejection
 * from ever becoming an unhandledRejection during App-scope construction.
 * Bound at App scope.
 */

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { BugIndicatingError } from '#/_base/errors/errors';
import {
  probeHostEnvironmentFromNode,
  ProbeShellNotFoundError,
} from '#/_base/execEnv/environmentProbe';
import { applyLoginShellPathFromNode } from '#/_base/execEnv/loginShellPath';

import {
  type HostEnvironmentInfo,
  IHostEnvironment,
  type OsKind,
  type PathClass,
  type ShellName,
} from '#/os/interface/hostEnvironment';
import { HostProcessError, OsProcessErrors } from '#/os/interface/hostProcess';

export class HostEnvironmentService implements IHostEnvironment {
  declare readonly _serviceBrand: undefined;

  private _info?: HostEnvironmentInfo;
  private _probeError?: Error;
  readonly ready: Promise<void>;

  constructor() {
    this.ready = Promise.all([
      probeHostEnvironmentFromNode().then((info) => {
        this._info = info;
      }),
      applyLoginShellPathFromNode(),
    ])
      .then(() => {})
      .catch((error: unknown) => {
        const translated = this.toHostProcessError(error);
        this._probeError = translated;
        throw translated;
      });
    this.ready.catch(() => {});
  }

  private require(field: keyof HostEnvironmentInfo): never | HostEnvironmentInfo[typeof field] {
    if (this._probeError !== undefined) {
      throw this._probeError;
    }
    if (this._info === undefined) {
      throw new BugIndicatingError(
        `IHostEnvironment.${field} accessed before ready — await IHostEnvironment.ready first (composition root should do so before creating a Session scope).`,
      );
    }
    return this._info[field];
  }

  private toHostProcessError(error: unknown): Error {
    if (error instanceof ProbeShellNotFoundError) {
      return new HostProcessError(
        OsProcessErrors.codes.SHELL_GIT_BASH_NOT_FOUND,
        error.message,
        { details: { checkedPaths: error.checked }, cause: error },
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  get osKind(): OsKind {
    return this.require('osKind') as OsKind;
  }

  get osArch(): string {
    return this.require('osArch') as string;
  }

  get osVersion(): string {
    return this.require('osVersion') as string;
  }

  get shellName(): ShellName {
    return this.require('shellName') as ShellName;
  }

  get shellPath(): string {
    return this.require('shellPath') as string;
  }

  get pathClass(): PathClass {
    return this.require('pathClass') as PathClass;
  }

  get homeDir(): string {
    return this.require('homeDir') as string;
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostEnvironment,
  HostEnvironmentService,
  ScopeActivation.OnScopeCreated,
  'hostEnvironment',
);
