/**
 * `hostEnvironment` domain (L1) — `IHostEnvironment` implementation.
 *
 * Kicks off the OS / shell probe (`probeHostEnvironmentFromNode`) and the
 * login-shell PATH enrichment (`applyLoginShellPathFromNode`) at construction
 * time; the sync fields become populated once `ready` resolves. Reads before
 * `ready` throws with a clear message so misuse fails loudly instead of
 * returning stale zeros. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { probeHostEnvironmentFromNode } from '#/_base/execEnv/environmentProbe';
import { applyLoginShellPathFromNode } from '#/_base/execEnv/loginShellPath';

import {
  type HostEnvironmentInfo,
  IHostEnvironment,
  type OsKind,
  type PathClass,
  type ShellName,
} from '#/os/interface/hostEnvironment';

export class HostEnvironmentService implements IHostEnvironment {
  declare readonly _serviceBrand: undefined;

  private _info?: HostEnvironmentInfo;
  readonly ready: Promise<void>;

  constructor() {
    // Enrich process.env.PATH from the user's login shell so spawned commands
    // find user-installed tools (e.g. Homebrew's gh) even when kimi-code itself
    // was launched without the full profile PATH. Both probes are memoised,
    // independent, and run concurrently: the login-shell probe is a no-op on
    // win32 (where probeHostEnvironment reads PATH to locate Git Bash), and on
    // POSIX probeHostEnvironment does not consult PATH.
    this.ready = Promise.all([
      probeHostEnvironmentFromNode().then((info) => {
        this._info = info;
      }),
      applyLoginShellPathFromNode(),
    ]).then(() => {});
  }

  private require(field: keyof HostEnvironmentInfo): never | HostEnvironmentInfo[typeof field] {
    if (this._info === undefined) {
      throw new Error(
        `IHostEnvironment.${field} accessed before ready — await IHostEnvironment.ready first (composition root should do so before creating a Session scope).`,
      );
    }
    return this._info[field];
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
  InstantiationType.Delayed,
  'hostEnvironment',
);
