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
 * (`session-lifecycle`) `await`s `ready` before creating any Session scope, so
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
} from '#/_base/execEnv';

export type { HostEnvironmentInfo, OsKind, PathClass, ShellName };

export interface IHostEnvironment {
  readonly _serviceBrand: undefined;

  /** Family of the host OS (`macOS` / `Linux` / `Windows`, or the raw
   * `process.platform` string for unknown platforms). */
  readonly osKind: OsKind;
  /** Host architecture (`process.arch`). */
  readonly osArch: string;
  /** Host kernel release (`os.release()`). */
  readonly osVersion: string;
  /** Name of the POSIX shell discovered on this host. */
  readonly shellName: ShellName;
  /** Absolute path to the POSIX shell (`/bin/bash`, `/bin/sh`, or a Git Bash
   *  installation on Windows). */
  readonly shellPath: string;
  /** Path style used by this host — `win32` on Windows, `posix` elsewhere. */
  readonly pathClass: PathClass;
  /** Absolute path of the current user's home directory (`os.homedir()`). */
  readonly homeDir: string;

  /**
   * Resolves once the probe has completed. Every field above is populated by
   * the time this promise settles. The composition root awaits this before
   * creating a Session scope so all Session/Agent consumers can read the
   * fields synchronously.
   */
  readonly ready: Promise<void>;
}

export const IHostEnvironment: ServiceIdentifier<IHostEnvironment> =
  createDecorator<IHostEnvironment>('hostEnvironment');
