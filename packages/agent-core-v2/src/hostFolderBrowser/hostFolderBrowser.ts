/**
 * `hostFolderBrowser` domain (L2) — host-side folder picker.
 *
 * Defines the `IHostFolderBrowser` used by the program side (TUI / server) to
 * let the user browse the real local filesystem when choosing a workspace
 * folder. Distinct from the Agent-side `agentFs`, which is sandboxed and may
 * be remote. Core-scoped.
 *
 * The wire shapes (`FsBrowseResponse` / `FsHomeResponse`) are sourced from
 * `@moonshot-ai/protocol` so the `/api/v1` and `/api/v2` transports share one
 * contract. Domain errors (`HostFolder*Error`) carry the failing path and are
 * translated to protocol error codes at the transport boundary.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { FsBrowseResponse, FsHomeResponse } from '@moonshot-ai/protocol';

export type { FsBrowseResponse, FsHomeResponse };

/** Thrown by `browse` when the requested path is not absolute. */
export class HostFolderNotAbsoluteError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path must be absolute: ${path}`);
    this.name = 'HostFolderNotAbsoluteError';
    this.path = path;
  }
}

/** Thrown by `browse` when the requested path does not exist or is not a directory. */
export class HostFolderNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path not found: ${path}`);
    this.name = 'HostFolderNotFoundError';
    this.path = path;
  }
}

/** Thrown by `browse` when the process lacks permission to read the path. */
export class HostFolderPermissionError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`permission denied: ${path}`);
    this.name = 'HostFolderPermissionError';
    this.path = path;
  }
}

export interface IHostFolderBrowser {
  readonly _serviceBrand: undefined;

  /**
   * List the immediate sub-directories of `absPath` (defaults to `$HOME`),
   * annotated with git metadata. The returned `path` is the realpath of the
   * target.
   */
  browse(absPath?: string): Promise<FsBrowseResponse>;

  /** `$HOME` plus the most recently opened workspace roots. */
  home(): Promise<FsHomeResponse>;
}

export const IHostFolderBrowser: ServiceIdentifier<IHostFolderBrowser> =
  createDecorator<IHostFolderBrowser>('hostFolderBrowser');

/** Maximum number of recent workspace roots returned by `home()`. */
export const RECENT_ROOTS_LIMIT = 8;
