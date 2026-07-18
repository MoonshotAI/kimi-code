/**
 * `hostEnvironment` domain (L1) — the OS / shell / path-style facts of the
 * host the Agent runs on.
 *
 * Defines `IHostEnvironment`, an immutable snapshot of the host OS
 * (`osKind`/`osArch`/`osVersion`), the POSIX shell to spawn commands with
 * (`shellName`/`shellPath`), the target path style (`pathClass`), and the
 * user's home directory (`homeDir`). The snapshot is a pure function of the
 * host and never changes during a process's lifetime; the service memoises
 * the probe.
 *
 * Async initialization: probing (`ready`) discovers the shell path — on
 * Windows this may run `git.exe --exec-path`. The composition root
 * (`sessionLifecycle`) `await`s `ready` before creating any Session scope, so
 * every Session/Agent-scope consumer reads the sync fields safely.
 *
 * App-scoped — one shared instance for the whole process.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type {
  HostEnvironmentInfo,
  OsKind,
  PathClass,
  ShellName,
} from '#/_base/execEnv/environmentProbe';

export type { HostEnvironmentInfo, OsKind, PathClass, ShellName };

export interface IHostEnvironment {
  readonly _serviceBrand: undefined;

  readonly osKind: OsKind;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: ShellName;
  readonly shellPath: string;
  readonly pathClass: PathClass;
  readonly homeDir: string;
  readonly ready: Promise<void>;
}

export const IHostEnvironment: ServiceIdentifier<IHostEnvironment> =
  createDecorator<IHostEnvironment>('hostEnvironment');
